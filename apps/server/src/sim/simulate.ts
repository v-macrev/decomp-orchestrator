// SPDX-License-Identifier: AGPL-3.0-or-later
// Headless end-to-end simulation: a 500-function run over a fault-injecting multi-account pool
// (hidden provider RPM cap → 429s, a 25 s outage on one workspace, quota exhaustion on another,
// random 5xx, a fraction of cheating outputs), with a hard crash at ~40% followed by a restart
// that resumes from the database. Prints a summary at the end.
//
//   npm run sim -- --count 500 --crash-at 0.4 --speed 4
import { parseArgs } from 'node:util';
import { defaultFlow } from '@decomp/core';
import { createApp, demoAccounts } from '../app.js';
import { ServerConfig } from '../config.js';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '500' },
    'crash-at': { type: 'string', default: '0.4' },
    speed: { type: 'string', default: '4' },
    cheat: { type: 'string', default: '0.03' },
  },
});
const count = Number(values.count);
const crashAt = Number(values['crash-at']);
const speed = Number(values.speed);
const dbPath = `data/sim/sim-${Date.now()}.db`;
const cfg = ServerConfig.parse({ mode: 'sim', dbPath, sim: { slots: 16, compareLatencyMs: [150 / speed, 600 / speed], infraRate: 0.01 }, engine: { infraBackoffMs: Math.round(15_000 / speed) } });

function scaledAccounts() {
  return demoAccounts().map((a) => {
    const o = { ...a.options } as Record<string, any>;
    if (o.latencyMs) o.latencyMs = (o.latencyMs as number[]).map((x) => x / speed);
    if (o.outages) o.outages = (o.outages as number[][]).map(([f, t]) => [f! / speed, t! / speed]);
    o.cheatRate = Number(values.cheat);
    return { ...a, options: o };
  });
}

async function boot() {
  const app = await createApp(cfg, { quiet: false });
  for (const a of scaledAccounts()) app.store.upsertAccount(a);
  app.reloadAccounts();
  return app;
}

const t0 = Date.now();
let app = await boot();
const flow = defaultFlow();
app.store.upsertFlow(flow);
const run = app.engine.createRun(`sim-${count}`, { flowId: flow.id, selection: { source: 'synthetic', count, seed: 42 }, prBatchSize: 50, gateConcurrency: 6 }, flow);
console.log(`\n▶ run ${run.id}: ${count} functions, db ${dbPath}\n`);
await app.engine.start(run.id);

const done = (a: typeof app) => {
  const fc = a.store.functionCounts(run.id);
  return (fc.passed ?? 0) + (fc.staged ?? 0) + (fc.dead ?? 0) + (fc.quarantined ?? 0);
};
const progress = setInterval(() => {
  const fc = app.store.functionCounts(run.id);
  const acc = app.pool.view().map((v) => `${v.accountId.replace('sim-', '')}:${v.status}${v.status === 'ok' ? '' : '!'}`).join(' ');
  process.stdout.write(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  done ${String(done(app)).padStart(4)}/${count}  pending ${fc.pending ?? 0}  in-flight ${(fc.leased ?? 0) + (fc.gating ?? 0)}  | ${acc}\n`);
}, 3_000);

if (crashAt > 0 && crashAt < 1) {
  while (done(app) < count * crashAt) await new Promise((r) => setTimeout(r, 200));
  console.log(`\n✖ simulated crash at ${done(app)}/${count} (hard stop, no cleanup)\n`);
  await app.engine.hardStop();
  app.pool.close();
  app.store.db.close();
  app = await boot();
  console.log('↻ restarted; recovering from the database\n');
  await app.engine.resumeOnBoot();
}
await app.engine.waitFor(run.id);
clearInterval(progress);

const m = app.store;
const r = m.getRun(run.id)!;
const fc = m.functionCounts(run.id);
const usage = m.runUsage(run.id);
const routes = m.db.prepare(`SELECT route, COUNT(*) n FROM verdicts GROUP BY route`).all() as Array<{ route: string; n: number }>;
const codes = m.topFindingCodes(run.id, 10);
const abandoned = (m.db.prepare(`SELECT COUNT(*) n FROM attempts WHERE status = 'abandoned'`).get() as { n: number }).n;
const provider = m.db.prepare(`SELECT substr(error, 1, instr(error, ':') - 1) kind, COUNT(*) n FROM attempts WHERE status = 'provider_error' GROUP BY kind`).all() as Array<{ kind: string; n: number }>;

console.log(`\n■ ${r.status.toUpperCase()} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  functions: ${fc.staged ?? 0} staged · ${fc.dead ?? 0} dead · ${fc.quarantined ?? 0} quarantined · ${fc.pending ?? 0} pending`);
console.log(`  attempts: ${usage.attempts} (${abandoned} abandoned by crash/abort, ${usage.provider_errors} provider errors, ${usage.parse_errors} parse errors)`);
console.log(`  provider errors by kind: ${provider.map((p) => `${p.kind}=${p.n}`).join(' ') || 'none'}`);
console.log(`  verdict routes: ${routes.map((x) => `${x.route}=${x.n}`).join(' ')}`);
console.log(`  top rejection codes: ${codes.map((c) => `${c.code}=${c.n}`).join(' ')}`);
console.log(`  tokens: in ${usage.input_tokens} · out ${usage.output_tokens} · cost $${r.costUsd.toFixed(2)}`);
console.log('  per account:');
for (const a of m.usageByAccount(run.id)) {
  console.log(`    ${String(a.account_id).padEnd(18)} ${String(a.model).padEnd(18)} attempts ${String(a.attempts).padStart(4)}  ok ${String(a.completed).padStart(4)}  provider-err ${String(a.provider_errors).padStart(3)}  $${Number(a.cost_usd ?? 0).toFixed(2)}`);
}
console.log('  account health:');
for (const v of app.pool.view()) console.log(`    ${v.accountId.padEnd(18)} ${v.status.padEnd(16)} 429s ${String(v.rateLimitedTotal).padStart(3)}  fails ${String(v.failuresTotal).padStart(3)}  limit ${v.concurrencyLimit}/${v.maxConcurrency}${v.lastError ? `  last: ${v.lastError}` : ''}`);
console.log(`  PR batches: ${m.listBatches(run.id).map((b) => `#${b.seq} ${b.status} (${(b.detail as { functions?: number } | null)?.functions ?? '?'} fns)`).join(', ')}`);
await app.close();
process.exit(r.status === 'completed' ? 0 : 1);
