// SPDX-License-Identifier: AGPL-3.0-or-later
// Token / cost benchmark for Phase 2.
//
// Part A — simulator, end to end (same backlog, same seed, list prices, no fault injection):
//   1. baseline   pre-Phase-2: cheap → strong ladder, legacy bundles (raw docs/headers/previous file)
//   2. +context   same ladder, budgeted TaskContextBundle v2 + prompt caching      (isolates context work)
//   3. phase 2    complexity-routed fast → balanced → frontier ladder + budgeted context
//
// Part B — real skyrim_decomp checkout (optional, read-only): builds legacy and budgeted bundles for
// real `sr next` candidates from a pristine worktree at the base revision. No claims, no starts, no
// writes, no model calls; worktrees are removed afterwards. Also classifies the local packs (counts).
//
//   npm run bench:context -w @decomp/server -- --count 500
//   npm run bench:context -w @decomp/server -- --repo /home/me/skyrim_decomp --local /home/me/skyrim_decomp/.local --worktrees /home/me/decomp-bench --host wsl
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ContextConfig, ComplexityThresholds, assessPacket, defaultFlow, type Account, type Flow } from '@decomp/core';
import { openDatabase } from '../db/database.js';
import { Store, type TaskRow } from '../db/store.js';
import { ContextBuilder } from '../orchestrator/context.js';
import { TaskContextBuilder } from '../orchestrator/contextBuilder.js';
import { RunEngine } from '../orchestrator/engine.js';
import { WORKER_SYSTEM, buildWorkerPrompt } from '../orchestrator/prompts.js';
import { AccountPool } from '../pool/scheduler.js';
import { ProviderRegistry } from '../providers/registry.js';
import { SimRepo } from '../repo/simRepo.js';
import { SrRepo } from '../repo/srRepo.js';
import { EventBus } from '../telemetry/events.js';
import { estimateTokens } from '../util/tokens.js';

const { values: a } = parseArgs({
  options: {
    count: { type: 'string', default: '500' },
    seed: { type: 'string', default: '42' },
    consent: { type: 'boolean', default: true },
    repo: { type: 'string' },
    local: { type: 'string' },
    worktrees: { type: 'string' },
    host: { type: 'string', default: 'wsl' },
    distro: { type: 'string', default: 'Ubuntu' },
    base: { type: 'string', default: 'origin/main' },
    candidates: { type: 'string', default: '40' },
    'max-size': { type: 'string', default: '64' },
  },
});

// ------------------------------------------------------------------------------------------- A
type Cap = 'fast' | 'balanced' | 'frontier';
function accounts(): Account[] {
  const acct = (id: string, model: string, cap: Cap, price: [number, number], tags: string[]): Account => ({
    id, label: id, provider: 'mock', auth: { type: 'none' }, tags, priority: 0, enabled: true, options: { latencyMs: [1, 4] },
    limits: { requestsPerMinute: 100_000, inputTokensPerMinute: 1e9, outputTokensPerMinute: 1e9, maxConcurrency: 16 },
    models: [{ id: model, roles: ['worker', 'gatekeeper', 'orchestrator'], capability: cap, contextTokens: 1_000_000, maxOutputTokens: 32_000, priceInPerMTok: price[0], priceOutPerMTok: price[1], priceCacheReadPerMTok: price[0] / 10, priceCacheWritePerMTok: price[0] * 1.25 }],
  });
  return [
    acct('haiku', 'claude-haiku-5-5', 'fast', [0.1, 0.5], ['fast']),
    acct('sonnet', 'claude-sonnet-5-5', 'balanced', [2, 10], ['cheap']),
    acct('opus', 'claude-opus-5-5', 'frontier', [4, 20], ['strong', 'orchestrator']),
  ];
}

