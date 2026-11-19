// SPDX-License-Identifier: AGPL-3.0-or-later
// Bulk execution engine.
//
// A run snapshots its flow and config, discovers the backlog, partitions it into unit-scoped
// packets and inserts them as durable tasks. Each worker slot (Σ instances over the flow's worker
// tiers, one git worktree each) loops: lease a task of its tier → reset worktree → carry forward
// units accepted earlier in the run → prepare (sr claim/start) → build bundle → acquire an account
// from the pool → call the model → Gate Keeper → route (accept / retry with trace / escalate to
// the next tier / dead-letter / quarantine). Leases are heartbeated; a lost lease aborts the slot's
// work immediately. All state lives in SQLite, so a crash at any point resumes on restart with at
// most the in-flight attempts abandoned (and not counted against any task's budget).
import { Flow, RunConfig, WorkerOutput, compileFlowPlan, validateFlow, type Attempt, type FlowPlan, type Verdict } from '@decomp/core';
import type { RunRow, Store, TaskRow } from '../db/store.js';
import { GateKeeper, type Reviewer } from '../gatekeeper/gatekeeper.js';
import { LlmReviewer, extractJson } from '../gatekeeper/review.js';
import { NoEligibleAccountError, type AccountPool } from '../pool/scheduler.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { ProviderError, costUsd } from '../providers/types.js';
import { TaskQueue } from '../queue/taskQueue.js';
import type { RepoAdapter, PreparedTask } from '../repo/types.js';
import type { EventBus } from '../telemetry/events.js';
import { AbortedError, Notifier, Semaphore, newId } from '../util/async.js';
import { ContextBuilder } from './context.js';
import { runPitfalls } from './lessons.js';
import { WORKER_OUTPUT_SCHEMA, WORKER_SYSTEM, buildWorkerPrompt, type Feedback } from './prompts.js';
import { stageRun } from './staging.js';

export interface EngineOptions {
  leaseMs: number;
  heartbeatMs: number;
  maxInfraFailures: number;
  maxProviderFailures: number;
  providerTimeoutMs: number;
  maxOutputTokens: number;
  idlePollMs: number;
  /** Backoff after an infra failure before the task is retried. */
  infraBackoffMs: number;
}

const DEFAULTS: EngineOptions = {
  leaseMs: 120_000,
  heartbeatMs: 20_000,
  maxInfraFailures: 5,
  maxProviderFailures: 40,
  providerTimeoutMs: 15 * 60_000,
  maxOutputTokens: 32_000,
  idlePollMs: 1_000,
  infraBackoffMs: 15_000,
};

export interface EngineDeps {
  store: Store;
  pool: AccountPool;
  providers: ProviderRegistry;
  repo: RepoAdapter;
  events: EventBus;
  reviewer?: (plan: FlowPlan) => Reviewer | null;
}

class ActiveRun {
  readonly cancel = new AbortController();
  inflight = new AbortController(); // replaced on resume; aborted by "pause now"
  paused = false;
  readonly resumed = new Notifier();
  readonly wake = new Notifier();
  activeSlots = 0;
  busySlots = new Set<number>();
  finished: Promise<void> = Promise.resolve();
  budgetPaused = false;
  constructor(readonly row: RunRow, readonly plan: FlowPlan, readonly gate: GateKeeper) {}
}

export class RunEngine {
  readonly queue: TaskQueue;
  private opts: EngineOptions;
  private active = new Map<string, ActiveRun>();
  private context: ContextBuilder;
  private reaper: NodeJS.Timeout;

  constructor(private deps: EngineDeps, opts: Partial<EngineOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.queue = new TaskQueue(deps.store);
    this.context = new ContextBuilder(deps.repo, deps.store);
    // Periodic reaper: reclaims leases of slots that stalled without crashing the process.
    this.reaper = setInterval(() => {
      for (const id of this.active.keys()) {
        const n = this.queue.recoverExpired(id);
        if (n) this.deps.events.emit('queue.reclaimed', `reclaimed ${n} expired lease(s)`, { runId: id, level: 'warn', data: { n } });
      }
    }, Math.max(5_000, this.opts.leaseMs / 2)).unref();
  }

