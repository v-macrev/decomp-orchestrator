// SPDX-License-Identifier: AGPL-3.0-or-later
// What a packet has already tried. A retry used to see only the attempt right before it, so workers
// ping-ponged between two guesses for twenty attempts (A → B → A → B), each time "fixing" the
// previous one back into a candidate that had already failed. This module gives every retry:
//   - every distinct earlier candidate of the failing functions with its outcome, best first;
//   - the progress score per attempt (exact bytes, else bytes that align after shifting — the
//     repo's own diagnostic metric; a count only, never target content);
//   - a fingerprint of the code so an exact resubmission is refused before it reaches the compiler.
import { createHash } from 'node:crypto';
import type { Attempt, Verdict } from '@decomp/core';
import type { Store, TaskRow } from '../db/store.js';
import { extractFunctions, lex } from '../gatekeeper/cpp.js';
import { clipToTokens, estimateTokens } from '../util/tokens.js';
import { failureCategory } from './lessons.js';

export interface HistoryEntry {
  n: number;
  model: string | null;
  accountId: string | null;
  category: string;
  /** Exact bytes, or aligned bytes when nothing matched in place; null without byte evidence. */
  score: number | null;
  outcome: string;
  /** Hash of the code with comments and whitespace removed: the same code scores the same. */
  fingerprint: string | null;
  /** The code was judged by the compiler (compiled and compared, or failed to compile). */
  judged: boolean;
  /** Bodies of the packet's functions in this candidate, keyed by function name. */
  bodies: Map<string, string>;
  /** Hash of the candidate's compiled code per function name (from the comparator), when it compiled. */
  machine: Map<string, string>;
  /** First mismatch offsets of the failing functions ('+0x0' = the very first instruction differs). */
  firstMismatches: string[];
}

const flat = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Remove comments (strings kept: include paths are code) and collapse whitespace. */
export function stripForCompare(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/("(?:[^"\\\n]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sourceFingerprint(files: Array<{ path: string; content: string }>): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) h.update(f.path).update('\0').update(stripForCompare(f.content)).update('\0');
  return h.digest('hex');
}

/** Progress of a verdict: target size for passes, else max(exact, aligned) per function. */
export function progressScore(v: Pick<Verdict, 'compare'>): number | null {
  if (!v.compare?.length) return null;
  return v.compare.reduce((s, c) => s + (c.result === 'pass' ? (c.targetSize ?? c.totalBytes ?? 0) : Math.max(c.exactBytes ?? 0, c.alignedBytes ?? 0)), 0);
}

function outcomeOf(v: Verdict): string {
  const blocks = v.findings.filter((f) => f.severity === 'block');
  if (v.compare?.length) {
    return v.compare.map((c) => {
      if (c.result === 'pass') return `${c.name ?? c.rva} matched`;
      const size = c.candidateSize != null ? `${c.candidateSize} B (target ${c.targetSize ?? '?'})` : `target ${c.targetSize ?? '?'} B`;
      const aligned = c.alignedBytes != null ? `, ${c.alignedBytes} aligned` : '';
      return `${size}, ${c.exactBytes ?? 0} exact${aligned}${c.firstMismatch ? `, first mismatch ${c.firstMismatch}` : ''}`;
    }).join('; ');
  }
  const compile = blocks.find((f) => f.code === 'COMPARE_COMPILE_ERROR');
  if (compile) {
    const first = compile.message.split('\n').map((l) => l.trim()).find((l) => /error/i.test(l) && !l.startsWith('candidate failed'));
    return `did not compile${first ? `: ${first.slice(0, 220)}` : ''}`;
  }
  return blocks.slice(0, 2).map((f) => `[${f.code}] ${f.message.split('\n')[0]!.slice(0, 160)}`).join('; ') || v.decision;
}

function bodiesOf(attempt: Attempt, names: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of attempt.files ?? []) {
    if (!file.path.endsWith('.cpp')) continue;
    for (const d of extractFunctions(lex(file.content).code)) {
      if (!names.has(d.name) && !names.has(flat(d.name))) continue;
      out.set(d.name, file.content.slice(d.start, d.close + 1).trim());
    }
  }
  return out;
}

/** Every earlier attempt of this packet that reached a verdict (infra failures excluded), oldest first. */
export function buildHistory(store: Store, task: TaskRow): HistoryEntry[] {
  const verdicts = new Map(store.verdictsForTask(task.id).map((v) => [v.attemptId, v]));
  const names = new Set(task.functions.flatMap((f) => (f.name ? [f.name, flat(f.name)] : [])));
  const out: HistoryEntry[] = [];
  for (const a of store.attemptsForTask(task.id)) {
    const v = verdicts.get(a.id);
    if (!v || v.findings.some((f) => f.code.startsWith('INFRA'))) continue;
    const judged = !!v.compare?.length || v.findings.some((f) => f.code === 'COMPARE_COMPILE_ERROR');
    out.push({
      n: a.n, model: a.model, accountId: a.accountId,
      category: v.decision === 'pass' ? 'PASS' : failureCategory(v.findings.find((f) => f.severity === 'block')?.code ?? 'OTHER'),
      score: progressScore(v), outcome: outcomeOf(v),
      fingerprint: a.files?.length ? sourceFingerprint(a.files) : null, judged,
      bodies: bodiesOf(a, names),
      machine: new Map((v.compare ?? []).filter((c) => c.codeSha256 && c.name).map((c) => [c.name!, c.codeSha256!])),
      firstMismatches: (v.compare ?? []).filter((c) => c.result !== 'pass' && c.firstMismatch).map((c) => c.firstMismatch!),
    });
  }
  return out;
}

