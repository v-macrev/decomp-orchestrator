// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 3 benchmark: the closed skill loop in the simulator.
//
// One database across rounds (skills and history accumulate, as in production). Every round runs a
// fresh backlog twice — skills off (control) and skills on — so each comparison is on identical
// functions:
//   round 0  backlog A, skills off                                 history for shadow evaluation
//   →        bootstrap from the (synthetic) cookbook + shadow-evaluate the candidates
//   round 1  backlog B, off vs on (bootstrap skills)
//   →        curate round 1's skills-on run: mine retry wins, patch failure clusters, promote/compress, shadow-evaluate
//   round 2  backlog C, off vs on (curated skills, core promotion)
//
// Effect sizes come from the simulator's trap model (repo/simContent.ts), so the numbers show that
// the machinery finds, gates and prices skills correctly — not how much a real model improves.
//
//   npm run bench:skills -w @decomp/server -- --count 400
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultFlow, type Account } from '@decomp/core';
import { openDatabase } from '../db/database.js';
import { Store } from '../db/store.js';
import { RunEngine } from '../orchestrator/engine.js';
import { AccountPool } from '../pool/scheduler.js';
import { ProviderRegistry } from '../providers/registry.js';
import { SimRepo } from '../repo/simRepo.js';
import { SkillCurator } from '../skills/curator.js';
import { SkillRegistry } from '../skills/registry.js';
import { ShadowEvaluator } from '../skills/shadow.js';
import { CuratorModel } from '../skills/synth.js';
import { EventBus } from '../telemetry/events.js';

const { values: a } = parseArgs({ options: { count: { type: 'string', default: '400' }, seed: { type: 'string', default: '7' }, verbose: { type: 'boolean', default: false } } });

type Cap = 'fast' | 'balanced' | 'frontier';
function accounts(): Account[] {
  const acct = (id: string, model: string, cap: Cap, price: [number, number]): Account => ({
    id, label: id, provider: 'mock', auth: { type: 'none' }, tags: [], priority: 0, enabled: true, options: { latencyMs: [1, 4] },
    limits: { requestsPerMinute: 100_000, inputTokensPerMinute: 1e9, outputTokensPerMinute: 1e9, maxConcurrency: 16 },
    models: [{ id: model, roles: ['worker', 'gatekeeper', 'orchestrator'], capability: cap, contextTokens: 1_000_000, maxOutputTokens: 32_000, priceInPerMTok: price[0], priceOutPerMTok: price[1], priceCacheReadPerMTok: price[0] / 10, priceCacheWritePerMTok: price[0] * 1.25 }],
  });
  return [acct('haiku', 'claude-haiku-5-5', 'fast', [0.1, 0.5]), acct('sonnet', 'claude-sonnet-5-5', 'balanced', [2, 10]), acct('opus', 'claude-opus-5-5', 'frontier', [4, 20])];
}

const dir = mkdtempSync(join(tmpdir(), 'decomp-skills-'));
const store = new Store(openDatabase(join(dir, 'b.db')));
const events = new EventBus(store, a.verbose ? (e) => e.kind.startsWith('skills') && console.log(`    · ${e.msg}`) : undefined);
const repo = new SimRepo({ slots: 16, compareLatencyMs: [1, 3], infraRate: 0, traps: true });
const pool = new AccountPool(accounts(), store, events);
const providers = new ProviderRegistry({ oracle: repo });
const registry = new SkillRegistry(store, join(dir, 'skills'));
const engine = new RunEngine({ store, pool, providers, repo, events, skills: registry }, { leaseMs: 30_000, heartbeatMs: 5_000, idlePollMs: 10 });
const shadow = new ShadowEvaluator({ store, registry, repo, pool, providers, events, engine, context: engine.contextV2 });
const curator = new SkillCurator({ store, registry, repo, events, engine, shadow, model: new CuratorModel(pool, providers), cwd: dir }, { shadow: { cases: 12, repeats: 2 } });
const flow = defaultFlow();
const count = Number(a.count);

