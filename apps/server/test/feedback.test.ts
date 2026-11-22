// SPDX-License-Identifier: AGPL-3.0-or-later
// What a retry is told: the comparator's aligned listing, the whole Gate Keeper message, the
// preflight's own rule and fix, and bind hints written from the pack's reference table.
// Every listing here is synthetic (made-up instructions and addresses), never game-derived.
import { afterEach, describe, expect, it } from 'vitest';
import { ContextConfig, type Attempt, type Verdict } from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store, type TaskRow } from '../src/db/store.js';
import { TaskContextBuilder, effectiveBudgets, renderRetryDelta } from '../src/orchestrator/contextBuilder.js';
import { preflightRule } from '../src/orchestrator/lessons.js';
import { renderBundle } from '../src/orchestrator/prompts.js';
import { autoBindHints, bindHintsPath, candidateRelocations, unboundNames } from '../src/repo/binding.js';
import { SimRepo } from '../src/repo/simRepo.js';

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.db.close();
});

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 't1', runId: 'r1', unit: 'reconstruction/sim/Class7.cpp', functions: [{ rva: '0x100010', name: 'Class7::Method2', size: 60 }],
  state: 'leased', priority: 0, tier: 0, attemptsTotal: 0, attemptsAtTier: 0, noImprovementStreak: 0, bestExactBytes: 0, cheatStrikes: 0,
  infraFailures: 0, providerFailures: 0, leaseId: 'l', leaseExpiresAt: null, notBefore: 0, lastVerdictId: null, srTaskId: null, updatedAt: 0,
  difficulty: 'medium', complexity: 3, attemptsAtDifficulty: 0, assessment: null, ...over,
});

// A synthetic side-by-side in the comparator's layout: the candidate loads a literal the comparator
// could not bind; the alignment pairs it with the target instruction at +0x7.
const SIDE = [
  'target 4 instructions, candidate 4; first differing row 1',
  '    off  target                                          off  candidate',
  '         --------------------------------------------         --------------------------------------------',
  '      0  sub rsp, 0x28                                     0  sub rsp, 0x28',
  '*     4  mov r9d, r8d                                      4  mov r9d, r8d',
  '*     7  lea r8, [rip + 0x1000] # 0x140001100              7  lea r8, [rip] # 0xe <Foo+0xe>  <REL32 ??_C@_02ABC@lit@>',
  '*     e  call qword ptr [rip + 0x2000] # 0x140002100       e  call qword ptr [rip] # 0x14 <Foo+0x14>  <REL32 __imp_helper>',
].join('\n');

describe('bind hints from the pack reference table', () => {
  const pack = {
    instructions: [{ offset: 0, length: 4 }, { offset: 4, length: 3 }, { offset: 7, length: 7 }, { offset: 14, length: 6 }],
    references: [{ target_rva: 0x1100, at: [10] }, { target_rva: 0x2100, at: [16] }],
  };
  const alignment = [{ op: 'pair', t: 0, c: 0 }, { op: 'pair', t: 4, c: 4 }, { op: 'pair', t: 7, c: 7 }, { op: 'pair', t: 14, c: 14 }];
  const bind = ['UNBOUND reference ??_C@_02ABC@lit@: add {"??_C@_02ABC@lit@": "0x<rva from the pack table>"} to /home/u/repo/.local/contrib/tasks/contrib-foo/bind-hints.json'];

  it('reads the unbound names and the hints file from the compare output', () => {
    expect(unboundNames(bind)).toEqual(['??_C@_02ABC@lit@']);
    expect(bindHintsPath(bind)).toBe('/home/u/repo/.local/contrib/tasks/contrib-foo/bind-hints.json');
    expect(unboundNames(['UNBOUND thread-local x: ...'])).toEqual([]);
    expect(candidateRelocations(SIDE).get(7)).toEqual(['??_C@_02ABC@lit@']);
  });

  it('pairs an unbound name with the address its aligned target instruction references', () => {
    expect(autoBindHints({ unbound: unboundNames(bind), sideBySide: SIDE, alignment, ...pack })).toEqual({ '??_C@_02ABC@lit@': '0x1100' });
  });

  it('binds nothing the pack does not list, and nothing ambiguous', () => {
    expect(autoBindHints({ unbound: unboundNames(bind), sideBySide: SIDE, alignment, instructions: pack.instructions, references: [] })).toEqual({});
    const twice = [...alignment, { op: 'pair', t: 14, c: 7 }];
    expect(autoBindHints({ unbound: unboundNames(bind), sideBySide: SIDE, alignment: twice, ...pack })).toEqual({});
    expect(autoBindHints({ unbound: unboundNames(bind), sideBySide: SIDE, alignment: [{ op: 'extra', c: 7 }], ...pack })).toEqual({});
  });
});

