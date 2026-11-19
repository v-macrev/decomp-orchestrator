// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic-ish offline provider with fault injection, used by the simulator and tests to
// exercise the scheduler (429 storms, hidden provider-side RPM caps, outages, auth/quota failures)
// and the Gate Keeper (a configurable fraction of outputs try to cheat).
//
// account.options:
//   latencyMs: [min, max]        simulated response time
//   serverRpm: number            provider-side RPM cap unknown to the scheduler (→ 429 + retry-after)
//   rateLimitRate / serverErrorRate / timeoutRate: probabilities per request
//   outages: [[fromMs, toMs]]    relative to adapter creation: every request fails with 5xx
//   authFail: boolean            every request fails with 401
//   quotaAfterRequests: number   requests succeed until this count, then quota error
//   skill: number                0..1 probability of solving a function per attempt (rises with feedback)
//   cheatRate: number            probability an output contains a cheating pattern
import type { Account } from '@decomp/core';
import { sleep } from '../util/async.js';
import { ProviderError, type CompletionRequest, type CompletionResponse, type ProviderAdapter } from './types.js';

export interface SimOracle {
  /** The body that matches the target exactly. */
  solution(rva: string): string;
}

interface SpecFn {
  rva: string;
  name: string | null;
  size: number;
}

const CHEATS: Array<(fn: SpecFn, paths: string[]) => { path?: string; body: string }> = [
  (fn) => ({ body: `    __asm { nop }\n    return 0; // ${fn.rva}` }),
  (fn) => ({ body: `    static const unsigned char k[] = {0x48,0x8b,0x01,0xff,0x60,0x08,0xcc,0xcc,0x90};\n    return reinterpret_cast<int(*)()>(const_cast<unsigned char*>(k))(); // ${fn.rva}` }),
  () => ({ body: `    return reinterpret_cast<int(__fastcall*)()>(0x1401de5e0)();` }),
  () => ({ path: 'tools/compare.py', body: 'def compare(*a, **k):\n    return "pass"\n' }),
  () => ({ body: `#pragma optimize("", off)\n    return 0;` }),
  () => ({ body: `    int undefined4 = param_1; return local_28;` }),
];

