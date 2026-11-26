// SPDX-License-Identifier: AGPL-3.0-or-later
// The deterministic tier (docs/recon/INTEGRATION_CONTRACT.md): the engine answers through the shared tail and the
// unchanged Gate Keeper; a run of engine tiers only needs no account, makes no provider call and needs no
// exposure consent; what the engine does not solve moves on with its reason codes; a failing engine process
// is an infrastructure failure.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Flow, FlowNodeData, defaultFlow, deterministicFirstFlow, type Account } from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { RunEngine } from '../src/orchestrator/engine.js';
import { AccountPool } from '../src/pool/scheduler.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { ReconRunner } from '../src/recon/runner.js';
import { LocalHost } from '../src/repo/host.js';
import { SimRepo } from '../src/repo/simRepo.js';
import type { RepoAdapter } from '../src/repo/types.js';
import { EventBus } from '../src/telemetry/events.js';
import { mockAccount } from './helpers.js';

const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fakeEngine.mjs');
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) if (s.db.open) s.db.close();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  }
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'decomp-recon-'));
  dirs.push(d);
  return d;
};

function runner(mode: string, scratch: string) {
  return new ReconRunner({ host: new LocalHost(), engineDir: process.cwd(), python: process.execPath, version: '9.9.9', timeoutMs: 20_000, scratch, args: [FAKE, '--mode', mode] });
}

function setup(opts: { mode?: string; accounts?: Account[]; recon?: boolean; maxInfraFailures?: number } = {}) {
  const dir = tmp();
  const store = new Store(openDatabase(join(dir, 'orch.db')));
  stores.push(store);
  const events = new EventBus(store);
  const repo = new SimRepo({ slots: 4, compareLatencyMs: [1, 2], infraRate: 0 });
  const pool = new AccountPool(opts.accounts ?? [], store, events);
  const providers = new ProviderRegistry({ oracle: repo });
  const calls = { n: 0 };
  const complete = providers.complete.bind(providers);
  providers.complete = (async (...a: Parameters<typeof complete>) => {
    calls.n++;
    return complete(...a);
  }) as typeof providers.complete;
  const recon = opts.recon === false ? null : runner(opts.mode ?? 'sim', join(dir, 'scratch'));
  const engine = new RunEngine({ store, pool, providers, repo, events, recon }, { leaseMs: 10_000, heartbeatMs: 500, infraBackoffMs: 5, idlePollMs: 20, maxInfraFailures: opts.maxInfraFailures ?? 3 });
  return { dir, store, events, repo, pool, providers, engine, calls };
}

const fast = { latencyMs: [1, 3] };

