// SPDX-License-Identifier: AGPL-3.0-or-later
// REST + SSE API for the UI. Binds to localhost by default; set ORCH_API_TOKEN to require a bearer
// token (the UI forwards it). Secrets are never returned: accounts only carry secret references.
import { existsSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Account, ComplexityThresholds, Flow, GatherFilter, RunConfig, classify, compileFlowPlan, scoreFeatures, sizeOnlyFeatures, validateFlow, type TelemetryEvent } from '@decomp/core';
import { planCapacity } from '../orchestrator/capacity.js';
import { allocateSlots } from '../orchestrator/engine.js';
import { z } from 'zod';
import type { App } from '../app.js';
import { fromRoot } from '../config.js';
import { ingestGithubReviews, seedRepoLessons } from '../orchestrator/lessons.js';
import { runMetrics } from '../telemetry/metrics.js';

const CreateRun = z.object({ name: z.string().min(1).max(120), flowId: z.string(), config: z.record(z.string(), z.unknown()) });

export async function buildServer(app: App) {
  const f = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  await f.register(cors, { origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/] });

  const token = process.env.ORCH_API_TOKEN;
  if (token) {
    f.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      const q = (req.query as Record<string, string> | undefined)?.token;
      if (req.headers.authorization !== `Bearer ${token}` && q !== token) return reply.code(401).send({ error: 'unauthorized' });
    });
  }
  f.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof z.ZodError ? 400 : err.statusCode ?? 400;
    reply.code(status).send({ error: err instanceof z.ZodError ? 'validation' : err.message, issues: err instanceof z.ZodError ? err.issues : undefined });
  });

  const { store, engine, pool, events } = app;
  const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: `${what} not found` });

  f.get('/api/health', async () => ({ ok: true, mode: app.cfg.mode, repo: app.repo.name, slots: app.repo.slotCount }));

  // ---------------- accounts
  f.get('/api/accounts', async () => store.listAccounts());
  f.get('/api/accounts/runtime', async () => pool.view());
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
    const run = engine.createRun(body.name, { ...body.config, flowId: body.flowId }, flow);
    engine.start(run.id).catch((e) => events.emit('run.failed', `start failed: ${(e as Error).message}`, { runId: run.id, level: 'error' }));
    return run;
  });
  f.get('/api/runs/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const r = store.getRun(req.params.id);
    return r ? { ...r, metrics: runMetrics(store, engine, pool, r.id) } : notFound(reply, 'run');
  });
  f.get('/api/runs/:id/metrics', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => runMetrics(store, engine, pool, req.params.id) ?? notFound(reply, 'run'));
  f.post('/api/runs/:id/:action', async (req: FastifyRequest<{ Params: { id: string; action: string }; Body: { immediate?: boolean } | undefined }>, reply) => {
    const { id, action } = req.params;
    if (!store.getRun(id)) return notFound(reply, 'run');
    if (action === 'pause') return { ok: engine.pause(id, !!req.body?.immediate) };
    if (action === 'resume') return { ok: await engine.resume(id) };
    if (action === 'cancel') return { ok: await engine.cancel(id) };
    return notFound(reply, 'action');
  });
  f.get('/api/runs/:id/tasks', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { state?: string; limit?: string; offset?: string } }>) => {
    const q = req.query;
    return store.listTasks(req.params.id, { state: q.state as never, limit: Math.min(1000, Number(q.limit ?? 200)), offset: Number(q.offset ?? 0) });
  });
  f.get('/api/runs/:id/batches', async (req: FastifyRequest<{ Params: { id: string } }>) => store.listBatches(req.params.id));
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
