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
