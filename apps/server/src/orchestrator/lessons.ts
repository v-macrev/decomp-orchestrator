// SPDX-License-Identifier: AGPL-3.0-or-later
// Lessons = short, deterministic guidance lines fed into every Task Context Bundle:
//   1. the repo's own distilled lessons (docs/contributor-lessons.md bullets);
//   2. PR review history: reason codes the project's bot posted on past PRs, counted and mapped to
//      guidance (comment text is untrusted — only codes matching a strict pattern are kept);
//   3. this run's own most frequent Gate Keeper rejections ("common pitfalls").
import { createHash } from 'node:crypto';
import type { Verdict } from '@decomp/core';
import type { Store } from '../db/store.js';
import type { RepoAdapter } from '../repo/types.js';
import { runBounded } from '../util/proc.js';
import { tagText } from '../intel/ruleDistiller.js';

/** Guidance for Gate Keeper / comparator finding codes (also used to explain repo reason codes). */
export const FINDING_GUIDANCE: Record<string, string> = {
  CHEAT_STUB: 'Never return a constant or leave a body empty for a non-trivial target; reconstruct the real logic.',
  CHEAT_BYTE_ARRAY: 'Do not embed byte arrays; declare fields and write expressions.',
  CHEAT_ABS_ADDRESS: 'Never cast absolute addresses; declare the callee or global and let compare bind it.',
  CHEAT_PRAGMA: 'Only `#pragma once` is allowed.',
  CHEAT_INLINE_ASM: 'No inline assembly, __emit or naked functions.',
  CHEAT_MATCHED_BODY_MODIFIED: 'Keep previously accepted function bodies byte-for-byte; add new functions alongside them.',
  CHEAT_MATCHED_BODY_REMOVED: 'Return the whole unit including every previously accepted function.',
  LEAK_DECOMPILER_IDENT: 'Do not copy pseudo-C identifiers (param_1, local_28, iVar1, FUN_...); use meaningful names.',
  LEAK_INCLUDE_OUTSIDE_ROOTS: 'Include own header as "X.h" and shared headers by reconstruction-root path ("area/Y.h"); only the standard headers the message lists are allowed, declare anything else yourself.',
  CONV_HEADER_TOO_LONG: 'Header: one line per key (Source exposure, Code origin, Adapted bodies, SPDX) plus one 0x<rva> line per compared function; replace placeholders instead of adding lines; no Task/Recipe/disclaimer lines ("Drafted by" is written for you).',
  CONV_STATIC_ASSERT_NO_MESSAGE: 'Every static_assert needs a message.',
  CONV_ORIGIN_PLACEHOLDER: 'Replace the SKELETON_TODO line (and its wrapped second line) with "// Code origin: <how you wrote it>" and "// Adapted bodies: none" (or the adapted bodies) — do not add a second line below it.',
  PREFLIGHT_PROBLEM: 'This is the repository preflight (the same check a pull request must pass). Its message names the file, the line and the exact fix after "fix:": apply that fix there and keep the rest of the header as it is.',
  PREFLIGHT_PREEXISTING: 'Your functions match; the preflight blocks on a line that was already in the file. Change that line only if no other function in the unit needs it (an include another body uses must stay); otherwise return the same functions unchanged and the packet is set aside, matched, until the line is fixed.',
  SCOPE_LINE_TOO_LONG: 'Keep every line under 200 characters; state origin and adaptation in short header lines.',
  COMPARE_FUNCTION_SIZE_MISMATCH: 'The candidate compiles to a different size: compare branch structure, inlined helpers and return paths with the target before changing details.',
  COMPARE_FUNCTION_SYMBOL_MISSING: "The compiled object has no function with the target's decorated name, so nothing was compared: declare and define it exactly as the unit header and the task signature say (class, name, parameter types, const, virtual), out of line in the .cpp, not inline, static or in an anonymous namespace.",
  COMPARE_COMPILE_ERROR: "Fix exactly the compiler errors listed. Declare every type and callee you use; include only the unit's own header (\"X.h\") and the allowed standard headers: the compiler searches only the unit's directory, and the repository preflight rejects \"../\" (include-outside-roots), so declare any other type or callee you need in the unit's own .h, marked STANDIN. To change a line of the .h (an #include, a member), return the complete .h in \"files\"; that is allowed even in edits mode.",
  COMPARE_CODE_BYTE_MISMATCH: 'Same size, different code: the shape is close. Check operand types and widths, field offsets, comparison direction and which value is tested first; keep the size.',
  REPEATED_CANDIDATE: 'This exact code already failed (see <history>). Try a structurally different reconstruction.',
  COMPARE_SYMBOL_MISSING: 'Define the function with exactly the declared signature so it binds to its symbol.',
  OUTPUT_PARSE: 'Return only the JSON object described in the output contract.',
};