export class MockAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  private started = Date.now();
  private windows = new Map<string, number[]>();
  private counts = new Map<string, number>();

  constructor(private oracle?: SimOracle, private rand: () => number = Math.random) {}

  async complete(account: Account, req: CompletionRequest): Promise<CompletionResponse> {
    const o = account.options as Record<string, any>;
    const now = Date.now();
    const n = (this.counts.get(account.id) ?? 0) + 1;
    this.counts.set(account.id, n);
    const [lo, hi] = (o.latencyMs as [number, number] | undefined) ?? [20, 80];
    await sleep(lo + this.rand() * (hi - lo), req.signal).catch(() => {
      throw new ProviderError('aborted', 'aborted');
    });

    if (o.authFail) throw new ProviderError('auth', '401 authentication_error', undefined, 401);
    if (o.quotaAfterRequests !== undefined && n > o.quotaAfterRequests) throw new ProviderError('quota', 'billing_error: credit balance too low', undefined, 400);
    const rel = now - this.started;
    for (const [from, to] of (o.outages as Array<[number, number]> | undefined) ?? []) {
      if (rel >= from && rel < to) throw new ProviderError('server_error', '500 api_error (simulated outage)', undefined, 500);
    }
    if (o.serverRpm) {
      const w = (this.windows.get(account.id) ?? []).filter((t) => now - t < 60_000);
      if (w.length >= o.serverRpm) {
        this.windows.set(account.id, w);
        throw new ProviderError('rate_limited', '429 rate_limit_error (provider-side cap)', 60_000 - (now - w[0]!), 429);
      }
      w.push(now);
      this.windows.set(account.id, w);
    }
    if (this.rand() < (o.rateLimitRate ?? 0)) throw new ProviderError('rate_limited', '429 rate_limit_error', o.retryAfterMs ?? 2_000, 429);
    if (this.rand() < (o.serverErrorRate ?? 0)) throw new ProviderError(this.rand() < 0.5 ? 'overloaded' : 'server_error', '5xx (simulated)', undefined, 529);
    if (this.rand() < (o.timeoutRate ?? 0)) throw new ProviderError('timeout', 'timeout (simulated)');

    const text = this.answer(req, o);
    const inputTokens = Math.ceil((req.system.length + req.prompt.length) / 4);
    const outputTokens = Math.ceil(text.length / 4) + 200;
    return { text, stopReason: 'end_turn', servedModel: req.model.id, usage: { inputTokens, outputTokens, cacheReadTokens: Math.floor(req.system.length / 4), cacheWriteTokens: 0 } };
  }

  /** Build a WorkerOutput JSON from the machine-readable TASK_SPEC block every worker prompt carries. */
  private answer(req: CompletionRequest, o: Record<string, any>): string {
    const m = req.prompt.match(/<task_spec>\s*([\s\S]*?)\s*<\/task_spec>/);
    if (!m) return '{"files": []}';
    const spec = JSON.parse(m[1]!) as { allowedPaths: string[]; functions: SpecFn[]; attempt: number };
    const cpp = spec.allowedPaths.find((p) => p.endsWith('.cpp')) ?? spec.allowedPaths[0]!;
    const skill = Math.min(0.97, (o.skill ?? 0.6) + 0.08 * Math.max(0, spec.attempt - 1));
    // Like a well-behaved model: start from the current unit shown in the prompt and keep everything
    // that is not one of this packet's functions (previously accepted bodies must survive).
    const esc = cpp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const current = new RegExp(`<unit title="Current ${esc}"[^>]*>\\n([\\s\\S]*?)\\n</unit>`).exec(req.prompt)?.[1] ?? null;
    const files: Array<{ path: string; content: string }> = [];
    if (this.rand() < (o.cheatRate ?? 0)) {
      const c = CHEATS[Math.floor(this.rand() * CHEATS.length)]!(spec.functions[0]!, spec.allowedPaths);
      if (c.path) files.push({ path: c.path, content: c.body });
      else files.push({ path: cpp, content: unit(current, spec.functions.map((f, i) => (i === 0 ? { f, body: c.body } : { f, body: this.body(f, skill) }))) });
      return JSON.stringify({ files, notes: 'sim cheat' });
    }
    files.push({ path: cpp, content: unit(current, spec.functions.map((f) => ({ f, body: this.body(f, skill) }))) });
    return JSON.stringify({ files, notes: `sim attempt ${spec.attempt}` });
  }

  private body(f: SpecFn, skill: number): string {
    const sol = this.oracle?.solution(f.rva) ?? 'return 0;';
    if (this.rand() < skill) return `    ${sol}`;
    // near miss: right shape, wrong constant → partial byte credit in the fake comparator
    return `    ${sol.replace(/0x[0-9a-f]+/, (h) => `0x${(parseInt(h, 16) ^ 0x10).toString(16)}`)}`;
  }
}

function unit(current: string | null, parts: Array<{ f: SpecFn; body: string }>): string {
  const fns = parts.map(({ f, body }) => `int ${simIdent(f)}()\n{\n${body}\n}\n`);
  if (current && current.trim()) {
    let kept = current;
    for (const { f } of parts) kept = kept.replace(new RegExp(`int ${simIdent(f)}\\(\\)\\n\\{[\\s\\S]*?\\n\\}\\n?`, 'g'), '');
    return `${kept.replace(/\n*$/, '\n')}\n${fns.join('\n')}`;
  }
  const head = [
    '// Source exposure: public (community headers).',
    '// Code origin: original; simulated draft',
    ...parts.map(({ f }) => `// ${f.rva} ${f.name ?? 'Unknown'}`),
    '#include "Sim.h"',
    '',
  ];
  return [...head, ...fns].join('\n');
}

export const simIdent = (f: { rva: string; name: string | null }) => (f.name ?? `Fn_${f.rva}`).replace(/::/g, '_').replace(/[^A-Za-z0-9_]/g, '_');
