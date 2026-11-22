// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFlow, type Account, type Flow } from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { RunEngine } from '../src/orchestrator/engine.js';
import { AccountPool } from '../src/pool/scheduler.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SimRepo } from '../src/repo/simRepo.js';
import { EventBus } from '../src/telemetry/events.js';
import { mockAccount } from './helpers.js';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) if (s.db.open) s.db.close();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows may hold the WAL briefly; temp dir cleanup is best-effort */
    }
  }
});

/**
 * The pre-Phase-2 preset (cheap → strong, tag-bound, one dispatch edge, no capabilities). These
 * tests keep exercising it so existing flows and account configs stay supported.
 */
function flow(cheap = 6, strong = 2): Flow {
  const f = defaultFlow();
  const gate = f.nodes.find((n) => n.type === 'gatekeeper')!;
  const orch = f.nodes.find((n) => n.type === 'orchestrator')!;
  const fast = f.nodes.find((n) => n.id === 'worker-fast')!;
  const mk = (id: string, label: string, instances: number, tags: string[], maxAttempts: number, stuckAfter: number) => ({
    ...fast, id, data: { ...fast.data, label, instances, maxAttempts, stuckAfter, capability: undefined, costWeight: undefined, pool: { strategy: 'pool' as const, accountIds: [], tags } },
  });
  return {
    id: 'legacy', name: 'Cheap → strong ladder',
    nodes: [orch, mk('worker-cheap', 'Workers (cheap)', cheap, ['cheap'], 6, 3), mk('worker-strong', 'Workers (strong)', strong, ['strong'], 10, 4), gate],
    edges: [
      { id: 'e-dispatch', source: orch.id, target: 'worker-cheap', kind: 'dispatch' },
      { id: 'e-submit-cheap', source: 'worker-cheap', target: gate.id, kind: 'submit' },
      { id: 'e-submit-strong', source: 'worker-strong', target: gate.id, kind: 'submit' },
      { id: 'e-retry-cheap', source: gate.id, target: 'worker-cheap', kind: 'reject_retry' },
      { id: 'e-retry-strong', source: gate.id, target: 'worker-strong', kind: 'reject_retry' },
      { id: 'e-escalate', source: 'worker-cheap', target: 'worker-strong', kind: 'escalate' },
      { id: 'e-report', source: gate.id, target: orch.id, kind: 'report' },
    ],
  };
}

function accounts(over: Record<string, Record<string, unknown>> = {}): Account[] {
  const fast = { latencyMs: [1, 4] };
  return [
    mockAccount('claude-ws-a', { tags: ['cheap'], options: { ...fast, skill: 0.55, rateLimitRate: 0.05, retryAfterMs: 30, ...over['claude-ws-a'] } }),
    mockAccount('claude-ws-b', { tags: ['cheap'], options: { ...fast, skill: 0.55, serverErrorRate: 0.05, ...over['claude-ws-b'] } }),
    mockAccount('gpt-a', { tags: ['cheap', 'strong'], options: { ...fast, skill: 0.6, ...over['gpt-a'] } }),
    mockAccount('opus', { tags: ['strong'], options: { ...fast, skill: 0.85, ...over['opus'] } }),
  ];
}

function setup(dbPath: string, opts: { accounts?: Account[]; slots?: number; infraRate?: number } = {}) {
  const store = new Store(openDatabase(dbPath));
  stores.push(store);
  const events = new EventBus(store);
  const repo = new SimRepo({ slots: opts.slots ?? 8, compareLatencyMs: [1, 3], infraRate: opts.infraRate ?? 0 });
  const pool = new AccountPool(opts.accounts ?? accounts(), store, events, { circuitBaseMs: 100, rateLimitBaseMs: 20, overloadCooldownMs: 20 });
  const providers = new ProviderRegistry({ oracle: repo });
  const engine = new RunEngine({ store, pool, providers, repo, events }, { leaseMs: 5_000, heartbeatMs: 500, infraBackoffMs: 5, idlePollMs: 20 });
  return { store, events, repo, pool, providers, engine };
}