/** The earlier candidate with exactly this code that the compiler already judged, if any. */
export function findRepeat(history: HistoryEntry[], files: Array<{ path: string; content: string }>): HistoryEntry | null {
  const fp = sourceFingerprint(files);
  return [...history].reverse().find((h) => h.judged && h.fingerprint === fp) ?? null;
}

/** Best score so far (null when no attempt produced byte evidence). */
export function bestScore(history: HistoryEntry[]): { score: number; n: number } | null {
  let best: { score: number; n: number } | null = null;
  for (const h of history) if (h.score !== null && (!best || h.score > best.score)) best = { score: h.score, n: h.n };
  return best;
}

/**
 * The <history> block: distinct candidates of the still-failing functions, best first, so the
 * worker can see the whole search so far, start from the closest one and never resubmit a loser.
 */
export function renderHistory(history: HistoryEntry[], failing: string[], maxTokens: number): string {
  const last = history[history.length - 1];
  if (history.length < 2 || !last) return '';
  const wanted = new Set(failing.flatMap((n) => [n, flat(n)]));
  // Group attempts by the machine code the failing functions compiled to when the comparator gave
  // its hash (renaming a constant changes nothing), else by their source (comments and spacing ignored).
  const groups = new Map<string, { entries: HistoryEntry[]; body: string; sources: Set<string> }>();
  for (const h of history) {
    const pick = <T>(m: Map<string, T>) => [...m].filter(([n]) => wanted.has(n) || wanted.has(flat(n))).map(([, x]) => x);
    const body = pick(h.bodies).join('\n\n');
    const machine = pick(h.machine);
    const src = body ? stripForCompare(body) : `#${h.n}`;
    const key = machine.length && machine.length === failing.length ? `m:${machine.join(',')}` : `s:${src}`;
    const g = groups.get(key) ?? { entries: [], body, sources: new Set<string>() };
    g.entries.push(h);
    g.sources.add(src);
    groups.set(key, g);
  }
  const best = bestScore(history);
  const top = (g: { entries: HistoryEntry[] }) => Math.max(...g.entries.map((e) => e.score ?? -1));
  const ordered = [...groups.values()].sort((a, b) => top(b) - top(a) || Math.max(...b.entries.map((e) => e.n)) - Math.max(...a.entries.map((e) => e.n)));

  const head: string[] = [`<history attempts="${history.length}" distinct="${groups.size}" note="every earlier attempt at this packet, best first; comments and spacing do not count as a change">`];
  if (best && best.score > 0) {
    const lastScore = last.score;
    head.push(`Progress score = bytes exact, or bytes that align with the target when nothing matches in place. Best so far: ${best.score} (attempt #${best.n}).${lastScore !== null && best.n !== last.n && lastScore < best.score ? ` Your last attempt scored ${lastScore}: it went backwards, so start again from #${best.n}, not from the last attempt.` : ''}`);
  } else if (best) {
    head.push('No candidate has matched or aligned a single byte yet: small edits to these ideas are not converging, so rethink the structure.');
  } else {
    head.push('No attempt has produced byte evidence yet (none compiled and compared).');
  }
  const compared = history.filter((h) => h.firstMismatches.length);
  if (compared.length >= 3 && compared.every((h) => h.firstMismatches.every((m) => /^\+0x0+$/.test(m)))) {
    head.push(`Every compared attempt (${compared.length}) differs at the very first instruction: what the function does first (the first field read, test or call) is wrong in all of them, so change that rather than what follows.`);
  }
  head.push('Resubmitting code identical to any attempt below is refused without compiling. Change the logic, not only names or comments.');
  const lines = [...head];
  let used = estimateTokens(head.join('\n'));
  let shown = 0;
  for (const g of ordered) {
    const ns = g.entries.map((e) => `#${e.n}`).join(', ');
    const e = g.entries[g.entries.length - 1]!;
    const isLast = g.entries.some((x) => x.n === last.n);
    const same = g.entries.length < 2 ? '' : g.sources.size > 1 ? ` (${g.sources.size} different sources, identical machine code: cosmetic changes)` : ' (same code)';
    const label = `- ${ns}${same}${e.model ? ` · ${e.model}` : ''} · ${e.outcome}${isLast ? ' · last attempt, code shown in <retry>' : ''}`;
    const body = !isLast && g.body ? clipToTokens(g.body, 140).text : '';
    const block = body ? `${label}\n${body}` : label;
    const t = estimateTokens(block) + 1;
    if (used + t > maxTokens - 30) {
      if (used + estimateTokens(label) + 1 <= maxTokens - 30) {
        lines.push(label);
        used += estimateTokens(label) + 1;
        shown++;
        continue;
      }
      break;
    }
    lines.push(block);
    used += t;
    shown++;
  }
  if (shown < ordered.length) lines.push(`- … ${ordered.length - shown} more distinct candidate(s), none better than those above.`);
  lines.push('</history>');
  return lines.join('\n');
}
