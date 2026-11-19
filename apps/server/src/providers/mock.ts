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
import { createHash } from 'node:crypto';
import type { Account, Difficulty, Usage } from '@decomp/core';
import { sleep } from '../util/async.js';
import { estimateTokens } from '../util/tokens.js';
import { ProviderError, type CompletionRequest, type CompletionResponse, type ProviderAdapter } from './types.js';

/** Default P(match per attempt) by model capability × packet difficulty (simulator only). */
export const SKILL_MATRIX: Record<string, Record<Difficulty, number>> = {
  fast: { easy: 0.82, medium: 0.42, hard: 0.12 },
  balanced: { easy: 0.9, medium: 0.68, hard: 0.32 },
  frontier: { easy: 0.94, medium: 0.84, hard: 0.6 },
};

/**
 * Prompt-cache simulator with Anthropic semantics: a breakpoint caches the exact prefix up to it,
 * per account+model, 5-minute TTL refreshed on hit; a request reads the longest cached breakpoint
 * prefix and writes the rest up to its last breakpoint. Legacy prompts cache only the system prompt.
 */
export class PromptCacheSim {
  private entries = new Map<string, number>();
  constructor(private ttlMs = 5 * 60_000, private minTokens = 512) {}

  usage(scope: string, req: CompletionRequest, now: number): Omit<Usage, 'outputTokens'> & { outputTokens: number } {
    const segments = [{ text: req.system, cache: true }, ...(req.blocks ?? [{ text: req.prompt, cache: false }])];
    const total = segments.reduce((s, x) => s + estimateTokens(x.text), 0);
    const h = createHash('sha256').update(scope);
    let tokens = 0;
    let read = 0;
    let lastBp = 0;
    let missed = false;
    for (const seg of segments) {
      h.update('\0').update(seg.text);
      tokens += estimateTokens(seg.text);
      if (!seg.cache || tokens < this.minTokens) continue;
      const key = h.copy().digest('hex');
      const exp = this.entries.get(key);
      if (!missed && exp !== undefined && exp > now) read = tokens;
      else missed = true;
      this.entries.set(key, now + this.ttlMs);
      lastBp = tokens;
    }
    if (this.entries.size > 50_000) for (const [k, e] of this.entries) if (e <= now) this.entries.delete(k);
    return { inputTokens: total, cacheReadTokens: read, cacheWriteTokens: Math.max(0, lastBp - read), outputTokens: 0 };
  }
}

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
  private cache = new PromptCacheSim();

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
    const usage = this.cache.usage(`${account.id}/${req.model.id}`, req, now);
    return { text, stopReason: 'end_turn', servedModel: req.model.id, usage: { ...usage, outputTokens: estimateTokens(text) + 120 } };
  }

  /** Build a WorkerOutput JSON from the machine-readable TASK_SPEC block every worker prompt carries. */
  private answer(req: CompletionRequest, o: Record<string, any>): string {
    const batch = req.prompt.match(/<complexity_batch>\s*([\s\S]*?)\s*<\/complexity_batch>/);
    if (batch) {
      // Tie-break: settle on the static score with a deterministic nudge (a stand-in for model judgement).
      const items = JSON.parse(batch[1]!) as Array<{ id: string; staticScore: number; sseOps?: number | null; indirectCalls?: number | null }>;
      return JSON.stringify({ items: items.map((it) => ({ id: it.id, difficulty: it.staticScore + ((it.sseOps ?? 0) > 0 ? 0.6 : 0) + ((it.indirectCalls ?? 0) > 1 ? 0.4 : 0) >= 5.5 ? 'hard' : it.staticScore >= 2.5 ? 'medium' : 'easy' })) });
    }
    const m = req.prompt.match(/<task_spec>\s*([\s\S]*?)\s*<\/task_spec>/);
    if (!m) return '{"files": []}';
    const spec = JSON.parse(m[1]!) as { allowedPaths: string[]; functions: SpecFn[]; attempt?: number; difficulty?: Difficulty; outputMode?: 'files' | 'edits' | 'either' };
    const attempt = Number(/<attempt n="(\d+)"\/>/.exec(req.prompt)?.[1] ?? spec.attempt ?? 1);
    const cpp = spec.allowedPaths.find((p) => p.endsWith('.cpp')) ?? spec.allowedPaths[0]!;
    // Capability-aware skill: a model's chance of matching depends on difficulty vs its tier. Without
    // a declared capability (or difficulty) the account's flat `skill` option applies (old behaviour).
    const cap = req.model.capability;
    const matrix = (o.skillMatrix as Record<string, Record<string, number>> | undefined) ?? SKILL_MATRIX;
    const base = cap && spec.difficulty ? matrix[cap]?.[spec.difficulty] ?? (o.skill ?? 0.6) : (o.skill ?? 0.6);
    const skill = Math.min(0.97, base + 0.08 * Math.max(0, attempt - 1));
    const edits = spec.outputMode === 'edits' || (spec.outputMode === 'either' && this.rand() < (o.editRate ?? 0.7));
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
    if (edits) {
      const functions = spec.functions.map((f) => ({ name: simIdent(f), code: `int ${simIdent(f)}()\n{\n${this.body(f, skill)}\n}` }));
      const header = current && current.trim() ? undefined : ['// Source exposure: public (community headers).', '// Code origin: original; simulated draft', ...spec.functions.map((f) => `// ${f.rva} ${f.name ?? 'Unknown'}`)].join('\n');
      return JSON.stringify({ edits: [{ path: cpp, ...(header ? { header, declarations: '#include "Sim.h"' } : {}), functions }], notes: `sim attempt ${attempt} (edits)` });
    }
    files.push({ path: cpp, content: unit(current, spec.functions.map((f) => ({ f, body: this.body(f, skill) }))) });
    return JSON.stringify({ files, notes: `sim attempt ${attempt}` });
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
