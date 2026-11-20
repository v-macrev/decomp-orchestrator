// SPDX-License-Identifier: AGPL-3.0-or-later
// Lifecycle boundaries where individually correct parts meet: staging that fails re-verification,
// staging overlapping another run, a worker whose lease was lost before routing, and retrying the
// failed packets of a paused run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFlow, type Flow } from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { RunEngine } from '../src/orchestrator/engine.js';
import { AccountPool } from '../src/pool/scheduler.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SimRepo } from '../src/repo/simRepo.js';
import type { StageBatchInput, StageBatchResult } from '../src/repo/types.js';
import { EventBus } from '../src/telemetry/events.js';
import { mockAccount } from './helpers.js';

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows may hold the WAL briefly */
    }
  }
});

function flow(): Flow {
  const f = defaultFlow();
  const gate = f.nodes.find((n) => n.type === 'gatekeeper')!;
  const orch = f.nodes.find((n) => n.type === 'orchestrator')!;
  const fast = f.nodes.find((n) => n.id === 'worker-fast')!;
  const w = { ...fast, id: 'worker', data: { ...fast.data, label: 'Workers', instances: 4, maxAttempts: 6, stuckAfter: 3, capability: undefined, costWeight: undefined, pool: { strategy: 'pool' as const, accountIds: [], tags: ['w'] } } };
  return {
    id: 'one', name: 'one tier',
    nodes: [orch, w, gate],
    edges: [
      { id: 'e-dispatch', source: orch.id, target: 'worker', kind: 'dispatch' },
      { id: 'e-submit', source: 'worker', target: gate.id, kind: 'submit' },
      { id: 'e-retry', source: gate.id, target: 'worker', kind: 'reject_retry' },
      { id: 'e-report', source: gate.id, target: orch.id, kind: 'report' },
    ],
  };
}

function setup() {
  const d = mkdtempSync(join(tmpdir(), 'decomp-life-'));
  dirs.push(d);
  const store = new Store(openDatabase(join(d, 'orch.db')));
  const events = new EventBus(store);
  const repo = new SimRepo({ slots: 4, compareLatencyMs: [1, 3], infraRate: 0 });
  const accounts = [mockAccount('m', { tags: ['w'], options: { latencyMs: [1, 3], skill: 0.95 } })];
  const pool = new AccountPool(accounts, store, events, { circuitBaseMs: 100, rateLimitBaseMs: 20, overloadCooldownMs: 20 });
  const providers = new ProviderRegistry({ oracle: repo });
  const engine = new RunEngine({ store, pool, providers, repo, events }, { leaseMs: 5_000, heartbeatMs: 500, infraBackoffMs: 5, idlePollMs: 20 });
  cleanups.push(() => {
    pool.close();
    engine.close();
    if (store.db.open) store.db.close();
  });
  return { store, events, repo, engine };
}

const createRun = (s: ReturnType<typeof setup>, name: string, count = 12, seed = 3) =>
  s.engine.createRun(name, { flowId: 'default', selection: { source: 'synthetic', count, seed }, prBatchSize: 40 }, flow());

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('staging that fails re-verification', () => {
  it('creates no branch, leaves packets passed, and stages them again on request', async () => {
    const s = setup();
    const real = s.repo.stageBatch.bind(s.repo);
    s.repo.stageBatch = async (): Promise<StageBatchResult> => ({ branch: 'should-not-be-used', verified: false, problems: ['task_x: 0x1 code-mismatch'] });
    const run = createRun(s, 'fail-stage');
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);

    expect(s.store.getRun(run.id)!.status).toBe('completed');
    const fc = s.store.functionCounts(run.id);
    expect(fc.staged ?? 0).toBe(0);
    expect(fc.passed ?? 0).toBeGreaterThan(0);
    const batches = s.store.listBatches(run.id);
    expect(batches.length).toBeGreaterThan(0);
    for (const b of batches) {
      expect(b.status).toBe('failed');
      expect(b.branch).toBeNull();
    }

    s.repo.stageBatch = real;
    const r = await s.engine.restage(run.id);
    expect(r).toEqual({ staged: 1, failed: 0 });
    const after = s.store.functionCounts(run.id);
    expect(after.passed ?? 0).toBe(0);
    expect(after.staged ?? 0).toBe(fc.passed);
    expect(s.store.listBatches(run.id).filter((b) => b.status === 'branch_ready')).toHaveLength(1);
  }, 60_000);
});