/** The pre-Phase-2 default preset: Sonnet-class cheap tier (12) → Opus-class strong tier (4). */
function legacyFlow(): Flow {
  const f = defaultFlow();
  const orch = f.nodes.find((n) => n.type === 'orchestrator')!;
  const gate = f.nodes.find((n) => n.type === 'gatekeeper')!;
  const base = f.nodes.find((n) => n.id === 'worker-fast')!;
  const w = (id: string, label: string, instances: number, tags: string[], maxAttempts: number, stuckAfter: number) => ({ ...base, id, data: { ...base.data, label, instances, maxAttempts, stuckAfter, capability: undefined, costWeight: undefined, pool: { strategy: 'pool' as const, accountIds: [], tags } } });
  return {
    id: 'legacy', name: 'Cheap → strong ladder',
    nodes: [orch, w('worker-cheap', 'Workers (cheap)', 12, ['cheap'], 6, 3), w('worker-strong', 'Workers (strong)', 4, ['strong'], 10, 4), gate],
    edges: [
      { id: 'd', source: orch.id, target: 'worker-cheap', kind: 'dispatch' },
      { id: 's1', source: 'worker-cheap', target: gate.id, kind: 'submit' }, { id: 's2', source: 'worker-strong', target: gate.id, kind: 'submit' },
      { id: 'r1', source: gate.id, target: 'worker-cheap', kind: 'reject_retry' }, { id: 'r2', source: gate.id, target: 'worker-strong', kind: 'reject_retry' },
      { id: 'e', source: 'worker-cheap', target: 'worker-strong', kind: 'escalate' }, { id: 'rep', source: gate.id, target: orch.id, kind: 'report' },
    ],
  };
}

async function simRun(label: string, flow: Flow, context: 'legacy' | 'budgeted', routing: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'decomp-bench-'));
  const store = new Store(openDatabase(join(dir, 'b.db')));
  const events = new EventBus(store);
  const repo = new SimRepo({ slots: 16, compareLatencyMs: [1, 3], infraRate: 0 });
  const pool = new AccountPool(accounts(), store, events);
  const engine = new RunEngine({ store, pool, providers: new ProviderRegistry({ oracle: repo }), repo, events }, { leaseMs: 30_000, heartbeatMs: 5_000, idlePollMs: 10 });
  const t0 = Date.now();
  const run = engine.createRun(label, {
    flowId: flow.id, selection: { source: 'synthetic', count: Number(a.count), seed: Number(a.seed) }, exposureConsent: a.consent,
    context: { mode: context }, routing: { enabled: routing },
  }, flow);
  await engine.start(run.id);
  await engine.waitFor(run.id);
  const r = store.getRun(run.id)!;
  const u = store.runUsage(run.id);
  const fc = store.functionCounts(run.id);
  const matched = (fc.passed ?? 0) + (fc.staged ?? 0);
  const out = {
    label, matched, attempts: u.attempts as number, input: r.inputTokens, cached: r.cachedInputTokens, output: r.outputTokens, cost: r.costUsd,
    perFn: Math.round((r.inputTokens + r.outputTokens) / Math.max(1, matched)), costPerFn: r.costUsd / Math.max(1, matched), secs: (Date.now() - t0) / 1000,
  };
  pool.close();
  engine.close();
  store.db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold the WAL briefly */
  }
  return out;
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (x: number, base: number) => `${x <= base ? '−' : '+'}${Math.abs(Math.round((1 - x / base) * 100))}%`;

