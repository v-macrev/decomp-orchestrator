// SPDX-License-Identifier: AGPL-3.0-or-later
// The LLM reviewer judges what the candidate adds, and its outage is not the candidate's fault.
import { describe, expect, it } from 'vitest';
import { GateChecks } from '@decomp/core';
import type { TaskRow } from '../src/db/store.js';
import { GateKeeper, type Reviewer } from '../src/gatekeeper/gatekeeper.js';
import { LlmReviewer, addedLines } from '../src/gatekeeper/review.js';
import { simIdent } from '../src/providers/mock.js';
import { SimRepo } from '../src/repo/simRepo.js';
import { Semaphore } from '../src/util/async.js';

const P = 'a/Foo.cpp';

function reviewer(blocking: unknown[]) {
  const seen: string[] = [];
  const pool = { acquire: async () => ({ account: {}, model: {} }), release: () => undefined };
  const providers = { complete: async (_a: unknown, r: { prompt: string }) => (seen.push(r.prompt), { text: JSON.stringify({ approve: false, blocking }), usage: {} }) };
  return { seen, r: new LlmReviewer(pool as never, providers as never, {} as never) };
}

describe('LLM review', () => {
  it('numbers the lines a candidate adds, counting repeated lines', () => {
    expect([...addedLines('a\n}\nb\n}\n', 'a\n}\n')]).toEqual([3, 4]);
    expect([...addedLines('x\ny', null)]).toEqual([1, 2]);
  });

  it('shows old lines as context and does not block on them', async () => {
    const before = ['void Old()', '{', '    raw[8] = 1;', '}', '', '', ''].join('\n');
    const after = `${before}\nvoid New()\n{\n    bad();\n}\n`;
    const { seen, r } = reviewer([
      { code: 'HIDDEN_FIELD', file: P, line: 3, reason: 'old' },
      { code: 'BYTE_STEERING', file: P, line: 10, reason: 'new' },
      { code: 'PROVENANCE', reason: 'no line' },
    ]);
    const out = await r.review({ task: { functions: [] } as unknown as TaskRow, files: [{ path: P, content: after }], before: new Map([[P, before]]), compare: [], signal: new AbortController().signal });
    expect(out.map((f) => [f.message, f.severity])).toEqual([['old', 'warn'], ['new', 'block'], ['no line', 'block']]);
    expect(seen[0]).toContain('\n3      raw[8] = 1;');
    expect(seen[0]).toContain('\n10+     bad();');
  });

  it('a reviewer that cannot be reached is an infrastructure failure', async () => {
    const repo = new SimRepo({ slots: 1 });
    const f = { rva: '0x100010', name: 'Class0::Method0', size: 40 };
    const task = { id: 't1', runId: 'r1', unit: 'reconstruction/sim/Class0.cpp', functions: [f], cheatStrikes: 0 } as unknown as TaskRow;
    const down: Reviewer = { review: async () => [{ stage: 'review', code: 'INFRA_REVIEW', severity: 'block', message: 'reviewer unavailable: quota' }] };
    const gk = new GateKeeper(repo, new Semaphore(1), down);
    const content = `// Source exposure: public.\n// Code origin: original; test\n#include "Sim.h"\n\nint ${simIdent(f)}()\n{\n    ${repo.solution(f.rva)}\n}\n`;
    const r = await gk.evaluate({
      task, attemptId: 'a', slot: 0, prepared: await repo.prepare(0, task), files: [{ path: task.unit, content }],
      checks: GateChecks.parse({ llmReview: true }), compareTimeoutMs: 5_000, signal: new AbortController().signal,
    });
    expect([r.infra, r.strike, r.verdict.decision]).toEqual([true, false, 'reject']);
  });
});