describe('staging attribution', () => {
  it('names the model that finished each packet in the batch commit, with the run\'s person', async () => {
    const s = setup();
    const real = s.repo.stageBatch.bind(s.repo);
    const messages: string[] = [];
    s.repo.stageBatch = async (input: StageBatchInput) => {
      messages.push(input.message);
      return real(input);
    };
    const run = s.engine.createRun('attr', { flowId: 'default', selection: { source: 'synthetic', count: 6, seed: 5 }, prBatchSize: 40, draftedBy: 'v-macrev' }, flow());
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const models = s.store.db.prepare(`SELECT DISTINCT a.model FROM tasks t JOIN verdicts v ON v.id = t.last_verdict_id JOIN attempts a ON a.id = v.attempt_id WHERE t.run_id = ? AND t.state = 'staged'`).all(run.id) as Array<{ model: string }>;
    expect(models.length).toBeGreaterThan(0);
    expect(messages).toHaveLength(1);
    for (const { model } of models) expect(messages[0]).toContain(`(drafted by ${model})`);
    expect(messages[0]).toMatch(new RegExp(`\\nDrafted by v-macrev, assisted by ${models[0]!.model}`));
    const batch = s.store.listBatches(run.id)[0]!;
    expect((batch.detail as unknown as { draftedBy: string }).draftedBy).toMatch(/^v-macrev, assisted by /);
  }, 60_000);
});

describe('staging and the slot lock', () => {
  it('refuses to start another run while a finished run is still staging', async () => {
    const s = setup();
    const real = s.repo.stageBatch.bind(s.repo);
    let entered!: () => void;
    const inStaging = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.repo.stageBatch = async (input: StageBatchInput) => {
      entered();
      await gate;
      return real(input);
    };
    const a = createRun(s, 'a');
    const b = createRun(s, 'b', 6, 9);
    await s.engine.start(a.id);
    await inStaging;
    expect(s.engine.isIdle()).toBe(false);
    await expect(s.engine.start(b.id)).rejects.toThrow(/busy/);
    expect((await s.engine.retryFailedTasks(b.id)).ok).toBe(false);
    release();
    await s.engine.waitFor(a.id);
    expect(s.store.getRun(a.id)!.status).toBe('completed');
    expect(s.engine.isIdle()).toBe(true);
    await s.engine.start(b.id);
    await s.engine.waitFor(b.id);
    expect(s.store.getRun(b.id)!.status).toBe('completed');
  }, 60_000);
});

describe('a worker whose lease was lost before routing', () => {
  it('files the verdict as stale and neither moves the task nor announces a pass', async () => {
    const s = setup();
    const real = s.repo.compare.bind(s.repo);
    let stolen: string | null = null;
    s.repo.compare = async (...args: Parameters<SimRepo['compare']>) => {
      const out = await real(...args);
      if (!stolen) {
        stolen = args[1].id;
        s.store.db.prepare("UPDATE tasks SET lease_id = 'someone-else' WHERE id = ?").run(stolen);
      }
      return out;
    };
    const run = createRun(s, 'stale', 4);
    await s.engine.start(run.id);
    await until(() => stolen !== null && s.store.verdictsForTask(stolen).length > 0);
    const verdicts = s.store.verdictsForTask(stolen!);
    expect(verdicts.map((v) => v.route)).toEqual(['stale']);
    const task = s.store.getTask(stolen!)!;
    expect(task.lastVerdictId).toBeNull();
    expect(['leased', 'gating']).toContain(task.state);
    const events = s.store.db.prepare('SELECT kind FROM events WHERE task_id = ?').all(stolen) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toContain('task.stale');
    expect(events.map((e) => e.kind)).not.toContain('task.passed');
    await s.engine.cancel(run.id);
  }, 60_000);
});