const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), 'decomp-test-'));
  dirs.push(d);
  return join(d, 'orch.db');
};

function totals(store: Store, runId: string) {
  const fc = store.functionCounts(runId);
  return { fc, sum: Object.values(fc).reduce((a, b) => a + b, 0) };
}

describe('RunEngine', () => {
  it('runs a bulk batch to completion and stages verified PR batches', async () => {
    const s = setup(tmpDb());
    const run = s.engine.createRun('t', { flowId: 'default', selection: { source: 'synthetic', count: 120, seed: 7 }, prBatchSize: 40 }, flow());
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const r = s.store.getRun(run.id)!;
    expect(r.status).toBe('completed');
    const { fc, sum } = totals(s.store, run.id);
    expect(sum).toBe(120);
    expect(fc.pending ?? 0).toBe(0);
    expect((fc.staged ?? 0) + (fc.dead ?? 0) + (fc.quarantined ?? 0)).toBe(120);
    expect(fc.staged ?? 0).toBeGreaterThan(90);
    const batches = s.store.listBatches(run.id);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (const b of batches) {
      expect(b.status).toBe('branch_ready');
      expect((b.detail as unknown as { functions: number }).functions).toBeLessThanOrEqual(40);
    }
    expect(r.costUsd).toBeGreaterThan(0);
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('survives a hard crash mid-run and resumes from the database without double-processing', async () => {
    const db = tmpDb();
    const a = setup(db);
    const run = a.engine.createRun('crash', { flowId: 'default', selection: { source: 'synthetic', count: 300, seed: 11 }, maxFunctionsPerWorker: 1000 }, flow());
    await a.engine.start(run.id);
    // let it make progress, then kill it like kill -9 (no cleanup of task state)
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if ((a.store.functionCounts(run.id).passed ?? 0) > 60) break;
    }
    await a.engine.hardStop();
    a.pool.close();
    const before = a.store.functionCounts(run.id);
    expect(before.passed ?? 0).toBeGreaterThan(0);
    expect(a.store.getRun(run.id)!.status).toBe('running');

    // "restart the process": new store/engine on the same file
    const b = setup(db);
    await b.engine.resumeOnBoot();
    await b.engine.waitFor(run.id);
    expect(b.store.getRun(run.id)!.status).toBe('completed');
    const { fc, sum } = totals(b.store, run.id);
    expect(sum).toBe(300);
    expect(fc.leased ?? 0).toBe(0);
    expect(fc.gating ?? 0).toBe(0);
    // every task passed at most once, and never has two passing verdicts
    const dup = b.store.db.prepare(`SELECT task_id, COUNT(*) n FROM verdicts WHERE decision = 'pass' GROUP BY task_id HAVING n > 1`).all();
    expect(dup).toEqual([]);
    b.pool.close();
    b.engine.close();
  }, 90_000);

  it('escalates stuck packets to the strong tier', async () => {
    const s = setup(tmpDb(), { accounts: accounts({ 'claude-ws-a': { skill: 0.05 }, 'claude-ws-b': { skill: 0.05 }, 'gpt-a': { skill: 0.05 } }) });
    // Ladder mechanics in isolation (difficulty routing would send hard packets straight to the strong tier).
    const run = s.engine.createRun('esc', { flowId: 'default', selection: { source: 'synthetic', count: 40, seed: 3 }, routing: { enabled: false } }, flow(4, 2));
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const escalations = s.store.db.prepare(`SELECT COUNT(*) n FROM verdicts WHERE route = 'escalate'`).get() as { n: number };
    expect(escalations.n).toBeGreaterThan(5);
    const strongPasses = s.store.db.prepare(`SELECT COUNT(*) n FROM attempts a JOIN verdicts v ON v.attempt_id = a.id WHERE v.decision = 'pass' AND a.tier = 1`).get() as { n: number };
    expect(strongPasses.n).toBeGreaterThan(0);
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('quarantines cheaters and never accepts cheating output', async () => {
    const s = setup(tmpDb(), { accounts: accounts({ 'claude-ws-a': { cheatRate: 0.6 }, 'claude-ws-b': { cheatRate: 0.6 }, 'gpt-a': { cheatRate: 0.6 } }) });
    const run = s.engine.createRun('cheat', { flowId: 'default', selection: { source: 'synthetic', count: 60, seed: 5 } }, flow());
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const fc = s.store.functionCounts(run.id);
    expect(fc.quarantined ?? 0).toBeGreaterThan(0);
    const accepted = s.store.db.prepare(`SELECT a.files_json FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE v.decision = 'pass'`).all() as Array<{ files_json: string }>;
    for (const r of accepted) expect(r.files_json).not.toMatch(/__asm|#pragma optimize|0x1401de5e0|param_1|tools\/compare/);
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('fails over around a dead account and an outage without stalling', async () => {
    const s = setup(tmpDb(), { accounts: accounts({ 'claude-ws-a': { authFail: true }, 'claude-ws-b': { outages: [[0, 400]] } }) });
    const run = s.engine.createRun('failover', { flowId: 'default', selection: { source: 'synthetic', count: 80, seed: 9 } }, flow());
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    const v = s.pool.view();
    expect(v.find((x) => x.accountId === 'claude-ws-a')!.status).toBe('disabled');
    expect(totals(s.store, run.id).sum).toBe(80);
    expect(s.store.functionCounts(run.id).staged ?? 0).toBeGreaterThan(50);
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('retries infra failures without burning attempt budgets', async () => {
    const s = setup(tmpDb(), { infraRate: 0.3 });
    const run = s.engine.createRun('infra', { flowId: 'default', selection: { source: 'synthetic', count: 30, seed: 2 } }, flow());
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const infra = s.store.db.prepare(`SELECT COUNT(*) n FROM verdicts WHERE findings_json LIKE '%INFRA_COMPARE%'`).get() as { n: number };
    expect(infra.n).toBeGreaterThan(0);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('a run paused on its budget resumes only with a new budget', async () => {
    const s = setup(tmpDb());
    const run = s.engine.createRun('budget', { flowId: 'default', selection: { source: 'synthetic', count: 200, seed: 5 }, budgetUsd: 0.000001 }, flow());
    await s.engine.start(run.id);
    for (let i = 0; i < 100 && s.store.getRun(run.id)!.status !== 'paused'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(s.store.getRun(run.id)!.status).toBe('paused');
    const spent = s.store.getRun(run.id)!.costUsd;
    expect(spent).toBeGreaterThan(0);

    // Plain resume would only pause again: refused, with the reason.
    const plain = await s.engine.resume(run.id);
    expect(plain.ok).toBe(false);
    expect(plain.reason).toMatch(/budget .* reached/);
    // A new budget must exceed what is already spent.
    expect((await s.engine.resume(run.id, { budgetUsd: spent / 2 })).ok).toBe(false);
    expect(s.store.getRun(run.id)!.status).toBe('paused');

    expect((await s.engine.resume(run.id, { budgetUsd: 1_000 })).ok).toBe(true);
    expect(s.store.getRun(run.id)!.config.budgetUsd).toBe(1_000);
    expect(s.store.getRun(run.id)!.status).toBe('running');
    await new Promise((r) => setTimeout(r, 100));
    expect(s.store.getRun(run.id)!.status).toBe('running'); // stays running under the new cap

    s.engine.pause(run.id, true);
    expect((await s.engine.resume(run.id, { budgetUsd: null })).ok).toBe(true);
    expect(s.store.getRun(run.id)!.config.budgetUsd).toBeUndefined();
    await s.engine.cancel(run.id);
    s.pool.close();
    s.engine.close();
  }, 30_000);

  it('pauses, resumes and cancels', async () => {
    const s = setup(tmpDb());
    const run = s.engine.createRun('ctl', { flowId: 'default', selection: { source: 'synthetic', count: 200, seed: 4 } }, flow());
    await s.engine.start(run.id);
    await new Promise((r) => setTimeout(r, 60));
    s.engine.pause(run.id, true);
    await new Promise((r) => setTimeout(r, 100));
    const frozen = s.store.taskCounts(run.id);
    await new Promise((r) => setTimeout(r, 150));
    expect(s.store.taskCounts(run.id)).toEqual(frozen); // nothing moves while paused
    expect(frozen.leased ?? 0).toBe(0);
    await s.engine.resume(run.id);
    await new Promise((r) => setTimeout(r, 60));
    await s.engine.cancel(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('cancelled');
    const after = s.store.taskCounts(run.id);
    expect((after.pending ?? 0) + (after.leased ?? 0) + (after.gating ?? 0)).toBe(0);
    s.pool.close();
    s.engine.close();
  }, 60_000);
});

describe('attempts per tier', () => {
  it('gives every tier exactly its attempts: the old promote-after and stuck-after rules no longer cut it short', async () => {
    const never = { latencyMs: [1, 2], skill: 0 };
    const s = setup(tmpDb(), { accounts: [mockAccount('cheap-a', { tags: ['cheap'], options: never }), mockAccount('strong-a', { tags: ['strong'], options: never })] });
    const f = flow(2, 2);
    for (const n of f.nodes) if (n.type === 'worker') n.data = { ...n.data, maxAttempts: n.id === 'worker-cheap' ? 4 : 3, stuckAfter: 1 };
    // promoteAfterFailures: 1 and stuckAfter: 1 would each have moved a packet on after one failure.
    const run = s.engine.createRun('attempts', { flowId: 'default', selection: { source: 'synthetic', count: 6, seed: 5 }, routing: { enabled: true, promoteAfterFailures: 1 } }, f);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const dead = s.store.listTasks(run.id, { state: 'dead', limit: 100 });
    expect(dead.length).toBeGreaterThan(0);
    const counted = s.store.db.prepare(`SELECT a.tier tier, COUNT(*) n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id
      WHERE v.task_id = ? AND v.route IN ('retry', 'escalate', 'dead_letter') AND v.findings_json NOT LIKE '%"format"%' GROUP BY a.tier`);
    for (const t of dead) {
      const byTier = Object.fromEntries((counted.all(t.id) as Array<{ tier: number; n: number }>).map((r) => [r.tier, r.n]));
      // Hard packets enter at the strong tier; every tier a packet visits gets exactly its attempts.
      expect(Object.keys(byTier).length).toBeGreaterThan(0);
      for (const [tier, n] of Object.entries(byTier)) expect(n).toBe(tier === '0' ? 4 : 3);
    }
    const kinds = s.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE run_id = ? AND kind = 'task.promoted'`).get(run.id) as { n: number };
    expect(kinds.n).toBe(0);
    s.pool.close();
    s.engine.close();
  }, 60_000);
});

describe('re-gating packets only foreign compare results killed', () => {
  it('submits the matched candidate again without a model call, and it passes', async () => {
    const s = setup(tmpDb(), { slots: 4 });
    const run = s.engine.createRun('regate', { flowId: 'default', selection: { source: 'synthetic', count: 6, seed: 9 }, routing: { enabled: false } }, flow(4, 2));
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const t = s.store.listTasks(run.id, { state: 'passed', limit: 100 })[0] ?? s.store.listTasks(run.id, { state: 'staged', limit: 100 })[0]!;
    const pass = s.store.getVerdict(t.lastVerdictId!)!;
    // As before the fix: the stale sr task also compared a dead packet's function, which failed.
    const killed = {
      ...pass, id: 'vd_killed', decision: 'reject' as const, route: 'retry' as const, createdAt: Date.now(),
      compare: [...(pass.compare ?? []), { rva: '0xdead0', name: 'Gone::F', result: 'fail', reason: 'function-symbol-missing' } as NonNullable<typeof pass.compare>[number]],
      findings: [{ stage: 'compare', code: 'COMPARE_FUNCTION_SYMBOL_MISSING', severity: 'block' as const, message: '0xdead0 Gone::F: fail function-symbol-missing' }],
    };
    s.store.insertVerdict(killed);
    s.store.db.prepare("UPDATE tasks SET state = 'dead', last_verdict_id = 'vd_killed' WHERE id = ?").run(t.id);
    const before = s.store.attemptsForTask(t.id).length;
    const r = await s.engine.regateMatched(run.id);
    expect(r.packets).toBe(1);
    await s.engine.waitFor(run.id);
    const after = s.store.getTask(t.id)!;
    expect(['passed', 'staged']).toContain(after.state);
    const last = s.store.getAttempt(s.store.getVerdict(after.lastVerdictId!)!.attemptId)!;
    expect(last.model).toBe('stored candidate (no model call)');
    expect(last.costUsd ?? 0).toBe(0);
    expect(s.store.attemptsForTask(t.id).length).toBe(before + 1);
    s.pool.close();
    s.engine.close();
  }, 60_000);
});

describe('packets the workers cannot finish', () => {
  it('sets aside, as held, a packet whose functions match but whose file fails the preflight on a line it did not write', async () => {
    // Every unit's base already has the include line; the preflight rejects that line in every file.
    class Upstream extends SimRepo {
      override async baseFile(path: string) {
        return path.endsWith('.cpp') ? '#include "Sim.h"\n' : null;
      }
      override async preflight(slot: number, task: Parameters<SimRepo['preflight']>[1]) {
        const src = (await this.readFile(slot, task.unit)) ?? '';
        const n = src.split('\n').findIndex((l) => l.trim() === '#include "Sim.h"') + 1;
        const problems = n ? [`${task.unit}:${n}: deterministic screen: include-outside-roots; fix: use a reconstruction-root header path`] : [];
        return { completed: true, ok: !problems.length, problems, infraError: null };
      }
    }
    const s = setup(tmpDb());
    const repo = new Upstream({ slots: 4, compareLatencyMs: [1, 2] });
    const engine = new RunEngine({ store: s.store, pool: s.pool, providers: new ProviderRegistry({ oracle: repo }), repo, events: s.events }, { leaseMs: 5_000, heartbeatMs: 500, infraBackoffMs: 5, idlePollMs: 20 });
    const run = engine.createRun('held', { flowId: 'default', selection: { source: 'synthetic', count: 12, seed: 4 }, routing: { enabled: false } }, flow(4, 2));
    await engine.start(run.id);
    await engine.waitFor(run.id);
    const held = s.store.listTasks(run.id, { state: 'set_aside', limit: 100 });
    expect(held.length).toBeGreaterThan(0);
    for (const t of held) {
      expect(t.hold?.problems[0]?.message).toMatch(/include-outside-roots.*already in the file before this packet/);
      const vs = s.store.verdictsForTask(t.id);
      // One retry to change the line, then held: never retried until its attempts run out.
      expect(vs.at(-1)!.route).toBe('hold');
      expect(vs.filter((v) => v.findings.some((f) => f.code === 'PREFLIGHT_PREEXISTING')).length).toBe(2);
    }
    expect(s.store.listTasks(run.id, { state: 'dead', limit: 100 }).filter((t) => s.store.verdictsForTask(t.id).some((v) => v.findings.some((f) => f.code === 'PREFLIGHT_PREEXISTING'))).length).toBe(0);
    expect(engine.batchingStatus(run.id).held.length).toBe(held.length);
    s.pool.close();
    s.engine.close();
    engine.close();
  }, 60_000);
});