async function partA() {
  console.log(`\nPart A — simulator, ${a.count} functions, seed ${a.seed}, exposure consent ${a.consent ? 'on' : 'off'} (list prices; no fault injection)\n`);
  const rows = [
    await simRun('1 baseline (legacy bundles, cheap→strong)', legacyFlow(), 'legacy', false),
    await simRun('2 + budgeted context & caching', legacyFlow(), 'budgeted', false),
    await simRun('3 phase 2 (routed fast→balanced→frontier)', defaultFlow(), 'budgeted', true),
  ];
  const b = rows[0]!;
  console.log('config                                        matched  attempts  input     cached  output   tok/fn   Δtok/fn  cost     $/fn      Δ$/fn');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(45)} ${String(r.matched).padStart(7)} ${String(r.attempts).padStart(9)}  ${k(r.input).padStart(7)} ${`${Math.round((r.cached / Math.max(1, r.input)) * 100)}%`.padStart(7)} ${k(r.output).padStart(7)} ${k(r.perFn).padStart(8)} ${(r === b ? '' : pct(r.perFn, b.perFn)).padStart(8)}  $${r.cost.toFixed(2).padStart(6)} ${r.costPerFn.toFixed(4).padStart(8)} ${(r === b ? '' : pct(r.costPerFn, b.costPerFn)).padStart(8)}`,
    );
  }
}

// ------------------------------------------------------------------------------------------- B
async function partB() {
  if (!a.repo || !a.local || !a.worktrees) return;
  console.log(`\nPart B — real checkout ${a.repo} (read-only: no claims, no writes, no model calls)\n`);
  const repo = new SrRepo({ repoPath: a.repo, baseRef: a.base, worktreeRoot: a.worktrees, localDir: a.local, python: 'python3', slots: 1, host: a.host === 'wsl' ? { kind: 'wsl', distro: a.distro } : { kind: 'local' }, sandbox: { mode: 'local' } });
  const store = new Store(openDatabase(':memory:'));
  try {
    await repo.init();
    const found = await repo.discover({ source: 'sr_next', count: Number(a.candidates) * 4, maxSize: Number(a['max-size']) });
    const T = ComplexityThresholds.parse({});
    const feats = await repo.analyze(found);
    const dist: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
    for (const f of feats.values()) dist[assessPacket([f], T).difficulty]!++;
    console.log(`  local packs analysed for ${feats.size}/${found.length} candidates → difficulty ${JSON.stringify(dist)} (counts only)`);
    const legacy = new ContextBuilder(repo, store);
    const v2 = new TaskContextBuilder(repo, store);
    const cfg = ContextConfig.parse({});
    let nL = 0, nV = 0, n = 0;
    const perSection: Record<string, number> = {};
    for (const f of found) {
      if (n >= Number(a.candidates)) break;
      const cpp = f.unit;
      if ((await repo.readFile(0, cpp)) === null) continue; // only units that exist at the base revision
      const task: TaskRow = {
        id: `bench-${f.rva}`, runId: 'bench', unit: cpp, functions: [{ rva: f.rva, name: f.name, size: f.size, nameOrigin: f.nameOrigin ?? null }], state: 'leased',
        priority: 0, tier: 0, attemptsTotal: 0, attemptsAtTier: 0, noImprovementStreak: 0, bestExactBytes: 0, cheatStrikes: 0, infraFailures: 0, providerFailures: 0,
        leaseId: null, leaseExpiresAt: null, notBefore: 0, lastVerdictId: null, srTaskId: null, updatedAt: 0,
        difficulty: feats.has(f.rva) ? assessPacket([feats.get(f.rva)!], T).difficulty : 'medium', complexity: 0, attemptsAtDifficulty: 0, assessment: null,
      };
      const prepared = { srTaskId: null, allowedPaths: [cpp.replace(/\.cpp$/, '.h'), cpp], packs: [], toolingChanges: [] };
      const lb = await legacy.build(task, prepared, 0, { runId: 'bench', exposureConsent: false, carried: [] });
      const lTok = estimateTokens(WORKER_SYSTEM) + estimateTokens(buildWorkerPrompt(task, lb, 1, null, []));
      const vb = await v2.build(task, prepared, 0, { runId: 'bench', exposureConsent: false, carried: [], attemptNo: 1, feedback: null, pitfalls: [], context: cfg });
      for (const s of vb.sections) perSection[s.kind] = (perSection[s.kind] ?? 0) + s.tokens;
      nL += lTok;
      nV += vb.tokens.sent;
      n++;
    }
    if (!n) {
      console.log('  no candidates with an existing unit at the base revision');
      return;
    }
    const staticT = Math.round((perSection.static_system_prefix ?? 0) / n);
    console.log(`  ${n} real packets (no exposure consent → no listings in either form)`);
    console.log(`  legacy bundle  ${k(Math.round(nL / n))} tokens/packet`);
    console.log(`  budgeted       ${k(Math.round(nV / n))} tokens/packet  (${pct(nV, nL)}); of which static cached prefix ${staticT}`);
    console.log(`  per section (avg): ${Object.entries(perSection).map(([s, t]) => `${s} ${Math.round(t / n)}`).join(' · ')}`);
    console.log(`  with the static prefix read from cache (0.1×): ≈${k(Math.round(nV / n - staticT * 0.9))} billed-equivalent tokens/packet (${pct(nV - staticT * 0.9 * n, nL)})`);
  } finally {
    await repo.removeWorktrees().catch(() => undefined);
    store.db.close();
  }
}

await partA();
await partB();