  // ---------------------------------------------------------------- run lifecycle

  createRun(name: string, configIn: unknown, flowIn: unknown): RunRow {
    const config = RunConfig.parse(configIn);
    const flow = Flow.parse(flowIn);
    const errors = validateFlow(flow).filter((i) => i.level === 'error');
    if (errors.length) throw new Error(`invalid flow: ${errors.map((e) => e.message).join('; ')}`);
    return this.deps.store.createRun({ id: newId('run'), name, config, flow });
  }

  /** Discover + enqueue (idempotent), then start slot loops. Returns once slots are running. */
  async start(runId: string): Promise<void> {
    const { store, events } = this.deps;
    if (this.active.has(runId)) return;
    if (this.active.size > 0) throw new Error('another run is active; worktree slots are exclusive to one run at a time');
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (['completed', 'cancelled'].includes(row.status)) throw new Error(`run is ${row.status}`);
    const plan = compileFlowPlan(row.flow);

    if (row.status === 'created' || row.status === 'discovering') {
      store.setRunStatus(runId, 'discovering');
      events.emit('run.discovering', `discovering backlog (${row.config.selection.source})`, { runId });
      try {
        const found = await this.deps.repo.discover(row.config.selection);
        const packets = partition(found, row.config.packetMaxFunctions);
        const inserted = store.insertTasks(runId, packets.map((p) => ({ ...p, id: newId('task') })));
        events.emit('run.enqueued', `${found.length} functions → ${packets.length} packets (${inserted} new)`, { runId, data: { functions: found.length, packets: packets.length } });
      } catch (e) {
        store.setRunStatus(runId, 'failed', undefined, { error: (e as Error).message });
        events.emit('run.failed', `discovery failed: ${(e as Error).message}`, { runId, level: 'error' });
        throw e;
      }
    }
    store.setRunStatus(runId, row.status === 'paused' ? 'paused' : 'running');
    const reviewer = this.deps.reviewer?.(plan) ?? defaultReviewer(this.deps, plan);
    const gate = new GateKeeper(this.deps.repo, new Semaphore(row.config.gateConcurrency), reviewer);
    const run = new ActiveRun(store.getRun(runId)!, plan, gate);
    run.paused = run.row.status === 'paused';
    this.active.set(runId, run);
    this.queue.recoverExpired(runId);

    const usable = allocateSlots(plan, this.deps.repo.slotCount);
    if (usable.length < plan.workerSlots) {
      events.emit('run.slots', `flow wants ${plan.workerSlots} worker slots; repo has ${this.deps.repo.slotCount} worktrees — scaled down proportionally`, { runId, level: 'warn' });
    }
    events.emit('run.started', `running with ${usable.length} worker slots across ${plan.tiers.length} tier(s)`, { runId, data: { slots: usable.length } });
    run.finished = Promise.all(usable.map((s) => this.slotLoop(run, s.tier, s.slot))).then(() => this.finish(run));
  }

  pause(runId: string, immediate = false) {
    const run = this.active.get(runId);
    if (!run) return this.deps.store.setRunStatus(runId, 'paused', ['running', 'discovering']);
    run.paused = true;
    if (immediate) run.inflight.abort();
    this.deps.store.setRunStatus(runId, 'paused', ['running']);
    this.deps.events.emit('run.paused', immediate ? 'paused (in-flight attempts aborted)' : 'paused (in-flight attempts will finish)', { runId });
    return true;
  }

  async resume(runId: string) {
    const run = this.active.get(runId);
    if (!run) {
      this.deps.store.setRunStatus(runId, 'running', ['paused']);
      await this.start(runId);
      return true;
    }
    run.paused = false;
    run.budgetPaused = false;
    run.inflight = new AbortController();
    this.deps.store.setRunStatus(runId, 'running', ['paused']);
    run.resumed.notify();
    run.wake.notify();
    this.deps.events.emit('run.resumed', 'resumed', { runId });
    return true;
  }

