// SPDX-License-Identifier: AGPL-3.0-or-later
// Retries see every earlier candidate (not just the last), exact resubmissions are refused, and the
// comparator's aligned-bytes metric and compiler errors reach the worker.
import { describe, expect, it } from 'vitest';
import { RunConfig, defaultFlow, type Attempt, type CompareFunctionResult, type Verdict } from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { leakScan } from '../src/gatekeeper/rules.js';
import { buildHistory, findRepeat, progressScore, renderHistory, sourceFingerprint, stripForCompare } from '../src/orchestrator/history.js';
import { compileErrorLines, relativiseWorktreePaths } from '../src/repo/srRepo.js';

const FN = 'TESObjectREFR::GetInventoryChanges';
const unit = (body: string, comment = '') => [
  { path: 'r/TESObjectREFR.h', content: '#pragma once\nclass TESObjectREFR;\n' },
  { path: 'r/TESObjectREFR.cpp', content: `// header ${comment}\n#include "TESObjectREFR.h"\n\nInventoryChanges* ${FN}(FormType a_type) const\n{\n${body}\n}\n` },
];
const A = '    if (formFlags & 0x20) { return nullptr; }\n    return extraList.GetInventoryChanges(a_type);';
const B = '    if (formType == FormType::ActorCharacter) { return nullptr; }\n    return extraList.GetInventoryChanges(a_type);';
const C = '    return extraList.GetInventoryChanges(a_type);';
const cmp = (over: Partial<CompareFunctionResult>): CompareFunctionResult => ({
  rva: '0x22b2c0', name: FN, result: 'fail', reason: 'code-byte-mismatch', hint: null, firstMismatch: '+0x0',
  candidateSize: 18, targetSize: 18, exactBytes: 0, totalBytes: 18, ...over,
});

function seed(candidates: Array<{ files: Array<{ path: string; content: string }> | null; compare?: CompareFunctionResult[]; code?: string; message?: string }>) {
  const store = new Store(openDatabase(':memory:'));
  const config = RunConfig.parse({ flowId: 'default', selection: { source: 'synthetic', count: 1, seed: 1 } });
  store.createRun({ id: 'run1', name: 'r', config, flow: defaultFlow() });
  store.insertTasks('run1', [{ id: 'task1', unit: 'r/TESObjectREFR.cpp', functions: [{ rva: '0x22b2c0', name: FN, size: 18, nameOrigin: null }], priority: 1 }]);
  candidates.forEach((c, i) => {
    const attempt: Attempt = {
      id: `att${i + 1}`, taskId: 'task1', runId: 'run1', n: i + 1, tier: 0, nodeId: 'w', accountId: 'a', model: i % 2 ? 'gpt' : 'opus', status: 'completed',
      bundleHash: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 1, error: null,
      files: c.files, startedAt: i, finishedAt: i, difficulty: 'hard', contextTokens: 0, contextRawTokens: 0,
    };
    store.insertAttempt(attempt);
    const verdict: Verdict = {
      id: `vd${i + 1}`, taskId: 'task1', attemptId: attempt.id, decision: 'reject', route: 'retry',
      findings: [{ stage: 'compare', code: c.code ?? 'COMPARE_CODE_BYTE_MISMATCH', severity: 'block', message: c.message ?? 'mismatch' }],
      compare: c.compare ?? null, exactBytes: 0, stages: [], createdAt: i,
    };
    store.insertVerdict(verdict);
  });
  return { store, task: store.getTask('task1')! };
}

describe('attempt history', () => {
  it('ignores comments and spacing when deciding whether code changed, but not include paths', () => {
    expect(stripForCompare('int a; // x\n/* y */ int  b;')).toBe('int a; int b;');
    expect(stripForCompare('#include "a//b.h"')).toBe('#include "a//b.h"');
    expect(sourceFingerprint(unit(A, 'one'))).toBe(sourceFingerprint(unit(A.replace(/ {4}/g, '  '), 'two')));
    expect(sourceFingerprint(unit(A))).not.toBe(sourceFingerprint(unit(B)));
  });

  it('scores progress by exact bytes, else aligned bytes', () => {
    expect(progressScore({ compare: [cmp({ alignedBytes: 7 })] })).toBe(7);
    expect(progressScore({ compare: [cmp({ exactBytes: 4, alignedBytes: 3 })] })).toBe(4);
    expect(progressScore({ compare: [cmp({ result: 'pass' })] })).toBe(18);
    expect(progressScore({ compare: null })).toBeNull();
  });

  it('lists every distinct candidate best first, flags going backwards, and refuses exact repeats', () => {
    const { store, task } = seed([
      { files: unit(A), compare: [cmp({ alignedBytes: 7 })] },
      { files: unit(B), compare: [cmp({ alignedBytes: 3 })] },
      { files: unit(A, 'reworded comment'), compare: [cmp({ alignedBytes: 7 })] },
      { files: unit(C), compare: [cmp({ candidateSize: 9, reason: 'function-size-mismatch', firstMismatch: null, alignedBytes: 2 })] },
      { files: null, code: 'OUTPUT_PARSE', message: 'not JSON' },
      { files: unit(B), compare: [cmp({ alignedBytes: 3 })] },
    ]);
    const h = buildHistory(store, task);
    expect(h.map((e) => e.score)).toEqual([7, 3, 7, 2, null, 3]);
    const text = renderHistory(h, [FN], 1_200);
    expect(text).toContain('Best so far: 7 (attempt #1)');
    expect(text).toContain('Your last attempt scored 3: it went backwards, so start again from #1');
    expect(text).toContain('#1, #3 (same code)');
    expect(text).toContain('#2, #6 (same code)');
    // best first: A (7) before B (3) before C (2)
    expect(text.indexOf('#1, #3')).toBeLessThan(text.indexOf('#2, #6'));
    expect(text.indexOf('#2, #6')).toBeLessThan(text.indexOf('#4'));
    expect(text).toContain('formFlags & 0x20');
    expect(text).toContain('last attempt, code shown in <retry>');

    expect(findRepeat(h, unit(B, 'new comment'))?.n).toBe(6);
    expect(findRepeat(h, unit('    return nullptr;'))).toBeNull();
  });

  it('does not count a format-only rejection as a judged candidate', () => {
    const { store, task } = seed([{ files: unit(A), code: 'CONV_HEADER_TOO_LONG', message: 'header too long' }]);
    expect(findRepeat(buildHistory(store, task), unit(A, 'shorter header'))).toBeNull();
  });
});

