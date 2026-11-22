// SPDX-License-Identifier: AGPL-3.0-or-later
// REST + SSE API for the UI. Binds to localhost by default; set ORCH_API_TOKEN to require a bearer
// token (the UI forwards it). Secrets are never returned: accounts only carry secret references.
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Account, ComplexityThresholds, Flow, GatherFilter, RunConfig, SelectionSpec, classify, compileFlowPlan, scoreFeatures, sizeOnlyFeatures, validateFlow, type TelemetryEvent } from '@decomp/core';
import { planCapacity } from '../orchestrator/capacity.js';
import { allocateSlots } from '../orchestrator/engine.js';
import { z } from 'zod';
import type { App } from '../app.js';
import { fromRoot } from '../config.js';
import { ingestGithubReviews, seedRepoLessons } from '../orchestrator/lessons.js';
import { runMetrics } from '../telemetry/metrics.js';
import { PACKET_FACETS, PACKET_SORTS } from '../db/store.js';
import { flowAssignments } from '../pool/assignments.js';
import { readCodexUsage } from '../providers/codexUsage.js';

const CreateRun = z.object({ name: z.string().min(1).max(120), flowId: z.string(), config: z.record(z.string(), z.unknown()) });

export async function buildServer(app: App) {
  const f = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  await f.register(cors, { origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/] });

  const token = process.env.ORCH_API_TOKEN;
  if (token) {
    const expected = Buffer.from(`Bearer ${token}`);
    const same = (got: string | undefined) => {
      const b = Buffer.from(got ?? '');
      return b.length === expected.length && timingSafeEqual(b, expected);
    };
    f.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      // Bearer header everywhere. The query-string token is accepted only on the SSE stream, which
      // EventSource cannot send headers to; URLs end up in history and logs, so nothing else takes it.
      const q = req.method === 'GET' && req.url.startsWith('/api/stream') ? (req.query as Record<string, string> | undefined)?.token : undefined;
      if (!same(req.headers.authorization) && !(q !== undefined && same(`Bearer ${q}`))) return reply.code(401).send({ error: 'unauthorized' });
    });
  }
  f.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof z.ZodError ? 400 : err.statusCode ?? 400;
    reply.code(status).send({ error: err instanceof z.ZodError ? 'validation' : err.message, issues: err instanceof z.ZodError ? err.issues : undefined });
  });

  const { store, engine, pool, events } = app;
  const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: `${what} not found` });

  f.get('/api/health', async () => ({ ok: true, mode: app.cfg.mode, repo: app.repo.name, slots: app.repo.slotCount, runDefaults: app.cfg.runDefaults }));

  // ---------------- accounts
  f.get('/api/accounts', async () => store.listAccounts());
  f.get('/api/accounts/runtime', async () => pool.view());
  f.get('/api/accounts/:id/subscription-usage', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const account = store.getAccount(req.params.id);
    if (!account) return notFound(reply, 'account');
    return { buckets: await readCodexUsage(account) };
  });
  f.put('/api/accounts/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const acc = Account.parse({ ...(req.body as object), id: req.params.id });
    const saved = store.upsertAccount(acc);
    app.providers.invalidate(acc.id);
    app.reloadAccounts();
    return saved;
  });
  f.delete('/api/accounts/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    store.deleteAccount(req.params.id);
    app.reloadAccounts();
    return { ok: true };
  });
  f.post('/api/accounts/:id/:action', async (req: FastifyRequest<{ Params: { id: string; action: string } }>, reply) => {
    const { id, action } = req.params;
    if (action === 'enable') return { ok: pool.operatorEnable(id) };
    if (action === 'disable') return { ok: pool.operatorDisable(id) };
    return notFound(reply, 'action');
  });

  // ---------------- flows
  f.get('/api/flows', async () => store.listFlows());
  f.get('/api/flows/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => store.getFlow(req.params.id) ?? notFound(reply, 'flow'));
  f.put('/api/flows/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const flow = Flow.parse({ ...(req.body as object), id: req.params.id });
    return { flow: store.upsertFlow(flow), issues: validateFlow(flow) };
  });
  f.delete('/api/flows/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    store.deleteFlow(req.params.id);
    return { ok: true };
  });
  // Which account·model serves each node of a flow, by the scheduler's own matching. `accounts` in the
  // body resolves against unsaved drafts (the Accounts tab's assignment grid) instead of the saved pool.
  f.post('/api/flows/:id/assignments', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const flow = store.getFlow(req.params.id);
    if (!flow) return notFound(reply, 'flow');
    const body = z.object({ accounts: z.array(Account).optional() }).parse(req.body ?? {});
    return flowAssignments(flow, body.accounts ?? store.listAccounts());
  });
  f.post('/api/flows/validate', async (req) => {
    const flow = Flow.parse(req.body);
    const issues = validateFlow(flow);
    let plan = null;
    if (!issues.some((i) => i.level === 'error')) {
      const p = compileFlowPlan(flow);
      plan = {
        tiers: p.tiers.map((t) => ({ node: t.node.id, label: t.node.data.label, instances: t.node.data.instances, retryLoop: t.retryLoop, capability: t.capability, capabilityInferred: t.capabilityInferred })),
        workerSlots: p.workerSlots, gatekeepers: p.gatekeepers.length, route: p.route, routeSource: p.routeSource,
      };
    }
    const unresolved = flow.nodes
      .filter((n) => n.type !== 'gatekeeper' || n.data.gate.llmReview)
      .filter((n) => pool.resolve(n.data.pool, n.type === 'worker' ? 'worker' : n.type).length === 0)
      .map((n) => ({ level: 'warn' as const, nodeId: n.id, message: `no account/model in the pool serves "${n.data.label || n.id}" with its binding` }));
    // Pre-run capacity check for the per-worker function cap: ?batch=500&cap=60&stealing=1
    const q = req.query as { batch?: string; cap?: string; stealing?: string };
    let capacity = null;
    if (plan && q.batch) {
      const p = compileFlowPlan(flow);
      capacity = planCapacity({
        plan: p, usable: allocateSlots(p, app.repo.slotCount), repoSlots: app.repo.slotCount,
        maxPerWorker: Math.max(1, Number(q.cap ?? 60)), batch: Math.max(1, Number(q.batch)), stealing: q.stealing !== '0',
      });
    }
    return { issues: [...issues, ...unresolved], plan, repoSlots: app.repo.slotCount, capacity };
  });

  // ---------------- function gathering (preview what a `gather` run would select; no run is created)
  f.post('/api/selection/preview', async (req, reply) => {
    const selection = SelectionSpec.parse(req.body);
    if (selection.source !== 'sr_next') return reply.code(400).send({ error: 'this preview requires sr next selection' });
    const found = await app.repo.discover(selection, { exclude: store.rvasInFlight(null) });
    return { requested: selection.count, selected: found.length, units: new Set(found.map((fn) => fn.unit)).size };
  });
  f.post('/api/gather/preview', async (req) => {
    const filter = GatherFilter.parse(req.body ?? {});
    const report = await engine.gatherer.gather(filter);
    const T = ComplexityThresholds.parse({});
    const functions = report.functions.map((fn) => {
      const s = scoreFeatures(fn.features ?? sizeOnlyFeatures(fn.size));
      return { ...fn, features: undefined, complexityScore: s.score, complexityTier: classify(s.score, T).difficulty, reasons: s.reasons.slice(0, 3) };
    });
    const tiers = { easy: 0, medium: 0, hard: 0 } as Record<string, number>;
    for (const fn of functions) tiers[fn.complexityTier]!++;
    return { ...report, functions: functions.slice(0, 300), byTier: tiers };
  });
  f.get('/api/runs/:id/gathered', async (req: FastifyRequest<{ Params: { id: string } }>) => ({ report: store.runJson(req.params.id, 'gather_json'), functions: store.gathered(req.params.id, 2000) }));
  f.post('/api/runs/:id/capacity', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const { maxFunctionsPerWorker, resume } = z.object({ maxFunctionsPerWorker: z.number().int().min(1).max(5_000), resume: z.boolean().default(true) }).parse(req.body);
    const run = store.getRun(req.params.id);
    if (!run) return notFound(reply, 'run');
    if (!['paused', 'running'].includes(run.status)) return reply.code(409).send({ error: `run is ${run.status}` });
    if (!store.raiseWorkerCap(run.id, maxFunctionsPerWorker)) return reply.code(409).send({ error: `the cap can only be raised (currently ${run.config.maxFunctionsPerWorker})` });
    events.emit('run.capacity', `per-worker cap raised to ${maxFunctionsPerWorker} functions by the operator`, { runId: run.id, level: 'warn' });
    if (resume && store.getRun(run.id)!.status === 'paused') await engine.resume(run.id);
    return { ok: true };
  });

  // ---------------- runs
  f.get('/api/runs', async () => store.listRuns(100).map((r) => ({ ...r, flow: undefined, counts: store.functionCounts(r.id), engine: engine.status(r.id) })));
  f.post('/api/runs', async (req, reply) => {
    const body = CreateRun.parse(req.body);
    const flow = store.getFlow(body.flowId);
    if (!flow) return notFound(reply, 'flow');
    const config: Record<string, unknown> = { ...body.config, flowId: body.flowId };
    const defaults = flow.runDefaults;
    if (defaults && config.maxFunctionsPerWorker === undefined) config.maxFunctionsPerWorker = defaults.maxFunctionsPerWorker;
    if (config.draftedBy === undefined && app.cfg.runDefaults.draftedBy) config.draftedBy = app.cfg.runDefaults.draftedBy;
    // "Carry the failed functions": the dead packets of the chosen earlier runs join this run's selection.
    const carry = z.object({ fromRuns: z.array(z.string()).max(50).default([]) }).optional().parse(config.carry);
    if (carry?.fromRuns.length) {
      const missing = carry.fromRuns.filter((id) => !store.getRun(id));
      if (missing.length) return reply.code(400).send({ error: `runs not found: ${missing.join(', ')}` });
      const dead = store.deadFunctions(carry.fromRuns);
      if (!dead.length && config.selection === undefined) return reply.code(400).send({ error: 'the chosen runs have no dead functions to carry' });
      // Without a selection of its own the run is only the carried functions.
      if (config.selection === undefined) {
        config.selection = { source: 'rva_list', rvas: dead.map((d) => d.rva) };
        config.carry = { fromRuns: carry.fromRuns, rvas: [] };
      } else config.carry = { fromRuns: carry.fromRuns, rvas: dead.map((d) => d.rva) };
    }
    if (defaults && config.selection === undefined) {
      config.selection = app.cfg.mode === 'sim'
        ? { source: 'synthetic', count: defaults.functionCount }
        : { source: 'sr_next', count: defaults.functionCount, maxSize: defaults.maxSizeBytes ?? 64 };
    }
    const resolved = RunConfig.parse(config);
    if (app.cfg.mode === 'repo' && resolved.selection.source === 'synthetic') {
      return reply.code(400).send({ error: 'Synthetic selection is only available in simulator mode. Refresh the page and select a repository backlog source.' });
    }
    const run = engine.createRun(body.name, resolved, flow);
    engine.start(run.id).catch((e) => events.emit('run.failed', `start failed: ${(e as Error).message}`, { runId: run.id, level: 'error' }));
    return run;
  });
  f.post('/api/runs/:id/retry-failed', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const from = (req.body as { from?: unknown } | undefined)?.from === 'fast' ? 'fast' : 'last';
    const result = await engine.retryFailedTasks(req.params.id, { from });
    return result.ok ? result : reply.code(result.reason === 'run not found' ? 404 : 409).send(result);
  });
  // Stage a completed run's packets that are still 'passed' (a batch failed re-verification, or staging was interrupted).
  f.post('/api/runs/:id/stage', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.restage(req.params.id)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, reason: (e as Error).message, error: (e as Error).message });
    }
  });
  // Edit a run's name and the settings that can still change (draftedBy, budget, PR size, staging before it finishes).
  const EditRun = z.object({
    name: z.string().min(1).max(120).optional(), draftedBy: z.string().min(1).max(200).optional(), budgetUsd: z.number().positive().nullable().optional(),
    prBatchSize: z.number().int().min(1).max(60).optional(), staging: z.enum(['branches', 'off']).optional(),
  }).strict();
  f.patch('/api/runs/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const patch = EditRun.parse(req.body ?? {});
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return await engine.updateRun(req.params.id, patch);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Apply the run's flow template as it is now (or a given flow) to the run, also while it runs.
  // Only edits that keep the worker ladder, instances, routing and LLM review are accepted.
  f.post('/api/runs/:id/flow', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const row = store.getRun(req.params.id);
    if (!row) return notFound(reply, 'run');
    const body = z.object({ flow: z.unknown().optional() }).parse(req.body ?? {});
    const flow = body.flow !== undefined ? Flow.parse(body.flow) : store.getFlow(row.flow.id);
    if (!flow) return reply.code(404).send({ ok: false, error: `flow template ${row.flow.id} no longer exists` });
    try {
      return engine.updateRunFlow(req.params.id, flow);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  f.delete('/api/runs/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      const result = await engine.deleteRun(req.params.id);
      if (result.ok) return result;
      return reply.code(409).send({
        ...result,
        error: `The run was kept because ${result.failed.length} claim(s) could not be released. Retry deletion after resolving these errors. ${result.failed.slice(0, 10).map(({ rva, error }) => `${rva}: ${error}`).join('; ')}${result.failed.length > 10 ? `; and ${result.failed.length - 10} more (see the run's events)` : ''}`,
      });
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Open the batch's pull request with `sr submit`. Defaults to a dry run; a real submission pushes
  // to the operator's fork and opens a PR upstream, so it needs { dryRun: false, confirm: true }.
  f.post('/api/runs/:id/batches/:batchId/submit', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    const body = z.object({ dryRun: z.boolean().default(true), confirm: z.boolean().optional(), allowUncheckedClaims: z.boolean().default(false) }).parse(req.body ?? {});
    if (!body.dryRun && body.confirm !== true) return reply.code(400).send({ ok: false, error: 'a real submission needs confirm: true' });
    if (body.dryRun && body.allowUncheckedClaims) return reply.code(400).send({ ok: false, error: 'a dry run must check claims for every task' });
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return await engine.submitBatch(req.params.id, req.params.batchId, body);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Withhold the batch's packets that other contributors' open claims or PRs name (whole units) and
  // stage the rest as a new batch. Reads GitHub; deletes the old batch's local branches; pushes nothing.
  f.post('/api/runs/:id/batches/:batchId/drop-collisions', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.dropCollidingPackets(req.params.id, req.params.batchId)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // The same for every unsubmitted staged batch of the run (one claims check; the kept packets are restaged together).
  f.post('/api/runs/:id/batches/drop-collisions', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.dropCollidingPacketsAll(req.params.id)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Re-verify the packets of a batch whose staging a server restart interrupted, as a new batch.
  f.post('/api/runs/:id/batches/:batchId/restage', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.restageInterrupted(req.params.id, req.params.batchId)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // What holds the worktree slots right now (staging, a dry run, a claims check), with its current step.
  f.get('/api/operation', async () => ({ operation: engine.operation() }));
  // Check withheld packets against open claims again and stage the units that are clear now.
  f.post('/api/runs/:id/withheld/recheck', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.recheckWithheld(req.params.id)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Re-verify every failed or interrupted batch's passed packets, as new batches.
  // Prepare all for PR: one operation that can take many minutes, so it answers once it has started
  // (or refused) and reports through the operation panel and the run's events.
  f.post('/api/runs/:id/prepare', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    const job = engine.prepareAll(req.params.id);
    const early = await Promise.race([job.then(() => null, (e: Error) => e), new Promise<'running'>((r) => setTimeout(() => r('running'), 1500))]);
    if (early instanceof Error) return reply.code(409).send({ ok: false, error: early.message });
    if (early === 'running') {
      job.catch((e: Error) => events.emit('run.prepare_failed', `Prepare all for PR stopped: ${e.message}`, { runId: req.params.id, level: 'error' }));
    }
    return { ok: true, started: true };
  });
  // Pull requests after submission: state and comments from GitHub, a plain-words explanation of the
  // comments, fixing from them with the agents, and pushing those fixes to the open PR.
  f.post('/api/runs/:id/pull-requests/refresh', async (req: FastifyRequest<{ Params: { id: string }; Body: { batchId?: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, pullRequests: await engine.refreshPullRequests(req.params.id, { batchId: req.body?.batchId }) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  f.post('/api/runs/:id/batches/:batchId/explain-review', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.explainPrComments(req.params.id, req.params.batchId)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  f.post('/api/runs/:id/batches/:batchId/fix-review', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return await engine.fixFromReview(req.params.id, req.params.batchId);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  f.post('/api/runs/:id/batches/:batchId/push-review-fixes', async (req: FastifyRequest<{ Params: { id: string; batchId: string }; Body: { confirm?: boolean } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    if (req.body?.confirm !== true) return reply.code(400).send({ ok: false, error: 'pushing to a pull request needs { "confirm": true }' });
    try {
      return await engine.pushReviewFixes(req.params.id, req.params.batchId);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Regroup the unsubmitted staged batches into as few as fit 60 functions each (GET: the plan only).
  f.get('/api/runs/:id/batches/rebalance', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return engine.rebalancePlan(req.params.id);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  f.post('/api/runs/:id/batches/rebalance', async (req: FastifyRequest<{ Params: { id: string }; Body: { max?: number } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.rebalanceBatches(req.params.id, req.body?.max ?? undefined)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Fix a batch that failed a check with the run's AI workers: its failing packets run through the flow again.
  f.post('/api/runs/:id/batches/:batchId/fix', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return await engine.fixBatchWithAgents(req.params.id, req.params.batchId);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Rewrite a submitted batch's open PR as one commit naming every function (force-pushes the fork's PR branch).
  f.post('/api/runs/:id/batches/:batchId/tidy-pr', async (req: FastifyRequest<{ Params: { id: string; batchId: string }; Body: { confirm?: boolean } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    if (req.body?.confirm !== true) return reply.code(400).send({ ok: false, error: 'rewriting a pull request needs { "confirm": true }' });
    try {
      return await engine.tidyPullRequest(req.params.id, req.params.batchId);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  f.post('/api/runs/:id/batches/restage-failed', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.restageFailedAll(req.params.id)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Which units the batch's last dry run blamed (read only).
  f.get('/api/runs/:id/batches/:batchId/blocking', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.blockingUnits(req.params.id, req.params.batchId)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Set those units aside (held out of PRs) and re-verify the rest of the batch.
  f.post('/api/runs/:id/batches/:batchId/set-aside', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.setAsideBlocking(req.params.id, req.params.batchId)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Check every unsubmitted batch against upstream; set aside units it already matched, no longer tracks, or changed.
  f.post('/api/runs/:id/batches/set-aside-upstream', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    try {
      return { ok: true, ...(await engine.setAsideUpstreamAll(req.params.id)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Rebuild set-aside units on upstream's current files (all units with dropped functions, or the units named).
  f.post('/api/runs/:id/set-aside/rebuild', async (req: FastifyRequest<{ Params: { id: string }; Body: { units?: string[] } | undefined }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    const units = Array.isArray(req.body?.units) ? req.body.units.filter((u): u is string => typeof u === 'string') : undefined;
    try {
      return { ok: true, ...(await engine.rebuildOnUpstream(req.params.id, units)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // Put set-aside units back (all, or the units named) and re-verify them.
  f.post('/api/runs/:id/set-aside/put-back', async (req: FastifyRequest<{ Params: { id: string }; Body: { units?: string[] } | undefined }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    const units = Array.isArray(req.body?.units) ? req.body.units.filter((u): u is string => typeof u === 'string') : undefined;
    try {
      return { ok: true, ...(await engine.putBackSetAside(req.params.id, units)) };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });
  // When the first withheld packet's blocking claim lapses (the server rechecks on its own then).
  f.get('/api/runs/:id/withheld/next-lapse', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!store.getRun(req.params.id)) return notFound(reply, 'run');
    return { at: engine.nextWithheldLapse(req.params.id) };
  });
  f.post('/api/runs/:id/batches/:batchId/cancel-dry-run', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    try {
      engine.cancelBatchDryRun(req.params.id, req.params.batchId);
      return { ok: true };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  f.delete('/api/runs/:id/batches/:batchId/branches', async (req: FastifyRequest<{ Params: { id: string; batchId: string } }>, reply) => {
    const { scope } = z.object({ scope: z.enum(['preview', 'batch']) }).parse(req.body);
    try {
      return await engine.clearBatchBranches(req.params.id, req.params.batchId, scope);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  f.get('/api/runs/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const r = store.getRun(req.params.id);
    return r ? { ...r, metrics: runMetrics(store, engine, pool, r.id) } : notFound(reply, 'run');
  });
  f.get('/api/runs/:id/metrics', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => runMetrics(store, engine, pool, req.params.id) ?? notFound(reply, 'run'));
  f.post('/api/runs/:id/:action', async (req: FastifyRequest<{ Params: { id: string; action: string }; Body: { immediate?: boolean; budgetUsd?: number | null } | undefined }>, reply) => {
    const { id, action } = req.params;
    if (!store.getRun(id)) return notFound(reply, 'run');
    if (action === 'pause') return { ok: engine.pause(id, !!req.body?.immediate) };
    if (action === 'resume') {
      const { budgetUsd } = z.object({ budgetUsd: z.number().positive().nullable().optional() }).parse(req.body ?? {});
      const r = await engine.resume(id, budgetUsd === undefined ? {} : { budgetUsd });
      return r.ok ? r : reply.code(409).send({ error: r.reason, ok: false });
    }
    if (action === 'cancel') return { ok: await engine.cancel(id) };
    return notFound(reply, 'action');
  });
  f.get('/api/runs/:id/tasks', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { state?: string; limit?: string; offset?: string } }>) => {
    const q = req.query;
    return store.listTasks(req.params.id, { state: q.state as never, limit: Math.min(1000, Number(q.limit ?? 200)), offset: Number(q.offset ?? 0) });
  });
  // The Packets table: `q` is the JSON of a PacketQuery (sort, per-column filters, page).
  const PacketQuery = z.object({
    sort: z.enum(PACKET_SORTS).optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    values: z.object(Object.fromEntries(PACKET_FACETS.map((k) => [k, z.array(z.union([z.string().max(200), z.number()])).max(500).optional()]))).partial().optional(),
    unit: z.string().max(200).optional(),
    fn: z.string().max(200).optional(),
    bytesMin: z.number().optional(),
    bytesMax: z.number().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  });
  f.get('/api/runs/:id/packets', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { q?: string } }>, reply) => {
    let raw: unknown = {};
    try {
      raw = req.query.q ? JSON.parse(req.query.q) : {};
    } catch {
      return reply.code(400).send({ error: 'q is not JSON' });
    }
    const q = PacketQuery.safeParse(raw);
    if (!q.success) return reply.code(400).send({ error: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return store.queryTasks(req.params.id, q.data as never);
  });
  f.get('/api/runs/:id/batching', async (req: FastifyRequest<{ Params: { id: string } }>) => engine.batchingStatus(req.params.id));
  f.get('/api/runs/:id/batches', async (req: FastifyRequest<{ Params: { id: string } }>) => engine.listBatches(req.params.id));
  f.get('/api/runs/:id/knowledge', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string } }>) =>
    store.listKnowledge(req.params.id, Math.min(1000, Number(req.query.limit ?? 200))));

  // ---------------- context bundles (audit: what a worker was shown; private sections stay redacted)
  f.get('/api/bundles/:hash', async (req: FastifyRequest<{ Params: { hash: string } }>, reply) => store.getBundle(req.params.hash) ?? notFound(reply, 'bundle'));

  // ---------------- tasks
  f.get('/api/tasks/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const task = store.getTask(req.params.id);
    if (!task) return notFound(reply, 'task');
    const attempts = store.attemptsForTask(task.id);
    const verdicts = store.verdictsForTask(task.id);
    const baseFiles: Record<string, string | null> = {};
    for (const a of attempts) for (const file of a.files ?? []) if (!(file.path in baseFiles)) baseFiles[file.path] = await app.repo.baseFile(file.path);
    return { task, attempts, verdicts, baseFiles, events: events.query({ taskId: task.id, limit: 200 }) };
  });
  f.post('/api/tasks/:id/requeue', async (req: FastifyRequest<{ Params: { id: string }; Body: { tier?: number } | undefined }>) => ({ ok: engine.queue.requeue(req.params.id, req.body?.tier ?? 0) }));

  // ---------------- lessons
  f.get('/api/lessons', async () => store.lessons(200));
  f.post('/api/lessons/refresh', async (req: FastifyRequest<{ Body: { github?: boolean; repoSlug?: string } | undefined }>) => {
    const repoN = await seedRepoLessons(store, app.repo);
    const gh = req.body?.github ? await ingestGithubReviews(store, { repoSlug: req.body.repoSlug ?? 'awarebayes/skyrim_decomp', cwd: fromRoot('.') }) : null;
    return { repoLessons: repoN, github: gh };
  });

  // ---------------- skills (registry, curator jobs, proposals, shadow evaluations)
  // Curator jobs run in the background (202 + job id); progress streams as skills.* events.
  const { skills, curator } = app;
  const lastRunId = () => curator.latestRun();
  f.get('/api/skills', async () => {
    const runId = lastRunId();
    return {
      skills: skills.list(),
      proposals: skills.proposals().map((p) => ({ ...p, diff: { before: p.current ? skills.renderMd(p.skill.id, p.current.version) : '', after: skills.renderMd(p.skill.id, p.version.version) } })),
      jobs: skills.jobs(15),
      evals: skills.evals(30),
      curator: curator.status(),
      lastRun: runId ? { id: runId, name: store.getRun(runId)?.name ?? runId, ...skills.runStats(runId) } : null,
      nextRun: skills.buildSnapshot(RunConfig.shape.skills.parse({})),
    };
  });
  f.get('/api/skills/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const s = skills.get(req.params.id);
    if (!s) return notFound(reply, 'skill');
    return { skill: s, versions: skills.versions(s.id).map((v) => ({ ...v, md: skills.renderMd(s.id, v.version) })), evals: skills.evals(200).filter((e) => e.skillId === s.id), lift: skills.lift(s.id) };
  });
  const SkillJobBody = z.object({ runId: z.string().optional(), github: z.boolean().optional(), repoSlug: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(), useModel: z.boolean().optional(), evaluate: z.boolean().optional() }).default({});
  f.post('/api/skills/jobs/:kind', async (req: FastifyRequest<{ Params: { kind: string } }>, reply) => {
    const kind = z.enum(['bootstrap', 'mine', 'update', 'optimize', 'curate', 'shadow']).parse(req.params.kind);
    const body = SkillJobBody.parse(req.body ?? {});
    try {
      const { jobId } = curator.run(kind, body);
      return reply.code(202).send({ jobId });
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  f.post('/api/skills/:id/versions/:v/:action', async (req: FastifyRequest<{ Params: { id: string; v: string; action: string } }>, reply) => {
    const { id, action } = req.params;
    const v = Number(req.params.v);
    const ver = skills.version(id, v);
    if (!ver) return notFound(reply, 'skill version');
    if (action === 'evaluate') {
      try {
        return reply.code(202).send({ jobId: curator.run('shadow', { skillId: id, version: v }).jobId });
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    }
    if (action === 'reject') {
      if (ver.state !== 'proposed') return reply.code(409).send({ error: `v${v} is ${ver.state}` });
      return { ok: skills.reject(id, v, null, 'rejected by the operator') };
    }
    if (action === 'reopen') {
      const r = skills.reopen(id, v);
      return r.ok ? r : reply.code(409).send({ error: r.reason });
    }
    return notFound(reply, 'action');
  });
  f.post('/api/skills/:id/status', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const { status } = z.object({ status: z.enum(['active', 'deprecated', 'promoted_to_core']) }).parse(req.body);
    const s = skills.get(req.params.id);
    if (!s) return notFound(reply, 'skill');
    // Activation is earned in shadow evaluation; the operator may only re-activate a skill that won one.
    if (status === 'active' && s.status === 'deprecated' && !skills.versions(s.id).some((v) => v.state === 'accepted' || v.state === 'superseded')) {
      return reply.code(409).send({ error: 'this skill never passed a shadow evaluation; evaluate a proposal instead' });
    }
    if (s.status === 'candidate') return reply.code(409).send({ error: 'candidates become active only through shadow evaluation' });
    return { ok: skills.setStatus(s.id, status, `set to ${status} by the operator`) };
  });
  f.post('/api/skills/import', async () => skills.importFromDisk());

  // ---------------- events + SSE
  f.get('/api/events', async (req: FastifyRequest<{ Querystring: { runId?: string; taskId?: string; afterSeq?: string; limit?: string; minLevel?: string } }>) => {
    const q = req.query;
    return events.query({ runId: q.runId, taskId: q.taskId, afterSeq: Number(q.afterSeq ?? 0), limit: Math.min(1000, Number(q.limit ?? 200)), minLevel: (q.minLevel as never) ?? 'debug' });
  });
  f.get('/api/stream', async (req: FastifyRequest<{ Querystring: { runId?: string } }>, reply) => {
    const runId = req.query.runId;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': req.headers.origin ?? '*' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const unsub = events.subscribe((e: TelemetryEvent) => {
      if (e.level === 'debug') return;
      if (!runId || e.runId === runId || (!e.runId && e.kind.startsWith('account.'))) send('event', e);
    });
    const tick = setInterval(() => {
      if (runId) send('metrics', runMetrics(store, engine, pool, runId));
      else send('accounts', pool.view());
    }, 2_000);
    send('hello', { ok: true });
    req.raw.on('close', () => {
      clearInterval(tick);
      unsub();
    });
  });

  // ---------------- UI
  const web = fromRoot('apps/web/dist');
  if (existsSync(web)) {
    // wildcard routing resolves files per request, so a rebuilt UI is served without a restart
    await f.register(fastifyStatic, { root: web });
    f.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }
  return f;
}
