// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic trigger engine. Evaluated by the context builder for every attempt, locally and
// before any model call: no tool round-trips, no embeddings, same inputs → same selection.
//
// Cache safety is a property of the selection rule, not of the renderer:
//   * packet placement uses only packet-static inputs (listing, symbols, features, patterns), so a
//     packet's retries select the same packet skills and re-read the per-packet cache block;
//   * skills that only become eligible through the previous verdict's failure codes get the
//     "retry" placement, which the renderer puts in the volatile block after every breakpoint;
//   * the number of packet slots depends only on the run snapshot, never on the attempt.
import type { Difficulty, FunctionFeatures, SkillPlacement } from '@decomp/core';
import type { SkillTrigger, TriggerGroup } from './schemas.js';

export const GROUP_WEIGHT: Record<TriggerGroup, number> = { mnemonics: 3, failures: 2.5, symbols: 2, features: 1.5, patterns: 1 };

export interface MatchContext {
  taskId: string;
  difficulty: Difficulty;
  functions: Array<{ name: string | null; features: FunctionFeatures }>;
  /** Packet pattern tags (patternsOf + header-slice patterns). */
  patterns: string[];
  /** Function names, classes and identifiers the packet references. */
  symbols: string[];
  /** Target listing text, read locally (null when no pack exists). Never persisted. */
  listing: string | null;
  /** Previous verdict: failure categories, finding codes and comparator reasons (null on attempt 1). */
  failures: string[] | null;
}

export interface MatchableSkill {
  id: string;
  version: number;
  name: string;
  body: string;
  tokenCount: number;
  triggers: SkillTrigger;
  /** Measured pass-rate lift (breaks ties toward skills that demonstrably help). */
  lift?: number | null;
}

export interface MatchResult<S extends MatchableSkill = MatchableSkill> {
  skill: S;
  placement: SkillPlacement;
  /** Weighted score of packet-static groups only (ranks packet placement). */
  staticScore: number;
  /** Including failure codes (ranks retry placement). */
  score: number;
  matched: TriggerGroup[];
}

export interface SelectOptions {
  maxDynamic: number;
  holdoutRate: number;
  /** Reserve one of the maxDynamic slots for retry-placement skills (when the snapshot has any). */
  reserveRetrySlot: boolean;
  /** Shadow evaluation: always inject these (bypasses holdout and ranking). */
  force?: string[];
  /** Shadow evaluation baseline: never consider these. */
  suppress?: string[];
}

export interface Selection<S extends MatchableSkill = MatchableSkill> {
  injected: Array<MatchResult<S>>;
  heldOut: Array<MatchResult<S>>;
  eligible: Array<MatchResult<S>>;
}

const LISTING_CAP = 300_000;
/** Nested quantifiers and backreferences are the classic catastrophic-backtracking shapes. */
const UNSAFE = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]|\\[1-9]/;

