// SPDX-License-Identifier: AGPL-3.0-or-later
// Lifecycle boundaries where individually correct parts meet: staging that fails re-verification,
// staging overlapping another run, a worker whose lease was lost before routing, and retrying the
// failed packets of a paused run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFlow, type Flow } from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { readyThreshold, RunEngine } from '../src/orchestrator/engine.js';
import { batchContent, finishingModel, packUnits } from '../src/orchestrator/staging.js';
import type { FunctionTarget } from '@decomp/core';
import { matchedSides } from '../src/orchestrator/engine.js';
import type { PrComment, PrStatus } from '../src/repo/types.js';
import { commentLine, reviewComments, triageTargets } from '../src/orchestrator/review.js';
import type { TaskRow } from '../src/db/store.js';
import { AccountPool } from '../src/pool/scheduler.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SimRepo } from '../src/repo/simRepo.js';
import type { RepoAdapter, StageBatchInput, StageBatchResult, SubmitBatchInput, SubmitBatchResult } from '../src/repo/types.js';
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

function setup(accountOptions: Record<string, unknown> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'decomp-life-'));
  dirs.push(d);
  const store = new Store(openDatabase(join(d, 'orch.db')));
  const events = new EventBus(store);
  const repo = new SimRepo({ slots: 4, compareLatencyMs: [1, 3], infraRate: 0 });
  const accounts = [mockAccount('m', { tags: ['w', 'orchestrator'], options: { latencyMs: [1, 3], skill: 0.95, ...accountOptions } })];
  const pool = new AccountPool(accounts, store, events, { circuitBaseMs: 100, rateLimitBaseMs: 20, overloadCooldownMs: 20 });
  const providers = new ProviderRegistry({ oracle: repo });
  const engine = new RunEngine({ store, pool, providers, repo, events }, { leaseMs: 5_000, heartbeatMs: 500, infraBackoffMs: 5, idlePollMs: 20 });
  cleanups.push(() => {
    pool.close();
    engine.close();
    if (store.db.open) store.db.close();
  });
  return { store, events, repo, engine, providers };
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
    expect(r).toEqual({ staged: 1, failed: 0, seqs: [2] });
    const after = s.store.functionCounts(run.id);
    expect(after.passed ?? 0).toBe(0);
    expect(after.staged ?? 0).toBe(fc.passed);
    expect(s.store.listBatches(run.id).filter((b) => b.status === 'branch_ready')).toHaveLength(1);
  }, 60_000);
});

