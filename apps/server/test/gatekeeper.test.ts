// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { GateChecks } from '@decomp/core';
import type { TaskRow } from '../src/db/store.js';
import { GateKeeper } from '../src/gatekeeper/gatekeeper.js';
import { simIdent } from '../src/providers/mock.js';
import { SimRepo } from '../src/repo/simRepo.js';
import { Semaphore } from '../src/util/async.js';

const CHECKS = GateChecks.parse({});

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't1', runId: 'r1', unit: 'reconstruction/sim/Class0.cpp',
    functions: [{ rva: '0x100010', name: 'Class0::Method0', size: 40 }],
    state: 'leased', priority: 0, tier: 0, attemptsTotal: 0, attemptsAtTier: 0, noImprovementStreak: 0, bestExactBytes: 0,
    cheatStrikes: 0, infraFailures: 0, providerFailures: 0, leaseId: 'l', leaseExpiresAt: null, notBefore: 0, lastVerdictId: null,
    srTaskId: null, updatedAt: 0, ...over,
  };
}

function unit(repo: SimRepo, t: TaskRow, body?: string) {
  const f = t.functions[0]!;
  return `// Source exposure: public.\n// Code origin: original; test\n#include "Sim.h"\n\nint ${simIdent(f)}()\n{\n    ${body ?? repo.solution(f.rva)}\n}\n`;
}

async function run(repo: SimRepo, t: TaskRow, files: Array<{ path: string; content: string }>, checks = CHECKS) {
  const gk = new GateKeeper(repo, new Semaphore(2));
  const prepared = await repo.prepare(0, t);
  return gk.evaluate({ task: t, attemptId: 'a1', slot: 0, prepared, files, checks, compareTimeoutMs: 5_000, signal: new AbortController().signal });
}

describe('GateKeeper pipeline', () => {
  it('accepts a matching, clean candidate', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }]);
    expect(r.verdict.decision).toBe('pass');
    expect(r.verdict.route).toBe('accept');
    expect(r.verdict.exactBytes).toBe(40);
    expect(r.verdict.stages.map((s) => s.name)).toEqual(['scope', 'leak', 'cheat', 'integrity_pre', 'compare', 'integrity_post', 'preflight', 'review']);
  });

  it('rejects a mismatch with per-function diagnostics and partial byte credit', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t, 'return 0x123456;') }]);
    expect(r.verdict.decision).toBe('reject');
    expect(r.verdict.findings.some((f) => f.code === 'COMPARE_CODE_MISMATCH' && f.message.includes('first mismatch'))).toBe(true);
    expect(r.verdict.exactBytes).toBe(28);
  });

  it('never writes or compiles a candidate that fails static checks', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t, '__asm { nop } return 0;') }]);
    expect(r.verdict.decision).toBe('reject');
    expect(r.strike).toBe(true);
    expect(r.written).toEqual([]);
    expect(repo.compares).toBe(0);
    expect(await repo.readFile(0, t.unit)).not.toContain('__asm');
  });

  it('blocks writes outside the allowlist without touching the worktree', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: 'tools/compare.py', content: 'def compare(): return "pass"' }]);
    expect(r.verdict.findings.map((f) => f.code)).toContain('SCOPE_PROTECTED_PATH');
    expect(await repo.changedPaths(0)).not.toContain('tools/compare.py');
  });

  it('quarantines on the second strike', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task({ cheatStrikes: 1 });
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t, 'return reinterpret_cast<int(*)()>(0x1401de5e0)();') }]);
    expect(r.verdict.decision).toBe('quarantine');
    expect(r.verdict.route).toBe('quarantine');
  });

  it('quarantines immediately when protected inputs change during compare', async () => {
    const repo = new SimRepo({ slots: 1, onCompare: (slot, rp) => rp.tamper(slot) });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }]);
    expect(r.verdict.decision).toBe('quarantine');
    expect(r.verdict.findings.map((f) => f.code)).toContain('INTEGRITY_HOST_TAMPER');
  });

  it('flags stray changes in the worktree as integrity violations', async () => {
    const repo = new SimRepo({ slots: 1, onCompare: (slot, rp) => rp.stray(slot, 'reconstruction/sim/Other.cpp') });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }]);
    expect(r.verdict.decision).not.toBe('pass');
    expect(r.verdict.findings.map((f) => f.code)).toContain('INTEGRITY_UNEXPECTED_CHANGE');
  });

  it('reports infrastructure failures as infra (not the candidate’s fault)', async () => {
    const repo = new SimRepo({ slots: 1, infraRate: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }]);
    expect(r.infra).toBe(true);
    expect(r.strike).toBe(false);
    expect(r.verdict.route).toBe('retry');
  });

  it('LLM review can block but deterministic failure always wins', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const approve = { review: async () => [] };
    const block = { review: async () => [{ stage: 'review', code: 'REVIEW_BYTE_STEERING', severity: 'block' as const, message: 'dead store' }] };
    const checks = GateChecks.parse({ llmReview: true });
    const prepared = await repo.prepare(0, t);
    const sig = new AbortController().signal;
    const ok = await new GateKeeper(repo, new Semaphore(1), approve).evaluate({ task: t, attemptId: 'a', slot: 0, prepared, files: [{ path: t.unit, content: unit(repo, t) }], checks, compareTimeoutMs: 1000, signal: sig });
    expect(ok.verdict.decision).toBe('pass');
    const blocked = await new GateKeeper(repo, new Semaphore(1), block).evaluate({ task: t, attemptId: 'a', slot: 0, prepared, files: [{ path: t.unit, content: unit(repo, t) }], checks, compareTimeoutMs: 1000, signal: sig });
    expect(blocked.verdict.decision).toBe('reject');
    const mismatch = await new GateKeeper(repo, new Semaphore(1), approve).evaluate({ task: t, attemptId: 'a', slot: 0, prepared, files: [{ path: t.unit, content: unit(repo, t, 'return 0x1;') }], checks, compareTimeoutMs: 1000, signal: sig });
    expect(mismatch.verdict.decision).toBe('reject');
    expect(mismatch.verdict.stages.find((s) => s.name === 'review')).toBeUndefined();
  });
});