  async cancel(runId: string) {
    const run = this.active.get(runId);
    if (run) {
      run.cancel.abort();
      run.inflight.abort();
      run.resumed.notify();
      run.wake.notify();
      await run.finished.catch(() => undefined);
    }
    const n = this.queue.cancelOpen(runId);
    this.deps.store.setRunStatus(runId, 'cancelled', ['created', 'discovering', 'running', 'paused']);
    this.deps.events.emit('run.cancelled', `cancelled (${n} open task(s) cancelled)`, { runId, level: 'warn' });
    await this.releaseUnsubmitted(runId, 'run cancelled');
    return true;
  }

  /** Give back local claims of packets that will not be submitted (dead, quarantined, cancelled). */
  private async releaseUnsubmitted(runId: string, why: string) {
    const repo = this.deps.repo;
    if (!repo.releaseClaims) return;
    const rows = this.deps.store.db
      .prepare(`SELECT functions_json FROM tasks WHERE run_id = ? AND state IN ('dead','quarantined','cancelled') AND sr_task_id IS NOT NULL`)
      .all(runId) as Array<{ functions_json: string }>;
    const rvas = [...new Set(rows.flatMap((r) => (JSON.parse(r.functions_json) as Array<{ rva: string }>).map((f) => f.rva)))];
    if (!rvas.length) return;
    const res = await repo.releaseClaims(rvas, `decomp-orchestrator: ${why}`).catch((e) => rvas.map((rva) => ({ rva, ok: false, error: String(e) })));
    const failed = res.filter((r) => !r.ok);
    this.deps.events.emit('claims.released', `released ${res.length - failed.length}/${res.length} local claim(s) (${why})${failed.length ? `; failed: ${failed.map((f) => `${f.rva} ${f.error}`).join('; ')}` : ''}`, {
      runId, level: failed.length ? 'warn' : 'info', data: { released: res.length - failed.length, failed: failed.length },
    });
  }

  /** On boot: every lease is stale; resume runs that were running when the process died. */
  async resumeOnBoot() {
    const n = this.queue.recoverAllOnBoot();
    if (n) this.deps.events.emit('queue.recovered', `recovered ${n} in-flight task(s) after restart`, { level: 'warn' });
    for (const r of this.deps.store.activeRuns()) {
      if (r.status === 'paused') continue;
      this.deps.events.emit('run.recovering', `resuming ${r.name} after restart`, { runId: r.id, level: 'warn' });
      await this.start(r.id).catch((e) => this.deps.events.emit('run.failed', `resume failed: ${(e as Error).message}`, { runId: r.id, level: 'error' }));
    }
  }

  /** For crash simulation and tests: stop all loops without touching task state (like a kill -9). */
  async hardStop() {
    for (const run of this.active.values()) {
      run.cancel.abort();
      run.inflight.abort();
      run.resumed.notify();
      run.wake.notify();
    }
    await Promise.all([...this.active.values()].map((r) => r.finished.catch(() => undefined)));
    this.active.clear();
    clearInterval(this.reaper);
  }

  close() {
    clearInterval(this.reaper);
  }

  status(runId: string) {
    const run = this.active.get(runId);
    return run ? { active: true, paused: run.paused, activeSlots: run.activeSlots, busySlots: run.busySlots.size } : { active: false, paused: false, activeSlots: 0, busySlots: 0 };
  }

  waitFor(runId: string): Promise<void> {
    return this.active.get(runId)?.finished ?? Promise.resolve();
  }

  // ---------------------------------------------------------------- slot loop