describe('a batch with one packet that does not compile', () => {
  it('keeps only that unit in the failed batch; the others are staged without it', async () => {
    const s = setup();
    const real = s.repo.stageBatch.bind(s.repo);
    let victim = '';
    s.repo.stageBatch = async (input: StageBatchInput) => {
      victim ||= input.tasks[0]!.id;
      if (!input.tasks.some((t) => t.id === victim)) return real(input);
      return { branch: null, verified: false, problems: [`${victim}: compile error: a.cpp(3): error C2039`], failedTaskIds: [victim] };
    };
    const run = createRun(s, 'one-bad');
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const unit = s.store.getTask(victim)!.unit;
    const [bad, good] = s.store.listBatches(run.id);
    expect(bad!.status).toBe('failed');
    expect(bad!.taskIds.map((id) => s.store.getTask(id)!.unit).every((u) => u === unit)).toBe(true);
    expect((bad!.detail as unknown as { functions: number }).functions).toBe(bad!.taskIds.reduce((n, id) => n + s.store.getTask(id)!.functions.length, 0));
    expect(good!.status).toBe('branch_ready');
    expect(good!.taskIds.length).toBeGreaterThan(0);
    for (const id of good!.taskIds) expect(s.store.getTask(id)).toMatchObject({ state: 'staged' });
    expect(s.store.getTask(victim)!.state).toBe('passed');
    expect(s.store.listBatches(run.id)).toHaveLength(2);
    // Once it is fixed, re-verifying the failed batch stages what is left of it.
    s.repo.stageBatch = real;
    expect(await s.engine.restageFailedAll(run.id)).toMatchObject({ staged: 1, failed: 0 });
    expect(s.store.functionCounts(run.id).passed ?? 0).toBe(0);
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
    // A packet that passed on a free attempt is drafted by the model whose code it submitted.
    for (const m of models) m.model = /^(?:stored candidate|splice) of (.+) (no model call)$/.exec(m.model)?.[1] ?? m.model;
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

describe('editing and deleting runs', () => {
  it('renames the person from then on, re-records held claims, and batches a staging-off run under the new name', async () => {
    const s = setup();
    const run = s.engine.createRun('off', { flowId: 'default', selection: { source: 'synthetic', count: 8, seed: 4 }, staging: 'off', draftedBy: 'decomp-orchestrator test' }, flow());
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    expect(s.store.functionCounts(run.id).passed ?? 0).toBeGreaterThan(0);
    const claims: string[] = [];
    (s.repo as RepoAdapter).recordAttribution = async (i) => {
      claims.push(i.draftedBy);
      return { ok: true, problems: [] };
    };
    const edited = await s.engine.updateRun(run.id, { draftedBy: 'v-macrev', name: 'real test', prBatchSize: 30 });
    expect(edited.name).toBe('real test');
    expect(edited.config.draftedBy).toBe('v-macrev');
    expect(edited.config.formerDraftedBy).toEqual(['decomp-orchestrator test']);
    expect(edited.config.prBatchSize).toBe(30);
    await expect(s.engine.updateRun(run.id, { staging: 'branches' })).rejects.toThrow(/decided when the run finishes/);
    expect(claims).toHaveLength(0); // a finished staging-off run holds no claims to re-record

    const messages: string[] = [];
    const real = s.repo.stageBatch.bind(s.repo);
    s.repo.stageBatch = async (input: StageBatchInput) => {
      messages.push(input.message);
      return real(input);
    };
    const r = await s.engine.restage(run.id);
    expect(r.staged).toBeGreaterThan(0);
    expect(claims.length).toBeGreaterThan(0); // batching takes the claims back, as the new person
    for (const c of claims) expect(c).toMatch(/^v-macrev, assisted by /);
    expect(messages[0]).toMatch(/\nDrafted by v-macrev, assisted by /);
    expect(s.store.functionCounts(run.id).passed ?? 0).toBe(0);
    await expect(s.engine.restage(run.id)).rejects.toThrow(/no passed packets/);
  }, 60_000);

  it('deletes a finished run with everything under it, and refuses a loaded one', async () => {
    const s = setup();
    const run = createRun(s, 'to-delete', 6, 8);
    await s.engine.start(run.id);
    await expect(s.engine.deleteRun(run.id)).rejects.toThrow(/loaded|cancel/);
    await s.engine.waitFor(run.id);
    const keep = createRun(s, 'keep', 4, 9);
    await s.engine.deleteRun(run.id);
    expect(s.store.getRun(run.id)).toBeNull();
    for (const t of ['tasks', 'attempts', 'pr_batches', 'run_workers', 'events']) {
      const n = (s.store.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE run_id = ?`).get(run.id) as { n: number }).n;
      expect(n, t).toBe(0);
    }
    expect(s.store.getRun(keep.id)).not.toBeNull();
  }, 60_000);

  it('keeps a run on partial claim cleanup and permits retrying deletion', async () => {
    const s = setup();
    const run = createRun(s, 'delete with claims', 6, 8);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    s.store.db.prepare("UPDATE tasks SET sr_task_id = 'claim-test' WHERE run_id = ?").run(run.id);
    let fail = true;
    (s.repo as RepoAdapter).releaseClaims = async (rvas) => rvas.map((rva, index) => (
      fail && index === 0 ? { rva, ok: false, error: 'claim file locked' } : { rva, ok: true, error: null }
    ));

    const first = await s.engine.deleteRun(run.id);
    expect(first).toMatchObject({ ok: false, failed: [{ rva: expect.any(String), error: 'claim file locked' }] });
    expect(first.released).toBeGreaterThan(0);
    expect(s.store.getRun(run.id)).not.toBeNull();
    expect(s.store.listTasks(run.id).length).toBeGreaterThan(0);

    fail = false;
    expect(await s.engine.deleteRun(run.id)).toMatchObject({ ok: true });
    expect(s.store.getRun(run.id)).toBeNull();
  }, 60_000);
});

describe('changing the flow of a running run', () => {
  it('applies model and attempt changes live, and refuses changes fixed at start', async () => {
    const s = setup();
    const run = createRun(s, 'live flow', 40, 5);
    await s.engine.start(run.id);
    const edited = flow();
    const worker = edited.nodes.find((n) => n.id === 'worker')!;
    worker.data = { ...worker.data, capability: 'frontier', maxAttempts: 9, pool: { ...worker.data.pool, capability: 'frontier' } };
    const updated = s.engine.updateRunFlow(run.id, edited);
    expect(updated.flow.nodes.find((n) => n.id === 'worker')!.data).toMatchObject({ capability: 'frontier', maxAttempts: 9 });
    expect(s.store.getRun(run.id)!.flow.nodes.find((n) => n.id === 'worker')!.data.maxAttempts).toBe(9);
    const ev = s.store.db.prepare(`SELECT msg FROM events WHERE run_id = ? AND kind = 'run.flow_updated'`).get(run.id) as { msg: string };
    expect(ev.msg).toMatch(/while running.*capability balanced → frontier/);

    const more = flow();
    more.nodes.find((n) => n.id === 'worker')!.data.instances = 5;
    expect(() => s.engine.updateRunFlow(run.id, more)).toThrow(/instances 4 ⇒ 5/);
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    expect(() => s.engine.updateRunFlow(run.id, edited)).toThrow(/completed/);
  }, 60_000);
});

describe('carrying failed functions into a new run', () => {
  it('adds the dead functions of earlier runs to the new run\'s selection', async () => {
    const s = setup();
    const first = createRun(s, 'first', 10, 11);
    await s.engine.start(first.id);
    await s.engine.waitFor(first.id);
    const victims = s.store.listTasks(first.id, { limit: 2 });
    s.store.db.prepare(`UPDATE tasks SET state = 'dead' WHERE id IN (?, ?)`).run(victims[0]!.id, victims[1]!.id);
    const dead = s.store.deadFunctions([first.id]);
    expect(dead.map((d) => d.rva).sort()).toEqual(victims.flatMap((t) => t.functions.map((f) => f.rva)).sort());

    const second = s.engine.createRun('second', { flowId: 'default', selection: { source: 'synthetic', count: 3, seed: 21 }, carry: { fromRuns: [first.id], rvas: dead.map((d) => d.rva) } }, flow());
    await s.engine.start(second.id);
    await s.engine.waitFor(second.id);
    const rvas = new Set(s.store.listTasks(second.id, { limit: 1000 }).flatMap((t) => t.functions.map((f) => f.rva)));
    for (const d of dead) expect(rvas.has(d.rva)).toBe(true);
    expect(rvas.size).toBe(3 + dead.length);
    const ev = s.store.db.prepare(`SELECT msg FROM events WHERE run_id = ? AND kind = 'run.carried'`).get(second.id) as { msg: string } | undefined;
    expect(ev?.msg).toMatch(new RegExp(`carried over ${dead.length} dead function`));
  }, 60_000);
});

describe('submitting a staged batch', () => {
  it('submits through the last unit\'s task, only marks a real submission, and never twice', async () => {
    const s = setup();
    const run = createRun(s, 'submit', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = s.store.listBatches(run.id).find((b) => b.status === 'branch_ready')!;
    expect(batch).toBeTruthy();
    const inputs: SubmitBatchInput[] = [];
    (s.repo as RepoAdapter).submitBatch = async (input): Promise<SubmitBatchResult> => {
      inputs.push(input);
      if (!input.dryRun && !input.allowUncheckedClaims) {
        return { ok: false, dryRun: false, submissionStarted: false, uncheckedClaims: ['one probe timed out'], problems: [], blockers: [], warnings: [], plan: [], pullRequest: null, link: null, error: 'Claims checks could not be completed' };
      }
      return { ok: true, dryRun: input.dryRun, problems: [], blockers: [], warnings: [], plan: input.dryRun ? ['would run: git push'] : [], pullRequest: input.dryRun ? null : 'https://github.com/o/r/pull/1', link: null, error: null };
    };

    await expect(s.engine.submitBatch(run.id, batch.id, { dryRun: false, allowUncheckedClaims: true })).rejects.toThrow(/clean dry run/);
    expect(inputs).toHaveLength(0);
    const dry = await s.engine.submitBatch(run.id, batch.id, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(s.store.getBatch(batch.id)!.status).toBe('branch_ready');
    const input = inputs[0]!;
    expect(input.dryRun).toBe(true);
    const units = input.tasks.map((t) => t.task.unit);
    expect(units.at(-1)).toBe([...units].sort().at(-1)); // the last unit is the one sr submit runs on
    if (new Set(units).size > 1) {
      expect(input.title).toMatch(/^Reconstruct \d+ functions$/);
      expect(input.extraBody).toContain('the others are:');
      expect(input.message).not.toContain(input.tasks.at(-1)!.functions[0]!.rva);
    }

    await s.engine.updateRun(run.id, { draftedBy: 'another drafter' });
    await expect(s.engine.submitBatch(run.id, batch.id, { dryRun: false })).rejects.toThrow(/clean dry run/);
    expect(inputs).toHaveLength(1);
    await s.engine.submitBatch(run.id, batch.id, { dryRun: true });
    const acceptedTask = s.store.getTask(batch.taskIds[0]!)!;
    s.store.db.prepare("UPDATE tasks SET sr_task_id = 'changed' WHERE id = ?").run(acceptedTask.id);
    await expect(s.engine.submitBatch(run.id, batch.id, { dryRun: false })).rejects.toThrow(/clean dry run/);
    s.store.db.prepare('UPDATE tasks SET sr_task_id = ? WHERE id = ?').run(acceptedTask.srTaskId, acceptedTask.id);
    await s.engine.submitBatch(run.id, batch.id, { dryRun: true });
    expect(await s.engine.submitBatch(run.id, batch.id, { dryRun: false })).toMatchObject({ ok: false, uncheckedClaims: ['one probe timed out'] });
    const real = await s.engine.submitBatch(run.id, batch.id, { dryRun: false, allowUncheckedClaims: true });
    expect(real.pullRequest).toBe('https://github.com/o/r/pull/1');
    const after = s.store.getBatch(batch.id)!;
    expect(after.status).toBe('submitted');
    expect((after.detail as unknown as { pr: string }).pr).toBe('https://github.com/o/r/pull/1');
    await expect(s.engine.submitBatch(run.id, batch.id, { dryRun: false })).rejects.toThrow(/already submitted/);
  }, 60_000);

  it('lets a dry run with unchecked claims through only with explicit acceptance, and re-arms only for unchecked claims', async () => {
    const s = setup();
    const run = createRun(s, 'unchecked', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = s.store.listBatches(run.id).find((b) => b.status === 'branch_ready')!;
    const inputs: SubmitBatchInput[] = [];
    let mode: 'unchecked' | 'problems' | 'ok' = 'unchecked';
    (s.repo as RepoAdapter).submitBatch = async (input): Promise<SubmitBatchResult> => {
      inputs.push(input);
      const base = { dryRun: input.dryRun, warnings: [], plan: [], pullRequest: null, link: null };
      if (mode === 'problems') return { ...base, ok: false, submissionStarted: false, problems: ['t1: compile error'], blockers: [], error: null };
      if (mode === 'unchecked' && (input.dryRun || !input.allowUncheckedClaims)) {
        return { ...base, ok: false, submissionStarted: false, uncheckedClaims: ['t1: claims check timed out'], problems: [], blockers: [], error: 'Claims checks could not be completed for the entire batch' };
      }
      return { ...base, ok: true, submissionStarted: !input.dryRun, problems: [], blockers: [], error: null, pullRequest: input.dryRun ? null : 'https://github.com/o/r/pull/2' };
    };
    const detail = () => s.store.getBatch(batch.id)!.detail as unknown as { dryRunFingerprint?: string; dryRunUncheckedClaims?: string[] };

    // The dry run could not check one task's claims: the prerequisite is held, marked unchecked.
    expect(await s.engine.submitBatch(run.id, batch.id, { dryRun: true })).toMatchObject({ ok: false, uncheckedClaims: ['t1: claims check timed out'] });
    expect(detail()).toMatchObject({ dryRunFingerprint: expect.any(String), dryRunUncheckedClaims: ['t1: claims check timed out'] });
    // A plain submission is refused before anything runs; the prerequisite survives the refusal.
    await expect(s.engine.submitBatch(run.id, batch.id, { dryRun: false })).rejects.toThrow(/explicitly accept/);
    expect(inputs).toHaveLength(1);
    expect(detail().dryRunFingerprint).toBeTruthy();

    // A real attempt that re-verifies with problems spends the prerequisite: a new dry run is needed.
    mode = 'problems';
    expect(await s.engine.submitBatch(run.id, batch.id, { dryRun: false, allowUncheckedClaims: true })).toMatchObject({ ok: false });
    expect(detail().dryRunFingerprint).toBeUndefined();
    await expect(s.engine.submitBatch(run.id, batch.id, { dryRun: false, allowUncheckedClaims: true })).rejects.toThrow(/clean dry run/);

    // Unchecked again; the operator accepts it explicitly and the submission goes through.
    mode = 'unchecked';
    await s.engine.submitBatch(run.id, batch.id, { dryRun: true });
    const real = await s.engine.submitBatch(run.id, batch.id, { dryRun: false, allowUncheckedClaims: true });
    expect(real).toMatchObject({ ok: true, pullRequest: 'https://github.com/o/r/pull/2' });
    expect(inputs.at(-1)).toMatchObject({ dryRun: false, allowUncheckedClaims: true });
    expect(s.store.getBatch(batch.id)!.status).toBe('submitted');
  }, 60_000);

  it('refuses a batch whose re-verification failed, and adapters that cannot submit', async () => {
    const s = setup();
    const run = createRun(s, 'nosubmit', 6, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = s.store.listBatches(run.id)[0]!;
    await expect(s.engine.submitBatch(run.id, batch.id, { dryRun: true })).rejects.toThrow(/cannot submit/);
    s.store.updateBatch(batch.id, { status: 'failed' });
    (s.repo as RepoAdapter).submitBatch = async () => { throw new Error('must not be called'); };
    await expect(s.engine.submitBatch(run.id, batch.id, { dryRun: true })).rejects.toThrow(/only a re-verified batch/);
  }, 60_000);
});

describe('dropping packets that collide with other contributors\' claims', () => {
  const claim = (n: number, author = 'someone-else') => [{ url: `https://github.com/o/r/issues/${n}`, author, updatedAt: '2026-11-20T23:45:08Z' }];

  it('withholds the colliding units, restages the rest as a new batch, and returns them once the claim is gone', async () => {
    const s = setup();
    const run = createRun(s, 'collide', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = s.store.listBatches(run.id).find((b) => b.status === 'branch_ready')!;
    const tasks = batch.taskIds.map((id) => s.store.getTask(id)!);
    expect(new Set(tasks.map((t) => t.unit)).size).toBeGreaterThan(1);
    const victim = tasks[0]!;
    const unitTasks = tasks.filter((t) => t.unit === victim.unit);
    s.repo.claimedByOthers.set(victim.functions[0]!.rva, claim(606));

    const r = await s.engine.dropCollidingPackets(run.id, batch.id);
    expect(r.withheldTasks).toBe(unitTasks.length);
    expect(r.units).toEqual([victim.unit]);
    expect(Object.keys(r.collisions)).toEqual([victim.functions[0]!.rva]);
    for (const t of unitTasks) expect(s.store.getTask(t.id)!.state).toBe('withheld');
    const old = s.store.getBatch(batch.id)!;
    expect(old.status).toBe('superseded');
    expect(old.branch).toBeNull();
    const detail = old.detail as unknown as { withheld: { taskIds: string[] }; supersededBy: number[] };
    expect(detail.withheld.taskIds.sort()).toEqual(unitTasks.map((t) => t.id).sort());
    expect(r.staged?.seqs).toEqual(detail.supersededBy);
    const next = s.store.listBatches(run.id).find((b) => b.seq === detail.supersededBy[0])!;
    expect(next.status).toBe('branch_ready');
    expect(next.taskIds.sort()).toEqual(tasks.filter((t) => t.unit !== victim.unit).map((t) => t.id).sort());
    for (const id of next.taskIds) expect(s.store.getTask(id)!.state).toBe('staged');
    // Withheld packets are not 'passed': plain staging does not pick them up.
    await expect(s.engine.restage(run.id)).rejects.toThrow(/no passed packets/);
    // A clean batch is left as it is.
    expect(await s.engine.dropCollidingPackets(run.id, next.id)).toMatchObject({ withheldTasks: 0, staged: null });
    expect(s.store.getBatch(next.id)!.status).toBe('branch_ready');

    // Still claimed: nothing comes back.
    expect(await s.engine.recheckWithheld(run.id)).toMatchObject({ returnedTasks: 0, stillWithheldTasks: unitTasks.length, staged: null });
    for (const t of unitTasks) expect(s.store.getTask(t.id)!.state).toBe('withheld');
    // The claim lapsed: the unit is batched again.
    s.repo.claimedByOthers.clear();
    const back = await s.engine.recheckWithheld(run.id);
    expect(back).toMatchObject({ returnedTasks: unitTasks.length, stillWithheldTasks: 0 });
    const again = s.store.listBatches(run.id).find((b) => b.seq === back.staged!.seqs[0])!;
    expect(again.status).toBe('branch_ready');
    expect(again.taskIds.sort()).toEqual(unitTasks.map((t) => t.id).sort());
    await expect(s.engine.recheckWithheld(run.id)).rejects.toThrow(/no withheld packets/);
  }, 60_000);

  it('changes nothing when claims cannot be checked, and never touches a submitted batch', async () => {
    const s = setup();
    const run = createRun(s, 'unchecked-claims', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = s.store.listBatches(run.id).find((b) => b.status === 'branch_ready')!;
    s.repo.claimCollisions = async () => ({ checked: false, error: 'offline', collisions: {} });
    await expect(s.engine.dropCollidingPackets(run.id, batch.id)).rejects.toThrow(/could not be checked, nothing changed: offline/);
    expect(s.store.getBatch(batch.id)!.status).toBe('branch_ready');
    for (const id of batch.taskIds) expect(s.store.getTask(id)!.state).toBe('staged');

    s.store.updateBatch(batch.id, { status: 'submitted', detail: { pr: 'https://github.com/o/r/pull/9' } });
    await expect(s.engine.dropCollidingPackets(run.id, batch.id)).rejects.toThrow(/only an unsubmitted staged batch/);
  }, 60_000);
});

describe('dropping colliding packets from every batch at once', () => {
  it('checks claims once, splits only the batches that collide, restages their rest together and marks the others clear', async () => {
    const s = setup();
    const run = s.engine.createRun('collide-all', { flowId: 'default', selection: { source: 'synthetic', count: 36, seed: 5 }, prBatchSize: 12 }, flow());
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const ready = s.store.listBatches(run.id).filter((b) => b.status === 'branch_ready');
    expect(ready.length).toBeGreaterThan(2);
    // A collision in the first batch, none elsewhere; the first batch must keep at least one unit.
    const victimBatch = ready.find((b) => new Set(b.taskIds.map((id) => s.store.getTask(id)!.unit)).size > 1)!;
    expect(victimBatch).toBeTruthy();
    const victim = s.store.getTask(victimBatch.taskIds[0]!)!;
    s.repo.claimedByOthers.set(victim.functions[0]!.rva, [{ url: 'https://github.com/o/r/issues/7', author: 'someone-else', updatedAt: '2026-11-20T23:45:08Z' }]);
    let checks = 0;
    const real = s.repo.claimCollisions.bind(s.repo);
    s.repo.claimCollisions = async (rvas) => {
      checks++;
      return real(rvas);
    };

    const r = await s.engine.dropCollidingPacketsAll(run.id);
    expect(checks).toBe(1);
    expect(r.batches).toHaveLength(ready.length);
    const hit = r.batches.filter((x) => x.withheldTasks);
    expect(hit.map((x) => x.batchId)).toEqual([victimBatch.id]);
    expect(s.store.getBatch(victimBatch.id)!.status).toBe('superseded');
    for (const b of ready.filter((x) => x.id !== victimBatch.id)) {
      const now = s.store.getBatch(b.id)!;
      expect(now.status).toBe('branch_ready');
      expect((now.detail as unknown as { claimCheck: { collisions: object } }).claimCheck.collisions).toEqual({});
    }
    const fresh = s.engine.listBatches(run.id).filter((b) => r.staged!.seqs.includes(b.seq));
    expect(fresh.flatMap((b) => b.taskIds).sort()).toEqual(victimBatch.taskIds.filter((id) => s.store.getTask(id)!.unit !== victim.unit).sort());
    for (const b of fresh) expect((b.detail as unknown as { claimCheck: { collisions: object } }).claimCheck.collisions).toEqual({});
    // The batch list shows every function with its packet's state now.
    const old = s.engine.listBatches(run.id).find((b) => b.id === victimBatch.id)!;
    expect(old.functions.filter((f) => f.unit === victim.unit).every((f) => f.state === 'withheld')).toBe(true);
    expect(old.functions.filter((f) => f.unit !== victim.unit).every((f) => f.state === 'staged')).toBe(true);
    // Nothing left to drop from: every staged batch is clear now.
    expect((await s.engine.dropCollidingPacketsAll(run.id)).withheldTasks).toBe(0);
  }, 60_000);
});

describe('live progress and interrupted staging', () => {
  it('reports what the slot-holding operation is doing while it runs, and nothing after', async () => {
    const s = setup();
    const run = createRun(s, 'progress', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    expect(s.engine.operation()).toBeNull();
    const batch = s.store.listBatches(run.id).find((b) => b.status === 'branch_ready')!;
    const victim = s.store.getTask(batch.taskIds[0]!)!;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    s.repo.claimCollisions = async () => {
      await gate;
      return { checked: true, error: null, collisions: { [victim.functions[0]!.rva]: [{ url: 'https://github.com/o/r/issues/7', author: 'x', updatedAt: null }] } };
    };
    const seen: string[] = [];
    const real = s.repo.stageBatch.bind(s.repo);
    s.repo.stageBatch = async (input) => {
      input.progress?.('re-verify', 'sr compare t1', 0, input.tasks.length);
      seen.push(s.engine.operation()!.step);
      return real(input);
    };
    const pending = s.engine.dropCollidingPacketsAll(run.id);
    await until(() => !!s.engine.operation()?.step.startsWith('Checking'));
    const op = s.engine.operation()!;
    expect(op.runId).toBe(run.id);
    expect(op.step).toMatch(/^Checking \d+ functions in 1 batch\(es\) against GitHub/);
    release();
    const r = await pending;
    if (r.staged?.seqs.length) {
      expect(seen[0]).toMatch(/^Re-verifying batch \d+: \d+ functions in \d+ packet\(s\)$/);
    }
    expect(s.engine.operation()).toBeNull();
  }, 60_000);

  it('marks a batch left in draft by a restart as interrupted and re-verifies exactly its packets', async () => {
    const s = setup();
    const run = createRun(s, 'interrupted', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = s.store.listBatches(run.id).find((b) => b.status === 'branch_ready')!;
    // What a restart mid-staging leaves behind: a draft batch whose packets are still passed.
    s.store.unstageBatch(batch, batch.detail);
    const draftId = 'batch_draft_test';
    s.store.createBatch({ id: draftId, runId: run.id, seq: s.store.maxBatchSeq(run.id) + 1, taskIds: batch.taskIds });
    expect(s.engine.markInterruptedBatches()).toBe(1);
    expect(s.store.getBatch(draftId)!.status).toBe('interrupted');
    await expect(s.engine.restageInterrupted(run.id, batch.id)).rejects.toThrow(/only an interrupted or failed batch/);

    const r = await s.engine.restageInterrupted(run.id, draftId);
    expect(r.staged).toBe(1);
    const fresh = s.store.listBatches(run.id).find((b) => b.seq === r.seqs[0])!;
    expect(fresh.status).toBe('branch_ready');
    expect(fresh.taskIds.sort()).toEqual([...batch.taskIds].sort());
    expect(s.store.getBatch(draftId)).toMatchObject({ status: 'superseded', detail: expect.objectContaining({ supersededBy: r.seqs }) });
  }, 60_000);
});

describe('handling what blocks a batch', () => {
  const batchOf = (s: ReturnType<typeof setup>, runId: string) => s.store.listBatches(runId).find((b) => b.status === 'branch_ready')!;

  it('sets aside units upstream already matched or changed, restages the rest, and puts them back on request', async () => {
    const s = setup();
    const run = createRun(s, 'upstream', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = batchOf(s, run.id);
    const tasks = batch.taskIds.map((id) => s.store.getTask(id)!);
    const [a, b] = [...new Set(tasks.map((t) => t.unit))];
    const matchedTask = tasks.find((t) => t.unit === a)!;
    s.repo.upstreamMatched.set(matchedTask.functions[0]!.rva, 'someone');
    s.repo.upstreamChanged.add(b!);

    const r = await s.engine.setAsideUpstreamAll(run.id);
    expect(r.setAsideTasks).toBe(tasks.filter((t) => t.unit === a || t.unit === b).length);
    const old = s.store.getBatch(batch.id)!;
    expect(old.status).toBe('superseded');
    const d = old.detail as unknown as { setAside: { reasons: Record<string, string[]> }; supersededBy: number[] };
    expect(d.setAside.reasons[a!]![0]).toMatch(/already matched upstream: 0x[0-9a-f]+ \(someone\)/);
    expect(d.setAside.reasons[b!]![0]).toMatch(/upstream changed this file since the batch was built/);
    for (const t of tasks) expect(s.store.getTask(t.id)!.state).toBe(t.unit === a || t.unit === b ? 'set_aside' : 'staged');
    expect(d.supersededBy).toEqual(r.staged!.seqs);
    // Set-aside packets are not 'passed': plain staging leaves them alone.
    await expect(s.engine.restage(run.id)).rejects.toThrow(/no passed packets/);

    const back = await s.engine.putBackSetAside(run.id, [a!]);
    expect(back.returnedTasks).toBe(tasks.filter((t) => t.unit === a).length);
    for (const t of tasks.filter((x) => x.unit === a)) expect(s.store.getTask(t.id)!.state).toBe('staged');
    for (const t of tasks.filter((x) => x.unit === b)) expect(s.store.getTask(t.id)!.state).toBe('set_aside');
  }, 60_000);

  it('a dry run stops at upstream findings before any compile, and "set aside blocking units" acts on them', async () => {
    const s = setup();
    const run = createRun(s, 'upstream-dry', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = batchOf(s, run.id);
    const tasks = batch.taskIds.map((id) => s.store.getTask(id)!);
    let calls = 0;
    (s.repo as RepoAdapter).submitBatch = async () => {
      calls++;
      throw new Error('must not be called');
    };
    const victim = tasks[0]!;
    s.repo.upstreamMatched.set(victim.functions[0]!.rva, null);
    const r = await s.engine.submitBatch(run.id, batch.id, { dryRun: true });
    expect(r).toMatchObject({ ok: false, blockers: [expect.stringMatching(new RegExp(`^${victim.unit}:1: already matched upstream`))] });
    expect(calls).toBe(0);
    expect(await s.engine.blockingUnits(run.id, batch.id)).toMatchObject({ units: { [victim.unit]: [expect.any(String)] }, unattributed: [] });
    const out = await s.engine.setAsideBlocking(run.id, batch.id);
    expect(out.setAsideTasks).toBe(tasks.filter((t) => t.unit === victim.unit).length);
    expect(s.store.getTask(victim.id)!.state).toBe('set_aside');
  }, 60_000);

  it('blames a file the batch reaches through its includes, and refuses to set aside for a file upstream changed since the pin', async () => {
    const s = setup();
    const run = createRun(s, 'stale-pin', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = batchOf(s, run.id);
    const tasks = batch.taskIds.map((id) => s.store.getTask(id)!);
    const victim = tasks[0]!;
    const dir = victim.unit.includes('/') ? victim.unit.slice(0, victim.unit.lastIndexOf('/')) : '';
    const deep = `${dir}/Deep.h`;
    // The unit includes Sim.h, which includes Deep.h: the screen followed the includes to Deep.h.
    s.repo.baseFile = async (p: string) => (p === `${dir}/Sim.h` ? '#pragma once\n#include "Deep.h"\n' : p === deep ? '#pragma once\n#include "../../x/Y.h"\n' : null);
    const finding = `${deep}:2: deterministic screen: include-outside-roots; fix: use a reconstruction-root header path`;
    s.store.updateBatch(batch.id, { detail: { ...(batch.detail as unknown as Record<string, unknown>), lastSubmit: { dryRun: true, ok: false, blockers: [finding], problems: [] } } });
    const blame = await s.engine.blockingUnits(run.id, batch.id);
    expect(Object.keys(blame.units)).toContain(victim.unit);
    expect(blame.unattributed).toEqual([]);
    expect(blame.fixedUpstream).toEqual([]);

    // Upstream fixed Deep.h after the base the dry run checked: a fresh dry run is the remedy, not a set-aside.
    let atPin = false;
    let since: string | null | undefined;
    (s.repo as RepoAdapter).baseDrift = async (files, from) => {
      since = from;
      const changed = files.filter((f) => f === deep);
      return { since: from ?? 'a'.repeat(40), pinned: 'c'.repeat(40), upstream: 'b'.repeat(40), behind: 34, changed, changedAtPin: atPin ? changed : [] };
    };
    s.store.updateBatch(batch.id, { detail: { ...(s.store.getBatch(batch.id)!.detail as unknown as Record<string, unknown>), lastSubmit: { dryRun: true, ok: false, blockers: [finding], problems: [], base: 'a'.repeat(40) } } });
    const stale = await s.engine.blockingUnits(run.id, batch.id);
    expect(since).toBe('a'.repeat(40));
    expect(stale.fixedUpstream).toEqual([finding]);
    // Only the upstream branch has the change: restart, then dry-run.
    await expect(s.engine.setAsideBlocking(run.id, batch.id)).rejects.toThrow(/after the base the last dry run checked \(aaaaaaaaaa; upstream is 34 commit\(s\) ahead.*restart the server/);
    expect((await s.engine.fixPlan(run.id, batch.id)).why).toMatch(/restart the server/);
    // The pinned base already has it: just dry-run again.
    atPin = true;
    await expect(s.engine.setAsideBlocking(run.id, batch.id)).rejects.toThrow(/already works on that newer base, so run the dry run again/);
    for (const t of tasks) expect(s.store.getTask(t.id)!.state).toBe('staged');
  }, 60_000);

  it('blames an upstream file the lint reaches through a header the batch changes', async () => {
    const s = setup();
    const run = createRun(s, 'lint-blame', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = batchOf(s, run.id);
    const tasks = batch.taskIds.map((id) => s.store.getTask(id)!);
    const victim = tasks[0]!;
    const header = 'src/lib/Owned.h';
    const dir = victim.unit.includes('/') ? victim.unit.slice(0, victim.unit.lastIndexOf('/')) : '';
    // The victim's unit file is what the batch writes; an upstream file includes it by a relative name.
    const unitName = victim.unit.slice(victim.unit.lastIndexOf('/') + 1);
    s.repo.baseFile = async (p: string) => (p === `${dir}/Upstream.cpp` ? `// upstream\n#include "${unitName}"\n` : p === header ? '' : null);
    s.store.updateBatch(batch.id, { detail: { ...(batch.detail as unknown as Record<string, unknown>), lastSubmit: { dryRun: true, ok: false, blockers: [
      `${dir}/Upstream.cpp:1: missing reconstruction origin statement in leading header; fix: add one`,
      'nowhere/Else.cpp:1: missing reconstruction origin statement',
      'contrib-x: another open claim or pull request names 0x1: https://github.com/o/r/issues/1',
    ], problems: [] } } });
    const blame = await s.engine.blockingUnits(run.id, batch.id);
    expect(Object.keys(blame.units)).toEqual([victim.unit]);
    expect(blame.unattributed).toEqual(['nowhere/Else.cpp:1: missing reconstruction origin statement']);
    expect(blame.claims).toHaveLength(1);
    // Neither finding is in a file the batch writes: the agents get nothing, and are told why.
    expect(blame.outside).toEqual([`${dir}/Upstream.cpp:1: missing reconstruction origin statement in leading header; fix: add one`, 'nowhere/Else.cpp:1: missing reconstruction origin statement']);
    const plan = await s.engine.fixPlan(run.id, batch.id);
    expect(plan.targets).toEqual([]);
    expect(plan.why).toMatch(/does not write/);
    await expect(s.engine.fixBatchWithAgents(run.id, batch.id)).rejects.toThrow(/does not write/);
    expect(s.engine.listBatches(run.id).find((b) => b.id === batch.id)!.outside).toHaveLength(2);
    // A finding in the victim's own file still goes to the agents.
    s.store.updateBatch(batch.id, { detail: { ...(s.store.getBatch(batch.id)!.detail as unknown as Record<string, unknown>), lastSubmit: { dryRun: true, ok: false, blockers: [
      `${victim.unit}:3: deterministic screen: include-outside-roots; fix: use a reconstruction-root header path`,
      `${dir}/Upstream.cpp:1: missing reconstruction origin statement in leading header; fix: add one`,
    ], problems: [] } } });
    const mixed = await s.engine.fixPlan(run.id, batch.id);
    expect(new Set(mixed.targets.map((t) => t.task.unit))).toEqual(new Set([victim.unit]));
    for (const t of mixed.targets) expect(t.reasons).toEqual([`${victim.unit}:3: deterministic screen: include-outside-roots; fix: use a reconstruction-root header path`]);
  }, 60_000);

  it('"Prepare all for PR" sets aside upstream work, withholds claimed units, and dry-runs the rest clean', async () => {
    const s = setup();
    const run = createRun(s, 'prepare', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const tasks = s.store.listBatches(run.id).filter((b) => b.status === 'branch_ready').flatMap((b) => b.taskIds.map((id) => s.store.getTask(id)!));
    const units = [...new Set(tasks.map((t) => t.unit))];
    expect(units.length).toBeGreaterThanOrEqual(3);
    const upstreamTask = tasks.find((t) => t.unit === units[0])!;
    const claimedTask = tasks.find((t) => t.unit === units[1])!;
    s.repo.upstreamMatched.set(upstreamTask.functions[0]!.rva, 'someone');
    const claimedRva = claimedTask.functions[0]!.rva;
    s.repo.claimedByOthers.set(claimedRva, [{ url: 'https://github.com/o/r/issues/7', author: 'x', updatedAt: new Date().toISOString() }]);
    let dryRuns = 0;
    (s.repo as RepoAdapter).submitBatch = async (input) => {
      dryRuns++;
      const hit = input.tasks.find((t) => t.functions.some((fn) => fn.rva === claimedRva));
      const blockers = hit ? [`${hit.srTaskId}: another open claim or pull request names ${claimedRva}: https://github.com/o/r/issues/7 (talk to them, or pass --ack-collision)`] : [];
      return { ok: !hit, dryRun: input.dryRun, submissionStarted: false, problems: [], blockers, warnings: [], plan: [], pullRequest: null, link: null, error: hit ? 'Submission preflight found blockers' : null };
    };
    const r = await s.engine.prepareAll(run.id);
    expect(r.cancelled).toBe(false);
    expect(r.needsYou).toEqual([]);
    expect(r.ready.length).toBeGreaterThan(0);
    for (const t of tasks) {
      const state = s.store.getTask(t.id)!.state;
      expect(state).toBe(t.unit === units[0] ? 'set_aside' : t.unit === units[1] ? 'withheld' : 'staged');
    }
    // Every batch still open has a clean dry run at this base: a second pass does no dry runs.
    const before = dryRuns;
    const again = await s.engine.prepareAll(run.id);
    expect(dryRuns).toBe(before);
    expect(again.ready.sort()).toEqual(r.ready.sort());
  }, 60_000);

  it('re-verifies every failed batch as new batches and knows when a withheld claim lapses', async () => {
    const s = setup();
    const run = createRun(s, 'refail', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = batchOf(s, run.id);
    // As if re-verification had failed: no branch, packets still passed.
    s.store.unstageBatch(batch, { problems: ['x'] });
    s.store.updateBatch(batch.id, { status: 'failed' });
    const r = await s.engine.restageFailedAll(run.id);
    expect(r.staged).toBeGreaterThan(0);
    expect(s.store.getBatch(batch.id)).toMatchObject({ status: 'superseded', detail: expect.objectContaining({ supersededBy: r.seqs }) });
    await expect(s.engine.restageFailedAll(run.id)).rejects.toThrow(/no failed batch/);

    const next = s.store.listBatches(run.id).find((b) => b.seq === r.seqs[0])!;
    const t = s.store.getTask(next.taskIds[0]!)!;
    s.repo.claimedByOthers.set(t.functions[0]!.rva, [{ url: 'https://github.com/o/r/issues/9', author: 'x', updatedAt: '2026-11-20T10:00:00Z' }]);
    await s.engine.dropCollidingPackets(run.id, next.id);
    expect(s.engine.nextWithheldLapse(run.id)).toBe(Date.parse('2026-11-20T10:00:00Z') + 24 * 3_600_000);
  }, 60_000);

  it('"Fix with AI agents" sends a failed batch\'s failing packets through the flow again and batches them when the run finishes', async () => {
    const s = setup();
    const run = createRun(s, 'fix', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = batchOf(s, run.id);
    const [victim, ...rest] = batch.taskIds.map((id) => s.store.getTask(id)!);
    const passedVerdict = victim!.lastVerdictId;
    const attemptsBefore = victim!.attemptsTotal;
    // As if re-verification had failed for one packet in the combined tree.
    s.store.unstageBatch(batch, { problems: [`${victim!.id}: ${victim!.functions[0]!.rva} mismatch at +0x12`], failedTaskIds: [victim!.id] });
    s.store.updateBatch(batch.id, { status: 'failed' });
    const plan = await s.engine.fixPlan(run.id, batch.id);
    expect(plan.targets.map((t) => t.task.id)).toEqual([victim!.id]);
    expect(plan.targets[0]!.reasons[0]).toMatch(/mismatch at \+0x12/);

    const r = await s.engine.fixBatchWithAgents(run.id, batch.id);
    expect(r).toMatchObject({ ok: true, check: 're-verify', requeued: 1, kept: rest.length });
    expect(s.store.getTask(victim!.id)!.fix).toMatchObject({ batchId: batch.id, check: 're-verify', verdictId: passedVerdict });
    expect(s.store.getBatch(batch.id)).toMatchObject({ status: 'superseded', detail: expect.objectContaining({ fixed: expect.objectContaining({ taskIds: [victim!.id] }) }) });
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    const after = s.store.getTask(victim!.id)!;
    expect(after.attemptsTotal).toBeGreaterThan(attemptsBefore);
    expect(after.lastVerdictId).not.toBe(passedVerdict);
    // The fixed packet and the ones kept matched are batched and re-verified again.
    expect(after.state).toBe('staged');
    for (const t of rest) expect(s.store.getTask(t.id)!.state).toBe('staged');
    await expect(s.engine.fixBatchWithAgents(run.id, batch.id)).rejects.toThrow(/nothing the agents can fix/);
  }, 60_000);

  it('"Fix with AI agents" takes the units a failed dry run blamed, never claims or upstream findings', async () => {
    const s = setup();
    const run = createRun(s, 'fix-dry', 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = batchOf(s, run.id);
    const tasks = batch.taskIds.map((id) => s.store.getTask(id)!);
    const victim = tasks[0]!;
    const withDry = (blockers: string[]) => s.store.updateBatch(batch.id, { detail: { ...(s.store.getBatch(batch.id)!.detail as unknown as Record<string, unknown>), lastSubmit: { dryRun: true, ok: false, blockers, problems: [] } } });
    withDry(['contrib-x: another open claim or pull request names 0x1: https://github.com/o/r/issues/1']);
    await expect(s.engine.fixBatchWithAgents(run.id, batch.id)).rejects.toThrow(/claims block it/);
    withDry([`${victim.unit}:1: already matched upstream: ${victim.functions[0]!.rva}; nothing to submit for it`]);
    await expect(s.engine.fixBatchWithAgents(run.id, batch.id)).rejects.toThrow(/upstream already has/);
    withDry([`${victim.unit}:1: missing reconstruction origin statement in leading header`]);
    const plan = await s.engine.fixPlan(run.id, batch.id);
    expect(new Set(plan.targets.map((t) => t.task.unit))).toEqual(new Set([victim.unit]));
    const r = await s.engine.fixBatchWithAgents(run.id, batch.id);
    expect(r.check).toBe('dry-run');
    expect(r.requeued).toBe(tasks.filter((t) => t.unit === victim.unit).length);
    await s.engine.waitFor(run.id);
    // Back through the flow: attempted again by the workers (the simulator's agent repeats its passing
    // candidate, which the Gate Keeper refuses as a repeat; a model reads the dry-run finding instead).
    const after = s.store.getTask(victim.id)!;
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    expect(after.attemptsTotal).toBeGreaterThan(victim.attemptsTotal);
    expect(['staged', 'dead']).toContain(after.state);
    for (const t of tasks.filter((x) => x.unit !== victim.unit)) expect(s.store.getTask(t.id)!.state).toBe('staged');
  }, 60_000);
});

describe('combining batches into bigger ones', () => {
  it('packs whole units into as few batches as fit, biggest first', () => {
    const u = (unit: string, functions: number) => ({ unit, functions, items: [unit] });
    expect(packUnits([u('a', 4), u('b', 3)], 60)).toEqual([['a', 'b']]);
    expect(packUnits([u('a', 30), u('b', 40), u('c', 25), u('d', 20)], 60)).toEqual([['b', 'd'], ['a', 'c']]);
    // A unit bigger than the cap stays whole, as a batch of its own.
    expect(packUnits([u('big', 70), u('s', 5)], 60)).toEqual([['big'], ['s']]);
  });

  it('regroups unsubmitted batches into fewer, re-verified ones and leaves submitted ones alone', async () => {
    const s = setup();
    const run = createRun(s, 'regroup', 12, 3);
    await s.engine.updateRun(run.id, { prBatchSize: 3 });
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const before = s.store.listBatches(run.id).filter((b) => b.status === 'branch_ready');
    expect(before.length).toBeGreaterThan(2);
    // One of them was submitted: it is never regrouped.
    const sent = before[0]!;
    s.store.updateBatch(sent.id, { status: 'submitted', detail: { ...(sent.detail as unknown as Record<string, unknown>), pr: 'https://github.com/o/r/pull/1' } });
    const rest = before.slice(1);
    const plan = s.engine.rebalancePlan(run.id);
    expect(plan.batches.map((b) => b.seq)).toEqual(rest.map((b) => b.seq));
    expect(plan.after).toHaveLength(1);

    const r = await s.engine.rebalanceBatches(run.id);
    expect(r.from).toEqual(rest.map((b) => b.seq));
    expect(r.staged.seqs).toHaveLength(1);
    const merged = s.store.listBatches(run.id).find((b) => b.seq === r.staged.seqs[0])!;
    expect(merged.status).toBe('branch_ready');
    expect(new Set(merged.taskIds)).toEqual(new Set(rest.flatMap((b) => b.taskIds)));
    for (const b of rest) expect(s.store.getBatch(b.id)).toMatchObject({ status: 'superseded', detail: expect.objectContaining({ rebalanced: expect.objectContaining({ max: 60 }), supersededBy: r.staged.seqs }) });
    expect(s.store.getBatch(sent.id)!.status).toBe('submitted');
    for (const id of merged.taskIds) expect(s.store.getTask(id)!.state).toBe('staged');
    await expect(s.engine.rebalanceBatches(run.id)).rejects.toThrow(/nothing to regroup/);
  }, 60_000);
});

describe('pull requests after submission', () => {
  const PR = 'https://github.com/o/r/pull/9';
  const comment = (over: Partial<PrComment>): PrComment => ({ id: `c-${Math.random()}`, kind: 'comment', author: 'reviewer', bot: false, mine: false, body: 'please rename', path: null, line: null, url: `${PR}#c`, at: '2026-11-21T10:00:00Z', reviewState: null, ...over });
  const status = (state: PrStatus['state'], comments: PrComment[]): PrStatus => ({ checked: true, error: null, state, title: 'Reconstruct things', mergedAt: state === 'merged' ? '2026-11-21T12:00:00Z' : null, closedAt: state === 'open' ? null : '2026-11-21T12:00:00Z', headSha: 'abc', comments });
  /** A finished run whose first batch was submitted as PR. */
  const submitted = async (name: string) => {
    const s = setup();
    const run = createRun(s, name, 12, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const batch = s.store.listBatches(run.id).find((b) => b.status === 'branch_ready')!;
    s.store.updateBatch(batch.id, { status: 'submitted', detail: { ...(batch.detail as unknown as Record<string, unknown>), pr: PR, prBranch: `decomp/${run.id}-b${batch.seq}-pr` } });
    const tasks = batch.taskIds.map((id) => s.store.getTask(id)!);
    return { s, run, batch, tasks };
  };

  it("matches comments to the packets they are about and leaves out the operator's own", async () => {
    const own = comment({ mine: true, body: 'claim for these' });
    const general = comment({ body: 'Thanks! One thing:\n  name the locals' });
    const inline = comment({ kind: 'inline', path: 'reconstruction/a/A.cpp', line: 12, body: 'use the field name' });
    expect(reviewComments({ comments: [own, general, inline, comment({ body: '  ' })] })).toEqual([general, inline]);
    expect(commentLine(inline)).toBe('reviewer on reconstruction/a/A.cpp:12: use the field name');
    const item = (over: object) => ({ comment: 1, needed: true, packets: [] as number[], instruction: 'do it', why: 'because', ...over });
    const out = triageTargets({ summary: '', items: [item({ needed: false, packets: [1] }), item({ comment: 2, packets: [2, 2], instruction: 'use the\n field name' })] }, ['a', 'b'], [general, inline]);
    expect([...out.fix]).toEqual([['b', ['use the field name (asked by reviewer)']]]);
    expect(out.skipped).toEqual([{ author: 'reviewer', why: 'because' }]);
    expect(() => triageTargets({ summary: '', items: [item({ packets: [3] })] }, ['a', 'b'], [general])).toThrow(/packet 3/);
    expect(() => triageTargets({ summary: '', items: [item({ comment: 9, packets: [1] })] }, ['a', 'b'], [general])).toThrow(/comment 9/);
  });

  it('reads the PR state and comments, and explains the comments once until they change', async () => {
    const { s, run, batch } = await submitted('pr-explain');
    s.repo.pullRequests.set(PR, status('open', [comment({ mine: true }), comment({ body: 'nit: name this local' })]));
    const r = await s.engine.refreshPullRequests(run.id);
    expect(r).toEqual([{ seq: batch.seq, state: 'open', comments: 1, error: null }]);
    const complete = vi.spyOn(s.providers, 'complete').mockResolvedValue({
      text: JSON.stringify({ summary: 'One small naming request.', points: [{ author: 'reviewer', about: 'a local variable', plain: 'They want a clearer name.', action: 'Rename it.' }], nextStep: 'Rename and push.' }),
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end',
    });
    const e = await s.engine.explainPrComments(run.id, batch.id);
    expect(e).toMatchObject({ summary: 'One small naming request.', cached: false });
    expect(complete.mock.calls[0]![1].prompt).toContain('nit: name this local');
    expect(complete.mock.calls[0]![1].prompt).not.toContain('please rename');
    expect((await s.engine.explainPrComments(run.id, batch.id)).cached).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    // Merged: the state change is recorded, and nothing is left to fix.
    s.repo.pullRequests.set(PR, status('merged', [comment({ body: 'nit: name this local' })]));
    await s.engine.refreshPullRequests(run.id);
    expect((s.store.getBatch(batch.id)!.detail as unknown as { prStatus: PrStatus }).prStatus.state).toBe('merged');
    await expect(s.engine.fixFromReview(run.id, batch.id)).rejects.toThrow(/merged/);
  }, 60_000);

  /** The orchestrator's answer: every packet of these units needs the change. */
  const orchestratorSays = (s: ReturnType<typeof setup>, packets: number[]) => vi.spyOn(s.providers, 'complete').mockResolvedValueOnce({
    text: JSON.stringify({ summary: 'One request.', items: [{ comment: 1, needed: packets.length > 0, packets, instruction: 'name the field', why: 'asked inline' }] }),
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end',
  });

  it('sends nothing before the orchestrator has decided, and only what it named', async () => {
    const { s, run, batch, tasks } = await submitted('pr-triage');
    s.repo.pullRequests.set(PR, status('open', [comment({ body: 'two of these headers are too long' })]));
    await expect(s.engine.fixFromReview(run.id, batch.id)).rejects.toThrow(/ask the orchestrator first/);
    const call = orchestratorSays(s, [99]);
    await expect(s.engine.triageReview(run.id, batch.id)).rejects.toThrow(/packet 99/);
    orchestratorSays(s, []);
    expect((await s.engine.triageReview(run.id, batch.id)).fix).toEqual([]);
    await expect(s.engine.fixFromReview(run.id, batch.id)).rejects.toThrow(/nothing that needs fixing/);
    const n = call.mock.calls.length;
    expect((await s.engine.triageReview(run.id, batch.id)).cached).toBe(true);
    expect(call.mock.calls.length).toBe(n);
    // Another comment: the old decision no longer counts.
    s.repo.pullRequests.set(PR, status('open', [comment({ body: 'and the third one' })]));
    await expect(s.engine.fixFromReview(run.id, batch.id)).rejects.toThrow(/comments changed/);
    orchestratorSays(s, [1]);
    const plan = await s.engine.triageReview(run.id, batch.id);
    expect(plan.fix.map((f) => f.taskId)).toEqual([tasks[0]!.id]);
    expect(call.mock.calls.at(-1)![1].prompt).toContain(`[1] ${tasks[0]!.unit}`);
    await expect(s.engine.fixFromReview(run.id, batch.id, { only: [] })).rejects.toThrow(/no packet was chosen/);
    for (const t of tasks) expect(s.store.getTask(t.id)!.state).toBe('staged');
  }, 60_000);

  it('refuses, without a model call, once someone else pushed to the PR', async () => {
    const { s, run, batch, tasks } = await submitted('pr-moved');
    s.repo.pullRequests.set(PR, status('open', [comment({ body: 'fix this' })]));
    (s.repo as { branchHead?: (b: string) => Promise<string | null> }).branchHead = async () => 'ours';
    const call = vi.spyOn(s.providers, 'complete');
    await expect(s.engine.triageReview(run.id, batch.id)).rejects.toThrow(/someone else pushed/);
    await expect(s.engine.fixFromReview(run.id, batch.id)).rejects.toThrow(/someone else pushed/);
    expect(call).not.toHaveBeenCalled();
    for (const t of tasks) expect(s.store.getTask(t.id)!.state).toBe('staged');
  }, 60_000);

  it('takes packets back from the agents exactly as they were submitted', async () => {
    const { s, run, batch, tasks } = await submitted('pr-recall');
    const before = new Map(tasks.map((t) => [t.id, t.lastVerdictId]));
    await expect(s.engine.recallReviewFix(run.id, batch.id)).rejects.toThrow(/nothing of this pull request/);
    s.repo.pullRequests.set(PR, status('open', [comment({ body: 'rework all of it' })]));
    orchestratorSays(s, tasks.map((_, i) => i + 1));
    await s.engine.triageReview(run.id, batch.id);
    // Hold every compare, so the packets are with the workers when the run is paused.
    const real = s.repo.compare.bind(s.repo);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.repo.compare = async (...a: Parameters<SimRepo['compare']>) => { await gate; return real(...a); };
    await s.engine.fixFromReview(run.id, batch.id);
    await until(() => s.engine.status(run.id).busySlots > 0);
    await expect(s.engine.recallReviewFix(run.id, batch.id)).rejects.toThrow(/pause it now/);
    s.engine.pause(run.id, true);
    release();
    await until(() => s.engine.status(run.id).busySlots === 0);
    // One of them was already matched again by the agents: its new version is dropped too.
    s.store.db.prepare("UPDATE tasks SET state = 'passed', last_verdict_id = 'vd_new' WHERE id = ?").run(tasks[0]!.id);
    const r = await s.engine.recallReviewFix(run.id, batch.id);
    expect(r).toMatchObject({ ok: true, packets: tasks.length });
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    for (const t of tasks) expect(s.store.getTask(t.id)).toMatchObject({ state: 'staged', lastVerdictId: before.get(t.id), fix: null });
    const b = s.store.getBatch(batch.id)!;
    expect(b.status).toBe('submitted');
    expect((b.detail as unknown as { reviewFix?: unknown }).reviewFix).toBeUndefined();
  }, 60_000);

  it('fixes an open PR from its comments with the agents and pushes the fixes to the same PR', async () => {
    const { s, run, batch, tasks } = await submitted('pr-fix-open');
    const victim = tasks[0]!;
    s.repo.pullRequests.set(PR, status('open', [comment({ kind: 'inline', path: victim.unit, line: 3, body: 'name the field' })]));
    const sameUnit = tasks.filter((t) => t.unit === victim.unit);
    orchestratorSays(s, sameUnit.map((t) => tasks.indexOf(t) + 1));
    await s.engine.triageReview(run.id, batch.id);
    const r = await s.engine.fixFromReview(run.id, batch.id);
    expect(r).toMatchObject({ ok: true, open: true, comments: 1 });
    expect(r.requeued).toBe(sameUnit.length);
    expect(s.store.getTask(victim.id)!.fix).toMatchObject({ check: 'review', prOpen: true, pr: PR, reasons: ['name the field (asked by reviewer)'] });
    expect(s.store.getBatch(batch.id)!.status).toBe('submitted');
    await s.engine.waitFor(run.id);
    for (const t of tasks.filter((x) => x.unit !== victim.unit)) expect(s.store.getTask(t.id)!.state).toBe('staged');
    if (sameUnit.some((t) => s.store.getTask(t.id)!.state === 'dead')) return; // the simulator's agent repeated itself: nothing to push
    const fixes = s.store.listBatches(run.id).find((b) => (b.detail as unknown as { updatesPr?: unknown } | null)?.updatesPr)!;
    expect(new Set(fixes.taskIds)).toEqual(new Set(sameUnit.map((t) => t.id)));
    expect(fixes.status).toBe('branch_ready');
    const pushed = await s.engine.pushReviewFixes(run.id, fixes.id);
    expect(pushed.ok).toBe(true);
    expect(s.repo.prUpdates).toHaveLength(1);
    expect(s.repo.prUpdates[0]!.tasks.sort()).toEqual([...new Set([...batch.taskIds, ...fixes.taskIds])].sort());
    expect(s.repo.prUpdates[0]!.message).toMatch(/^Address review comments/);
    expect(s.store.getBatch(fixes.id)).toMatchObject({ status: 'submitted', detail: expect.objectContaining({ prUpdateOf: batch.seq, pr: PR }) });
    expect((s.store.getBatch(batch.id)!.detail as unknown as { prUpdates: unknown[] }).prUpdates).toHaveLength(1);
    expect(s.store.getTask(victim.id)!.fix).toBeNull();
    // Only the PR's own batch is read from GitHub.
    expect((await s.engine.refreshPullRequests(run.id)).map((p) => p.seq)).toEqual([batch.seq]);
  }, 60_000);

  it('fixes a closed PR from its comments into a new batch with the rest of its packets', async () => {
    const { s, run, batch, tasks } = await submitted('pr-fix-closed');
    s.repo.pullRequests.set(PR, status('closed', [comment({ body: 'closing: the names are guesses' })]));
    orchestratorSays(s, tasks.map((_, i) => i + 1));
    await s.engine.triageReview(run.id, batch.id);
    const r = await s.engine.fixFromReview(run.id, batch.id);
    expect(r).toMatchObject({ open: false, requeued: tasks.length });
    expect(s.store.getBatch(batch.id)!.status).toBe('superseded');
    await s.engine.waitFor(run.id);
    for (const t of tasks) expect(['staged', 'dead']).toContain(s.store.getTask(t.id)!.state);
    const next = s.store.listBatches(run.id).filter((b) => b.status === 'branch_ready' && b.taskIds.some((id) => batch.taskIds.includes(id)));
    expect(next.length).toBeGreaterThan(0);
    for (const b of next) expect((b.detail as unknown as { updatesPr?: unknown }).updatesPr).toBeUndefined();
  }, 60_000);
});

describe('batching while the run goes on', () => {
  /** Holds every compare of the first unit the workers reach until `release()`: that unit stays open. */
  const holdFirstUnit = (s: ReturnType<typeof setup>) => {
    const real = s.repo.compare.bind(s.repo);
    let held: string | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.repo.compare = async (...args: Parameters<SimRepo['compare']>) => {
      held ??= args[1].unit;
      if (args[1].unit === held) await gate;
      return real(...args);
    };
    return { unit: () => held, release };
  };

  it('batches finished units once they fill a batch, leaves open units out, and batches the rest at the end', async () => {
    const s = setup();
    const hold = holdFirstUnit(s);
    const run = s.engine.createRun('rolling', { flowId: 'default', selection: { source: 'synthetic', count: 30, seed: 11 }, prBatchSize: 6 }, flow());
    await s.engine.start(run.id);
    await until(() => s.store.listBatches(run.id).some((b) => b.status === 'branch_ready'));
    expect(s.store.getRun(run.id)!.status).toBe('running');
    const early = s.store.listBatches(run.id).filter((b) => b.status === 'branch_ready');
    for (const b of early) {
      const tasks = b.taskIds.map((id) => s.store.getTask(id)!);
      expect(tasks.every((t) => t.unit !== hold.unit())).toBe(true);
      expect(tasks.reduce((n, t) => n + t.functions.length, 0)).toBeGreaterThanOrEqual(readyThreshold(6));
    }
    const st = s.engine.batchingStatus(run.id);
    expect(st).toMatchObject({ batchSize: 6, fullAt: readyThreshold(6), rolling: true });
    expect(st.fresh.functions).toBeLessThanOrEqual(st.ready.functions);

    hold.release();
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    expect(s.store.functionCounts(run.id).passed ?? 0).toBe(0);
    const staged = s.store.listTasks(run.id, { state: 'staged', limit: 1000 });
    expect(staged.some((t) => t.unit === hold.unit())).toBe(true);
    // Every staged packet is in exactly one live batch.
    const live = s.store.listBatches(run.id).filter((b) => b.status === 'branch_ready').flatMap((b) => b.taskIds);
    expect(new Set(live).size).toBe(live.length);
    expect(new Set(live)).toEqual(new Set(staged.map((t) => t.id)));
    expect(s.engine.batchingStatus(run.id).ready.functions).toBe(0);
  }, 60_000);

  it('runs a PR step beside the workers on finished units only, and the run ends only after it', async () => {
    const s = setup();
    const hold = holdFirstUnit(s);
    const run = s.engine.createRun('beside', { flowId: 'default', selection: { source: 'synthetic', count: 24, seed: 5 }, prBatchSize: 40, staging: 'off' }, flow());
    await s.engine.start(run.id);
    await until(() => s.engine.readyTasks(run.id).length > 0);

    const real = s.repo.stageBatch.bind(s.repo);
    let entered!: () => void;
    const inStep = new Promise<void>((r) => (entered = r));
    let finishStep!: () => void;
    const stepGate = new Promise<void>((r) => (finishStep = r));
    const stagedUnits: string[] = [];
    s.repo.stageBatch = async (input: StageBatchInput) => {
      stagedUnits.push(...input.tasks.map((t) => t.task.unit));
      entered();
      await stepGate;
      return real(input);
    };
    const step = s.engine.restage(run.id);
    await inStep;
    expect(stagedUnits).not.toContain(hold.unit());
    // Another run cannot start while this one is loaded.
    const other = createRun(s, 'other', 6, 9);
    await expect(s.engine.start(other.id)).rejects.toThrow();

    // The held unit finishes; the run has nothing left to work on but waits for the step.
    hold.release();
    await until(() => {
      const fc = s.store.functionCounts(run.id);
      return !(fc.pending || fc.leased || fc.gating);
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(s.store.getRun(run.id)!.status).toBe('running');

    finishStep();
    const r = await step;
    expect(r.staged).toBeGreaterThan(0);
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    // The held unit was not in that batch: it is still matched, waiting for Prepare all.
    expect(s.store.listTasks(run.id, { state: 'passed', limit: 1000 }).some((t) => t.unit === hold.unit())).toBe(true);
  }, 60_000);
});

describe('smaller batches after a wait', () => {
  it('batches ready functions that waited long enough, and dry-runs them on its own', async () => {
    const s = setup();
    const dry: Array<{ seq: number; dryRun: boolean }> = [];
    (s.repo as RepoAdapter).submitBatch = async (input): Promise<SubmitBatchResult> => {
      dry.push({ seq: input.seq, dryRun: input.dryRun });
      return { ok: true, dryRun: input.dryRun, problems: [], blockers: [], uncheckedClaims: [], warnings: [], plan: [], pullRequest: null, link: null, error: null };
    };
    const real = s.repo.compare.bind(s.repo);
    let held: string | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.repo.compare = async (...args: Parameters<SimRepo['compare']>) => {
      held ??= args[1].unit;
      if (args[1].unit === held) await gate;
      return real(...args);
    };
    const run = s.engine.createRun('aged', { flowId: 'default', selection: { source: 'synthetic', count: 20, seed: 11 }, prBatchSize: 60, batchMaxAgeMinutes: 30, batchMinFunctions: 4 }, flow());
    await s.engine.start(run.id);
    await until(() => s.engine.batchingStatus(run.id).ready.functions >= 8);
    await new Promise((r) => setTimeout(r, 400));
    expect(s.store.listBatches(run.id)).toHaveLength(0); // far from a full batch, and nothing has waited
    s.store.db.prepare("UPDATE tasks SET updated_at = updated_at - 3600000 WHERE run_id = ? AND state = 'passed'").run(run.id);
    (s.engine as unknown as { stageReadySoon(id: string): void }).stageReadySoon(run.id);
    await until(() => s.events.query({ runId: run.id, limit: 500 }).some((e) => e.kind === 'run.prepared'));
    expect(s.store.getRun(run.id)!.status).toBe('running');
    const b = s.store.listBatches(run.id).filter((x) => x.status === 'branch_ready');
    expect(b.length).toBeGreaterThan(0);
    expect(dry.length).toBeGreaterThan(0);
    expect(dry.every((d) => d.dryRun)).toBe(true);
    release();
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    await until(() => !s.engine.operation() && s.store.listBatches(run.id).filter((x) => x.status === 'branch_ready').every((x) => dry.some((d) => d.seq === x.seq)));
    expect(dry.every((d) => d.dryRun)).toBe(true);
    expect(s.store.listBatches(run.id).some((x) => x.status === 'submitted')).toBe(false);
  }, 60_000);

  it('leaves everything to the operator with autoPrepare off', async () => {
    const s = setup();
    let calls = 0;
    (s.repo as RepoAdapter).submitBatch = async (): Promise<SubmitBatchResult> => {
      calls++;
      throw new Error('not expected');
    };
    const run = s.engine.createRun('manual', { flowId: 'default', selection: { source: 'synthetic', count: 6, seed: 3 }, autoPrepare: false }, flow());
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(0);
  }, 60_000);
});

/** One packet per unit (whole), whatever their difficulty. */
const whole = (s: ReturnType<typeof setup>, name: string) =>
  s.engine.createRun(name, { flowId: 'default', selection: { source: 'synthetic', count: 12, seed: 3 }, prBatchSize: 40, packetMaxFunctions: 20, routing: { enabled: false } }, flow());

describe('functions nobody should pay for', () => {
  it('skips what upstream matched since, without a model call, and goes on with the rest of the packet', async () => {
    const s = setup({ cheatRate: 0, skill: 1 });
    const run = whole(s, 'taken');
    const found = await s.repo.discover({ source: 'synthetic', count: 12, seed: 3 });
    const unit = found.map((f) => f.unit).find((u) => found.filter((f) => f.unit === u).length > 1)!;
    const taken = found.find((f) => f.unit === unit)!;
    const alone = found.find((f) => found.filter((g) => g.unit === f.unit).length === 1);
    s.repo.upstreamMatched.set(taken.rva, 'someone');
    if (alone) s.repo.upstreamMatched.set(alone.rva, null);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const tasks = s.store.listTasks(run.id, { limit: 1000 });
    for (const f of [taken, ...(alone ? [alone] : [])]) {
      const t = tasks.filter((x) => x.functions.some((g) => g.rva === f.rva));
      expect(t).toHaveLength(1);
      expect(t[0]!.state).toBe('dead');
      expect(s.store.attemptsForTask(t[0]!.id).map((a) => a.model)).toEqual(['skipped (no model call)']);
      expect(s.store.getVerdict(t[0]!.lastVerdictId!)!.findings.some((x) => x.code === 'SKIP_MATCHED_UPSTREAM' && x.message.includes(f.rva))).toBe(true);
    }
    const rest = found.filter((f) => f.unit === unit && f.rva !== taken.rva);
    for (const f of rest) expect(tasks.filter((x) => x.functions.some((g) => g.rva === f.rva)).map((x) => x.state)).toEqual(['staged']);
    const fc = s.store.functionCounts(run.id);
    expect(Object.values(fc).reduce((a, b) => a + b, 0)).toBe(12);
  }, 60_000);

  it('keeps going when upstream cannot be asked', async () => {
    const s = setup({ cheatRate: 0, skill: 1 });
    s.repo.takenUpstream = async () => {
      throw new Error('offline');
    };
    const run = createRun(s, 'offline', 6, 3);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const fc = s.store.functionCounts(run.id);
    expect((fc.staged ?? 0) + (fc.dead ?? 0)).toBe(6);
    expect(fc.staged ?? 0).toBeGreaterThan(3);
  }, 60_000);

  it('leaves thunks out at discovery when a pack tells, and after prepare when only that does', async () => {
    const s = setup({ cheatRate: 0, skill: 1 });
    const found = await s.repo.discover({ source: 'synthetic', count: 12, seed: 3 });
    const [early, late] = [found[0]!.rva, found[1]!.rva];
    const real = s.repo.analyze.bind(s.repo);
    s.repo.analyze = (async (fns: FunctionTarget[], opts?: { packs?: string[] }) => {
      const m = await real(fns);
      for (const [rva, f] of m) if (rva === early || (rva === late && opts?.packs)) m.set(rva, { ...f, adjustorThunk: true });
      return m;
    }) as typeof s.repo.analyze;
    const run = whole(s, 'thunks');
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const tasks = s.store.listTasks(run.id, { limit: 1000 });
    expect(tasks.some((t) => t.functions.some((f) => f.rva === early))).toBe(false);
    const t = tasks.find((x) => x.functions.some((f) => f.rva === late))!;
    expect(t.functions).toHaveLength(1);
    expect(t.state).toBe('dead');
    expect(s.store.getVerdict(t.lastVerdictId!)!.findings[0]!.code).toBe('SKIP_ADJUSTOR_THUNK');
    const fc = s.store.functionCounts(run.id);
    expect((fc.staged ?? 0) + (fc.dead ?? 0)).toBe(11); // the one left out at discovery is no packet
  }, 60_000);
});

describe('accepting functions one by one', () => {
  /** A repo where one function of the first multi-function unit never matches. */
  async function stubborn(s: ReturnType<typeof setup>) {
    const found = await s.repo.discover({ source: 'synthetic', count: 12, seed: 3 });
    const unit = found.map((f) => f.unit).find((u) => found.filter((f) => f.unit === u).length > 1)!;
    const mine = found.filter((f) => f.unit === unit);
    const bad = mine[0]!.rva;
    const real = s.repo.compare.bind(s.repo);
    s.repo.compare = async (...args: Parameters<SimRepo['compare']>) => {
      const r = await real(...args);
      const functions = r.functions.map((f) => (f.rva === bad ? { ...f, result: 'fail' as const, reason: 'code-mismatch', exactBytes: 1 } : f));
      return { ...r, functions, allPass: functions.every((f) => f.result === 'pass') };
    };
    return { unit, bad, good: mine.slice(1) };
  }

  it('a function that never matches does not sink the rest of its packet', async () => {
    const s = setup({ cheatRate: 0, skill: 1 });
    const { unit, bad, good } = await stubborn(s);
    const run = whole(s, 'split');
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const tasks = s.store.listTasks(run.id, { limit: 1000 }).filter((t) => t.unit === unit);
    const dead = tasks.filter((t) => t.state === 'dead');
    expect(dead.flatMap((t) => t.functions.map((f) => f.rva))).toEqual([bad]);
    for (const g of good) expect(tasks.filter((t) => t.functions.some((f) => f.rva === g.rva)).map((t) => t.state)).toEqual(['staged']);
    expect(s.events.query({ runId: run.id, limit: 1000 }).some((e) => e.kind === 'task.split')).toBe(true);
    const free = tasks.filter((t) => t.fix?.check === 'regate' || s.store.attemptsForTask(t.id).some((a) => a.model?.startsWith('stored candidate') && a.model.endsWith('(no model call)')));
    expect(free.length).toBeGreaterThan(0);
    for (const t of free) {
      const first = s.store.attemptsForTask(t.id)[0]!;
      expect(first.model).toMatch(/^stored candidate of .+ \(no model call\)$/);
      // Credited to the model that wrote the code, also for rows that do not name it.
      const writer = /of (.+) \(/.exec(first.model!)![1]!;
      const now = s.store.getTask(t.id)!;
      expect(finishingModel(s.store, now)).toBe(writer);
      s.store.updateAttempt(first.id, { model: 'stored candidate (no model call)' });
      expect(finishingModel(s.store, now)).toBe(writer);
      expect(batchContent(s.store, run.id, [now]).message).not.toContain('no model call');
      expect(first.costUsd ?? 0).toBe(0);
    }
    expect(Object.values(s.store.functionCounts(run.id)).reduce((a, b) => a + b, 0)).toBe(12);
  }, 60_000);

  it('a free rebuild of a set-aside unit that does not pass is set aside again as it was, with no model call', async () => {
    const s = setup({ cheatRate: 0, skill: 1 });
    const run = whole(s, 'rebuild');
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const t = s.store.listTasks(run.id, { state: 'staged', limit: 100 }).find((x) => x.functions.length > 1)!;
    s.store.db.prepare("UPDATE tasks SET state = 'set_aside' WHERE id = ?").run(t.id);
    const gone = t.functions[0]!;
    // Upstream now has one of its functions in a unit of its own.
    const state = s.repo.upstreamState.bind(s.repo);
    s.repo.upstreamState = async (i) => ({ ...(await state(i)), marked: { [gone.rva]: [{ unit: 'reconstruction/other.cpp', name: null }] } });
    const compare = s.repo.compare.bind(s.repo);
    s.repo.compare = async (...args: Parameters<SimRepo['compare']>) => {
      const r = await compare(...args);
      return { ...r, allPass: false, functions: r.functions.map((f) => ({ ...f, result: 'fail' as const, reason: 'code-mismatch', exactBytes: 1 })) };
    };
    const spent = () => s.store.listTasks(run.id, { limit: 1000 }).flatMap((x) => s.store.attemptsForTask(x.id)).reduce((n, a) => n + (a.costUsd ?? 0), 0);
    const cost = spent();
    const r = await s.engine.rebuildOnUpstream(run.id, [t.unit], { free: true });
    expect(r.dropped.map((d) => [d.rva, d.why])).toEqual([[gone.rva, 'already in reconstruction/other.cpp upstream']]);
    await s.engine.waitFor(run.id);
    const now = s.store.getTask(t.id)!;
    expect(now.state).toBe('set_aside');
    expect(s.store.attemptsForTask(t.id).at(-1)!.model).toMatch(/^splice of .+ [(]no model call[)]$/);
    expect(now.lastVerdictId).toBe(t.lastVerdictId);
    expect(now.functions.map((f) => f.rva)).toEqual(t.functions.slice(1).map((f) => f.rva));
    expect(spent()).toBe(cost);
    expect(finishingModel(s.store, now)).toBe(finishingModel(s.store, t));
  }, 60_000);

  it('salvages matched functions of packets that died before, without a model call; the preview changes nothing', async () => {
    const s = setup({ cheatRate: 0, skill: 1 });
    const { unit, bad, good } = await stubborn(s);
    // As before the change: packets live or die whole.
    const proto = s.engine as unknown as { splitMatched: () => void };
    proto.splitMatched = () => undefined;
    const run = whole(s, 'salvage');
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const deadBefore = s.store.listTasks(run.id, { state: 'dead', limit: 100 }).filter((t) => t.functions.length > 1 && t.functions.some((f) => f.rva === bad));
    expect(deadBefore).toHaveLength(1);
    const lost = deadBefore[0]!.functions.filter((f) => f.rva !== bad);
    s.repo.upstreamMatched.set(lost[0]!.rva, 'someone');
    const rows = () => JSON.stringify(s.store.listTasks(run.id, { limit: 1000 }));
    const before = rows();
    const preview = await s.engine.regateMatched(run.id, { partial: true, preview: true });
    expect(rows()).toBe(before);
    expect(preview).toMatchObject({ preview: true, functions: lost.length - 1, takenUpstream: 1 });
    expect(await s.engine.regateMatched(run.id)).toMatchObject({ packets: 0 });
    if (lost.length > 1) {
      const spent = () => s.store.listTasks(run.id, { limit: 1000 }).flatMap((t) => s.store.attemptsForTask(t.id)).reduce((n, a) => n + (a.costUsd ?? 0), 0);
      const cost = spent();
      const r = await s.engine.regateMatched(run.id, { partial: true });
      expect(r).toMatchObject({ packets: 1, functions: lost.length - 1 });
      await s.engine.waitFor(run.id);
      for (const f of lost.slice(1)) expect(s.store.listTasks(run.id, { limit: 1000 }).filter((t) => t.functions.some((g) => g.rva === f.rva)).map((t) => t.state)).toEqual(['staged']);
      expect(spent()).toBe(cost);
      expect(s.store.listTasks(run.id, { state: 'dead', limit: 100 }).find((t) => t.unit === unit && t.functions.some((f) => f.rva === bad))!.functions.map((f) => f.rva).sort()).toEqual([bad, lost[0]!.rva].sort());
    }
    void good;
  }, 60_000);

  it('splits only on compare results: a compile error or another finding keeps the packet whole', () => {
    const functions = [{ rva: '0x10', name: 'A::F', size: 8 }, { rva: '0x20', name: 'A::G', size: 8 }];
    const row = (rva: string, result: 'pass' | 'fail') => ({ rva, name: null, result }) as never;
    const v = (codes: string[], compare = [row('0x10', 'pass'), row('0x20', 'fail')]) => ({ decision: 'reject', compare, findings: codes.map((code) => ({ stage: 'compare', code, severity: 'block', message: '' })) }) as never;
    expect(matchedSides({ functions }, v(['COMPARE_CODE_MISMATCH']))).toEqual({ matched: [functions[0]], rest: [functions[1]] });
    expect(matchedSides({ functions }, v(['COMPARE_COMPILE_ERROR']))).toBeNull();
    expect(matchedSides({ functions }, v(['COMPARE_CODE_MISMATCH', 'CHEAT_ASM']))).toBeNull();
    expect(matchedSides({ functions }, v(['COMPARE_CODE_MISMATCH'], [row('0x10', 'pass')]))).toBeNull();
    expect(matchedSides({ functions }, v(['COMPARE_CODE_MISMATCH'], [row('0x10', 'fail'), row('0x20', 'fail')]))).toBeNull();
  });
});

describe('every AI account down', () => {
  const poolOf = (s: ReturnType<typeof setup>) => (s.engine as unknown as { deps: { pool: AccountPool } }).deps.pool;

  it('pauses the run, keeps the outage across checks, and resumes on its own once an account is back', async () => {
    const s = setup();
    const pool = poolOf(s);
    const run = createRun(s, 'outage', 24, 7);
    await s.engine.start(run.id);
    await until(() => (s.store.functionCounts(run.id).passed ?? 0) + (s.store.functionCounts(run.id).staged ?? 0) > 0);

    pool.operatorDisable('m');
    await s.engine.watchOutages();
    expect(s.store.getRun(run.id)!.status).toBe('paused');
    const outage = s.store.runJson<{ accounts: Array<{ id: string; status: string }>; nextBackAt: number | null }>(run.id, 'outage_json')!;
    expect(outage.accounts).toEqual([expect.objectContaining({ id: 'm', status: 'disabled' })]);
    expect(outage.nextBackAt).toBeNull(); // only the operator brings a disabled account back

    await s.engine.watchOutages(); // still down: stays paused
    expect(s.store.getRun(run.id)!.status).toBe('paused');

    pool.operatorEnable('m');
    await s.engine.watchOutages();
    expect(s.store.getRun(run.id)!.status).toBe('running');
    expect(s.store.runJson(run.id, 'outage_json')).toBeNull();
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    // Nothing was charged for the outage.
    expect(s.store.listTasks(run.id, { limit: 1000 }).every((t) => t.providerFailures === 0)).toBe(true);
  }, 60_000);

  it('pauses as soon as a failed call leaves no account, without charging the packets', async () => {
    const s = setup({ quotaAfterRequests: 4 });
    const run = createRun(s, 'quota', 24, 9);
    await s.engine.start(run.id);
    await until(() => s.store.getRun(run.id)!.status === 'paused');
    const outage = s.store.runJson<{ accounts: Array<{ id: string; status: string }>; nextBackAt: number | null }>(run.id, 'outage_json')!;
    expect(outage.accounts).toEqual([expect.objectContaining({ id: 'm', status: 'quota_exhausted' })]);
    expect(outage.nextBackAt).toEqual(expect.any(Number)); // a quota resets on its own
    await until(() => s.engine.status(run.id).busySlots === 0);
    const tasks = s.store.listTasks(run.id, { limit: 1000 });
    expect(tasks.every((t) => t.providerFailures === 0)).toBe(true);
    expect(tasks.some((t) => t.state === 'dead')).toBe(false);
    await s.engine.cancel(run.id);
  }, 60_000);

  it('never resumes a run the operator paused, and a manual resume clears the outage mark', async () => {
    const s = setup();
    const pool = poolOf(s);
    const run = createRun(s, 'manual', 24, 8);
    await s.engine.start(run.id);
    s.engine.pause(run.id);
    pool.operatorDisable('m');
    await s.engine.watchOutages();
    expect(s.store.runJson(run.id, 'outage_json')).toBeNull(); // paused by you, not by the outage
    pool.operatorEnable('m');
    await s.engine.watchOutages();
    expect(s.store.getRun(run.id)!.status).toBe('paused');

    await s.engine.resume(run.id);
    pool.operatorDisable('m');
    await s.engine.watchOutages();
    expect(s.store.getRun(run.id)!.status).toBe('paused');
    expect(s.store.runJson(run.id, 'outage_json')).not.toBeNull();
    // Resuming by hand during the outage: the mark goes; the watcher pauses it again while still down.
    await s.engine.resume(run.id);
    expect(s.store.runJson(run.id, 'outage_json')).toBeNull();
    await s.engine.watchOutages();
    expect(s.store.getRun(run.id)!.status).toBe('paused');
    pool.operatorEnable('m');
    await s.engine.watchOutages();
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
  }, 60_000);
});
