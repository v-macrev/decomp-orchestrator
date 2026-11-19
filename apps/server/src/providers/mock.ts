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
import { compressSkillBody } from '@decomp/skills';
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
  /** Ground-truth difficulty of a function (independent of what any prompt claims). */
  difficulty?(rva: string, size: number): Difficulty;
  /** Ground-truth matching trap (simulator): what guidance must say for the function to be matchable. */
  trapInfo?(rva: string, size: number): { id: string; title: string; signature: string | null; fix: RegExp; fixText: string } | null;
}

/**
 * Guidance the worker was given, as separate chunks: each core skill (static prefix) and each
 * dynamic/retry skill body. The mock scores traps against these exactly as a real model would
 * benefit from them: only text that states the fix helps.
 */
function guidanceChunks(req: CompletionRequest): { core: string[]; dynamic: string[] } {
  const core = (/<core_skills[^>]*>([\s\S]*?)<\/core_skills>/.exec(req.system)?.[1] ?? '').split(/\n(?=## )/).filter((c) => c.trim());
  const dynamic = [...req.prompt.matchAll(/<skill id="[^"]*"[^>]*>([\s\S]*?)<\/skill>/g)].map((m) => m[1]!);
  return { core, dynamic };
}

const RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };
/** The simulator's over-generalised mined lesson (see curatorAnswer): wrong for every trap-less function. */
const MISLEADING = /into locals in the order the target loads them/;

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
    const curator = this.curatorAnswer(req);
    if (curator !== null) return curator;
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
    // Ground truth decides, never the prompt: the router's estimate may be wrong, and legacy prompts
    // carry no difficulty at all — benchmarks must not change the model's odds by changing the prompt.
    const truth = this.oracle?.difficulty
      ? spec.functions.map((f) => this.oracle!.difficulty!(f.rva, f.size)).reduce<Difficulty>((m, d) => (RANK[d] > RANK[m] ? d : m), 'easy')
      : spec.difficulty;
    const base = cap && truth ? matrix[cap]?.[truth] ?? (o.skill ?? 0.6) : (o.skill ?? 0.6);
    const packetSkill = Math.min(0.97, base + 0.08 * Math.max(0, attempt - 1));
    // Traps (simulator): a trapped function is far harder unless some guidance states its fix; each
    // injected skill that does not help this function costs a little attention.
    const { core, dynamic } = guidanceChunks(req);
    const odds = (f: SpecFn) => {
      const trap = this.oracle?.trapInfo?.(f.rva, f.size) ?? null;
      const helps = (g: string) => !!trap && trap.fix.test(g);
      // Plausible-but-wrong advice (a lesson over-fitted to lucky retries) actively misleads.
      const distract = dynamic.filter((g) => !helps(g)).reduce((acc, g) => acc + (MISLEADING.test(g) ? 0.12 : 0.03), 0);
      if (!trap) return Math.max(0.02, packetSkill - distract);
      const fixed = core.some(helps) || dynamic.some(helps);
      return Math.max(0.02, Math.min(0.97, fixed ? packetSkill + 0.05 : packetSkill * 0.5) - distract);
    };
    const skill = packetSkill;
    const edits = spec.outputMode === 'edits' || (spec.outputMode === 'either' && this.rand() < (o.editRate ?? 0.7));
    // Like a well-behaved model: start from the current unit shown in the prompt and keep everything
    // that is not one of this packet's functions (previously accepted bodies must survive).
    const esc = cpp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const current = new RegExp(`<unit title="Current ${esc}"[^>]*>\\n([\\s\\S]*?)\\n</unit>`).exec(req.prompt)?.[1] ?? null;
    const files: Array<{ path: string; content: string }> = [];
    if (this.rand() < (o.cheatRate ?? 0)) {
      const c = CHEATS[Math.floor(this.rand() * CHEATS.length)]!(spec.functions[0]!, spec.allowedPaths);
      if (c.path) files.push({ path: c.path, content: c.body });
      else files.push({ path: cpp, content: unit(current, spec.functions.map((f, i) => (i === 0 ? { f, body: c.body } : { f, body: this.body(f, odds(f)) }))) });
      return JSON.stringify({ files, notes: 'sim cheat' });
    }
    if (edits) {
      const functions = spec.functions.map((f) => ({ name: simIdent(f), code: `int ${simIdent(f)}()\n{\n${this.body(f, odds(f))}\n}` }));
      const header = current && current.trim() ? undefined : ['// Source exposure: public (community headers).', '// Code origin: original; simulated draft', ...spec.functions.map((f) => `// ${f.rva} ${f.name ?? 'Unknown'}`)].join('\n');
      const decls = [...(header ? ['#include "Sim.h"'] : []), ...helperDecls(spec.functions)].join('\n');
      return JSON.stringify({ edits: [{ path: cpp, ...(header ? { header } : {}), ...(decls ? { declarations: decls } : {}), functions }], notes: `sim attempt ${attempt} (edits)` });
    }
    files.push({ path: cpp, content: unit(current, spec.functions.map((f) => ({ f, body: this.body(f, odds(f)) }))) });
    void skill;
    return JSON.stringify({ files, notes: `sim attempt ${attempt}` });
  }

  /**
   * Stand-in for the curator's frontier model. It answers from ground truth the way a capable model
   * would answer from the diffs: it recognises a trap when at least two retry wins share it. It also
   * proposes one over-broad "lesson" from trap-less wins, so the shadow gate has something to reject.
   */
  private curatorAnswer(req: CompletionRequest): string | null {
    const block = (tag: string) => {
      const m = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(req.prompt);
      return m ? JSON.parse(m[1]!) : null;
    };
    const mining = block('skill_mining') as { wins: Array<{ id: string; functions: SpecFn[] }>; existingSkills: string[]; maxSkills?: number } | null;
    if (mining) {
      const known = new Set(mining.existingSkills.map((n) => n.toLowerCase()));
      const byTrap = new Map<string, { info: NonNullable<ReturnType<NonNullable<SimOracle['trapInfo']>>>; ids: string[] }>();
      const plain: string[] = [];
      for (const w of mining.wins) {
        const info = w.functions.map((f) => this.oracle?.trapInfo?.(f.rva, f.size) ?? null).find((x) => x) ?? null;
        if (!info) {
          plain.push(w.id);
          continue;
        }
        const g = byTrap.get(info.id) ?? { info, ids: [] };
        g.ids.push(w.id);
        byTrap.set(info.id, g);
      }
      const skills: unknown[] = [];
      for (const { info, ids } of byTrap.values()) {
        if (ids.length < 2 || known.has(info.title.toLowerCase())) continue;
        skills.push({
          name: info.title,
          description: `Recognised in ${ids.length} retry wins that share this listing signature.`,
          body: `**${info.title}.**\nSymptom: first attempts reproduce the logic but miss this shape, and the comparator reports a byte mismatch around it.\nFix: ${info.fixText}`,
          triggers: info.signature ? { mnemonics: [info.signature], minScore: 3 } : { patterns: ['vtable'], features: { minIndirectCalls: 1 }, minScore: 2.5 },
          rationale: `${ids.length} wins: the passing diff applies this fix, the failed diff did not`,
          winIds: ids,
        });
      }
      if (plain.length >= 3 && !known.has('keep call arguments in source order')) {
        skills.push({
          name: 'Keep call arguments in source order',
          description: 'Several retries passed after reordering statements.',
          body: '**Keep call arguments in source order.**\nSymptom: argument setup order differs at a call. Fix: evaluate arguments into locals in the order the target loads them, then make the call; keep stores in source order.',
          triggers: { patterns: ['calls'], minScore: 1 },
          rationale: `${plain.length} wins changed statement order`,
          winIds: plain.slice(0, 6),
        });
      }
      return JSON.stringify({ skills: skills.slice(0, mining.maxSkills ?? 4) });
    }
    const patch = block('skill_patch') as { skill: { body: string; triggers: Record<string, any> }; failing: Array<{ functions: SpecFn[] }>; passing: Array<{ functions: SpecFn[] }> } | null;
    if (patch) {
      const traps = new Map<string, { info: NonNullable<ReturnType<NonNullable<SimOracle['trapInfo']>>>; n: number }>();
      for (const f of patch.failing.flatMap((x) => x.functions)) {
        const info = this.oracle?.trapInfo?.(f.rva, f.size);
        if (!info || info.fix.test(patch.skill.body)) continue;
        traps.set(info.id, { info, n: (traps.get(info.id)?.n ?? 0) + 1 });
      }
      const top = [...traps.values()].sort((a, b) => b.n - a.n)[0];
      if (top && top.n >= Math.max(2, Math.ceil(patch.failing.length / 3))) {
        const mn = new Set<string>([...(patch.skill.triggers.mnemonics ?? []), ...(top.info.signature ? [top.info.signature] : [])]);
        return JSON.stringify({ action: 'add_rule', body: `${patch.skill.body.trim()}\nAlso: ${top.info.fixText}`, triggers: { ...patch.skill.triggers, mnemonics: [...mn] }, rationale: `${top.n} failing packets share an unaddressed shape (${top.info.title})` });
      }
      if ((patch.skill.triggers.mnemonics ?? []).length && !(patch.skill.triggers.require ?? []).includes('mnemonics')) {
        return JSON.stringify({ action: 'tighten', triggers: { ...patch.skill.triggers, require: ['mnemonics'] }, rationale: 'failures fire without the listing signature: require it' });
      }
      return JSON.stringify({ action: 'none', rationale: 'no shared root cause the skill can address' });
    }
    const compress = block('skill_compress') as { body: string; targetTokens: number } | null;
    if (compress) return JSON.stringify({ body: compressSkillBody(compress.body, { target: compress.targetTokens }).body });
    if (block('pr_corrections') || block('recipe_triggers')) return JSON.stringify({ skills: [] });
    return null;
  }

  private body(f: SpecFn, skill: number): string {
    const sol = this.oracle?.solution(f.rva) ?? 'return 0;';
    if (this.rand() < skill) return `    ${sol}`;
    // near miss: right shape, wrong constant → partial byte credit in the fake comparator
    return `    ${sol.replace(/0x[0-9a-f]+/, (h) => `0x${(parseInt(h, 16) ^ 0x10).toString(16)}`)}`;
  }
}

/**
 * Callee declarations a real draft would carry: methods of the class's base (the sim header's
 * Class<5k> groups). Harmless to the fake comparator; once a packet passes they become verified
 * run knowledge that packets of sibling classes are offered.
 */
function helperDecls(fns: SpecFn[]): string[] {
  const out = new Set<string>();
  for (const f of fns) {
    const m = /^Class(\d+)::Method(\d+)$/.exec(f.name ?? '');
    if (!m) continue;
    const n = Number(m[1]);
    const base = n % 5 === 0 ? 'BaseForm' : `Class${n - (n % 5)}`;
    out.add(`std::uint32_t ${base}::Helper${Number(m[2]) % 6}() const;`);
  }
  return [...out];
}

function unit(current: string | null, parts: Array<{ f: SpecFn; body: string }>): string {
  const fns = parts.map(({ f, body }) => `int ${simIdent(f)}()\n{\n${body}\n}\n`);
  const decls = helperDecls(parts.map((p) => p.f));
  if (decls.length) fns.unshift(`${decls.join('\n')}\n`);
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