describe('deterministic tier', () => {
  it('runs with no account, no provider call and no exposure consent, and the Gate Keeper decides', async () => {
    const s = setup();
    const flow = deterministicFirstFlow({ withModels: false });
    const run = s.engine.createRun('det', { flowId: flow.id, selection: { source: 'synthetic', count: 24, seed: 21 }, packetMaxFunctions: 1 }, flow);
    expect(run.config.exposureConsent).toBe(false);
    expect(s.store.listAccounts()).toEqual([]);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const r = s.store.getRun(run.id)!;
    expect(r.status).toBe('completed');
    expect(s.calls.n).toBe(0);
    expect(r.costUsd).toBe(0);
    const fc = s.store.functionCounts(run.id);
    expect((fc.staged ?? 0) + (fc.passed ?? 0)).toBeGreaterThan(0);
    expect(fc.dead ?? 0).toBeGreaterThan(0);
    const attempts = s.store.db.prepare('SELECT account_id, model, cost_usd FROM attempts WHERE run_id = ?').all(run.id) as Array<{ account_id: string | null; model: string | null; cost_usd: number }>;
    expect(attempts.length).toBeGreaterThan(0);
    for (const a of attempts) {
      expect(a.account_id).toBeNull();
      expect(a.model).toBe('recon-engine-9.9.9');
      expect(a.cost_usd).toBe(0);
    }
    // One attempt per packet: the same input gives the same answer.
    const most = s.store.db.prepare('SELECT MAX(n) m FROM (SELECT task_id, COUNT(*) n FROM attempts WHERE run_id = ? GROUP BY task_id)').get(run.id) as { m: number };
    expect(most.m).toBe(1);
    // Unsolved packets end with the engine's reason, without a gate call.
    const dead = s.store.db.prepare(`SELECT v.findings_json f FROM tasks t JOIN verdicts v ON v.id = t.last_verdict_id WHERE t.run_id = ? AND t.state = 'dead'`).all(run.id) as Array<{ f: string }>;
    expect(dead.length).toBeGreaterThan(0);
    for (const d of dead) expect(d.f).toContain('RECON_UNSOLVED');
    // Every function asked about has a row of codes and counts.
    const rows = s.store.db.prepare('SELECT status, reason_code FROM recon_results WHERE run_id = ?').all(run.id) as Array<{ status: string; reason_code: string }>;
    expect(rows.length).toBe(24);
    expect(new Set(rows.map((x) => x.status))).toEqual(new Set(['solved', 'unsolved']));
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('sends what the engine does not solve up the model ladder, and the engine never steals or is stolen from', async () => {
    const s = setup({ accounts: [mockAccount('m-a', { options: { ...fast, skill: 0.95 } }), mockAccount('m-b', { options: { ...fast, skill: 0.95 } })] });
    const flow = deterministicFirstFlow();
    const run = s.engine.createRun('det-first', { flowId: flow.id, selection: { source: 'synthetic', count: 30, seed: 5 }, packetMaxFunctions: 1 }, flow);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    // Every packet's first attempt is the engine's.
    const first = s.store.db.prepare('SELECT a.tier, a.account_id FROM attempts a WHERE a.run_id = ? AND a.n = 1').all(run.id) as Array<{ tier: number; account_id: string | null }>;
    expect(first.length).toBe(s.store.listTasks(run.id).length);
    for (const a of first) {
      expect(a.tier).toBe(0);
      expect(a.account_id).toBeNull();
    }
    const escalated = s.store.db.prepare(`SELECT COUNT(*) n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.run_id = ? AND a.tier = 0 AND v.route = 'escalate'`).get(run.id) as { n: number };
    expect(escalated.n).toBeGreaterThan(0);
    const modelPasses = s.store.db.prepare(`SELECT COUNT(*) n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.run_id = ? AND a.tier > 0 AND v.decision = 'pass'`).get(run.id) as { n: number };
    expect(modelPasses.n).toBeGreaterThan(0);
    expect(s.calls.n).toBeGreaterThan(0);
    // The packets the engine solved cost nothing: no model attempt exists for them.
    const solvedByEngine = s.store.db.prepare(`SELECT COUNT(*) n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.run_id = ? AND a.tier = 0 AND v.decision = 'pass'`).get(run.id) as { n: number };
    expect(solvedByEngine.n).toBeGreaterThan(0);
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('records a gate rejection of an engine answer as a disagreement and does not try it again', async () => {
    const s = setup({ mode: 'sim-wrong' });
    const flow = deterministicFirstFlow({ withModels: false });
    const run = s.engine.createRun('det-wrong', { flowId: flow.id, selection: { source: 'synthetic', count: 12, seed: 9 }, packetMaxFunctions: 1 }, flow);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const fc = s.store.functionCounts(run.id);
    expect((fc.passed ?? 0) + (fc.staged ?? 0)).toBe(0);
    const disagreements = s.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE run_id = ? AND kind = 'recon.disagreement'`).get(run.id) as { n: number };
    expect(disagreements.n).toBeGreaterThan(0);
    const most = s.store.db.prepare('SELECT MAX(n) m FROM (SELECT task_id, COUNT(*) n FROM attempts WHERE run_id = ? GROUP BY task_id)').get(run.id) as { m: number };
    expect(most.m).toBe(1);
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('treats a crashing engine as an infrastructure failure, never charged, then moves the packet on', async () => {
    const s = setup({ mode: 'crash', maxInfraFailures: 2, accounts: [mockAccount('m-a', { options: { ...fast, skill: 0.99 } })] });
    const flow = deterministicFirstFlow();
    const run = s.engine.createRun('det-crash', { flowId: flow.id, selection: { source: 'synthetic', count: 4, seed: 2 }, packetMaxFunctions: 1 }, flow);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    expect(s.store.getRun(run.id)!.status).toBe('completed');
    const infra = s.store.db.prepare(`SELECT COUNT(*) n FROM recon_results WHERE run_id = ? AND infra_kind = 'exit'`).get(run.id) as { n: number };
    expect(infra.n).toBeGreaterThan(0);
    const routed = s.store.db.prepare(`SELECT COUNT(*) n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.run_id = ? AND a.tier = 0 AND v.route = 'escalate' AND v.findings_json LIKE '%RECON_INFRA%'`).get(run.id) as { n: number };
    expect(routed.n).toBe(s.store.listTasks(run.id).length);
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('sends the engine the packet, the slot and its own model name, never file contents, packs or candidates', async () => {
    const s = setup();
    const data = tmp();
    (s.repo as SimRepo & Pick<RepoAdapter, 'engineContext'>).engineContext = (slot: number) => ({ worktree: `/wt/slot-${slot}`, checkout: '/checkout', dataDir: data });
    const flow = deterministicFirstFlow({ withModels: false });
    const run = s.engine.createRun('det-sent', { flowId: flow.id, selection: { source: 'synthetic', count: 10, seed: 4 }, packetMaxFunctions: 1 }, flow);
    await s.engine.start(run.id);
    await s.engine.waitFor(run.id);
    const sent = readFileSync(join(data, 'requests.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(sent.length).toBe(s.store.listTasks(run.id).length);
    for (const q of sent) {
      expect(Object.keys(q).sort()).toEqual(expect.arrayContaining(['checkout', 'command', 'dataDir', 'modelName', 'packet', 'protocol', 'requestId', 'worktree']));
      for (const k of Object.keys(q)) expect(['budgets', 'checkout', 'command', 'dataDir', 'modelName', 'options', 'packet', 'protocol', 'requestId', 'worktree']).toContain(k);
      expect(q.modelName).toBe('recon-engine-9.9.9');
      expect(String(q.worktree)).toMatch(/^\/wt\/slot-\d+$/);
      expect(Object.keys(q.packet as object).sort()).toEqual(['allowedPaths', 'functions', 'unit']);
      for (const v of Object.values((q.options ?? {}) as Record<string, unknown>)) expect(typeof v === 'string' && v.length > 40).toBe(false);
    }
    s.pool.close();
    s.engine.close();
  }, 60_000);

  it('refuses a deterministic flow when no engine is configured', () => {
    const s = setup({ recon: false });
    const flow = deterministicFirstFlow({ withModels: false });
    expect(() => s.engine.createRun('x', { flowId: flow.id, selection: { source: 'synthetic', count: 2, seed: 1 } }, flow)).toThrow(/no reconstruction engine/);
    s.pool.close();
    s.engine.close();
  });
});

describe('deterministic tier: saved flows and the request file', () => {
  it('loads a flow saved before worker kinds existed as model tiers, and both presets validate', () => {
    const old = JSON.parse(JSON.stringify(defaultFlow())) as { nodes: Array<{ data: Record<string, unknown> }> };
    for (const n of old.nodes) delete n.data.kind;
    const parsed = Flow.parse(old);
    expect(parsed.nodes.every((n) => n.data.kind === 'llm')).toBe(true);
    expect(FlowNodeData.parse({}).kind).toBe('llm');
    for (const f of [deterministicFirstFlow(), deterministicFirstFlow({ withModels: false })]) expect(Flow.safeParse(f).success).toBe(true);
  });

  it('sends the request in a private file that is gone afterwards, never on stdin', async () => {
    const scratch = tmp();
    const r = runner('solved', scratch);
    const out = await r.solve({ packet: { functions: [{ rva: '0x10', size: 40, name: 'A::B' }], unit: 'reconstruction/a/A.cpp', allowedPaths: ['reconstruction/a/A.cpp'] } }, { signal: new AbortController().signal });
    expect(out.ok).toBe(true);
    expect(out.request.modelName).toBe('recon-engine-9.9.9');
    const left = existsSync(join(scratch, 'requests')) ? readdirSync(join(scratch, 'requests')) : [];
    expect(left).toEqual([]);
  });
});