export function regexProblem(src: string): string | null {
  if (src.length > 200) return 'longer than 200 characters';
  if (UNSAFE.test(src)) return 'nested quantifier or backreference (catastrophic backtracking risk)';
  try {
    new RegExp(src, 'im');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Deterministic [0,1) per (task, skill): FNV-1a. Retries of a packet land in the same group. */
export function holdoutDraw(taskId: string, skillId: string): number {
  let h = 0x811c9dc5;
  const s = `${taskId}|${skillId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

export class SkillMatcher {
  private compiled = new Map<string, RegExp | null>();

  private re(src: string): RegExp | null {
    let r = this.compiled.get(src);
    if (r === undefined) {
      r = regexProblem(src) ? null : new RegExp(src, 'im');
      this.compiled.set(src, r);
      if (this.compiled.size > 4_000) this.compiled.delete(this.compiled.keys().next().value!);
    }
    return r;
  }

  private anyRegex(list: string[], text: string | null): boolean {
    if (!text || !list.length) return false;
    const t = text.length > LISTING_CAP ? text.slice(0, LISTING_CAP) : text;
    return list.some((src) => this.re(src)?.test(t) ?? false);
  }

  /** Evaluate one skill; null when it is not eligible for this attempt. */
  evaluate<S extends MatchableSkill>(skill: S, ctx: MatchContext): MatchResult<S> | null {
    const t = skill.triggers;
    if (t.exclude.symbols.length && symbolHit(t.exclude.symbols, ctx.symbols)) return null;
    if (t.exclude.patterns.some((p) => ctx.patterns.includes(p))) return null;
    if (this.anyRegex(t.exclude.mnemonics, ctx.listing)) return null;

    const hit = new Set<TriggerGroup>();
    if (this.anyRegex(t.mnemonics, ctx.listing)) hit.add('mnemonics');
    if (t.symbols.length && symbolHit(t.symbols, ctx.symbols)) hit.add('symbols');
    if (hasFeatureConditions(t.features) && ctx.functions.some((f) => featuresMatch(t.features, f.features, f.name, ctx.difficulty))) hit.add('features');
    if (t.patterns.some((p) => ctx.patterns.includes(p))) hit.add('patterns');
    const failHit = !!ctx.failures?.length && t.failures.some((c) => ctx.failures!.some((f) => f.toLowerCase() === c.toLowerCase()));

    const staticScore = [...hit].reduce((s, g) => s + GROUP_WEIGHT[g], 0);
    const score = staticScore + (failHit ? GROUP_WEIGHT.failures : 0);
    const staticRequireOk = t.require.every((g) => hit.has(g));
    const fullRequireOk = t.require.every((g) => hit.has(g) || (g === 'failures' && failHit));
    let placement: SkillPlacement | null = null;
    if (staticScore > 0 && staticScore >= t.minScore && staticRequireOk) placement = 'packet';
    else if (failHit && score >= t.minScore && fullRequireOk) placement = 'retry';
    if (!placement) return null;
    const matched = [...hit, ...(failHit ? (['failures'] as TriggerGroup[]) : [])];
    return { skill, placement, staticScore, score, matched: matched.sort((a, b) => GROUP_WEIGHT[b] - GROUP_WEIGHT[a]) };
  }

  select<S extends MatchableSkill>(skills: S[], ctx: MatchContext, opts: SelectOptions): Selection<S> {
    const suppress = new Set(opts.suppress ?? []);
    const force = new Set(opts.force ?? []);
    const eligible: Array<MatchResult<S>> = [];
    for (const s of skills) {
      if (suppress.has(s.id)) continue;
      const r = this.evaluate(s, ctx);
      if (r) eligible.push(r);
      else if (force.has(s.id)) eligible.push({ skill: s, placement: 'packet', staticScore: 0, score: 0, matched: [] });
    }
    const bonus = (r: MatchResult<S>) => Math.max(-1, Math.min(1, (r.skill.lift ?? 0) * 4)) + r.matched.length * 0.05;
    const injected: Array<MatchResult<S>> = [];
    const heldOut: Array<MatchResult<S>> = [];
    for (const r of eligible) if (force.has(r.skill.id)) injected.push(r);

    const packetSlots = Math.max(0, opts.maxDynamic - (opts.reserveRetrySlot ? 1 : 0)) - injected.length;
    const packet = eligible
      .filter((r) => r.placement === 'packet' && !force.has(r.skill.id))
      .sort((a, b) => b.staticScore + bonus(b) - (a.staticScore + bonus(a)) || a.skill.id.localeCompare(b.skill.id));
    let used = 0;
    for (const r of packet) {
      if (used >= packetSlots) break;
      used++; // a held-out skill keeps its slot empty: a clean control group, and stable packet slots
      if (holdoutDraw(ctx.taskId, r.skill.id) < opts.holdoutRate) heldOut.push(r);
      else injected.push(r);
    }
    if (ctx.failures?.length) {
      const room = opts.maxDynamic - injected.length - heldOut.length;
      const retry = eligible
        .filter((r) => r.placement === 'retry' && !force.has(r.skill.id))
        .sort((a, b) => b.score + bonus(b) - (a.score + bonus(a)) || a.skill.id.localeCompare(b.skill.id));
      for (const r of retry.slice(0, Math.max(0, room))) {
        if (holdoutDraw(ctx.taskId, r.skill.id) < opts.holdoutRate) heldOut.push(r);
        else injected.push(r);
      }
    }
    return { injected, heldOut, eligible };
  }
}

function symbolHit(prefixes: string[], symbols: string[]): boolean {
  for (const sym of symbols) {
    for (const p of prefixes) {
      if (sym.startsWith(p)) return true;
      if (!p.includes('::') && sym.includes('::') && sym.split('::').some((seg) => seg.startsWith(p))) return true;
      if (p.endsWith('::') && sym.includes(`::${p}`)) return true;
    }
  }
  return false;
}

function hasFeatureConditions(f: SkillTrigger['features']): boolean {
  return Object.values(f).some((v) => v !== undefined && !(Array.isArray(v) && !v.length));
}

function featuresMatch(t: SkillTrigger['features'], f: FunctionFeatures, name: string | null, difficulty: Difficulty): boolean {
  const ge = (v: number | null | undefined, min: number | undefined) => min === undefined || (v ?? 0) >= min;
  if (!ge(f.condBranches, t.minBranches)) return false;
  if (!ge(f.backEdges, t.minLoops)) return false;
  if (!ge(f.indirectCalls, t.minIndirectCalls)) return false;
  if (!ge(f.indirectJumps, t.minIndirectJumps)) return false;
  if (!ge(f.sseOps, t.minSseOps)) return false;
  if (!ge(f.calls, t.minCalls)) return false;
  if (!ge(f.size, t.minSize)) return false;
  if (t.maxSize !== undefined && f.size > t.maxSize) return false;
  if (t.eh !== undefined && ((f.unwindEntries ?? 0) > 1) !== t.eh) return false;
  if (t.tailCall !== undefined && !!f.tailCall !== t.tailCall) return false;
  if (t.destructor !== undefined && /~/.test(name ?? '') !== t.destructor) return false;
  if (t.difficulties?.length && !t.difficulties.includes(difficulty)) return false;
  return true;
}

/** Human-readable one-liner of a trigger (UI and SKILL.md comments). */
export function describeTrigger(t: SkillTrigger): string {
  const parts: string[] = [];
  if (t.mnemonics.length) parts.push(`listing ~ ${t.mnemonics.map((m) => `/${m}/`).join(' | ')}`);
  if (t.symbols.length) parts.push(`symbols ${t.symbols.join(', ')}`);
  const f = Object.entries(t.features).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length));
  if (f.length) parts.push(`shape ${f.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(', ')}`);
  if (t.patterns.length) parts.push(`patterns ${t.patterns.join(', ')}`);
  if (t.failures.length) parts.push(`after ${t.failures.join(', ')}`);
  if (t.require.length) parts.push(`requires ${t.require.join('+')}`);
  const ex = [...t.exclude.symbols, ...t.exclude.patterns, ...t.exclude.mnemonics.map((m) => `/${m}/`)];
  if (ex.length) parts.push(`except ${ex.join(', ')}`);
  return parts.join(' · ') || 'never (no trigger)';
}