async function run(label: string, seed: number, skills: boolean) {
  const r0 = engine.createRun(label, { flowId: flow.id, selection: { source: 'synthetic', count, seed }, exposureConsent: true, maxFunctionsPerWorker: 5000, skills: { enabled: skills } }, flow);
  await engine.start(r0.id);
  await engine.waitFor(r0.id);
  const r = store.getRun(r0.id)!;
  const u = store.runUsage(r.id);
  const fc = store.functionCounts(r.id);
  const total = Object.values(fc).reduce((s, n) => s + n, 0);
  const matched = (fc.passed ?? 0) + (fc.staged ?? 0);
  const prefixes = (store.db.prepare(`SELECT COUNT(DISTINCT json_extract(b.json, '$.staticPrefixHash')) n FROM attempts a JOIN bundles b ON b.hash = a.bundle_hash WHERE a.run_id = ?`).get(r.id) as { n: number }).n;
  const inj = store.db.prepare('SELECT SUM(injected) i, SUM(1 - injected) h, SUM(tokens) t FROM skill_injections WHERE run_id = ?').get(r.id) as { i: number | null; h: number | null; t: number | null };
  return {
    id: r.id, label, matched, prefixes, total, attempts: u.attempts as number, input: r.inputTokens, cached: r.cachedInputTokens, output: r.outputTokens, cost: r.costUsd,
    injected: inj.i ?? 0, heldOut: inj.h ?? 0, skillTokens: inj.t ?? 0, core: r.config.skills.enabled ? (JSON.parse((store.db.prepare('SELECT skills_json FROM runs WHERE id = ?').get(r.id) as { skills_json: string | null }).skills_json ?? '{"core":[]}') as { core: unknown[] }).core.length : 0,
  };
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
type Row = Awaited<ReturnType<typeof run>>;
function print(rows: Row[]) {
  console.log('  run                               matched     pass   att/fn   tok/fn  cache   $/fn     skills inj/held  core  prefixes');
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(32)} ${`${r.matched}/${r.total}`.padStart(9)} ${`${Math.round((r.matched / r.total) * 1000) / 10}%`.padStart(7)} ${(r.attempts / Math.max(1, r.matched)).toFixed(2).padStart(7)} ${k(Math.round((r.input + r.output) / Math.max(1, r.matched))).padStart(8)} ${`${Math.round((r.cached / Math.max(1, r.input)) * 100)}%`.padStart(6)} ${(r.cost / Math.max(1, r.matched)).toFixed(4).padStart(8)}   ${`${r.injected}/${r.heldOut}`.padStart(12)}  ${String(r.core).padStart(4)}  ${String(r.prefixes).padStart(8)}`);
  }
}
function skillsTable() {
  for (const s of registry.list()) {
    const t = s.telemetry;
    console.log(`    ${s.status.padEnd(17)} v${s.version} ${s.name.slice(0, 58).padEnd(58)} ${String(s.tokenCount).padStart(4)} tok  inj ${String(t.injectCount).padStart(4)}  lift ${t.lift === null ? '  n/a' : `${t.lift >= 0 ? '+' : ''}${t.lift.toFixed(2)}`} (${t.liftMethod})${s.statusReason ? `  — ${s.statusReason.slice(0, 70)}` : ''}`);
  }
}

const seed = Number(a.seed);
console.log(`\nPhase 3 skill loop — simulator, ${count} functions per backlog, routed + budgeted context, exposure consent on\n`);
const r0 = await run('round 0 · backlog A · skills off', seed, false);
print([r0]);

console.log('\n→ bootstrap from the cookbook + shadow evaluation');
let job = await curator.run('bootstrap', { evaluate: true }).done;
console.log(`  ${job.status}: ${JSON.stringify({ created: job.summary.created, duplicates: job.summary.duplicates, evaluated: (job.summary.evaluated as Record<string, unknown> | undefined)?.evaluated, accepted: (job.summary.evaluated as Record<string, unknown> | undefined)?.accepted })}  curator spend $${job.costUsd.toFixed(3)}`);
skillsTable();

console.log('\nround 1 · backlog B');
const r1off = await run('round 1 · B · skills off', seed + 1, false);
const r1on = await run('round 1 · B · skills on', seed + 1, true);
print([r1off, r1on]);

console.log(`\n→ curate round 1 (mine retry wins → patch failure clusters → promote/compress → shadow-evaluate)`);
job = await curator.run('curate', { runId: r1on.id }).done;
const s = job.summary as Record<string, Record<string, unknown>>;
console.log(`  ${job.status}: mined ${s.mine?.created ?? 0} from ${s.mine?.wins ?? 0} wins · ${s.update?.proposals ?? 0} patch(es) from ${s.update?.clusters ?? 0} cluster(s) · promoted ${(s.optimize?.promoted as unknown[] | undefined)?.length ?? 0} · compressed ${(s.optimize?.compressions as unknown[] | undefined)?.length ?? 0} · deprecated ${(s.optimize?.deprecated as unknown[] | undefined)?.length ?? 0} · shadow: ${s.evaluate?.accepted ?? 0} accepted / ${s.evaluate?.rejected ?? 0} rejected   curator spend $${job.costUsd.toFixed(3)}`);
skillsTable();

console.log('\nround 2 · backlog C');
const r2off = await run('round 2 · C · skills off', seed + 2, false);
const r2on = await run('round 2 · C · skills on', seed + 2, true);
print([r2off, r2on]);

const evals = registry.evals(100);
console.log(`\nshadow evaluations: ${evals.length} (${evals.filter((e) => e.decision === 'accept').length} accepted, ${evals.filter((e) => e.decision === 'reject').length} rejected, ${evals.filter((e) => e.status === 'error').length} errors), total $${evals.reduce((x, e) => x + e.costUsd, 0).toFixed(3)}`);
for (const e of evals.slice(0, 12)) console.log(`    ${e.decision ?? e.status} ${registry.get(e.skillId)?.name.slice(0, 50) ?? e.skillId} v${e.version}: ${e.reason}`);

pool.close();
engine.close();
store.db.close();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* Windows may hold the WAL briefly */
}