describe('comparator feedback', () => {
  it('keeps the compiler error lines with repo-relative paths', () => {
    const json = {
      ok: false, exit_code: 3, error: 'compile failed',
      errors: ["z:\\home\\me\\decomp-orchestrator-worktrees\\slot-2\\reconstruction\\skyrim_shared\\forms\\TESObjectARMO.h(13): fatal error C1083: Cannot open include file: 'declarations/TESForm.h': No such file or directory"],
    };
    expect(compileErrorLines(json)).toEqual(["reconstruction/skyrim_shared/forms/TESObjectARMO.h(13): fatal error C1083: Cannot open include file: 'declarations/TESForm.h': No such file or directory"]);
    expect(compileErrorLines({ exit_code: 4, error: 'translation unit: include "x.h" not found' })).toEqual(['translation unit: include "x.h" not found']);
    expect(relativiseWorktreePaths('/home/me/wt/slot-0/reconstruction/a/B.cpp(4): error C2065')).toBe('reconstruction/a/B.cpp(4): error C2065');
  });

  it('names the refused standard header and the allowed ones', () => {
    const [f] = leakScan('reconstruction/a/BSTask.cpp', '', '#include <cstdio>\n');
    expect(f?.code).toBe('LEAK_INCLUDE_OUTSIDE_ROOTS');
    expect(f?.message).toContain('<cstdio> is not an allowed standard header');
    expect(f?.message).toContain('<cstdint>');
  });
});

describe('placeholder slot runs', () => {
  it('collapse to one marker line in prompts and come back verbatim in returned files', async () => {
    const { collapsePlaceholderSlots, expandPlaceholderSlots, materialise } = await import('../src/orchestrator/edits.js');
    const slots = Array.from({ length: 0x6f - 0x3b + 1 }, (_, i) => `    virtual void Unk_${(0x3b + i).toString(16).toUpperCase()}();`);
    const header = ['class TESObjectREFR : public TESForm {', 'public:', ...slots, '    virtual NiAVObject* Get3D2() const;  // 70', '    ExtraDataList extraList;  // 70', '};', ''].join('\n');
    const shown = collapsePlaceholderSlots(header);
    expect(shown.split('\n').length).toBe(header.split('\n').length - slots.length + 1);
    expect(shown).toContain('// [placeholder slots Unk_3B..Unk_6F (53 lines');
    expect(shown).toContain('ExtraDataList extraList;');
    expect(expandPlaceholderSlots(shown)).toBe(header);
    // A short run stays as is.
    expect(collapsePlaceholderSlots(slots.slice(0, 3).join('\n'))).toBe(slots.slice(0, 3).join('\n'));
    const m = await materialise({ files: [{ path: 'r/TESObjectREFR.h', content: shown.replace('extraList;', 'extraList;\n    int added;') }], codeOrigin: 'x', adaptedBodies: 'none' } as never, async () => null);
    expect(m.files[0]!.content).toContain('    virtual void Unk_50();');
    expect(m.files[0]!.content).toContain('int added;');
  });
});

describe('machine-code grouping', () => {
  it('groups rewrites that compiled to identical machine code and says when every attempt fails at +0x0', () => {
    const { store, task } = seed([
      { files: unit(A), compare: [cmp({ codeSha256: 'aaa' })] },
      { files: unit(A.replace('0x20', 'kDeleted').replace('if', 'constexpr unsigned kDeleted = 0x20;\n    if')), compare: [cmp({ codeSha256: 'aaa' })] },
      { files: unit(B), compare: [cmp({ codeSha256: 'bbb' })] },
    ]);
    const text = renderHistory(buildHistory(store, task), [FN], 1_200);
    expect(text).toContain('#1, #2 (2 different sources, identical machine code: cosmetic changes)');
    expect(text).toContain('No candidate has matched or aligned a single byte yet');
    expect(text).toContain('Every compared attempt (3) differs at the very first instruction');
  });
});

describe('retrying dead packets', () => {
  it('keeps each packet on the tier where it stopped unless asked to start again at the fast tier', async () => {
    const { TaskQueue } = await import('../src/queue/taskQueue.js');
    const { store } = seed([]);
    store.insertTasks('run1', [{ id: 'task2', unit: 'r/B.cpp', functions: [{ rva: '0x1', name: 'B::F', size: 8, nameOrigin: null }], priority: 1, tier: 2 }]);
    store.db.prepare("UPDATE tasks SET state = 'dead', tier = 2, attempts_at_tier = 9 WHERE run_id = 'run1'").run();
    const q = new TaskQueue(store);
    expect(q.requeueDead('run1', null)).toBe(2);
    expect(store.getTask('task2')!.tier).toBe(2);
    expect(store.getTask('task2')!.attemptsAtTier).toBe(0);
    store.db.prepare("UPDATE tasks SET state = 'dead' WHERE run_id = 'run1'").run();
    q.requeueDead('run1', 0);
    expect(store.getTask('task2')!.tier).toBe(0);
  });
});
