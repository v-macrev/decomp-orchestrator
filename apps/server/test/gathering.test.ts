// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 4: FunctionGatherer, the atomic per-worker function cap, capacity planning and stalls.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileFlowPlan, defaultFlow, type Account } from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { FunctionGatherer, inNamespace, moduleOf } from '../src/intel/gatherer.js';
import { planCapacity } from '../src/orchestrator/capacity.js';
import { RunEngine, allocateSlots } from '../src/orchestrator/engine.js';
import { AccountPool } from '../src/pool/scheduler.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { TaskQueue } from '../src/queue/taskQueue.js';
import { SimRepo } from '../src/repo/simRepo.js';
import { EventBus } from '../src/telemetry/events.js';
import { mockAccount } from './helpers.js';

const closers: Array<() => void> = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows may hold the WAL briefly */
    }
  }
});
const tmpStore = () => {
  const d = mkdtempSync(join(tmpdir(), 'decomp-gather-'));
  dirs.push(d);
  const s = new Store(openDatabase(join(d, 'db.sqlite')));
  closers.push(() => s.db.open && s.db.close());
  return s;
};

describe('FunctionGatherer', () => {
  it('scans the inventory, explains every exclusion and enriches with source, pack and table metadata', async () => {
    const store = tmpStore();
    const repo = new SimRepo({ slots: 1, backlogSize: 400 });
    const g = new FunctionGatherer(repo, store);
    const r = await g.gather({ maxFunctions: 120, maxSize: 256 });
    expect(r.inventory).toMatchObject({ total: 1200, matched: 800, mapped: 400 });
    expect(r.excluded.matched).toBe(800);
    expect(r.excluded.locked ?? 0).toBeGreaterThan(0); // simulated local claims
    expect(r.selected).toBe(120);
    expect(r.excluded.over_cap).toBe(400 - 120 - (r.excluded.locked ?? 0) - (r.excluded.size ?? 0) - (r.excluded.in_flight ?? 0));
    const f = r.functions[0]!;
    expect(f.unit).toMatch(/^reconstruction\/sim\//);
    expect(f.sources).toEqual(expect.arrayContaining(['inventory', 'pack', 'table']));
    expect(f.basicBlocks).not.toBeNull();
    expect(f.xrefsIn).not.toBeNull();
    expect(r.withTableFacts).toBe(120);
    // readiness order: non-decreasing readiness rank
    for (let i = 1; i < r.functions.length; i++) expect(r.functions[i]!.readiness! >= r.functions[i - 1]!.readiness!).toBe(true);
    // templates are flagged for the classifier
    const all = await g.gather({ maxFunctions: 5000, maxSize: 5000 });
    const tpl = all.functions.find((x) => x.name?.includes('<'));
    if (tpl) expect(tpl.features?.templated).toBe(true);
  });

  it('filters by size, RVA range, namespace, module, unit, name origin and in-flight work', async () => {
    const store = tmpStore();
    const repo = new SimRepo({ slots: 1, backlogSize: 300 });
    const g = new FunctionGatherer(repo, store);
    const base = await g.gather({ maxFunctions: 5000 });
    const first = base.functions[0]!;
    const cls = first.name!.split('::')[0]!;
    expect((await g.gather({ maxFunctions: 5000, namespaces: [cls] })).functions.every((f) => f.name!.startsWith(`${cls}::`))).toBe(true);
    expect((await g.gather({ maxFunctions: 5000, maxSize: 40 })).functions.every((f) => f.size <= 40)).toBe(true);
    expect((await g.gather({ maxFunctions: 5000, units: [first.unit] })).functions.every((f) => f.unit === first.unit)).toBe(true);
    expect((await g.gather({ maxFunctions: 5000, modules: ['nope'] })).selected).toBe(0);
    expect((await g.gather({ maxFunctions: 5000, excludeNameOrigins: ['GUESS'] })).functions.every((f) => f.nameOrigin !== 'GUESS')).toBe(true);
    const lo = parseInt(first.rva, 16);
    const ranged = await g.gather({ maxFunctions: 5000, rvaRanges: [{ start: `0x${lo.toString(16)}`, end: `0x${(lo + 0x2000).toString(16)}` }] });
    expect(ranged.functions.every((f) => parseInt(f.rva, 16) >= lo && parseInt(f.rva, 16) < lo + 0x2000)).toBe(true);
    // a function open in another run is in flight
    store.createRun({ id: 'other', name: 'o', config: { flowId: 'f', selection: { source: 'synthetic', count: 1 } } as never, flow: defaultFlow() });
    store.insertTasks('other', [{ id: 't-other', unit: first.unit, functions: [{ rva: first.rva, name: first.name, size: first.size }], priority: 0 }]);
    const after = await g.gather({ maxFunctions: 5000 });
    expect(after.functions.some((f) => f.rva === first.rva)).toBe(false);
    expect(after.excluded.in_flight).toBe(1);
    expect(moduleOf('reconstruction/actors/Actor.cpp')).toBe('actors');
    expect(inNamespace('RE::TESForm::GetFormID', ['RE'])).toBe(true);
    expect(inNamespace('REFR::Get', ['RE'])).toBe(false);
  });

  it('detects drafts in the unit source (present vs stub) and can skip drafted functions', async () => {
    const store = tmpStore();
    const repo = new SimRepo({ slots: 1, backlogSize: 200 });
    const g = new FunctionGatherer(repo, store);
    const r = await g.gather({ maxFunctions: 5000 });
    const f = r.functions[0]!;
    const ident = f.name!.replace(/::/g, '_').replace(/[^A-Za-z0-9_]/g, '_');
    (repo as unknown as { base: Map<string, string> }).base.set(f.unit, `#include "Sim.h"\nint ${ident}()\n{\n    return 0;\n}\n`);
    const second = r.functions.find((x) => x.unit !== f.unit)!;
    const ident2 = second.name!.replace(/::/g, '_').replace(/[^A-Za-z0-9_]/g, '_');
    (repo as unknown as { base: Map<string, string> }).base.set(second.unit, `#include "Sim.h"\nint ${ident2}()\n{\n    int x = 3;\n    return x * 7;\n}\n`);
    const again = await g.gather({ maxFunctions: 5000 });
    expect(again.functions.find((x) => x.rva === f.rva)!.draft).toBe('stub');
    expect(again.functions.find((x) => x.rva === second.rva)!.draft).toBe('present');
    const skip = await g.gather({ maxFunctions: 5000, excludeDrafted: true });
    expect(skip.functions.some((x) => x.rva === second.rva)).toBe(false);
    expect(skip.functions.some((x) => x.rva === f.rva)).toBe(true); // a stub is still work to do
  });
});

// ------------------------------------------------------------------------------------------------
describe('per-worker function cap (atomic, in the lease transaction)', () => {
  function seed(store: Store, packets: number[]) {
    store.createRun({ id: 'r', name: 'r', config: { flowId: 'f', selection: { source: 'synthetic', count: 1 } } as never, flow: defaultFlow() });
    store.insertTasks('r', packets.map((n, i) => ({
      id: `t${i}`, unit: `reconstruction/sim/U${i}.cpp`, priority: 100 - i, tier: 0,
      functions: Array.from({ length: n }, (_, k) => ({ rva: `0x${(0x1000 + i * 16 + k).toString(16)}`, name: null, size: 10 })),
    })));
    store.registerWorkers('r', [{ workerId: 'w#1', nodeId: 'w', tier: 0, capability: 'fast' }, { workerId: 'w#2', nodeId: 'w', tier: 0, capability: 'fast' }], 5);
  }

  it('never lets a worker pass its cap, skips packets that do not fit and charges a function once', () => {
    const store = tmpStore();
    seed(store, [4, 4, 1, 4, 1]);
    const q = new TaskQueue(store);
    const a = q.lease('r', 0, 1, 60_000, { worker: 'w#1' })[0]!; // 4 → 4/5
    expect(a.task.id).toBe('t0');
    const b = q.lease('r', 0, 1, 60_000, { worker: 'w#1' })[0]!; // next 4 does not fit → takes the 1
    expect(b.task.id).toBe('t2');
    expect(q.lease('r', 0, 1, 60_000, { worker: 'w#1' })).toHaveLength(0); // 5/5
    expect(q.workerRemaining('r', 'w#1')).toBe(0);
    // the skipped packet stayed pending for another worker
    expect(store.getTask('t1')!.state).toBe('pending');
    expect(q.lease('r', 0, 1, 60_000, { worker: 'w#2' })[0]!.task.id).toBe('t1');
    // a retry of its own packet is free (no second charge) even at the cap
    q.transition('t0', a.leaseId, ['leased'], 'pending', { attemptsTotal: 1 });
    const again = q.lease('r', 0, 1, 60_000, { worker: 'w#1' })[0]!;
    expect(again.task.id).toBe('t0');
    const w1 = store.workerStats('r').find((w) => w.worker_id === 'w#1')!;
    expect(w1.assigned_function_count).toBe(5);
    expect(w1.assigned_tasks).toBe(2);
    // the database refuses an over-cap count outright
    expect(() => store.db.prepare(`UPDATE run_workers SET assigned_function_count = 6 WHERE worker_id = 'w#1'`).run()).toThrow(/CHECK/);
  });

  it('reports packets no worker can take, refunds unattempted packets and lets the cap be raised', () => {
    const store = tmpStore();
    seed(store, [4, 4, 4, 4]);
    const q = new TaskQueue(store);
    const l1 = q.lease('r', 0, 1, 60_000, { worker: 'w#1' })[0]!;
    q.lease('r', 0, 1, 60_000, { worker: 'w#2' });
    expect(q.capacityBlocked('r', false)).toMatchObject({ pending: 2, blocked: 2, blockedFunctions: 8, inFlight: 2 });
    q.transition(l1.task.id, l1.leaseId, ['leased'], 'pending', {});
    q.unassign('r', 'w#1', l1.task.id);
    expect(q.workerRemaining('r', 'w#1')).toBe(5);
    expect(store.raiseWorkerCap('r', 3)).toBe(false); // never lowered
    expect(store.raiseWorkerCap('r', 60)).toBe(true);
    expect(q.capacityBlocked('r', false).blocked).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------
describe('capacity planning', () => {
  it('warns when workers × cap cannot hold the batch, per tier, and with little headroom', () => {
    const plan = compileFlowPlan(defaultFlow());
    const usable8 = allocateSlots(plan, 8);
    const small = planCapacity({ plan, usable: usable8, repoSlots: 8, maxPerWorker: 60, batch: 500, stealing: true });
    expect(small.workers).toBe(8);
    expect(small.workersNeeded).toBe(9);
    expect(small.ok).toBe(false);
    expect(small.warnings.join(' ')).toMatch(/need at least 9 worker instance/);
    expect(small.warnings.join(' ')).toMatch(/scaled down/);
    const usable = allocateSlots(plan, 64);
    const full = planCapacity({ plan, usable, repoSlots: 64, maxPerWorker: 60, batch: 500, stealing: true });
    expect(full.capacity).toBe(20 * 60);
    expect(full.warnings).toHaveLength(0);
    // routing: 300 hard functions for 4 frontier workers (240) cannot be stolen downwards
    const tiered = planCapacity({ plan, usable, repoSlots: 64, maxPerWorker: 60, batch: 500, demandByTier: [150, 50, 300], stealing: true });
    expect(tiered.unplaced).toBe(60);
    expect(tiered.warnings.join(' ')).toMatch(/frontier tier \(300 fn for 4 worker/);
    // easy overflow is absorbed by idle higher tiers when stealing is on, not otherwise
    expect(planCapacity({ plan, usable, repoSlots: 64, maxPerWorker: 60, batch: 800, demandByTier: [700, 50, 50], stealing: true }).unplaced).toBe(0);
    expect(planCapacity({ plan, usable, repoSlots: 64, maxPerWorker: 60, batch: 800, demandByTier: [700, 50, 50], stealing: false }).unplaced).toBe(100);
  });
});

// ------------------------------------------------------------------------------------------------
function accounts(): Account[] {
  const m = (id: string, capability: 'fast' | 'balanced' | 'frontier', price: [number, number]) => [{ id, roles: ['worker', 'gatekeeper', 'orchestrator'], capability, priceInPerMTok: price[0], priceOutPerMTok: price[1], priceCacheReadPerMTok: price[0] / 10, priceCacheWritePerMTok: price[0] * 1.25 }];
  const o = { latencyMs: [1, 3] };
  const lim = { requestsPerMinute: 100_000, inputTokensPerMinute: 1e9, outputTokensPerMinute: 1e9, maxConcurrency: 16 };
  return [
    mockAccount('haiku', { models: m('haiku', 'fast', [0.1, 0.5]) as never, options: o, limits: lim }),
    mockAccount('sonnet', { models: m('sonnet', 'balanced', [2, 10]) as never, options: o, limits: lim }),
    mockAccount('opus', { models: m('opus', 'frontier', [4, 20]) as never, options: o, limits: lim }),
  ];
}

function world(slots: number) {
  const store = tmpStore();
  const events = new EventBus(store);
  const repo = new SimRepo({ slots, compareLatencyMs: [1, 3], infraRate: 0, backlogSize: 900 });
  const pool = new AccountPool(accounts(), store, events);
  const engine = new RunEngine({ store, pool, providers: new ProviderRegistry({ oracle: repo }), repo, events }, { leaseMs: 5_000, heartbeatMs: 500, infraBackoffMs: 5, idlePollMs: 10 });
  closers.unshift(() => {
    pool.close();
    engine.close();
  });
  return { store, events, repo, pool, engine };
}

describe('end to end: gather → classify → capped tiered distribution', () => {
  it('runs 500 gathered functions across 20 workers without any worker passing 60', async () => {
    const w = world(20);
    const f = defaultFlow();
    const run = w.engine.createRun('gather 500', { flowId: f.id, selection: { source: 'gather', filter: { maxFunctions: 500 } }, maxFunctionsPerWorker: 60, skills: { enabled: false } }, f);
    await w.engine.start(run.id);
    await w.engine.waitFor(run.id);
    const r = w.store.getRun(run.id)!;
    expect(r.status).toBe('completed');
    const fc = w.store.functionCounts(run.id);
    expect(Object.values(fc).reduce((a, b) => a + b, 0)).toBe(500);
    const ws = w.store.workerStats(run.id);
    expect(ws).toHaveLength(20);
    for (const x of ws) expect(x.assigned_function_count).toBeLessThanOrEqual(60);
    expect(ws.filter((x) => x.assigned_function_count > 0).length).toBeGreaterThanOrEqual(9); // spread, not monopolised
    // every assignment is accounted for in the ledger
    const ledger = w.store.db.prepare(`SELECT worker_id, SUM(functions) n FROM worker_assignments WHERE run_id = ? GROUP BY worker_id`).all(run.id) as Array<{ worker_id: string; n: number }>;
    for (const l of ledger) expect(ws.find((x) => x.worker_id === l.worker_id)!.assigned_function_count).toBe(l.n);
    // gather report + metadata persisted, tiers visible per task
    expect(w.store.runJson<{ selected: number }>(run.id, 'gather_json')!.selected).toBe(500);
    expect(w.store.gathered(run.id).length).toBe(500);
    const tiers = w.store.db.prepare(`SELECT complexity_tier, COUNT(*) n FROM task_complexity WHERE run_id = ? GROUP BY complexity_tier`).all(run.id) as Array<{ complexity_tier: string; n: number }>;
    expect(tiers.length).toBeGreaterThanOrEqual(2);
    const cap = w.store.runJson<{ capacity: number; batch: number }>(run.id, 'capacity_json')!;
    expect(cap).toMatchObject({ capacity: 1200, batch: 500 });
  }, 180_000);

  it('staging off commits nothing: passed packets stay passed and no batch is staged', async () => {
    const w = world(10);
    const f = defaultFlow();
    const run = w.engine.createRun('dry', { flowId: f.id, selection: { source: 'gather', filter: { maxFunctions: 40 } }, staging: 'off', skills: { enabled: false } }, f);
    await w.engine.start(run.id);
    await w.engine.waitFor(run.id);
    expect(w.store.getRun(run.id)!.status).toBe('completed');
    const fc = w.store.functionCounts(run.id);
    expect(fc.staged ?? 0).toBe(0);
    expect(fc.passed ?? 0).toBeGreaterThan(0);
    expect(w.store.listBatches(run.id)).toHaveLength(0);
    expect(w.events.query({ runId: run.id, limit: 500 }).some((e) => e.kind === 'run.staging')).toBe(true);
  }, 120_000);

  it('pauses with a capacity error when every eligible worker is capped, and resumes after the cap is raised', async () => {
    const w = world(6);
    const f = defaultFlow();
    const run = w.engine.createRun('tight', { flowId: f.id, selection: { source: 'gather', filter: { maxFunctions: 120 } }, maxFunctionsPerWorker: 8, routing: { workStealing: true }, skills: { enabled: false } }, f);
    await w.engine.start(run.id);
    const deadline = Date.now() + 60_000;
    while (w.store.getRun(run.id)!.status !== 'paused' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(w.store.getRun(run.id)!.status).toBe('paused');
    const ev = w.events.query({ runId: run.id, limit: 500 }).map((e) => e.kind);
    expect(ev).toContain('run.capacity_exhausted');
    expect(ev).toContain('run.capacity'); // the pre-run warning
    for (const x of w.store.workerStats(run.id)) expect(x.assigned_function_count).toBeLessThanOrEqual(8);
    expect(w.store.raiseWorkerCap(run.id, 200)).toBe(true);
    await w.engine.resume(run.id);
    await w.engine.waitFor(run.id);
    expect(w.store.getRun(run.id)!.status).toBe('completed');
    expect(Object.values(w.store.functionCounts(run.id)).reduce((a, b) => a + b, 0)).toBe(120);
  }, 180_000);
});