  private async slotLoop(run: ActiveRun, tier: number, slot: number): Promise<void> {
    const { store, events } = this.deps;
    const runId = run.row.id;
    run.activeSlots++;
    try {
      while (!run.cancel.signal.aborted) {
        if (run.paused) {
          await run.resumed.wait(5_000, run.cancel.signal);
          continue;
        }
        const budget = run.row.config.budgetUsd;
        if (budget !== undefined && (store.getRun(runId)?.costUsd ?? 0) >= budget) {
          if (!run.budgetPaused) {
            run.budgetPaused = true;
            this.pause(runId);
            events.emit('run.budget', `run budget $${budget} reached; paused`, { runId, level: 'warn' });
          }
          continue;
        }
        const [leased] = this.queue.lease(runId, tier, 1, this.opts.leaseMs);
        if (!leased) {
          if (!this.queue.hasOpenWork(runId)) return;
          const next = this.queue.nextReadyAt(runId, tier);
          const wait = next ? Math.min(Math.max(10, next - Date.now()), this.opts.idlePollMs) : this.opts.idlePollMs;
          await run.wake.wait(wait, run.cancel.signal);
          continue;
        }
        run.busySlots.add(slot);
        try {
          await this.processTask(run, tier, slot, leased.task, leased.leaseId);
        } finally {
          run.busySlots.delete(slot);
          run.wake.notify();
        }
      }
    } finally {
      run.activeSlots--;
    }
  }

