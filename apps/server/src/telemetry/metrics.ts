// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from '../db/store.js';
import type { RunEngine } from '../orchestrator/engine.js';
import type { AccountPool } from '../pool/scheduler.js';

export function runMetrics(store: Store, engine: RunEngine, pool: AccountPool, runId: string) {
  const run = store.getRun(runId);
  if (!run) return null;
  const tasks = store.taskCounts(runId);
  const functions = store.functionCounts(runId);
  const usage = store.runUsage(runId);
  const now = Date.now();
  const passRows = store.db
    .prepare(`SELECT v.created_at t, json_array_length(t.functions_json) n FROM verdicts v JOIN tasks t ON t.id = v.task_id
      WHERE t.run_id = ? AND v.decision = 'pass' AND v.created_at > ?`)
    .all(runId, now - 15 * 60_000) as Array<{ t: number; n: number }>;
  const inWindow = (ms: number) => passRows.filter((r) => r.t > now - ms).reduce((s, r) => s + r.n, 0);
  // Average over min(5 min, time since start) so early-run rates aren't diluted by an empty window.
  const windowMin = Math.max(0.25, Math.min(5, run.startedAt ? (now - run.startedAt) / 60_000 : 5));
  const perMin5 = inWindow(windowMin * 60_000) / windowMin;
  const totalFns = Object.values(functions).reduce((a, b) => a + b, 0);
  const open = (functions.pending ?? 0) + (functions.leased ?? 0) + (functions.gating ?? 0);
  const routes = Object.fromEntries(
    (store.db.prepare(`SELECT v.route, COUNT(*) n FROM verdicts v JOIN tasks t ON t.id = v.task_id WHERE t.run_id = ? GROUP BY v.route`).all(runId) as Array<{ route: string; n: number }>).map((r) => [r.route, r.n]),
  );
  const tiers = store.db
    .prepare(`SELECT tier, state, COUNT(*) n FROM tasks WHERE run_id = ? GROUP BY tier, state`)
    .all(runId) as Array<{ tier: number; state: string; n: number }>;
  // Throughput series: passed functions per minute over the last 15 minutes.
  const series = Array.from({ length: 15 }, (_, i) => {
    const end = now - (14 - i) * 60_000;
    return { t: end, passed: passRows.filter((r) => r.t <= end && r.t > end - 60_000).reduce((s, r) => s + r.n, 0) };
  });
  return {
    run: { id: run.id, name: run.name, status: run.status, costUsd: run.costUsd, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, budgetUsd: run.config.budgetUsd ?? null, error: run.error },
    engine: engine.status(runId),
    tasks,
    functions,
    totalFunctions: totalFns,
    queueDepth: functions.pending ?? 0,
    routes,
    tiers,
    usage: {
      attempts: usage.attempts ?? 0,
      providerErrors: usage.provider_errors ?? 0,
      parseErrors: usage.parse_errors ?? 0,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_tokens ?? 0,
      costUsd: usage.cost_usd ?? 0,
    },
    throughput: { passedPerMin5: Math.round(perMin5 * 10) / 10, etaMinutes: perMin5 > 0 ? Math.round(open / perMin5) : null, series },
    byAccount: store.usageByAccount(runId),
    accounts: pool.view(),
  };
}
