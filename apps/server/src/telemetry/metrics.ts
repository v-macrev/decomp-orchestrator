// SPDX-License-Identifier: AGPL-3.0-or-later
import { DIFFICULTIES, compileFlowPlan, type ModelSpec } from '@decomp/core';
import type { Store } from '../db/store.js';
import type { RunEngine } from '../orchestrator/engine.js';
import type { AccountPool } from '../pool/scheduler.js';

/** Token + caching economics of a run, priced per (account, model) actually used. */
function tokenEconomics(store: Store, runId: string) {
  const models = new Map<string, ModelSpec>();
  for (const a of store.listAccounts()) for (const m of a.models) models.set(`${a.id}\0${m.id}`, m);
  let savedByCachingUsd = 0;
  for (const r of store.usageByAccount(runId)) {
    const m = models.get(`${r.account_id}\0${r.model}`);
    if (!m) continue;
    const reads = r.cached_input_tokens ?? 0;
    const writes = m.priceCacheWritePerMTok !== undefined ? r.cache_write_tokens ?? 0 : 0;
    savedByCachingUsd += (reads * (m.priceInPerMTok - m.priceCacheReadPerMTok) - writes * ((m.priceCacheWritePerMTok ?? m.priceInPerMTok) - m.priceInPerMTok)) / 1_000_000;
  }
  return { savedByCachingUsd: Math.round(savedByCachingUsd * 10_000) / 10_000 };
}

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
  // Routing: plan, where packets sit by difficulty, attempts/pass per (difficulty, tier), adaptive moves.
  let plan: ReturnType<typeof compileFlowPlan> | null = null;
  try {
    plan = compileFlowPlan(run.flow);
  } catch {
    /* invalid snapshot: routing panel stays empty */
  }
  const moves = Object.fromEntries(
    (store.db.prepare(`SELECT kind, COUNT(*) n FROM events WHERE run_id = ? AND kind IN ('task.stolen','task.promoted','task.rerouted','task.escalated') GROUP BY kind`).all(runId) as Array<{ kind: string; n: number }>).map((r) => [r.kind.slice(5), r.n]),
  );
  const diffRows = store.difficultyCounts(runId);
  const byDifficulty = Object.fromEntries(
    DIFFICULTIES.map((d) => {
      const rows = diffRows.filter((r) => r.difficulty === d);
      const fns = (states: string[]) => rows.filter((r) => states.includes(r.state)).reduce((s, r) => s + r.functions, 0);
      return [d, { packets: rows.reduce((s, r) => s + r.n, 0), functions: fns(['pending', 'leased', 'gating', 'passed', 'staged', 'dead', 'quarantined', 'cancelled']), open: fns(['pending', 'leased', 'gating']), matched: fns(['passed', 'staged']), dead: fns(['dead', 'quarantined']) }];
    }),
  );
  const inTok = usage.input_tokens ?? 0;
  const cached = usage.cache_read_tokens ?? 0;
  const ctxSent = usage.context_tokens ?? 0;
  const ctxRaw = usage.context_raw_tokens ?? 0;
  const matchedFns = (functions.passed ?? 0) + (functions.staged ?? 0);
  return {
    run: { id: run.id, name: run.name, status: run.status, costUsd: run.costUsd, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, budgetUsd: run.config.budgetUsd ?? null, error: run.error, contextMode: run.config.context.mode, routingEnabled: run.config.routing.enabled },
    routing: plan
      ? {
          enabled: run.config.routing.enabled,
          tiers: plan.tiers.map((t) => ({ index: t.index, node: t.node.id, label: t.node.data.label || t.node.id, capability: t.capability, inferred: t.capabilityInferred, instances: t.node.data.instances })),
          route: plan.route,
          routeSource: plan.routeSource,
          byDifficulty,
          matrix: store.routingMatrix(runId),
          moves,
        }
      : null,
    knowledge: { byKind: store.knowledgeStats(runId), recent: store.listKnowledge(runId, 8).map((k) => ({ kind: k.kind, symbol: k.symbol, sourceUnit: k.sourceUnit, uses: k.uses })) },
    skills: skillMetrics(store, runId, run.config.skills.enabled),
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
      inputTokens: inTok,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: usage.cache_write_tokens ?? 0,
      /** Share of input tokens served from provider prompt caches. */
      cacheHitRate: inTok ? Math.round((cached / inTok) * 1000) / 1000 : 0,
      /** Bundle tokens actually sent vs. what the unsliced sources (≈ legacy bundles) would have cost. */
      contextTokens: ctxSent,
      contextRawTokens: ctxRaw,
      contextSavedPct: ctxRaw ? Math.round((1 - ctxSent / ctxRaw) * 1000) / 10 : 0,
      tokensPerMatchedFunction: matchedFns ? Math.round((inTok + (usage.output_tokens ?? 0)) / matchedFns) : null,
      costPerMatchedFunction: matchedFns ? Math.round(((usage.cost_usd ?? 0) / matchedFns) * 10_000) / 10_000 : null,
      ...tokenEconomics(store, runId),
      costUsd: usage.cost_usd ?? 0,
    },
    throughput: { passedPerMin5: Math.round(perMin5 * 10) / 10, etaMinutes: perMin5 > 0 ? Math.round(open / perMin5) : null, series },
    byAccount: store.usageByAccount(runId),
    accounts: pool.view(),
  };
}

