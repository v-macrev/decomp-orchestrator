// SPDX-License-Identifier: AGPL-3.0-or-later
// Static complexity scoring. Pure and deterministic: the same features always give the same score,
// so routing decisions are reproducible and auditable (reasons list every contributor).
//
// Scale: points roughly track "independent things the model must get exactly right". Size-only
// estimates (no local pack yet) add the branch count expected for that size so both paths share
// one scale; the engine refines them from the pack after `prepare`.
import {
  DIFFICULTY_RANK, DIFFICULTIES,
  type ComplexityAssessment, type ComplexityThresholds, type Difficulty, type FunctionFeatures,
} from './schemas.js';

export const COMPLEXITY_VERSION = 1;

export interface Score {
  score: number;
  reasons: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function scoreFeatures(f: FunctionFeatures): Score {
  const parts: Array<[number, string]> = [];
  const add = (pts: number, why: string) => {
    if (pts > 0.05) parts.push([pts, why]);
  };
  add(f.size <= 24 ? 0 : 1.2 * Math.log2(f.size / 24), `${f.size} bytes`);
  if (f.source === 'size_only' || f.condBranches === null) {
    add(0.6 * Math.min(8, f.size / 45), `~${Math.round(f.size / 45)} branches expected for the size (no pack yet)`);
  } else {
    add(0.6 * Math.min(8, f.condBranches), `${f.condBranches} conditional branch(es)`);
    add(0.8 * Math.min(3, f.backEdges ?? 0), `${f.backEdges} loop(s)`);
    add(0.25 * Math.min(8, f.calls ?? 0), `${f.calls} direct call(s)`);
    add(0.6 * Math.min(4, f.indirectCalls ?? 0), `${f.indirectCalls} virtual/indirect call(s)`);
    add(0.8 * Math.min(2, f.indirectJumps ?? 0), `${f.indirectJumps} indirect jump(s) (switch / tail through vtable)`);
    if ((f.sseOps ?? 0) > 0) add(1 + 0.08 * Math.min(20, f.sseOps!), `${f.sseOps} SSE/float op(s)`);
    add(0.12 * Math.min(10, f.dataRefs ?? 0), `${f.dataRefs} global/constant reference(s)`);
  }
  if ((f.unwindEntries ?? 0) > 1) add(1.5, `${f.unwindEntries} unwind entries (EH funclets)`);
  add(0.9 * Math.min(3, f.priorFailures), `${f.priorFailures} failed attempt(s) in earlier runs`);
  add(f.nameConfidence === 'unnamed' ? 0.8 : f.nameConfidence === 'guess' ? 0.4 : 0, `name is ${f.nameConfidence}`);
  add(0.25 * Math.min(4, f.cautions), `${f.cautions} backlog caution(s)`);
  parts.sort((a, b) => b[0] - a[0]);
  const score = parts.reduce((s, [p]) => s + p, 0);
  return { score: r1(score), reasons: parts.map(([p, why]) => `${why} (+${r1(p)})`) };
}

export function classify(score: number, t: ComplexityThresholds): { difficulty: Difficulty; borderline: boolean } {
  const difficulty: Difficulty = score >= t.hard ? 'hard' : score >= t.medium ? 'medium' : 'easy';
  const borderline = Math.abs(score - t.medium) < t.borderlineBand || Math.abs(score - t.hard) < t.borderlineBand;
  return { difficulty, borderline };
}

/** A packet is as hard as its hardest function, plus a little for every extra function in it. */
export function assessPacket(fns: FunctionFeatures[], t: ComplexityThresholds): ComplexityAssessment {
  if (!fns.length) throw new Error('assessPacket: empty packet');
  const scored = fns.map((f) => ({ f, s: scoreFeatures(f) })).sort((a, b) => b.s.score - a.s.score);
  const top = scored[0]!;
  const extra = 0.35 * (fns.length - 1);
  const score = r1(top.s.score + extra);
  const reasons = [...top.s.reasons];
  if (extra > 0) reasons.push(`${fns.length - 1} more function(s) in the packet (+${r1(extra)})`);
  const { difficulty, borderline } = classify(score, t);
  return { difficulty, score, reasons, borderline, decidedBy: 'static', features: top.f, version: COMPLEXITY_VERSION };
}

export function promote(d: Difficulty): Difficulty {
  return DIFFICULTIES[Math.min(DIFFICULTIES.length - 1, DIFFICULTY_RANK[d] + 1)]!;
}

export function harder(a: Difficulty, b: Difficulty): Difficulty {
  return DIFFICULTY_RANK[a] >= DIFFICULTY_RANK[b] ? a : b;
}

export function sizeOnlyFeatures(size: number, extra: Partial<FunctionFeatures> = {}): FunctionFeatures {
  return {
    source: 'size_only', size, instructions: null, basicBlocks: null, condBranches: null, backEdges: null, calls: null,
    indirectCalls: null, indirectJumps: null, sseOps: null, dataRefs: null, xrefsIn: null, unwindEntries: null, tailCall: null,
    priorFailures: 0, nameConfidence: 'named', cautions: 0, ...extra,
  };
}

/** Code patterns used to pick matching lessons and run discoveries. */
export function patternsOf(f: FunctionFeatures, name: string | null): string[] {
  const p = new Set<string>();
  if ((f.sseOps ?? 0) > 0) p.add('sse');
  if ((f.indirectCalls ?? 0) > 0) p.add('vtable');
  if ((f.indirectJumps ?? 0) > 0) p.add('switch');
  if ((f.backEdges ?? 0) > 0) p.add('loop');
  if ((f.unwindEntries ?? 0) > 1) p.add('eh');
  if (f.tailCall) p.add('tailcall');
  if ((f.dataRefs ?? 0) > 0) p.add('globals');
  if ((f.calls ?? 0) > 0) p.add('calls');
  if (name && /~/.test(name)) p.add('destructor').add('eh');
  if (name && /::(?:operator|Get|Set|Is|Has)/.test(name) && f.size <= 32) p.add('accessor');
  if (f.size <= 16) p.add('tiny');
  return [...p].sort();
}