/** Coarse failure category of a finding code (retry delta headline, skill triggers, failure clusters). */
const CATEGORY: Array<[RegExp, string]> = [
  [/^COMPARE_COMPILE_ERROR$/, 'COMPILE_ERROR'],
  [/^(CHEAT|LEAK|SCOPE|INTEGRITY)_/, 'ANTI_CHEAT_VIOLATION'],
  [/^COMPARE_/, 'BYTE_MISMATCH'],
  [/^(PREFLIGHT|CONV)_/, 'PREFLIGHT_LINT'],
  [/^(OUTPUT|PROVIDER)_/, 'OUTPUT_CONTRACT'],
  [/^REVIEW_/, 'REVIEW_BLOCK'],
];
export function failureCategory(code: string): string {
  return CATEGORY.find(([re]) => re.test(code))?.[1] ?? 'OTHER';
}

/**
 * Everything a verdict says about why it failed, as trigger keys: categories, finding codes and the
 * comparator's per-function reasons (code-mismatch, function-size-mismatch, symbol-missing, ...).
 */
export function failureSignals(v: Verdict | null | undefined): string[] {
  if (!v || v.decision === 'pass') return [];
  const blocks = v.findings.filter((f) => f.severity === 'block');
  const out = new Set<string>();
  for (const f of blocks) {
    out.add(f.code);
    out.add(failureCategory(f.code));
  }
  for (const c of v.compare ?? []) if (c.result !== 'pass' && c.reason) out.add(c.reason);
  return [...out];
}

/** First blocking finding's (category, code): the key failure clusters are grouped by. */
export function primaryFailure(v: Verdict): { category: string | null; code: string | null } {
  if (v.decision === 'pass') return { category: null, code: null };
  const f = v.findings.find((x) => x.severity === 'block');
  const reason = (v.compare ?? []).find((c) => c.result !== 'pass')?.reason;
  const code = f?.code === 'COMPARE_MISMATCH' && reason ? reason : f?.code ?? reason ?? null;
  return { category: f ? failureCategory(f.code) : reason ? 'BYTE_MISMATCH' : null, code };
}

export async function seedRepoLessons(store: Store, repo: RepoAdapter) {
  const docs = await repo.docs();
  const lessons = docs.find((d) => d.id === 'contributor-lessons');
  if (!lessons) return 0;
  let n = 0;
  for (const line of lessons.content.split('\n')) {
    const m = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!m) continue;
    const text = m[1]!.replace(/\s*\(docs\/[^)]*\)\s*$/, '').trim();
    if (text.length < 12) continue;
    store.upsertLesson({ id: `repo:${hash(text)}`, source: 'repo-docs', topic: 'contributor-lessons', text, weight: 10, tags: tagText(text) });
    n++;
  }
  return n;
}

/**
 * Pull reason codes from the project bot's PR comments via the GitHub CLI (uses the operator's own
 * `gh` login). Only `reason`/`code` tokens of a strict shape survive; free text is discarded.
 */