describe('an infrastructure failure after the lease was lost', () => {
  it('files the verdict as stale and does not move or charge the task', async () => {
    const s = setup();
    let stolen: string | null = null;
    const realCompare = s.repo.compare.bind(s.repo);
    s.repo.compare = async (...args: Parameters<SimRepo['compare']>) => {
      if (!stolen) {
        stolen = args[1].id;
        s.store.db.prepare("UPDATE tasks SET lease_id = 'someone-else' WHERE id = ?").run(stolen);
        return { ...(await realCompare(...args)), completed: false, allPass: false, functions: [], infraError: 'comparator crashed' };
      }
      return realCompare(...args);
    };
    const run = createRun(s, 'infra-stale', 4);
    await s.engine.start(run.id);
    await until(() => stolen !== null && s.store.verdictsForTask(stolen).length > 0);
    expect(s.store.verdictsForTask(stolen!).map((v) => v.route)).toEqual(['stale']);
    const task = s.store.getTask(stolen!)!;
    expect(task.infraFailures).toBe(0);
    const kinds = (s.store.db.prepare('SELECT kind FROM events WHERE task_id = ?').all(stolen) as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('task.stale');
    expect(kinds).not.toContain('task.infra');
    await s.engine.cancel(run.id);
  }, 60_000);
});

describe('a slot whose worktree cannot be restored', () => {
  it('is parked and retried; its packets go back uncharged and the run completes', async () => {
    const s = setup();
    const real = s.repo.reset.bind(s.repo);
    let failures = 4;
    s.repo.reset = async (slot: number) => {
      if (slot === 0 && failures > 0) {
        failures--;
        throw new Error(`slot 0 could not be restored to a clean state: index.lock: File exists`);
      }
      return real(slot);
    };
    const engine = new RunEngine((s.engine as unknown as { deps: ConstructorParameters<typeof RunEngine>[0] }).deps, { leaseMs: 5_000, heartbeatMs: 500, infraBackoffMs: 5, idlePollMs: 20, slotParkBaseMs: 30, maxInfraFailures: 2 });
    cleanups.push(() => engine.close());
    const run = createRun(s, 'parked', 12);
    await engine.start(run.id);
    await engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    const kinds = (s.store.db.prepare('SELECT kind FROM events WHERE run_id = ?').all(run.id) as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('slot.parked');
    expect(kinds).toContain('slot.recovered');
    expect(kinds).not.toContain('task.dead'); // 4 failed restores, maxInfraFailures 2: none charged to a packet
    expect(s.store.taskCounts(run.id).dead ?? 0).toBe(0);
  }, 60_000);
});

describe('retrying failed packets of a paused run', () => {
  it('resumes the run so the requeued packets are worked', async () => {
    const s = setup();
    const run = createRun(s, 'paused-retry', 12);
    await s.engine.start(run.id);
    s.engine.pause(run.id, true);
    await until(() => (s.store.taskCounts(run.id).leased ?? 0) + (s.store.taskCounts(run.id).gating ?? 0) === 0);
    s.store.db.prepare("UPDATE tasks SET state = 'dead' WHERE run_id = ? AND state = 'pending'").run(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('paused');

    const r = await s.engine.retryFailedTasks(run.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('running');
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    const fc = s.store.taskCounts(run.id);
    expect((fc.pending ?? 0) + (fc.leased ?? 0) + (fc.gating ?? 0)).toBe(0);
  }, 60_000);

  it('starts a paused run that is not loaded as running, not paused', async () => {
    const s = setup();
    const run = createRun(s, 'cold-paused', 6);
    await s.engine.start(run.id);
    s.engine.pause(run.id, true);
    await until(() => (s.store.taskCounts(run.id).leased ?? 0) + (s.store.taskCounts(run.id).gating ?? 0) === 0);
    await s.engine.hardStop(); // like a server restart: the run stays paused in the store
    s.store.db.prepare("UPDATE tasks SET state = 'dead' WHERE run_id = ? AND state = 'pending'").run(run.id);
    // A fresh engine on the same database: the run is paused in the store but not active.
    const engine2 = new RunEngine((s.engine as unknown as { deps: ConstructorParameters<typeof RunEngine>[0] }).deps, { leaseMs: 5_000, heartbeatMs: 500, infraBackoffMs: 5, idlePollMs: 20 });
    cleanups.push(() => engine2.close());
    const r = await engine2.retryFailedTasks(run.id);
    expect(r.ok).toBe(true);
    await engine2.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
  }, 60_000);
});
