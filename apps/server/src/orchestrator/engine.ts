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
import {
  CAPABILITY_RANK, DIFFICULTIES, DIFFICULTY_RANK, Flow, RunConfig, WorkerOutput, compileFlowPlan, harder, promote, stealSources, tierFor, validateFlow,
  type Attempt, type CapabilityTier, type Difficulty, type FlowPlan, type PoolBinding, type SkillSelection, type Verdict,
} from '@decomp/core';
import { createHash } from 'node:crypto';
import type { RunRow, Store, TaskRow } from '../db/store.js';
import { GateKeeper, type Reviewer } from '../gatekeeper/gatekeeper.js';
import { LlmReviewer, extractJson } from '../gatekeeper/review.js';
import { ComplexityClassifier } from '../intel/complexity.js';
import { extractKnowledge } from '../intel/knowledge.js';
import { NoEligibleAccountError, type AccountPool } from '../pool/scheduler.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { ProviderError, costUsd, type PromptBlock } from '../providers/types.js';
import { TaskQueue, type StealSource } from '../queue/taskQueue.js';
import type { DiscoveredFunction, RepoAdapter, PreparedTask } from '../repo/types.js';
import type { EventBus } from '../telemetry/events.js';
import { AbortedError, Notifier, Semaphore, newId } from '../util/async.js';
import { ContextBuilder } from './context.js';
import { TaskContextBuilder, shouldCacheTaskPrefix } from './contextBuilder.js';
import { materialise } from './edits.js';
import { repairAnswer } from './headerRepair.js';
import { runPitfalls } from './lessons.js';
import { WORKER_OUTPUT_SCHEMA, WORKER_OUTPUT_SCHEMA_V2, WORKER_SYSTEM, buildWorkerPrompt, renderBundle, type Feedback } from './prompts.js';
import { stageRun } from './staging.js';
import { SkillRegistry } from '../skills/registry.js';
import { FunctionGatherer } from '../intel/gatherer.js';
import { planCapacity } from './capacity.js';
import { hasRetryOnlySkills, type RunSkills } from './contextBuilder.js';

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
  skills?: SkillRegistry;
}

class ActiveRun {
  readonly cancel = new AbortController();
  inflight = new AbortController(); // replaced on resume; aborted by "pause now"
  paused = false;
  readonly resumed = new Notifier();
  readonly wake = new Notifier();
  activeSlots = 0;
  busySlots = new Set<number>();
  /** Worker slots per tier (for work-stealing backlog thresholds). */
  slotsByTier = new Map<number, number[]>();
  finished: Promise<void> = Promise.resolve();
  budgetPaused = false;
  /** Frozen skill view for the whole run (null: skills off or legacy context). */
  skills: RunSkills | null = null;
  /** Worker instance identity per slot: `<node id>#<instance>` (stable across restarts). */
  workerBySlot = new Map<number, string>();
  /** Workers with no function left under the per-worker cap (they only finish their own packets). */
  capped = new Set<number>();
  capacityStalled = false;
  constructor(readonly row: RunRow, readonly plan: FlowPlan, readonly gate: GateKeeper) {}

  /** Idle slots that could still take new work (capped workers cannot absorb a backlog). */
  idleSlots(tier: number): number {
    return (this.slotsByTier.get(tier) ?? []).filter((s) => !this.busySlots.has(s) && !this.capped.has(s)).length;
  }
}

/** The difficulty a capability tier is meant for (used when a task escalates up the ladder). */
const CAPABILITY_DIFFICULTY: Record<CapabilityTier, Difficulty> = { fast: 'easy', balanced: 'medium', frontier: 'hard' };

export class RunEngine {
  readonly queue: TaskQueue;
  private opts: EngineOptions;
  private active = new Map<string, ActiveRun>();
  private context: ContextBuilder;
  readonly contextV2: TaskContextBuilder;
  readonly classifier: ComplexityClassifier;
  readonly gatherer: FunctionGatherer;
  readonly skills: SkillRegistry;
  /** Called after a run completes (the app wires the skill curator here when autoCurate is on). */
  afterRun: ((runId: string) => void) | null = null;
  /** Held by work that needs the worktree slots outside a run (shadow evaluation). */
  private exclusiveHolder: string | null = null;
  private reaper: NodeJS.Timeout;