  private async processTask(run: ActiveRun, tierIdx: number, slot: number, task: TaskRow, leaseId: string) {
    const { store, pool, providers, repo, events } = this.deps;
    const runId = run.row.id;
    const cfg = run.row.config;
    const node = run.plan.tiers[tierIdx]!.node;
    const lost = new AbortController();
    const signal = AbortSignal.any([run.cancel.signal, run.inflight.signal, lost.signal]);
    const hb = setInterval(() => {
      if (!this.queue.heartbeat(task.id, leaseId, this.opts.leaseMs)) lost.abort();
    }, this.opts.heartbeatMs);
    const ev = (kind: string, msg: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info', data?: Record<string, unknown>) =>
      events.emit(kind, msg, { runId, taskId: task.id, level, ...(data ? { data } : {}) });

    let attempt: Attempt | null = null;
    try {
      // 1. fresh worktree + carry forward units accepted earlier in this run
      await repo.reset(slot);
      const carried = this.carriedFiles(runId, task.unit);
      if (carried.length) await repo.writeFiles(slot, carried);
      const modelHint = node.data.pool.model ?? node.data.label;
      let prepared: PreparedTask;
      try {
        prepared = await repo.prepare(slot, task, { draftedBy: cfg.draftedBy, model: modelHint, signal });
      } catch (e) {
        if (e instanceof AbortedError || signal.aborted) throw e;
        return this.infraFailure(run, task, leaseId, `prepare failed: ${(e as Error).message}`);
      }

      // 2. bundle + feedback
      const bundle = await this.context.build(task, prepared, slot, { runId, exposureConsent: cfg.exposureConsent, carried });
      const feedback = this.lastFeedback(task);
      const n = task.attemptsTotal + 1;
      const prompt = buildWorkerPrompt(task, bundle, n, feedback, runPitfalls(store, runId));
      attempt = {
        id: newId('att'), taskId: task.id, runId, n, tier: tierIdx, nodeId: node.id, accountId: null, model: null, status: 'running',
        bundleHash: bundle.hash, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0,
        latencyMs: null, error: null, files: null, startedAt: Date.now(), finishedAt: null,
      };
      store.insertAttempt(attempt);

      // 3. account lease + model call
      const estIn = Math.ceil((WORKER_SYSTEM.length + prompt.length) / 3.5);
      let waitedEmitted = false;
      const lease = await pool.acquire(
        { binding: node.data.pool, role: 'worker', estInputTokens: estIn, estOutputTokens: Math.min(this.opts.maxOutputTokens, 8_000) },
        signal,
        (ms, reason) => {
          if (!waitedEmitted && ms > 3_000) {
            waitedEmitted = true;
            ev('pool.wait', `waiting ${Number.isFinite(ms) ? Math.round(ms / 1000) + 's' : '∞'} for an account (${reason})`, 'debug');
          }
        },
      );
      store.updateAttempt(attempt.id, { accountId: lease.account.id, model: lease.model.id });
      const t0 = Date.now();
      let text: string;
      try {
        const resp = await providers.complete(lease.account, {
          system: WORKER_SYSTEM, prompt, model: lease.model, effort: node.data.pool.effort, jsonSchema: WORKER_OUTPUT_SCHEMA,
          maxOutputTokens: Math.min(this.opts.maxOutputTokens, lease.model.maxOutputTokens), timeoutMs: this.opts.providerTimeoutMs, signal,
        });
        const latencyMs = Date.now() - t0;
        pool.release(lease, { kind: 'ok', usage: resp.usage, latencyMs, rateLimit: resp.rateLimit });
        const cost = costUsd(lease.model, resp.usage);
        store.addRunCost(runId, cost);
        store.updateAttempt(attempt.id, { usage: resp.usage, costUsd: cost, latencyMs });
        text = resp.text;
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError(signal.aborted ? 'aborted' : 'network', (e as Error).message);
        pool.release(lease, { kind: pe.kind, retryAfterMs: pe.retryAfterMs, message: pe.message, latencyMs: Date.now() - t0 });
        if (pe.kind === 'aborted' || signal.aborted) throw new AbortedError();
        store.updateAttempt(attempt.id, { status: 'provider_error', error: `${pe.kind}: ${pe.message}`, finishedAt: Date.now() });
        ev('attempt.provider_error', `${lease.account.id}/${lease.model.id}: ${pe.kind}`, 'warn', { accountId: lease.account.id, kind: pe.kind });
        // Refusals/bad requests are about this packet, not the account: they consume an attempt.
        if (pe.kind === 'refusal' || pe.kind === 'bad_request') {
          return this.route(run, task, leaseId, attempt, syntheticVerdict(task, attempt, 'PROVIDER_' + pe.kind.toUpperCase(), `provider ${pe.kind}: ${pe.message}`), { infra: false, strike: false }, tierIdx);
        }
        const pf = task.providerFailures + 1;
        if (pf >= this.opts.maxProviderFailures) {
          this.queue.transition(task.id, leaseId, ['leased'], 'dead', { providerFailures: pf });
          ev('task.dead', `dead-lettered after ${pf} provider failures`, 'error');
          return;
        }
        // Failover: requeue immediately; the scheduler routes the next try to a healthy account.
        this.queue.transition(task.id, leaseId, ['leased'], 'pending', { providerFailures: pf, notBefore: Date.now() + Math.min(30_000, 250 * pf) });
        return;
      }

      // 4. parse output
      const parsed = WorkerOutput.safeParse(extractJson(text));
      if (!parsed.success) {
        store.updateAttempt(attempt.id, { status: 'parse_error', error: 'output did not match the contract', finishedAt: Date.now() });
        return this.route(run, task, leaseId, attempt, syntheticVerdict(task, attempt, 'OUTPUT_PARSE', 'reply was not a JSON object matching {"files":[{"path","content"}]}'), { infra: false, strike: false }, tierIdx);
      }
      store.updateAttempt(attempt.id, { files: parsed.data.files });

      // 5. Gate Keeper
      if (!this.queue.transition(task.id, leaseId, ['leased'], 'gating')) throw new AbortedError('lease lost before gating');
      const gate = await run.gate.evaluate({
        task, attemptId: attempt.id, slot, prepared, files: parsed.data.files, checks: mergeGateChecks(run.plan),
        compareTimeoutMs: cfg.compareTimeoutMs, signal, carried: new Map(carried.map((c) => [c.path, c.content])),
      });
      if (signal.aborted) throw new AbortedError();
      store.updateAttempt(attempt.id, { status: 'completed', files: gate.written.length ? gate.written : parsed.data.files, finishedAt: Date.now() });
      return this.route(run, task, leaseId, attempt, gate.verdict, { infra: gate.infra, strike: gate.strike }, tierIdx, prepared.srTaskId);
    } catch (e) {
      if (e instanceof AbortedError || signal.aborted) {
        if (attempt) store.updateAttempt(attempt.id, { status: 'abandoned', error: lost.signal.aborted ? 'lease lost' : 'aborted', finishedAt: Date.now() });
        // Paused-now or cancelled: give the task back without consuming an attempt.
        if (!lost.signal.aborted && !run.cancel.signal.aborted) this.queue.transition(task.id, leaseId, ['leased', 'gating'], 'pending');
        return;
      }
      if (e instanceof NoEligibleAccountError) {
        ev('task.config_error', e.message, 'error');
        this.queue.transition(task.id, leaseId, ['leased', 'gating'], 'dead');
        if (attempt) store.updateAttempt(attempt.id, { status: 'abandoned', error: e.message, finishedAt: Date.now() });
        return;
      }
      if (attempt) store.updateAttempt(attempt.id, { status: 'abandoned', error: (e as Error).message, finishedAt: Date.now() });
      return this.infraFailure(run, task, leaseId, (e as Error).message);
    } finally {
      clearInterval(hb);
      await repo.reset(slot).catch((err) => ev('slot.reset_failed', `slot ${slot} reset failed: ${(err as Error).message}`, 'error'));
    }
  }

  private infraFailure(run: ActiveRun, task: TaskRow, leaseId: string, msg: string) {
    const n = task.infraFailures + 1;
    const runId = run.row.id;
    if (n >= this.opts.maxInfraFailures) {
      this.queue.transition(task.id, leaseId, ['leased', 'gating'], 'dead', { infraFailures: n });
      this.deps.events.emit('task.dead', `dead-lettered after ${n} infrastructure failures: ${msg}`, { runId, taskId: task.id, level: 'error' });
    } else {
      this.queue.transition(task.id, leaseId, ['leased', 'gating'], 'pending', { infraFailures: n, notBefore: Date.now() + this.opts.infraBackoffMs * n });
      this.deps.events.emit('task.infra', `infrastructure failure (${n}/${this.opts.maxInfraFailures}): ${msg}`, { runId, taskId: task.id, level: 'warn' });
    }
  }

  /** Final routing: persists the verdict with its effective route and moves the task. */
  private route(run: ActiveRun, task: TaskRow, leaseId: string, attempt: Attempt, verdict: Verdict, flags: { infra: boolean; strike: boolean }, tierIdx: number, srTaskId?: string | null) {
    const { store, events } = this.deps;
    const runId = run.row.id;
    const from: Array<'leased' | 'gating'> = ['leased', 'gating'];
    const tierNode = run.plan.tiers[tierIdx]!;
    const common = { lastVerdictId: verdict.id, ...(srTaskId ? { srTaskId } : {}) };
    const fnLabel = task.functions.map((f) => f.name ?? f.rva).join(', ');

    if (flags.infra) {
      store.insertVerdict({ ...verdict, route: 'retry' });
      return this.infraFailure(run, task, leaseId, verdict.findings.find((f) => f.code.startsWith('INFRA'))?.message ?? 'infra');
    }
    const attemptsTotal = task.attemptsTotal + 1;
    const attemptsAtTier = task.attemptsAtTier + 1;
    const improved = verdict.exactBytes > task.bestExactBytes;
    const bestExactBytes = Math.max(task.bestExactBytes, verdict.exactBytes);
    const noImprovementStreak = improved ? 0 : task.noImprovementStreak + 1;
    const cheatStrikes = task.cheatStrikes + (flags.strike ? 1 : 0);

    if (verdict.decision === 'pass') {
      store.insertVerdict({ ...verdict, route: 'accept' });
      this.queue.transition(task.id, leaseId, from, 'passed', { ...common, attemptsTotal, attemptsAtTier, bestExactBytes, noImprovementStreak: 0 });
      events.emit('task.passed', `PASS ${fnLabel} (attempt ${attempt.n}, tier ${tierIdx})`, { runId, taskId: task.id, data: { attempt: attempt.n, tier: tierIdx } });
      return;
    }
    if (verdict.decision === 'quarantine') {
      store.insertVerdict({ ...verdict, route: 'quarantine' });
      this.queue.transition(task.id, leaseId, from, 'quarantined', { ...common, attemptsTotal, attemptsAtTier, cheatStrikes, bestExactBytes });
      events.emit('task.quarantined', `QUARANTINE ${fnLabel}: ${verdict.findings.filter((f) => f.severity === 'block').map((f) => f.code).join(', ')}`, { runId, taskId: task.id, level: 'error' });
      return;
    }
    const limit = tierNode.node.data;
    const exhausted = attemptsAtTier >= limit.maxAttempts || noImprovementStreak >= limit.stuckAfter || !tierNode.retryLoop;
    if (!exhausted) {
      store.insertVerdict({ ...verdict, route: 'retry' });
      this.queue.transition(task.id, leaseId, from, 'pending', { ...common, attemptsTotal, attemptsAtTier, bestExactBytes, noImprovementStreak, cheatStrikes, notBefore: 0 });
      events.emit('task.retry', `retry ${fnLabel}: ${summarise(verdict)}`, { runId, taskId: task.id, level: 'debug' });
      return;
    }
    if (tierIdx + 1 < run.plan.tiers.length) {
      store.insertVerdict({ ...verdict, route: 'escalate' });
      this.queue.transition(task.id, leaseId, from, 'pending', { ...common, tier: tierIdx + 1, attemptsTotal, attemptsAtTier: 0, bestExactBytes, noImprovementStreak: 0, cheatStrikes, notBefore: 0 });
      events.emit('task.escalated', `escalate ${fnLabel} → tier ${tierIdx + 1} (${run.plan.tiers[tierIdx + 1]!.node.data.label})`, { runId, taskId: task.id, level: 'info' });
      run.wake.notify();
      return;
    }
    store.insertVerdict({ ...verdict, route: 'dead_letter' });
    this.queue.transition(task.id, leaseId, from, 'dead', { ...common, attemptsTotal, attemptsAtTier, bestExactBytes, noImprovementStreak, cheatStrikes });
    events.emit('task.dead', `DEAD ${fnLabel} after ${attemptsTotal} attempts (best ${bestExactBytes} bytes exact)`, { runId, taskId: task.id, level: 'warn' });
  }

  private lastFeedback(task: TaskRow): Feedback | null {
    if (!task.lastVerdictId) return null;
    const verdict = this.deps.store.getVerdict(task.lastVerdictId);
    const attempt = verdict ? this.deps.store.getAttempt(verdict.attemptId) : null;
    return verdict && attempt ? { verdict, attempt } : null;
  }

  /** Latest accepted files per path for packets of the same unit in this run. */
  private carriedFiles(runId: string, unit: string): Array<{ path: string; content: string }> {
    const rows = this.deps.store.db
      .prepare(`SELECT a.files_json FROM tasks t JOIN verdicts v ON v.id = t.last_verdict_id JOIN attempts a ON a.id = v.attempt_id
        WHERE t.run_id = ? AND t.unit = ? AND t.state IN ('passed','staged') ORDER BY v.created_at`)
      .all(runId, unit) as Array<{ files_json: string | null }>;
    const latest = new Map<string, string>();
    for (const r of rows) for (const f of (r.files_json ? JSON.parse(r.files_json) : []) as Array<{ path: string; content: string }>) latest.set(f.path, f.content);
    return [...latest].map(([path, content]) => ({ path, content }));
  }

  private async finish(run: ActiveRun) {
    const { store, events } = this.deps;
    const runId = run.row.id;
    this.active.delete(runId);
    if (run.cancel.signal.aborted) return;
    if (this.queue.hasOpenWork(runId)) return; // paused/hard-stopped with work left
    await this.releaseUnsubmitted(runId, 'not matched in this run');
    try {
      const batches = await stageRun(store, this.deps.repo, events, runId, run.row.config.prBatchSize);
      store.setRunStatus(runId, 'completed', ['running', 'paused']);
      const fc = store.functionCounts(runId);
      events.emit('run.completed', `completed: ${(fc.passed ?? 0) + (fc.staged ?? 0)} functions matched, ${fc.dead ?? 0} dead-lettered, ${fc.quarantined ?? 0} quarantined; ${batches} PR batch(es) staged`, { runId, data: fc });
    } catch (e) {
      store.setRunStatus(runId, 'failed', undefined, { error: (e as Error).message });
      events.emit('run.failed', `staging failed: ${(e as Error).message}`, { runId, level: 'error' });
    }
  }
}

// ---------------------------------------------------------------- helpers

export function partition(found: Array<{ rva: string; name: string | null; size: number; nameOrigin?: string | null; unit: string; readiness?: number }>, maxPerPacket: number) {
  const byUnit = new Map<string, typeof found>();
  for (const f of found) {
    const list = byUnit.get(f.unit) ?? [];
    list.push(f);
    byUnit.set(f.unit, list);
  }
  const packets: Array<{ unit: string; functions: Array<{ rva: string; name: string | null; size: number; nameOrigin: string | null }>; priority: number }> = [];
  for (const [unit, fns] of byUnit) {
    fns.sort((a, b) => a.size - b.size || a.rva.localeCompare(b.rva));
    for (let i = 0; i < fns.length; i += maxPerPacket) {
      const chunk = fns.slice(i, i + maxPerPacket);
      const size = chunk.reduce((s, f) => s + f.size, 0);
      const readiness = Math.min(...chunk.map((f) => f.readiness ?? 3));
      // Smaller, more "ready" packets first: they pass sooner and unlock carried context for later packets.
      packets.push({ unit, functions: chunk.map((f) => ({ rva: f.rva, name: f.name, size: f.size, nameOrigin: f.nameOrigin ?? null })), priority: 1_000_000 - readiness * 10_000 - size - i });
    }
  }
  return packets;
}

/** Map tiers onto worktree slots: node.instances each, scaled down proportionally (≥1 per tier) when capped. */
export function allocateSlots(plan: FlowPlan, capacity: number): Array<{ tier: number; slot: number }> {
  const want = plan.tiers.map((t) => t.node.data.instances);
  const total = want.reduce((a, b) => a + b, 0);
  let counts = want;
  if (total > capacity) {
    counts = want.map((w) => Math.max(1, Math.floor((w / total) * capacity)));
    while (counts.reduce((a, b) => a + b, 0) > capacity && counts.some((c) => c > 1)) {
      const i = counts.indexOf(Math.max(...counts));
      counts[i]!--;
    }
  }
  const out: Array<{ tier: number; slot: number }> = [];
  counts.forEach((c, tier) => {
    for (let i = 0; i < c && out.length < capacity; i++) out.push({ tier, slot: out.length });
  });
  return out;
}

function mergeGateChecks(plan: FlowPlan) {
  // Multiple gatekeeper nodes: a check is on if any node enables it (strictest wins).
  const g = plan.gatekeepers.map((n) => n.data.gate);
  const any = (k: keyof (typeof g)[number]) => g.some((x) => x[k]);
  return { scope: true, leak: any('leak'), cheat: any('cheat'), integrity: any('integrity'), repoCompare: any('repoCompare'), repoPreflight: any('repoPreflight'), llmReview: any('llmReview') };
}

function defaultReviewer(deps: EngineDeps, plan: FlowPlan): Reviewer | null {
  const gk = plan.gatekeepers.find((n) => n.data.gate.llmReview);
  return gk ? new LlmReviewer(deps.pool, deps.providers, gk.data.pool) : null;
}

function syntheticVerdict(task: TaskRow, attempt: Attempt, code: string, message: string): Verdict {
  return {
    id: newId('vd'), taskId: task.id, attemptId: attempt.id, decision: 'reject', route: 'retry',
    findings: [{ stage: 'worker', code, severity: 'block', message }], compare: null, exactBytes: 0,
    stages: [{ name: 'parse', ok: false, ms: 0, skipped: false }], createdAt: Date.now(),
  };
}

function summarise(v: Verdict) {
  const codes = [...new Set(v.findings.filter((f) => f.severity === 'block').map((f) => f.code))];
  return `${codes.slice(0, 4).join(', ')}${codes.length > 4 ? '…' : ''} (${v.exactBytes} B exact)`;
}