export async function ingestGithubReviews(store: Store, opts: { repoSlug: string; pages?: number; cwd: string }): Promise<{ codes: number; comments: number }> {
  const counts = new Map<string, number>();
  let comments = 0;
  for (let page = 1; page <= (opts.pages ?? 5); page++) {
    const r = await runBounded('gh', ['api', `repos/${opts.repoSlug}/issues/comments?per_page=100&sort=created&direction=desc&page=${page}`], {
      cwd: opts.cwd, timeoutMs: 60_000, inheritEnv: true, maxOutputBytes: 32 * 1024 * 1024,
    });
    if (r.code !== 0) break;
    const items = JSON.parse(r.stdout) as Array<{ body?: string; user?: { type?: string; login?: string } }>;
    if (!items.length) break;
    for (const c of items) {
      if (c.user?.type !== 'Bot' && !/bot/i.test(c.user?.login ?? '')) continue;
      comments++;
      for (const m of (c.body ?? '').matchAll(/(?:reason(?:[ _]code)?|code)\s*[:=`]+\s*`?([a-z][a-z0-9-]{2,40})`?/gi)) {
        const code = m[1]!.toLowerCase();
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }
  }
  for (const [code, n] of counts) {
    const key = `COMPARE_${code.toUpperCase().replace(/-/g, '_')}`;
    const text = FINDING_GUIDANCE[key] ?? `Past PRs were sent back with reason "${code}" (${n}×); check for it before returning.`;
    store.upsertLesson({ id: `gh:${code}`, source: 'github-reviews', topic: code, text, weight: Math.min(9, 1 + Math.log2(n + 1)), tags: tagText(`${code.replace(/-/g, ' ')} ${text}`) });
  }
  return { codes: counts.size, comments };
}

/** Findings that say nothing another packet can use (its own repeats, parse slips, infrastructure). */
const NOT_PITFALLS = new Set(['REPEATED_CANDIDATE', 'OUTPUT_PARSE', 'OUTPUT_EDIT']);

/**
 * The repository preflight's rule behind a PREFLIGHT_PROBLEM message, without the file, line and
 * names it was reported on, and the fix the preflight itself gives for it.
 */
export function preflightRule(message: string): { rule: string; fix: string | null } {
  const m = message.replace(/^(?:label|origin):\s*/, '').replace(/^\S+?:\d+:\s*/, '').replace(/^(?:label|origin):\s*/, '');
  const [head, ...rest] = m.split(/;\s*fix:\s*/);
  return { rule: (head ?? m).replace(/\s+/g, ' ').trim().slice(0, 400), fix: rest.length ? rest.join('; ').replace(/\s+/g, ' ').trim().slice(0, 300) : null };
}

/**
 * The most frequent rejections of this run, as advice for the next attempt. A repository
 * preflight problem is reported as its own rule with the preflight's own fix: one canned line for
 * every preflight finding sent workers chasing a header line that was not the problem.
 */
export function runPitfalls(store: Store, runId: string): string[] {
  const rows = store.db.prepare(`SELECT json_extract(f.value, '$.code') code, json_extract(f.value, '$.message') message
    FROM verdicts v JOIN tasks t ON t.id = v.task_id, json_each(v.findings_json) f
    WHERE t.run_id = ? AND json_extract(f.value, '$.severity') = 'block' ORDER BY v.created_at DESC LIMIT 4000`).all(runId) as Array<{ code: string; message: string | null }>;
  const counts = new Map<string, { n: number; text: string }>();
  for (const r of rows) {
    if (NOT_PITFALLS.has(r.code) || r.code.startsWith('INFRA') || r.code.startsWith('SKIP_')) continue;
    let key = r.code;
    let text = FINDING_GUIDANCE[r.code] ?? 'see Gate Keeper diagnostics';
    if (r.code === 'PREFLIGHT_PROBLEM') {
      const p = preflightRule(r.message ?? '');
      key = `preflight: ${p.rule.slice(0, 60)}`;
      text = `${p.rule}${p.fix ? ` — fix: ${p.fix}` : ''}`;
    }
    const c = counts.get(key) ?? { n: 0, text };
    c.n++;
    counts.set(key, c);
  }
  return [...counts]
    .filter(([, c]) => c.n >= 3)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 6)
    .map(([key, c]) => (key.startsWith('preflight: ') ? `Repository preflight (${c.n}× this run): ${c.text}` : `${key} (${c.n}× this run): ${c.text}`));
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