  constructor(private deps: EngineDeps, opts: Partial<EngineOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.queue = new TaskQueue(deps.store);
    this.context = new ContextBuilder(deps.repo, deps.store);
    this.contextV2 = new TaskContextBuilder(deps.repo, deps.store);
    this.classifier = new ComplexityClassifier({ store: deps.store, repo: deps.repo, pool: deps.pool, providers: deps.providers, events: deps.events });
    this.skills = deps.skills ?? new SkillRegistry(deps.store, null);
    this.gatherer = new FunctionGatherer(deps.repo, deps.store);
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
    if (this.exclusiveHolder) throw new Error(`worktree slots are busy (${this.exclusiveHolder}); start the run when it finishes`);
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (['completed', 'cancelled'].includes(row.status)) throw new Error(`run is ${row.status}`);
    const plan = compileFlowPlan(row.flow);

    if (row.status === 'created' || row.status === 'discovering') {
      store.setRunStatus(runId, 'discovering');
      events.emit('run.discovering', `discovering backlog (${row.config.selection.source})`, { runId });
      try {
        let found: DiscoveredFunction[];
        if (row.config.selection.source === 'gather') {
          const report = await this.gatherer.gather(row.config.selection.filter, { runId });
          store.putGathered(runId, report.functions);
          store.setRunJson(runId, 'gather_json', { ...report, functions: undefined });
          const ex = Object.entries(report.excluded).filter(([k, n]) => n && k !== 'matched').map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
          events.emit('run.gathered', `gathered ${report.selected} function(s) in ${report.units} unit(s) from ${report.inventory.mapped} unmatched of ${report.inventory.total} (${report.source})${ex ? `; excluded: ${ex}` : ''}`, {
            runId, data: { selected: report.selected, excluded: report.excluded, withPack: report.withPackFeatures, withTable: report.withTableFacts },
          });
          found = report.functions;
        } else found = await this.deps.repo.discover(row.config.selection);
        const routing = row.config.routing;
        if (routing.enabled) {
          const packets = await this.classifier.plan(runId, found, row.config, plan);
          const inserted = store.insertTasks(runId, packets.map((p) => ({ ...p, id: newId('task'), tier: tierFor(plan, p.difficulty) })));
          const by = (d: Difficulty) => packets.filter((p) => p.difficulty === d);
          const summary = DIFFICULTIES.map((d) => `${d} ${by(d).reduce((s, p) => s + p.functions.length, 0)} fn/${by(d).length} pk → ${plan.tiers[plan.route[d]]!.node.data.label || plan.tiers[plan.route[d]]!.node.id}`).join(' · ');
          events.emit('run.enqueued', `${found.length} functions → ${packets.length} packets (${inserted} new); routing: ${summary}`, {
            runId, data: { functions: found.length, packets: packets.length, byDifficulty: Object.fromEntries(DIFFICULTIES.map((d) => [d, by(d).length])) },
          });
        } else {
          const packets = partition(found, row.config.packetMaxFunctions);
          const inserted = store.insertTasks(runId, packets.map((p) => ({ ...p, id: newId('task') })));
          events.emit('run.enqueued', `${found.length} functions → ${packets.length} packets (${inserted} new)`, { runId, data: { functions: found.length, packets: packets.length } });
        }
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
    for (const s of usable) run.slotsByTier.set(s.tier, [...(run.slotsByTier.get(s.tier) ?? []), s.slot]);
    // Worker identities + the per-worker function cap (counts persist across restarts and resumes).
    const perTier = new Map<number, number>();
    const workers = usable.map((s) => {
      const k = perTier.get(s.tier) ?? 0;
      perTier.set(s.tier, k + 1);
      const node = plan.tiers[s.tier]!.node;
      const workerId = `${node.id}#${k + 1}`;
      run.workerBySlot.set(s.slot, workerId);
      return { workerId, nodeId: node.id, tier: s.tier, capability: plan.tiers[s.tier]!.capability };
    });
    store.registerWorkers(runId, workers, run.row.config.maxFunctionsPerWorker);
    for (const s of usable) if (this.queue.workerRemaining(runId, run.workerBySlot.get(s.slot)!) <= 0) run.capped.add(s.slot);
    if (!store.runJson(runId, 'capacity_json')) {
      const demand = store.db.prepare(`SELECT tier, SUM(json_array_length(functions_json)) n FROM tasks WHERE run_id = ? GROUP BY tier`).all(runId) as Array<{ tier: number; n: number }>;
      const demandByTier = plan.tiers.map((_, i) => demand.find((d) => d.tier === i)?.n ?? 0);
      const cap = planCapacity({
        plan, usable, repoSlots: this.deps.repo.slotCount, maxPerWorker: run.row.config.maxFunctionsPerWorker, batch: demandByTier.reduce((a, b) => a + b, 0),
        demandByTier, stealing: run.row.config.routing.enabled && run.row.config.routing.workStealing, stealMaxGap: run.row.config.routing.stealMaxGap,
      });
      store.setRunJson(runId, 'capacity_json', cap);
      events.emit('run.capacity', `${cap.workers} worker(s) × ${cap.maxPerWorker} functions = ${cap.capacity} for ${cap.batch} function(s)${cap.warnings.length ? `: ${cap.warnings.join(' ')}` : ' (ok)'}`, {
        runId, level: cap.warnings.length ? 'warn' : 'info', data: { capacity: cap.capacity, batch: cap.batch, unplaced: cap.unplaced },
      });
    }
    if (run.row.config.context.mode === 'budgeted') {
      run.skills = this.runSkills(run.row);
      const snap = run.skills?.snapshot;
      const prefix = await this.contextV2.staticPrefix(run.row.config.context.budgets, snap?.coreText ? { text: snap.coreText, hash: snap.coreHash } : null).catch(() => null);
      if (snap) {
        events.emit('skills.snapshot', `skills frozen for this run: ${snap.core.length} core (${snap.core.reduce((s, c) => s + c.tokens, 0)} tok in the cached prefix), ${snap.dynamic.length} dynamic`, {
          runId, data: { core: snap.core.map((c) => `${c.id}@${c.version}`), dynamic: snap.dynamic.length, coreHash: snap.coreHash.slice(0, 12) },
        });
      }
      if (prefix && run.row.config.skills.prewarm && run.row.status !== 'paused') await this.prewarm(run, prefix.text).catch((e) => events.emit('cache.prewarm', `prewarm failed: ${(e as Error).message}`, { runId, level: 'warn' }));
    }
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
    run.capacityStalled = false;
    for (const [slot, w] of run.workerBySlot) if (this.queue.workerRemaining(runId, w) > 0) run.capped.delete(slot);
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
    // Staging off: nothing from this run will ever be submitted, so matched functions' claims go back too.
    await this.releaseUnsubmitted(runId, 'run cancelled', this.deps.store.getRun(runId)?.config.staging === 'off');
    return true;
  }

  /** Give back local claims of packets that will not be submitted (dead, quarantined, cancelled). */
  private async releaseUnsubmitted(runId: string, why: string, all = false) {
    const repo = this.deps.repo;
    if (!repo.releaseClaims) return;
    const states = all ? `'dead','quarantined','cancelled','passed','staged'` : `'dead','quarantined','cancelled'`;
    const rows = this.deps.store.db
      .prepare(`SELECT functions_json FROM tasks WHERE run_id = ? AND state IN (${states}) AND sr_task_id IS NOT NULL`)
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

  /** Run `fn` with exclusive use of the worktree slots (refused while a run is active). */
  async exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.active.size) throw new Error('a run is active; shadow evaluation uses the worktree slots and runs between runs');
    if (this.exclusiveHolder) throw new Error(`worktree slots are busy (${this.exclusiveHolder})`);
    this.exclusiveHolder = label;
    try {
      return await fn();
    } finally {
      this.exclusiveHolder = null;
    }
  }

  isIdle() {
    return this.active.size === 0 && this.exclusiveHolder === null;
  }

  /** The run's frozen skill view (snapshot persisted on first start, reused on resume). */
  private runSkills(row: RunRow): RunSkills | null {
    const cfg = row.config.skills;
    if (!cfg.enabled) return null;
    const snapshot = this.skills.snapshotForRun(row.id, cfg);
    const dynamic = this.skills.resolveDynamic(snapshot);
    const ids = [...snapshot.core.map((c) => c.id), ...snapshot.dynamic.map((d) => d.id)];
    const replacesCookbookLessons = ids.some((id) => this.skills.get(id)?.origin === 'repo_bootstrap');
    return { snapshot, dynamic, config: cfg, reserveRetrySlot: hasRetryOnlySkills(dynamic), replacesCookbookLessons };
  }

  /**
   * Prefix-cache pre-warm: one tiny request per (account, model) the flow will use, carrying the
   * exact static prefix with its breakpoint, before the slots fan out. Without it, N parallel
   * first calls all miss and all pay the cache write; with it they all read.
   */
  private async prewarm(run: ActiveRun, prefixText: string) {
    const { pool, providers, store, events } = this.deps;
    const runId = run.row.id;
    const seen = new Set<string>();
    const targets: Array<{ accountId: string; modelId: string }> = [];
    for (const t of run.plan.tiers) {
      const binding: PoolBinding = { ...t.node.data.pool, capability: t.node.data.pool.capability ?? (run.row.config.routing.enabled ? t.capability : undefined) };
      for (const { slot, model } of pool.resolve(binding, 'worker')) {
        const key = `${slot.account.id}/${model.id}`;
        if (seen.has(key) || slot.account.provider === 'claude_cli' || !slot.account.enabled) continue;
        seen.add(key);
        targets.push({ accountId: slot.account.id, modelId: model.id });
      }
    }
    if (!targets.length) return;
    const signal = AbortSignal.any([run.cancel.signal, AbortSignal.timeout(45_000)]);
    let ok = 0;
    let cost = 0;
    let written = 0;
    await Promise.all(targets.slice(0, 8).map(async (t) => {
      const lease = await pool.acquire({ binding: { strategy: 'bound', accountIds: [t.accountId], tags: [], model: t.modelId }, role: 'worker', estInputTokens: Math.ceil(prefixText.length / 3.3), estOutputTokens: 8 }, signal).catch(() => null);
      if (!lease) return;
      const t0 = Date.now();
      try {
        const resp = await providers.complete(lease.account, {
          system: prefixText, prompt: 'Reply with OK.', blocks: [{ text: 'Reply with OK.', cache: false }], cacheKey: `decomp:${createHash('sha256').update(prefixText).digest('hex').slice(0, 32)}`,
          model: lease.model, maxOutputTokens: 8, timeoutMs: 30_000, signal,
        });
        pool.release(lease, { kind: 'ok', usage: resp.usage, latencyMs: Date.now() - t0, rateLimit: resp.rateLimit });
        const c = costUsd(lease.model, resp.usage);
        store.addRunUsage(runId, c, resp.usage);
        cost += c;
        written += resp.usage.cacheWriteTokens + resp.usage.cacheReadTokens;
        ok++;
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError('network', (e as Error).message);
        pool.release(lease, { kind: pe.kind, retryAfterMs: pe.retryAfterMs, message: pe.message, latencyMs: Date.now() - t0 });
      }
    }));
    events.emit('cache.prewarm', `pre-warmed the static prefix on ${ok}/${Math.min(8, targets.length)} account·model pair(s) (${written} tokens cached, $${cost.toFixed(4)})`, { runId, data: { ok, targets: targets.length, cost } });
  }

  status(runId: string) {
    const run = this.active.get(runId);
    return run ? { active: true, paused: run.paused, activeSlots: run.activeSlots, busySlots: run.busySlots.size } : { active: false, paused: false, activeSlots: 0, busySlots: 0 };
  }

  /** Live slot state per worker instance of an active run (busy / capped). */
  workerActivity(runId: string): Map<string, { busy: boolean; capped: boolean }> {
    const run = this.active.get(runId);
    const out = new Map<string, { busy: boolean; capped: boolean }>();
    if (!run) return out;
    for (const [slot, w] of run.workerBySlot) out.set(w, { busy: run.busySlots.has(slot), capped: run.capped.has(slot) });
    return out;
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
        const routing = run.row.config.routing;
        // Steal only from tiers within `stealMaxGap` capability steps: a frontier slot taking a fast
        // tier's easy packet costs ~40x the tokens for work a cheap model handles.
        const myRank = CAPABILITY_RANK[run.plan.tiers[tier]!.capability];
        const steal: StealSource[] = routing.enabled && routing.workStealing
          ? stealSources(run.plan, tier).filter((t) => myRank - CAPABILITY_RANK[run.plan.tiers[t]!.capability] <= routing.stealMaxGap).map((t) => ({ tier: t, minBacklog: run.idleSlots(t) }))
          : [];
        const worker = run.workerBySlot.get(slot);
        const [leased] = this.queue.lease(runId, tier, 1, this.opts.leaseMs, { stealFrom: steal, worker });
        if (!leased) {
          if (!this.queue.hasOpenWork(runId)) return;
          if (worker && this.queue.workerRemaining(runId, worker) <= 0 && !run.capped.has(slot)) {
            run.capped.add(slot);
            events.emit('worker.capped', `${worker} reached its ${run.row.config.maxFunctionsPerWorker}-function cap for this run; it only finishes its own packets now`, { runId, data: { worker } });
          }
          if (run.busySlots.size === 0 && !run.capacityStalled) {
            const b = this.queue.capacityBlocked(runId, routing.enabled && routing.workStealing, routing.stealMaxGap);
            if (b.pending > 0 && b.blocked === b.pending && b.inFlight === 0) {
              run.capacityStalled = true;
              const cap = store.runJson<Record<string, unknown>>(runId, 'capacity_json') ?? {};
              store.setRunJson(runId, 'capacity_json', { ...cap, stalled: { at: Date.now(), packets: b.blocked, functions: b.blockedFunctions } });
              this.pause(runId);
              events.emit('run.capacity_exhausted', `${b.blockedFunctions} function(s) in ${b.blocked} packet(s) left, but every eligible worker reached its ${run.row.config.maxFunctionsPerWorker}-function cap. Raise the cap for this run (or add worker instances in a new run) and resume.`, {
                runId, level: 'error', data: { packets: b.blocked, functions: b.blockedFunctions },
              });
              continue;
            }
          }
          const next = this.queue.nextReadyAt(runId, [tier, ...steal.map((s) => s.tier)]);
          const wait = next ? Math.min(Math.max(10, next - Date.now()), this.opts.idlePollMs) : this.opts.idlePollMs;
          await run.wake.wait(wait, run.cancel.signal);
          continue;
        }
        if (leased.stolenFrom !== undefined) {
          const from = run.plan.tiers[leased.stolenFrom]!;
          events.emit('task.stolen', `${run.plan.tiers[tier]!.node.data.label || run.plan.tiers[tier]!.node.id} stole a ${leased.task.difficulty} packet from ${from.node.data.label || from.node.id} backlog`, {
            runId, taskId: leased.task.id, data: { from: leased.stolenFrom, to: tier },
          });
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

      // 1b. late classification: prepare just produced the local packs — refine size-only estimates
      const routing = cfg.routing;
      if (routing.enabled) {
        const refined = await this.classifier.refine(task, prepared.packs, routing).catch(() => null);
        if (refined) {
          store.setAssessment(task.id, refined);
          task = { ...task, assessment: refined, complexity: refined.score };
          if (DIFFICULTY_RANK[refined.difficulty] > DIFFICULTY_RANK[task.difficulty]) {
            const to = tierFor(run.plan, refined.difficulty, tierIdx);
            if (task.attemptsTotal === 0 && to > tierIdx) {
              this.queue.transition(task.id, leaseId, ['leased'], 'pending', { tier: to, difficulty: refined.difficulty, attemptsAtDifficulty: 0, attemptsAtTier: 0, notBefore: 0 });
              const w = run.workerBySlot.get(slot);
              if (w) this.queue.unassign(runId, w, task.id); // never attempted here: refund the cap
              ev('task.rerouted', `pack analysis: ${task.difficulty} → ${refined.difficulty} (score ${refined.score}); moved to ${run.plan.tiers[to]!.node.data.label || run.plan.tiers[to]!.node.id} before any attempt`, 'info', { from: tierIdx, to, score: refined.score });
              run.wake.notify();
              return;
            }
            this.queue.transition(task.id, leaseId, ['leased'], 'leased', { difficulty: refined.difficulty, attemptsAtDifficulty: 0 });
            task = { ...task, difficulty: refined.difficulty, attemptsAtDifficulty: 0 };
          }
        }
      }

      // 2. bundle + feedback
      const feedback = this.lastFeedback(task);
      const n = task.attemptsTotal + 1;
      let system: string;
      let prompt: string;
      let blocks: PromptBlock[] | undefined;
      let cacheKey: string | undefined;
      let jsonSchema = WORKER_OUTPUT_SCHEMA;
      let bundleHash: string;
      let contextTokens: number;
      let contextRawTokens: number;
      let outputMode: 'files' | 'edits' | 'either' = 'files';
      let elided: string[] = [];
      let selections: SkillSelection[] = [];
      if (cfg.context.mode === 'legacy') {
        const bundle = await this.context.build(task, prepared, slot, { runId, exposureConsent: cfg.exposureConsent, carried });
        system = WORKER_SYSTEM;
        prompt = buildWorkerPrompt(task, bundle, n, feedback, runPitfalls(store, runId));
        bundleHash = bundle.hash;
        contextTokens = contextRawTokens = Math.ceil((system.length + prompt.length) / 3.3);
      } else {
        const bundle = await this.contextV2.build(task, prepared, slot, { runId, exposureConsent: cfg.exposureConsent, carried, attemptNo: n, feedback, pitfalls: runPitfalls(store, runId), context: cfg.context, skills: run.skills });
        selections = bundle.skills;
        const r = renderBundle(bundle, n, shouldCacheTaskPrefix(cfg.context.cacheTaskPrefix, task.difficulty, n, bundle.tokens.taskPrefix));
        ({ system, prompt, blocks } = r);
        cacheKey = `decomp:${bundle.staticPrefixHash.slice(0, 32)}`;
        jsonSchema = WORKER_OUTPUT_SCHEMA_V2;
        bundleHash = bundle.hash;
        contextTokens = bundle.tokens.sent;
        contextRawTokens = bundle.tokens.raw;
        outputMode = bundle.outputMode;
        elided = bundle.elidedFunctions;
      }
      attempt = {
        id: newId('att'), taskId: task.id, runId, n, tier: tierIdx, nodeId: node.id, accountId: null, model: null, status: 'running',
        bundleHash, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0,
        latencyMs: null, error: null, files: null, startedAt: Date.now(), finishedAt: null,
        difficulty: task.difficulty, contextTokens, contextRawTokens,
      };
      store.insertAttempt(attempt);
      if (run.workerBySlot.has(slot)) store.db.prepare('UPDATE attempts SET worker_id = ? WHERE id = ?').run(run.workerBySlot.get(slot), attempt.id);
      this.skills.recordSelections({ attemptId: attempt.id, runId, taskId: task.id, difficulty: task.difficulty, functions: task.functions.length }, selections);

      // 3. account lease + model call
      const tier = run.plan.tiers[tierIdx]!;
      const binding: PoolBinding = { ...node.data.pool, capability: node.data.pool.capability ?? (routing.enabled ? tier.capability : undefined) };
      const estIn = contextTokens;
      let waitedEmitted = false;
      const lease = await pool.acquire(
        { binding, role: 'worker', estInputTokens: estIn, estOutputTokens: Math.min(this.opts.maxOutputTokens, outputMode === 'edits' ? 3_000 : 8_000) },
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
          system, prompt, blocks, cacheKey, model: lease.model, effort: node.data.pool.effort, jsonSchema,
          maxOutputTokens: Math.min(this.opts.maxOutputTokens, lease.model.maxOutputTokens), timeoutMs: this.opts.providerTimeoutMs, signal,
        });
        const latencyMs = Date.now() - t0;
        pool.release(lease, { kind: 'ok', usage: resp.usage, latencyMs, rateLimit: resp.rateLimit });
        const cost = costUsd(lease.model, resp.usage);
        store.addRunUsage(runId, cost, resp.usage);
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

      // 4. parse output; materialise function-level edits into complete files
      const parsed = WorkerOutput.safeParse(extractJson(text));
      if (!parsed.success) {
        store.updateAttempt(attempt.id, { status: 'parse_error', error: 'output did not match the contract', finishedAt: Date.now() });
        return this.route(run, task, leaseId, attempt, syntheticVerdict(task, attempt, 'OUTPUT_PARSE', 'reply was not a JSON object with "edits" or "files" as described in the output contract'), { infra: false, strike: false }, tierIdx);
      }
      if (outputMode === 'edits' && elided.length && parsed.data.files?.some((f) => f.path.endsWith('.cpp'))) {
        // Complete files cannot contain bodies the worker never saw: reject as a contract error, not a cheat strike.
        store.updateAttempt(attempt.id, { status: 'parse_error', error: 'returned complete files in edits mode', finishedAt: Date.now() });
        return this.route(run, task, leaseId, attempt, syntheticVerdict(task, attempt, 'OUTPUT_MODE', `accepted bodies were elided (${elided.length} function(s)); return "edits" with only the functions you add or change, never complete files`), { infra: false, strike: false }, tierIdx);
      }
      const mat = await materialise(parsed.data, (p) => repo.readFile(slot, p));
      if (mat.problems.length) {
        store.updateAttempt(attempt.id, { status: 'parse_error', error: mat.problems.join('; ').slice(0, 500), files: mat.files, finishedAt: Date.now() });
        return this.route(run, task, leaseId, attempt, syntheticVerdict(task, attempt, 'OUTPUT_EDIT', mat.problems.join('; ').slice(0, 1_000)), { infra: false, strike: false }, tierIdx);
      }
      // Deterministic header repair (skeleton placeholders, duplicate keys, banned lines, origin in .h).
      const fixed = await repairAnswer(mat.files, (p) => repo.readFile(slot, p), { codeOrigin: parsed.data.codeOrigin, adaptedBodies: parsed.data.adaptedBodies });
      mat.files = fixed.files;
      if (fixed.changes.length) ev('attempt.header_repaired', `header repaired before the Gate Keeper: ${fixed.changes.join('; ').slice(0, 600)}`, 'debug', { changes: fixed.changes });
      store.updateAttempt(attempt.id, { files: mat.files });

      // 5. Gate Keeper (always on the complete materialised files)
      if (!this.queue.transition(task.id, leaseId, ['leased'], 'gating')) throw new AbortedError('lease lost before gating');
      const carriedMap = new Map(carried.map((c) => [c.path, c.content]));
      const gate = await run.gate.evaluate({
        task, attemptId: attempt.id, slot, prepared, files: mat.files, checks: mergeGateChecks(run.plan),
        compareTimeoutMs: cfg.compareTimeoutMs, signal, carried: carriedMap,
      });
      if (signal.aborted) throw new AbortedError();
      const written = gate.written.length ? gate.written : mat.files;
      store.updateAttempt(attempt.id, { status: 'completed', files: written, finishedAt: Date.now() });
      if (gate.verdict.decision === 'pass') await this.learn(run, task, written, carriedMap).catch((e) => ev('knowledge.failed', `knowledge extraction failed: ${(e as Error).message}`, 'warn'));
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

  /** Mine a passing packet's accepted files for verified facts the rest of the run can reuse. */
  private async learn(run: ActiveRun, task: TaskRow, files: Array<{ path: string; content: string }>, carried: Map<string, string>) {
    const base = new Map<string, string | null>();
    for (const f of files) base.set(f.path, carried.get(f.path) ?? (await this.deps.repo.baseFile(f.path)));
    const entries = extractKnowledge({ runId: run.row.id, taskId: task.id, unit: task.unit, files, base });
    if (!entries.length) return;
    this.deps.store.upsertKnowledge(entries);
    const kinds = entries.reduce<Record<string, number>>((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
    this.deps.events.emit('knowledge.added', `+${entries.length} verified fact(s) shared with the run (${Object.entries(kinds).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')})`, {
      runId: run.row.id, taskId: task.id, level: 'debug', data: kinds,
    });
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
    this.skills.recordOutcome(attempt.id, verdict);
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
    const routing = run.row.config.routing;

    // Format-only rejections (header/lint/output contract with no byte evidence against the code)
    // say nothing about how hard the function is: retry on the same tier without counting toward
    // promotion or escalation — at most FORMAT_RETRIES times per packet, then normal rules apply.
    if (isFormatOnly(verdict) && store.verdictsForTask(task.id).filter((v) => v.route === 'retry' && isFormatOnly(v)).length < FORMAT_RETRIES) {
      store.insertVerdict({ ...verdict, route: 'retry' });
      this.queue.transition(task.id, leaseId, from, 'pending', { ...common, attemptsTotal, bestExactBytes, cheatStrikes, notBefore: 0 });
      events.emit('task.retry', `retry ${fnLabel} on the same tier (format only, not counted toward escalation): ${summarise(verdict)}`, { runId, taskId: task.id, level: 'debug' });
      return;
    }
    const attemptsAtDifficulty = task.attemptsAtDifficulty + 1;
    const label = (i: number) => run.plan.tiers[i]!.node.data.label || run.plan.tiers[i]!.node.id;

    // Retry escalation by difficulty: after N failed attempts at a difficulty, promote it
    // (easy → medium → hard) and move to the tier that serves the new difficulty (never down).
    if (routing.enabled && attemptsAtDifficulty >= routing.promoteAfterFailures && task.difficulty !== 'hard') {
      const difficulty = promote(task.difficulty);
      const to = tierFor(run.plan, difficulty, tierIdx);
      const moved = to > tierIdx;
      const stillHere = !moved && attemptsAtTier < limit.maxAttempts && tierNode.retryLoop;
      if (moved || stillHere) {
        store.insertVerdict({ ...verdict, route: moved ? 'escalate' : 'retry' });
        this.queue.transition(task.id, leaseId, from, 'pending', {
          ...common, difficulty, attemptsAtDifficulty: 0, attemptsTotal, bestExactBytes, cheatStrikes, notBefore: 0,
          ...(moved ? { tier: to, attemptsAtTier: 0, noImprovementStreak: 0 } : { attemptsAtTier, noImprovementStreak }),
        });
        events.emit('task.promoted', `promote ${fnLabel}: ${task.difficulty} → ${difficulty} after ${attemptsAtDifficulty} failed attempt(s)${moved ? `; → ${label(to)}` : ` (stays on ${label(tierIdx)})`}: ${summarise(verdict)}`, {
          runId, taskId: task.id, level: 'info', data: { from: task.difficulty, to: difficulty, tierFrom: tierIdx, tierTo: to },
        });
        run.wake.notify();
        return;
      }
    }

    const exhausted = attemptsAtTier >= limit.maxAttempts || noImprovementStreak >= limit.stuckAfter || !tierNode.retryLoop;
    if (!exhausted) {
      store.insertVerdict({ ...verdict, route: 'retry' });
      this.queue.transition(task.id, leaseId, from, 'pending', { ...common, attemptsTotal, attemptsAtTier, attemptsAtDifficulty, bestExactBytes, noImprovementStreak, cheatStrikes, notBefore: 0 });
      events.emit('task.retry', `retry ${fnLabel}: ${summarise(verdict)}`, { runId, taskId: task.id, level: 'debug' });
      return;
    }
    if (tierIdx + 1 < run.plan.tiers.length) {
      const next = run.plan.tiers[tierIdx + 1]!;
      // Climbing the ladder proves the packet is at least as hard as the next tier is meant for.
      const difficulty = routing.enabled ? harder(task.difficulty, CAPABILITY_DIFFICULTY[next.capability]) : task.difficulty;
      store.insertVerdict({ ...verdict, route: 'escalate' });
      this.queue.transition(task.id, leaseId, from, 'pending', { ...common, tier: tierIdx + 1, difficulty, attemptsAtDifficulty: difficulty === task.difficulty ? attemptsAtDifficulty : 0, attemptsTotal, attemptsAtTier: 0, bestExactBytes, noImprovementStreak: 0, cheatStrikes, notBefore: 0 });
      events.emit('task.escalated', `escalate ${fnLabel} → tier ${tierIdx + 1} (${label(tierIdx + 1)})`, { runId, taskId: task.id, level: 'info' });
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
    const stagingOff = run.row.config.staging === 'off';
    // Staging off: nothing will be submitted from this run, so every claim it took goes back.
    await this.releaseUnsubmitted(runId, stagingOff ? 'test run with staging off: nothing is submitted' : 'not matched in this run', stagingOff);
    try {
      if (stagingOff) events.emit('run.staging', 'staging off: nothing committed in the target repository; accepted files stay in this run\'s attempts', { runId });
      const batches = stagingOff ? 0 : await stageRun(store, this.deps.repo, events, runId, run.row.config.prBatchSize);
      store.setRunStatus(runId, 'completed', ['running', 'paused']);
      const fc = store.functionCounts(runId);
      events.emit('run.completed', `completed: ${(fc.passed ?? 0) + (fc.staged ?? 0)} functions matched, ${fc.dead ?? 0} dead-lettered, ${fc.quarantined ?? 0} quarantined; ${batches} PR batch(es) staged`, { runId, data: fc });
      if (run.row.config.skills.enabled && run.row.config.skills.autoCurate) queueMicrotask(() => this.afterRun?.(runId));
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
    // Largest remainder: proportional, ≥1 per tier, and every worktree slot gets a worker (each
    // worker instance adds `maxFunctionsPerWorker` of run capacity, so leaving slots idle costs).
    const exact = want.map((w) => (w / total) * capacity);
    counts = exact.map((x) => Math.max(1, Math.floor(x)));
    while (counts.reduce((a, b) => a + b, 0) > capacity && counts.some((c) => c > 1)) {
      const i = counts.indexOf(Math.max(...counts));
      counts[i]!--;
    }
    const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
    for (let k = 0; counts.reduce((a, b) => a + b, 0) < capacity && k < order.length * 4; k++) counts[order[k % order.length]!.i]!++;
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

/** Header, lint, scope-line and output-contract findings only, and no comparator failure. */
const FORMAT_CODES = /^(CONV_|PREFLIGHT_|SCOPE_LINE_TOO_LONG|OUTPUT_|LEAK_INCLUDE_OUTSIDE_ROOTS)/;
const FORMAT_RETRIES = 3;
export function isFormatOnly(v: Verdict): boolean {
  const blocks = v.findings.filter((f) => f.severity === 'block');
  return blocks.length > 0 && blocks.every((f) => FORMAT_CODES.test(f.code)) && !(v.compare ?? []).some((c) => c.result !== 'pass');
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