describe('preflight problems as their own rule', () => {
  it('drops the file, line and names and keeps the preflight fix', () => {
    expect(preflightRule('reconstruction/a/B.cpp:11: deterministic screen: include-outside-roots; fix: use a reconstruction-root header path without parent steps or host paths'))
      .toEqual({ rule: 'deterministic screen: include-outside-roots', fix: 'use a reconstruction-root header path without parent steps or host paths' });
    expect(preflightRule('label: reconstruction/a/B.h:5: Update is labelled GUESS but a community header names it').rule).toBe('Update is labelled GUESS but a community header names it');
  });
});

describe('retry feedback is shown whole', () => {
  it('raises the feedback budgets of runs created with the old, tight ones', () => {
    const old = ContextConfig.parse({ budgets: { retry_delta: { min: 200, max: 600 }, attempt_history: { min: 0, max: 1_200 } } }).budgets;
    const b = effectiveBudgets(old);
    expect(b.retry_delta.max).toBeGreaterThanOrEqual(2_000);
    expect(b.attempt_history.max).toBeGreaterThanOrEqual(2_500);
    expect(b.compare_listing.max).toBeGreaterThanOrEqual(1_500);
    expect(b.unit_files).toEqual(old.unit_files);
  });

  it('keeps a long preflight message and its fix instead of cutting it at 400 characters', () => {
    const msg = `reconstruction/sim/Class7.h:24: label outside the v2 grammar; write "// <names>: <LABEL> ...[; note]" with LABEL one of ${'COMMUNITY(<owner>/<repo>@<rev>, <licence>), '.repeat(8)}GUESS; fix: resolve the reported source/header requirement`;
    const verdict = { decision: 'reject', findings: [{ stage: 'preflight', code: 'PREFLIGHT_PROBLEM', severity: 'block', file: 'reconstruction/sim/Class7.h', line: 24, message: msg }], compare: null } as unknown as Verdict;
    const r = renderRetryDelta({ verdict, attempt: { n: 2, files: [] } as unknown as Attempt }, task(), 2_000);
    expect(r.text).toContain('fix: resolve the reported source/header requirement');
    expect(r.text).not.toContain('Code origin');
  });

  it("puts the comparator's listing of the last attempt in the prompt, privately and only with consent", async () => {
    const store = new Store(openDatabase(':memory:'));
    stores.push(store);
    const repo = new SimRepo({ slots: 1 });
    const read: Array<[string, string]> = [];
    repo.readCompareListing = async (ref, rva) => {
      read.push([ref, rva]);
      return `# synthetic aligned listing\n    off  target            off  candidate\n!     7  lea r8, [rip]       7  mov edx, r8d   callee-or-argument-setup\n# next: a live argument register`;
    };
    const [f] = await repo.discover({ source: 'synthetic', count: 1, seed: 5 });
    const t = task({ unit: f!.unit, functions: [f!] });
    const prep = await repo.prepare(0, t);
    const verdict = {
      decision: 'reject', findings: [{ stage: 'compare', code: 'COMPARE_CODE_BYTE_MISMATCH', severity: 'block', message: `${f!.rva} fail code-byte-mismatch` }],
      compare: [{ rva: f!.rva, name: f!.name, result: 'fail', reason: 'code-byte-mismatch', hint: null, firstMismatch: '+0x4', candidateSize: 34, targetSize: 34, exactBytes: 0, totalBytes: 34, alignedBytes: 20, listingRef: '/local/tasks/x/runs/054' }],
    } as unknown as Verdict;
    const feedback = { verdict, attempt: { n: 4, files: [] } as unknown as Attempt };
    const b = new TaskContextBuilder(repo, store);
    const cfg = ContextConfig.parse({});
    const bundle = await b.build(t, prep, 0, { runId: 'r1', exposureConsent: true, carried: [], attemptNo: 5, feedback, pitfalls: [], context: cfg });
    const sec = bundle.sections.find((s) => s.kind === 'compare_listing');
    expect(sec?.privacy).toBe('private');
    expect(sec?.content).toContain('next: a live argument register');
    expect(read).toEqual([['/local/tasks/x/runs/054', f!.rva]]);
    expect(renderBundle(bundle, 5, false).prompt).toContain('<compare_listing');
    const stored = store.getBundle(bundle.hash) as { sections: Array<{ kind: string; content: string }> };
    expect(stored.sections.find((s) => s.kind === 'compare_listing')!.content).toMatch(/^\[private: /);
    await repo.reset(0);
    const without = await b.build(t, await repo.prepare(0, t), 0, { runId: 'r1', exposureConsent: false, carried: [], attemptNo: 5, feedback, pitfalls: [], context: cfg });
    expect(without.sections.some((s) => s.kind === 'compare_listing')).toBe(false);
  });
});
