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
  LEAK_INCLUDE_OUTSIDE_ROOTS: 'Include own header as "X.h" and shared headers by reconstruction-root path ("area/Y.h").',
  CONV_HEADER_TOO_LONG: 'Keep the skeleton header (max 6 lines besides labels / Sibling source / 0x<rva> lines).',
  CONV_STATIC_ASSERT_NO_MESSAGE: 'Every static_assert needs a message.',
  CONV_ORIGIN_PLACEHOLDER: 'Fill the "Code origin:" header line truthfully.',
  COMPARE_COMPILE_ERROR: 'The unit must compile: declare every type and callee you use.',
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

export function runPitfalls(store: Store, runId: string): string[] {
  return store
    .topFindingCodes(runId, 6)
    .filter((c) => c.n >= 3)
    .map((c) => `${c.code} (${c.n}× this run): ${FINDING_GUIDANCE[c.code] ?? 'see Gate Keeper diagnostics'}`);
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