/** Frozen skill snapshot of the run + per-skill injections, held-out controls and outcomes. */
function skillMetrics(store: Store, runId: string, enabled: boolean) {
  if (!enabled) return { enabled: false as const };
  const row = store.db.prepare('SELECT skills_json FROM runs WHERE id = ?').get(runId) as { skills_json: string | null } | undefined;
  const snap = row?.skills_json ? (JSON.parse(row.skills_json) as { core: Array<{ id: string; name: string; tokens: number }>; dynamic: unknown[]; coreHash: string }) : null;
  const rows = store.db.prepare(`SELECT si.skill_id, s.name, SUM(si.injected) injected, SUM(1 - si.injected) held,
      SUM(CASE WHEN si.injected = 1 AND si.decision = 'pass' THEN 1 ELSE 0 END) injected_pass, SUM(CASE WHEN si.injected = 1 AND si.decision IS NOT NULL THEN 1 ELSE 0 END) injected_done,
      SUM(CASE WHEN si.injected = 0 AND si.decision = 'pass' THEN 1 ELSE 0 END) held_pass, SUM(CASE WHEN si.injected = 0 AND si.decision IS NOT NULL THEN 1 ELSE 0 END) held_done,
      SUM(si.tokens) tokens, COUNT(DISTINCT si.task_id) tasks
    FROM skill_injections si LEFT JOIN skills s ON s.id = si.skill_id WHERE si.run_id = ? GROUP BY si.skill_id ORDER BY injected DESC`).all(runId) as Array<Record<string, number | string>>;
  const prefixes = (store.db.prepare(`SELECT COUNT(DISTINCT json_extract(b.json, '$.staticPrefixHash')) n FROM attempts a JOIN bundles b ON b.hash = a.bundle_hash WHERE a.run_id = ?`).get(runId) as { n: number }).n;
  return {
    enabled: true as const,
    core: snap?.core ?? [],
    coreTokens: (snap?.core ?? []).reduce((s, c) => s + c.tokens, 0),
    dynamic: snap?.dynamic.length ?? 0,
    /** Distinct static prefixes sent in this run: 1 means the shared cache prefix never changed. */
    staticPrefixes: prefixes,
    bySkill: rows.map((r) => ({
      skillId: r.skill_id as string, name: (r.name as string) ?? (r.skill_id as string), tasks: r.tasks as number, injected: r.injected as number, heldOut: r.held as number, tokens: r.tokens as number,
      passRate: (r.injected_done as number) ? Math.round(((r.injected_pass as number) / (r.injected_done as number)) * 1000) / 1000 : null,
      heldOutPassRate: (r.held_done as number) ? Math.round(((r.held_pass as number) / (r.held_done as number)) * 1000) / 1000 : null,
    })),
  };
}
