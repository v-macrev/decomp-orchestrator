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
  type Attempt, type CapabilityTier, type Difficulty, type FlowPlan, type PoolBinding, type Route, type SkillSelection, type TaskState, type Verdict,
} from '@decomp/core';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { RunRow, Store, TaskRow } from '../db/store.js';
import { GateKeeper, type Reviewer } from '../gatekeeper/gatekeeper.js';
import { LlmReviewer, extractJson } from '../gatekeeper/review.js';
import { ComplexityClassifier } from '../intel/complexity.js';
import { extractKnowledge } from '../intel/knowledge.js';
import { NoEligibleAccountError, type AccountPool } from '../pool/scheduler.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { ProviderError, costUsd, type PromptBlock } from '../providers/types.js';
import { TaskQueue, type StealSource, type TaskPatch } from '../queue/taskQueue.js';
import type { ClaimCollision, DiscoveredFunction, ProgressFn, RepoAdapter, PreparedTask, SubmitBatchInput, SubmitBatchResult } from '../repo/types.js';
import type { EventBus } from '../telemetry/events.js';
import { AbortedError, Notifier, Semaphore, newId } from '../util/async.js';
import { ContextBuilder } from './context.js';
import { TaskContextBuilder, shouldCacheTaskPrefix } from './contextBuilder.js';
import { materialise } from './edits.js';
import { repairAnswer } from './headerRepair.js';
import { buildHistory, findRepeat, progressScore, type HistoryEntry } from './history.js';
import { draftedByText, personOf } from './attribution.js';
import { runPitfalls } from './lessons.js';
import { WORKER_OUTPUT_SCHEMA, WORKER_OUTPUT_SCHEMA_V2, WORKER_SYSTEM, buildWorkerPrompt, renderBundle, type Feedback } from './prompts.js';
import { batchContent, finishingModel, stageRun, type StageSummary } from './staging.js';
import { SkillRegistry } from '../skills/registry.js';
import { FunctionGatherer } from '../intel/gatherer.js';
import { planCapacity } from './capacity.js';
import { hasRetryOnlySkills, type RunSkills } from './contextBuilder.js';

export interface EngineOptions {
  leaseMs: number;
  heartbeatMs: number;
  maxInfraFailures: number;
  /** First back-off for a slot whose worktree cannot be restored (doubles per failed restore, cap 5 min). */
  slotParkBaseMs: number;
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
  slotParkBaseMs: 15_000,
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
  /** Slots whose worktree could not be restored: slot → when to try again. They take no work. */
  parked = new Map<number, number>();
  parkStrikes = new Map<number, number>();
  /** Replaced when the operator applies a live-compatible flow edit (see RunEngine.updateRunFlow). */
  constructor(readonly row: RunRow, public plan: FlowPlan, readonly gate: GateKeeper) {}

  /** Idle slots that could still take new work (capped workers cannot absorb a backlog). */
  idleSlots(tier: number): number {
    return (this.slotsByTier.get(tier) ?? []).filter((s) => !this.busySlots.has(s) && !this.capped.has(s) && !this.parked.has(s)).length;
  }
}

/** The difficulty a capability tier is meant for (used when a task escalates up the ladder). */
const CAPABILITY_DIFFICULTY: Record<CapabilityTier, Difficulty> = { fast: 'easy', balanced: 'medium', frontier: 'hard' };
/** `sr`'s CLAIM_LAPSE: a claim with no activity for a day no longer blocks others. */
const CLAIM_LAPSE_MS = 24 * 60 * 60_000;

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
  /** What the slot-holding operation is doing right now (batch staging, dry runs, claims checks). */
  private op: OperationProgress | null = null;
  private discovering: string | null = null;
  private dryRuns = new Map<string, AbortController>();
  private editingAttribution = new Set<string>();
  /** Runs that left `active` and are still staging: waitFor() resolves only once staging is over. */
  private finishing = new Map<string, Promise<void>>();
  private reaper: NodeJS.Timeout;
  private claimWatch: NodeJS.Timeout;

  constructor(private deps: EngineDeps, opts: Partial<EngineOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.queue = new TaskQueue(deps.store);
    deps.repo.notice = (kind, msg) => deps.events.emit(kind, msg, { level: 'warn' });
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
    // Withheld packets go back into staging on their own once their blocking claims lapse.
    this.claimWatch = setInterval(() => this.autoRecheckWithheld(), 5 * 60_000).unref();
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
    if (this.discovering === runId) return;
    if (this.discovering) throw new Error('another run is already discovering its backlog');
    if (this.active.size > 0) throw new Error('another run is active; worktree slots are exclusive to one run at a time');
    if (this.exclusiveHolder) throw new Error(`worktree slots are busy (${this.exclusiveHolder}); start the run when it finishes`);
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (['completed', 'cancelled'].includes(row.status)) throw new Error(`run is ${row.status}`);
    const plan = compileFlowPlan(row.flow);

    if (row.status === 'created' || row.status === 'discovering') {
      this.discovering = runId;
      store.setRunStatus(runId, 'discovering');
      events.emit('run.discovering', `discovering backlog (${row.config.selection.source})`, { runId });
      try {
        const selection = row.config.selection;
        const exclude = store.rvasInFlight(runId);
        let found: DiscoveredFunction[];
        if (selection.source === 'gather') {
          const report = await this.gatherer.gather(selection.filter, { runId });
          if (store.getRun(runId)?.status === 'cancelled') return;
          store.putGathered(runId, report.functions);
          store.setRunJson(runId, 'gather_json', { ...report, functions: undefined });
          const ex = Object.entries(report.excluded).filter(([k, n]) => n && k !== 'matched').map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
          events.emit('run.gathered', `gathered ${report.selected} function(s) in ${report.units} unit(s) from ${report.inventory.mapped} unmatched of ${report.inventory.total} (${report.source})${ex ? `; excluded: ${ex}` : ''}`, {
            runId, data: { selected: report.selected, excluded: report.excluded, withPack: report.withPackFeatures, withTable: report.withTableFacts },
          });
          found = report.functions;
        } else found = await this.deps.repo.discover(selection, { exclude });
        if (store.getRun(runId)?.status === 'cancelled') return;
        // Dead functions carried over from earlier runs join whatever the selection found.
        const carried = row.config.carry.rvas.filter((r) => !found.some((f) => f.rva === r.toLowerCase()));
        if (carried.length) {
          const extra = await this.deps.repo.discover({ source: 'rva_list', rvas: carried }, { exclude });
          if (store.getRun(runId)?.status === 'cancelled') return;
          // Give explicitly carried functions priority inside a capped repository selection.
          const limit = selection.source === 'sr_next' ? selection.count : selection.source === 'gather' ? selection.filter.maxFunctions : Infinity;
          const added = extra.filter((e) => !found.some((f) => f.rva === e.rva)).slice(0, limit);
          found = Number.isFinite(limit) ? [...added, ...found].slice(0, limit) : [...found, ...added];
          events.emit('run.carried', `carried over ${added.length} dead function(s) from ${row.config.carry.fromRuns.length} earlier run(s)`, {
            runId, data: { carried: added.length, asked: carried.length, eligible: extra.length, fromRuns: row.config.carry.fromRuns },
          });
        }
        const requested = selection.source === 'gather' ? selection.filter.maxFunctions : selection.source === 'rva_list' ? new Set(selection.rvas.map((rva) => rva.toLowerCase())).size : selection.count;
        if (found.length < requested) {
          events.emit('run.selection_shortfall', `Found ${found.length} eligible functions out of ${requested} requested. This run will use the available functions.`, {
            runId, level: 'warn', data: { selected: found.length, requested },
          });
        }
        if (!found.length) {
          store.setRunStatus(runId, 'completed', ['discovering']);
          events.emit('run.completed', 'No eligible functions were available', { runId });
          return;
        }
        const routing = row.config.routing;
        if (routing.enabled) {
          const packets = await this.classifier.plan(runId, found, row.config, plan);
          if (store.getRun(runId)?.status === 'cancelled') return;
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
        if (store.getRun(runId)?.status === 'cancelled') return;
        store.setRunStatus(runId, 'failed', undefined, { error: (e as Error).message });
        events.emit('run.failed', `discovery failed: ${(e as Error).message}`, { runId, level: 'error' });
        throw e;
      } finally {
        this.discovering = null;
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

  /**
   * Resume a paused run. `budgetUsd` replaces the run's budget first (null removes it). Without a new
   * budget, a run whose spend has reached its cap is not resumed: it would only pause again at once.
   */
  async resume(runId: string, opts: { budgetUsd?: number | null } = {}): Promise<{ ok: boolean; reason?: string }> {
    const row = this.deps.store.getRun(runId);
    if (!row) return { ok: false, reason: 'run not found' };
    if (opts.budgetUsd !== undefined) {
      const before = row.config.budgetUsd;
      if (opts.budgetUsd !== null && opts.budgetUsd <= row.costUsd) {
        return { ok: false, reason: `a new budget must exceed the $${row.costUsd.toFixed(2)} already spent` };
      }
      this.deps.store.setRunBudget(runId, opts.budgetUsd);
      const live = this.active.get(runId);
      if (live) {
        if (opts.budgetUsd === null) delete live.row.config.budgetUsd;
        else live.row.config.budgetUsd = opts.budgetUsd;
      }
      this.deps.events.emit('run.budget', `run budget ${before === undefined ? 'none' : `$${before}`} → ${opts.budgetUsd === null ? 'none' : `$${opts.budgetUsd}`}`, { runId, data: { before: before ?? null, after: opts.budgetUsd } });
    } else if (budgetReached(row)) {
      return { ok: false, reason: `run budget $${row.config.budgetUsd} reached ($${row.costUsd.toFixed(2)} spent): resume with a higher budgetUsd, or budgetUsd: null to remove the cap` };
    }
    await this.resumeRun(runId);
    return { ok: true };
  }

  /**
   * Retry the run's dead-lettered packets only. By default each goes back to the tier where it
   * stopped (it already proved too hard for the tiers below, and its history carries over);
   * `from: 'fast'` starts the ladder again.
   */
  async retryFailedTasks(runId: string, opts: { from?: 'last' | 'fast' } = {}): Promise<{ ok: true; requeued: number; tier: number; tierLabel: string; status: string } | { ok: false; reason: string }> {
    const { store, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) return { ok: false, reason: 'run not found' };
    if (!['running', 'paused', 'completed'].includes(row.status)) return { ok: false, reason: `run is ${row.status}` };
    if (row.config.budgetUsd !== undefined && row.costUsd >= row.config.budgetUsd) {
      return { ok: false, reason: `run budget $${row.config.budgetUsd} reached; raise the budget before retrying failed tasks` };
    }

    const active = this.active.get(runId);
    if (!active && this.active.size > 0) return { ok: false, reason: 'another run is active; retry when it finishes' };
    if (!active && this.exclusiveHolder) return { ok: false, reason: `worktree slots are busy (${this.exclusiveHolder}); retry when they are free` };

    const plan = compileFlowPlan(row.flow);
    const fromFast = opts.from === 'fast';
    const fast = plan.tiers.findIndex((t) => t.capability === 'fast');
    if (fromFast && fast < 0) return { ok: false, reason: 'flow has no fast worker tier; add one before retrying failed tasks' };
    const dead = store.db.prepare("SELECT MAX(tier) t FROM tasks WHERE run_id = ? AND state = 'dead'").get(runId) as { t: number | null };
    const tier = fromFast ? fast : Math.min(dead.t ?? 0, plan.tiers.length - 1);
    const tierLabel = fromFast ? plan.tiers[tier]!.node.data.label || plan.tiers[tier]!.node.id : 'the tier where each packet stopped';
    const requeued = this.queue.requeueDead(runId, fromFast ? tier : null);
    if (!requeued) return { ok: true, requeued: 0, tier, tierLabel, status: row.status };

    events.emit('run.retry_failed', `requeued ${requeued} dead packet(s) at ${tierLabel}`, {
      runId, level: 'warn', data: { requeued, tier, tierLabel },
    });
    // Retrying is asking for the work to happen: a paused run resumes (its slot loops wait on the
    // resume signal, not on the queue), and a run that is not loaded starts as running, not paused.
    if (active?.paused) {
      await this.resumeRun(runId);
    } else if (active) {
      active.capacityStalled = false;
      active.wake.notify();
    } else {
      if (row.status !== 'running') store.setRunStatus(runId, 'running', ['completed', 'paused']);
      await this.start(runId);
    }
    return { ok: true, requeued, tier, tierLabel, status: store.getRun(runId)?.status ?? 'running' };
  }

  private async resumeRun(runId: string) {
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
    const states = all ? `'dead','quarantined','cancelled','passed','staged','withheld','set_aside'` : `'dead','quarantined','cancelled'`;
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
    this.markInterruptedBatches();
    for (const r of this.deps.store.activeRuns()) {
      if (r.status === 'paused') continue;
      this.deps.events.emit('run.recovering', `resuming ${r.name} after restart`, { runId: r.id, level: 'warn' });
      await this.start(r.id).catch((e) => this.deps.events.emit('run.failed', `resume failed: ${(e as Error).message}`, { runId: r.id, level: 'error' }));
    }
  }

  /**
   * A batch still 'draft' at boot was being re-verified when the process stopped: no branch was
   * created and its packets are still 'passed'. Mark it so the operator can re-verify exactly it.
   */
  markInterruptedBatches() {
    const { store, repo, events } = this.deps;
    if (!repo.stageBatch) return 0;
    const rows = store.db.prepare("SELECT id, run_id FROM pr_batches WHERE status = 'draft'").all() as Array<{ id: string; run_id: string }>;
    for (const r of rows) {
      const b = store.getBatch(r.id)!;
      store.updateBatch(b.id, { status: 'interrupted', detail: { ...(b.detail as Record<string, unknown> | null), interruptedAt: Date.now() } });
      events.emit('batch.interrupted', `batch ${b.seq}: re-verification was interrupted by a server restart; no branch was created and its packets stay passed (Re-verify again)`, { runId: r.run_id, level: 'warn' });
    }
    return rows.length;
  }

  /** Re-verify exactly the packets of a batch whose staging was interrupted, as a new batch. */
  async restageInterrupted(runId: string, batchId: string) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.status !== 'completed') throw new Error(`run is ${row.status}; only a completed run can be staged`);
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    if (batch.status !== 'interrupted' && batch.status !== 'failed') throw new Error(`batch ${batch.seq} is ${batch.status}: only an interrupted or failed batch can be re-verified again`);
    const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t && t.state === 'passed');
    if (!tasks.length) throw new Error(`batch ${batch.seq} has no passed packets left`);
    return this.exclusive(`re-verifying the packets of ${batch.status} batch ${batch.seq} of ${runId}`, async () => {
      const staged = await stageRun(store, repo, events, runId, row.config.prBatchSize, { only: tasks.map((t) => t.id), progress: this.progress });
      store.updateBatch(batchId, { status: 'superseded', detail: { ...(batch.detail as Record<string, unknown> | null), supersededBy: staged.seqs } });
      return staged;
    });
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
    clearInterval(this.claimWatch);
  }

  close() {
    clearInterval(this.reaper);
    clearInterval(this.claimWatch);
  }

  /**
   * Stage a completed run's packets that are still 'passed' (a batch failed re-verification, or
   * staging was interrupted), under the slot lock: never alongside a run or another staging.
   */
  async restage(runId: string): Promise<StageSummary> {
    const { store, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.status !== 'completed') throw new Error(`run is ${row.status}; only a completed run can be staged`);
    if (!store.listTasks(runId, { state: 'passed', limit: 1 }).length) throw new Error('no passed packets left to stage');
    return this.exclusive(`staging ${runId}`, async () => {
      // A run with staging off gave its claims back when it finished: batching its functions for a
      // PR takes them again, under the run's current draftedBy.
      if (row.config.staging === 'off') await this.reclaim(runId, store.listTasks(runId, { state: 'passed', limit: 100_000 }));
      const r = await stageRun(store, this.deps.repo, events, runId, row.config.prBatchSize, { progress: this.progress });
      events.emit('run.restaged', `staged: ${r.staged} batch(es) staged, ${r.failed} failed`, { runId, level: r.failed ? 'warn' : 'info', data: { ...r } });
      return r;
    });
  }

  /** Re-record each packet's claim and drafter (`sr claim`), with the finishing model and the run's current person. */
  private async reclaim(runId: string, tasks: TaskRow[], signal?: AbortSignal) {
    const { store, repo, events } = this.deps;
    if (!repo.recordAttribution) return;
    const person = personOf(store.getRun(runId)?.config.draftedBy);
    const failed: string[] = [];
    for (const t of tasks) {
      if (signal?.aborted) return;
      const model = finishingModel(store, t);
      if (!t.srTaskId || !model) continue;
      const r = await repo.recordAttribution({ task: t, srTaskId: t.srTaskId, model, draftedBy: draftedByText(person, [model]) }).catch((e) => ({ ok: false, problems: [String(e)] }));
      if (!r.ok) failed.push(`${t.functions.map((f) => f.rva).join(',')}: ${r.problems.join('; ')}`);
    }
    events.emit(failed.length ? 'claims.attribution_failed' : 'claims.attributed', `claims re-recorded for ${tasks.length - failed.length}/${tasks.length} packet(s)${person ? ` as ${person}` : ''}${failed.length ? `; failed: ${failed.join(' | ')}` : ''}`, { runId, level: failed.length ? 'warn' : 'info' });
  }

  /**
   * Edit a run: its name and the settings that can change after it started. A new `draftedBy` is
   * used from then on (claims are re-recorded, and lines written under the old name are renamed
   * when the functions are staged or submitted).
   */
  async updateRun(runId: string, patch: { name?: string; draftedBy?: string; budgetUsd?: number | null; prBatchSize?: number; staging?: 'branches' | 'off' }) {
    const { store, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    const cfg: RunConfig = structuredClone(row.config);
    const changes: string[] = [];
    if (patch.budgetUsd !== undefined && patch.budgetUsd !== (cfg.budgetUsd ?? null)) {
      if (patch.budgetUsd !== null && ['running', 'paused'].includes(row.status) && patch.budgetUsd <= row.costUsd) throw new Error(`a new budget must exceed the $${row.costUsd.toFixed(2)} already spent`);
      changes.push(`budget ${cfg.budgetUsd === undefined ? 'none' : `$${cfg.budgetUsd}`} → ${patch.budgetUsd === null ? 'none' : `$${patch.budgetUsd}`}`);
      if (patch.budgetUsd === null) delete cfg.budgetUsd;
      else cfg.budgetUsd = patch.budgetUsd;
    }
    if (patch.prBatchSize !== undefined && patch.prBatchSize !== cfg.prBatchSize) {
      changes.push(`functions per PR ${cfg.prBatchSize} → ${patch.prBatchSize}`);
      cfg.prBatchSize = patch.prBatchSize;
    }
    if (patch.staging !== undefined && patch.staging !== cfg.staging) {
      if (row.status === 'completed' || this.finishing.has(runId)) throw new Error('staging is decided when the run finishes; for a completed run use "Batch passed functions"');
      changes.push(`staging ${cfg.staging} → ${patch.staging}`);
      cfg.staging = patch.staging;
    }
    const newPerson = patch.draftedBy?.replace(/\s+/g, ' ').trim();
    const renamed = newPerson && newPerson !== cfg.draftedBy;
    if (renamed) {
      if (this.editingAttribution.has(runId) || this.exclusiveHolder?.includes(runId)) throw new Error('wait for the current batch or attribution operation before editing attribution');
      changes.push(`drafted by "${cfg.draftedBy}" → "${newPerson}"`);
      cfg.formerDraftedBy = [...new Set([...cfg.formerDraftedBy, cfg.draftedBy])].filter((x) => x !== newPerson);
      cfg.draftedBy = newPerson;
    }
    const name = patch.name?.trim() && patch.name.trim() !== row.name ? patch.name.trim() : undefined;
    if (name) changes.push(`renamed "${row.name}" → "${name}"`);
    if (!changes.length) return store.getRun(runId)!;
    const config = RunConfig.parse(cfg);
    store.updateRun(runId, { name, config });
    const live = this.active.get(runId);
    if (live) Object.assign(live.row, { ...(name ? { name } : {}), config });
    events.emit('run.edited', changes.join('; '), { runId, data: { changes } });
    if (renamed) {
      for (const batch of store.listBatches(runId)) {
        if (batch.status !== 'branch_ready') continue;
        const detail = { ...(batch.detail as Record<string, unknown> | null) };
        if (detail.dryRunFingerprint === undefined) continue;
        delete detail.dryRunFingerprint;
        delete detail.dryRunUncheckedClaims;
        store.updateBatch(batch.id, { detail });
      }
      // Claims and task drafters follow the new name now; held claims only (finished staging-off runs gave theirs back).
      const held = row.status === 'completed' && cfg.staging === 'off' ? ['staged', 'withheld', 'set_aside'] : ['passed', 'staged', 'withheld', 'set_aside'];
      const tasks = held.flatMap((s) => store.listTasks(runId, { state: s as TaskState, limit: 100_000 }));
      if (tasks.length) {
        this.editingAttribution.add(runId);
        try {
          await this.reclaim(runId, tasks);
        } finally {
          this.editingAttribution.delete(runId);
        }
      }
    }
    return store.getRun(runId)!;
  }

  /**
   * Delete a run that is not loaded, with everything recorded under it. Local claims it still holds
   * go back, except functions in a submitted PR and functions another run is working on.
   */
  async deleteRun(runId: string) {
    const { store, events, repo } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (this.active.has(runId) || this.finishing.has(runId) || this.exclusiveHolder?.includes(runId)) throw new Error('the run is loaded or staging: cancel it (or wait) before deleting it');
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish before deleting the run');
    if (['running', 'discovering'].includes(row.status)) throw new Error(`run is ${row.status}: cancel it before deleting it`);
    if (store.db.prepare("SELECT 1 FROM runs WHERE status = 'discovering' LIMIT 1").get()) throw new Error('wait for discovery to finish before deleting a run');
    return this.exclusive(`deleting ${runId}`, async () => {
      const submitted = new Set(store.listBatches(runId).filter((b) => b.status === 'submitted').flatMap((b) => b.taskIds));
      const elsewhere = store.rvasInFlight(runId);
      const tasks = store.listTasks(runId, { limit: 100_000 });
      for (const task of tasks) {
        if (submitted.has(task.id)) for (const fn of task.functions) elsewhere.add(fn.rva);
      }
      const rvas = [...new Set(tasks.filter((t) => t.srTaskId).flatMap((t) => t.functions.map((f) => f.rva)))].filter((r) => !elsewhere.has(r));
      let released = 0;
      if (rvas.length && repo.releaseClaims) {
        // sr release is idempotent, including when a previous deletion attempt released the claim.
        const results = await repo.releaseClaims(rvas, 'decomp-orchestrator: run deleted')
          .catch((e) => rvas.map((rva) => ({ rva, ok: false, error: String(e) })));
        const byRva = new Map(results.map((result) => [result.rva, result]));
        const failed = rvas.flatMap((rva) => {
          const result = byRva.get(rva);
          return result?.ok ? [] : [{ rva, error: result?.error || 'Claim release did not report success' }];
        });
        released = rvas.length - failed.length;
        if (failed.length) {
          events.emit('run.delete_claims_failed', `could not release ${failed.length} local claim(s); run kept`, { runId, level: 'warn', data: { released, failed } });
          return { ok: false as const, released, failed };
        }
      }
      store.deleteRun(runId);
      events.emit('run.deleted', `deleted run "${row.name}" (${runId}); ${released} local claim(s) released${submitted.size ? '; claims in submitted PRs kept' : ''}`, { level: 'warn', data: { runId, released } });
      return { ok: true as const, released };
    });
  }

  /**
   * Apply a flow edit to a run, including an active one. Each attempt reads its tier's binding
   * (models, capability, effort), attempt limits and gate checks from the plan when it starts, so
   * those change from the next attempt on; attempts already running finish as they started. What
   * was fixed when the run started cannot change here: the worker ladder, instances per tier
   * (worktree slots and worker identities), difficulty routing and the LLM reviewer.
   */
  updateRunFlow(runId: string, next: Flow) {
    const { store, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (['completed', 'cancelled', 'failed'].includes(row.status)) throw new Error(`run is ${row.status}; flow changes apply to runs that still have work`);
    const errors = validateFlow(next).filter((i) => i.level === 'error');
    if (errors.length) throw new Error(`the flow is invalid: ${errors.map((e) => e.message).join('; ')}`);
    const before = compileFlowPlan(row.flow);
    const after = compileFlowPlan(next);
    const ladder = (p: FlowPlan) => p.tiers.map((t) => t.node.id).join(' → ');
    const problems: string[] = [];
    if (ladder(before) !== ladder(after)) problems.push(`worker tiers changed (${ladder(before)} ⇒ ${ladder(after)})`);
    else {
      before.tiers.forEach((t, i) => {
        const n = after.tiers[i]!.node.data.instances;
        if (t.node.data.instances !== n) problems.push(`${t.node.data.label || t.node.id}: instances ${t.node.data.instances} ⇒ ${n}`);
      });
    }
    if (DIFFICULTIES.some((d) => before.route[d] !== after.route[d])) problems.push('difficulty routing changed');
    const reviewer = (p: FlowPlan) => JSON.stringify(p.gatekeepers.filter((g) => g.data.gate.llmReview).map((g) => g.data.pool));
    if (reviewer(before) !== reviewer(after)) problems.push('LLM review changed');
    if (problems.length) {
      throw new Error(`these changes need a new run (they are fixed when a run starts): ${problems.join('; ')}`);
    }
    const flow = { ...next, id: row.flow.id };
    const changes = after.tiers.flatMap((t, i) => {
      const a = before.tiers[i]!.node.data;
      const b = t.node.data;
      const out: string[] = [];
      if (before.tiers[i]!.capability !== t.capability) out.push(`capability ${before.tiers[i]!.capability} → ${t.capability}`);
      if (JSON.stringify(a.pool) !== JSON.stringify(b.pool)) out.push('models');
      if (a.maxAttempts !== b.maxAttempts || a.stuckAfter !== b.stuckAfter) out.push(`attempts ${a.maxAttempts}/${a.stuckAfter} → ${b.maxAttempts}/${b.stuckAfter}`);
      return out.length ? [`${b.label || t.node.id}: ${out.join(', ')}`] : [];
    });
    store.setRunFlow(runId, flow, after.tiers.map((t) => t.capability));
    const live = this.active.get(runId);
    if (live) {
      Object.assign(live.row, { flow });
      live.plan = after;
      live.wake.notify();
    }
    events.emit('run.flow_updated', `flow updated${live ? ' while running' : ''}: ${changes.join('; ') || 'labels and checks only'}; attempts already running finish as they started`, { runId, level: 'warn', data: { changes } });
    return store.getRun(runId)!;
  }

  listBatches(runId: string) {
    const { store } = this.deps;
    return store.listBatches(runId).map((batch) => {
      const dryRun = this.dryRuns.get(batch.id);
      // Every function of the batch with its unit and its packet's state now (staged, withheld, ...).
      const functions = batch.taskIds.flatMap((id) => {
        const t = store.getTask(id);
        return t ? t.functions.map((fn) => ({ rva: fn.rva, name: fn.name, unit: t.unit, taskId: t.id, state: t.state })) : [];
      });
      return { ...batch, functions, dryRunState: dryRun ? (dryRun.signal.aborted ? 'cancelling' : 'running') : null };
    });
  }

  cancelBatchDryRun(runId: string, batchId: string) {
    const batch = this.deps.store.getBatch(batchId);
    const dryRun = this.dryRuns.get(batchId);
    if (batch?.runId !== runId || !dryRun) throw new Error('this batch has no running dry run');
    dryRun.abort();
  }

  async clearBatchBranches(runId: string, batchId: string, scope: 'preview' | 'batch') {
    const { store, repo, events } = this.deps;
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    const detail = { ...(batch.detail as { lastSubmit?: { dryRun: boolean; submissionStarted?: boolean }; dryRunFingerprint?: string; dryRunUncheckedClaims?: string[]; pr?: string; link?: string } | null) };
    const realAttempt = detail.lastSubmit?.dryRun === false && detail.lastSubmit.submissionStarted !== false;
    if (batch.status !== 'branch_ready' || detail.pr || detail.link || realAttempt) {
      throw new Error('only unsubmitted batches can be cleared here');
    }
    if (!repo.deleteBatchBranch) throw new Error('this repository adapter does not manage local batch branches');
    const branch = `decomp/${runId}-b${batch.seq}`;
    if (batch.branch !== branch) throw new Error('the batch does not own the expected local branch');
    return this.exclusive(`clearing ${runId} b${batch.seq}`, async () => {
      const deleted: string[] = [];
      const preview = `${branch}-pr`;
      if (await repo.deleteBatchBranch!(preview)) deleted.push(preview);
      delete detail.lastSubmit;
      delete detail.dryRunFingerprint;
      delete detail.dryRunUncheckedClaims;
      store.updateBatch(batchId, { detail });
      if (scope === 'batch') {
        if (await repo.deleteBatchBranch!(branch)) deleted.push(branch);
        store.unstageBatch(batch, detail);
      }
      events.emit(scope === 'batch' ? 'batch.branch_deleted' : 'batch.dry_run_cleared', `batch ${batch.seq}: ${scope === 'batch' ? 'staged branch cleared' : 'dry run cleared'}`, { runId, data: { deleted } });
      return { deleted };
    });
  }

  /**
   * Hold back the packets of one staged batch that collide with other contributors' open claims or
   * pull requests (the rule `sr submit` blocks on), and stage the rest as a new batch.
   */
  async dropCollidingPackets(runId: string, batchId: string) {
    const r = await this.dropCollisions(runId, [batchId]);
    const b = r.batches[0]!;
    return { ...b, collisions: r.collisions, staged: r.staged };
  }

  /** The same for every unsubmitted staged batch of the run, with one claims check for all of them. */
  async dropCollidingPacketsAll(runId: string) {
    return this.dropCollisions(runId, null);
  }

  /**
   * One claims check over the batches' functions; in each batch every unit with a colliding function
   * is withheld (a unit's final file carries every packet of the unit). Batches that lose packets
   * have their local branches deleted and become `superseded`; their other packets are re-verified
   * together as new batches. Withheld packets keep their local claims and go back into staging with
   * `recheckWithheld` once the claims lapse or close. Nothing is pushed; nothing changes unless every
   * function could be checked.
   */
  private async dropCollisions(runId: string, batchIds: string[] | null) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.status !== 'completed') throw new Error(`run is ${row.status}; only a completed run's batches can be changed`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish first');
    if (!repo.claimCollisions) throw new Error('this repository adapter cannot check claims');
    type Detail = Record<string, unknown> & { lastSubmit?: { dryRun: boolean; submissionStarted?: boolean }; pr?: string; link?: string };
    const unsubmitted = (b: NonNullable<ReturnType<Store['getBatch']>>) => {
      const d = (b.detail ?? {}) as Detail;
      const realAttempt = d.lastSubmit?.dryRun === false && d.lastSubmit.submissionStarted !== false;
      return b.status === 'branch_ready' && !d.pr && !d.link && !realAttempt;
    };
    const chosen = batchIds
      ? batchIds.map((id) => {
          const b = store.getBatch(id);
          if (!b || b.runId !== runId) throw new Error('batch not found');
          if (!unsubmitted(b)) throw new Error(`batch ${b.seq} is ${b.status}: only an unsubmitted staged batch can drop packets`);
          return b;
        })
      : store.listBatches(runId).filter(unsubmitted);
    if (!chosen.length) throw new Error('no unsubmitted staged batches');
    const work = chosen.map((batch) => {
      const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
      if (!tasks.length || tasks.length !== batch.taskIds.length || tasks.some((t) => t.state !== 'staged')) throw new Error(`every packet of batch ${batch.seq} must still be staged`);
      return { batch, tasks };
    });
    const label = batchIds?.length === 1 ? `checking claims for ${runId} b${chosen[0]!.seq}` : `checking claims for ${chosen.length} batches of ${runId}`;
    return this.exclusive(label, async () => {
      const allRvas = work.flatMap((w) => w.tasks.flatMap((t) => t.functions.map((f) => f.rva)));
      this.progress(`Checking ${allRvas.length} functions in ${work.length} batch(es) against GitHub's open claims and PRs`, 'sr open_items + claim_state (about half a minute)');
      const check = await repo.claimCollisions!(allRvas);
      if (!check.checked) throw new Error(`claims could not be checked, nothing changed: ${check.error ?? 'unknown error'}`);
      const at = Date.now();
      const keep: TaskRow[] = [];
      const affected: string[] = [];
      const results = [];
      for (const { batch, tasks } of work) {
        const prior = { ...(batch.detail as Detail | null) } as Detail;
        const collisions = Object.fromEntries(tasks.flatMap((t) => t.functions.filter((f) => check.collisions[f.rva]).map((f) => [f.rva, check.collisions[f.rva]!])));
        const claimCheck = { at, collisions };
        const units = new Set(tasks.filter((t) => t.functions.some((f) => collisions[f.rva])).map((t) => t.unit));
        const withheld = tasks.filter((t) => units.has(t.unit));
        const kept = tasks.filter((t) => !units.has(t.unit));
        const fnCount = withheld.reduce((n, t) => n + t.functions.length, 0);
        results.push({ seq: batch.seq, batchId: batch.id, withheldTasks: withheld.length, withheldFunctions: fnCount, keptTasks: kept.length, keptFunctions: kept.reduce((n, t) => n + t.functions.length, 0), units: [...units], deleted: [] as string[] });
        if (!withheld.length) {
          store.updateBatch(batch.id, { detail: { ...prior, claimCheck } });
          continue;
        }
        this.progress(`Withholding claimed units`, `batch ${batch.seq}: ${units.size} unit(s), ${fnCount} function(s); deleting its local branches`, results.length, work.length);
        const deleted = results.at(-1)!.deleted;
        if (repo.deleteBatchBranch && batch.branch === `decomp/${runId}-b${batch.seq}`) {
          for (const branch of [`${batch.branch}-pr`, batch.branch]) if (await repo.deleteBatchBranch(branch)) deleted.push(branch);
        }
        delete prior.dryRunFingerprint;
        delete prior.dryRunUncheckedClaims;
        store.unstageBatch(batch, { ...prior, claimCheck, withheld: { taskIds: withheld.map((t) => t.id), units: [...units] } });
        store.updateBatch(batch.id, { status: 'superseded' });
        const hold = store.db.prepare("UPDATE tasks SET state = 'withheld', updated_at = ? WHERE id = ? AND run_id = ? AND state = 'passed'");
        store.tx(() => withheld.forEach((t) => hold.run(Date.now(), t.id, runId)));
        events.emit('batch.packets_withheld', `batch ${batch.seq}: ${fnCount} function(s) in ${units.size} unit(s) withheld; other open claims or PRs name ${Object.keys(collisions).length} of them (${describeCollisions(collisions)})`, {
          runId, level: 'warn', data: { seq: batch.seq, units: [...units], collisions, deleted },
        });
        keep.push(...kept);
        affected.push(batch.id);
      }
      const clear = results.filter((r) => !r.withheldTasks).map((r) => r.seq);
      if (clear.length) events.emit('batch.claims_clear', `batch ${clear.join(', ')}: no other open claim or pull request names their functions`, { runId });
      let staged: StageSummary | null = null;
      if (keep.length) {
        staged = await stageRun(store, repo, events, runId, row.config.prBatchSize, { only: keep.map((t) => t.id), progress: this.progress });
        // The restaged packets were just checked: record that on the new batches too.
        const fresh = store.listBatches(runId).filter((b) => staged!.seqs.includes(b.seq));
        for (const b of fresh) store.updateBatch(b.id, { detail: { ...(b.detail as Record<string, unknown> | null), claimCheck: { at, collisions: {} } } });
        for (const id of affected) store.updateBatch(id, { detail: { ...(store.getBatch(id)!.detail as Record<string, unknown> | null), supersededBy: staged.seqs } });
      }
      return {
        batches: results, collisions: check.collisions, staged,
        withheldTasks: results.reduce((n, r) => n + r.withheldTasks, 0),
        withheldFunctions: results.reduce((n, r) => n + r.withheldFunctions, 0),
      };
    });
  }

  /**
   * Check the run's withheld packets against open claims again and stage every unit that no other
   * contributor's open claim or pull request names any more (claims lapse after a day without activity).
   */
  async recheckWithheld(runId: string) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.status !== 'completed') throw new Error(`run is ${row.status}; only a completed run can be staged`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish first');
    if (!repo.claimCollisions) throw new Error('this repository adapter cannot check claims');
    const tasks = store.listTasks(runId, { state: 'withheld', limit: 100_000 });
    if (!tasks.length) throw new Error('no withheld packets');
    return this.exclusive(`rechecking withheld packets of ${runId}`, async () => {
      this.progress(`Checking ${tasks.reduce((n, t) => n + t.functions.length, 0)} withheld functions against GitHub's open claims and PRs`, 'sr open_items + claim_state (about half a minute)');
      const check = await repo.claimCollisions!(tasks.flatMap((t) => t.functions.map((f) => f.rva)));
      if (!check.checked) throw new Error(`claims could not be checked, nothing changed: ${check.error ?? 'unknown error'}`);
      const at = Date.now();
      const blocked = new Set(tasks.filter((t) => t.functions.some((f) => check.collisions[f.rva])).map((t) => t.unit));
      const ready = tasks.filter((t) => !blocked.has(t.unit));
      const back = store.db.prepare("UPDATE tasks SET state = 'passed', updated_at = ? WHERE id = ? AND run_id = ? AND state = 'withheld'");
      store.tx(() => ready.forEach((t) => back.run(Date.now(), t.id, runId)));
      // Keep each superseded batch's view of its withheld packets' claims current.
      for (const b of store.listBatches(runId)) {
        const d = b.detail as (Record<string, unknown> & { withheld?: { taskIds: string[] } }) | null;
        if (!d?.withheld) continue;
        const rvas = new Set(d.withheld.taskIds.flatMap((id) => store.getTask(id)?.functions.map((f) => f.rva) ?? []));
        const collisions = Object.fromEntries(Object.entries(check.collisions).filter(([rva]) => rvas.has(rva)));
        store.updateBatch(b.id, { detail: { ...d, claimCheck: { at, collisions } } });
      }
      const still = tasks.length - ready.length;
      events.emit('run.withheld_rechecked', `withheld packets rechecked: ${ready.length} back into staging, ${still} still withheld${still ? ` (${describeCollisions(check.collisions)})` : ''}`, {
        runId, level: still ? 'warn' : 'info', data: { returned: ready.length, still, collisions: check.collisions },
      });
      const staged = ready.length ? await stageRun(store, repo, events, runId, row.config.prBatchSize, { only: ready.map((t) => t.id), progress: this.progress }) : null;
      if (staged) {
        for (const b of store.listBatches(runId).filter((x) => staged.seqs.includes(x.seq))) {
          store.updateBatch(b.id, { detail: { ...(b.detail as Record<string, unknown> | null), claimCheck: { at, collisions: {} } } });
        }
      }
      return { returnedTasks: ready.length, stillWithheldTasks: still, collisions: check.collisions, staged };
    });
  }

  /**
   * The units a batch's last dry run blamed: a blocker on a file the batch writes belongs to that
   * file's unit; one on a file the batch does not write (an upstream file the lint reaches because
   * it includes a header the batch changes) belongs to the unit whose file it includes. Claim
   * blockers are left to "Drop colliding packets".
   */
  async blockingUnits(runId: string, batchId: string) {
    const { store, repo } = this.deps;
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    const d = (batch.detail ?? {}) as { lastSubmit?: { blockers?: string[]; problems?: string[] } };
    const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
    const filesOf = new Map(tasks.map((t) => [t.id, batchContent(store, runId, [t]).files.map((f) => f.path)]));
    const owners = (path: string) => tasks.filter((t) => t.unit === path || filesOf.get(t.id)!.includes(path));
    const reasons = new Map<string, string[]>();
    const unattributed: string[] = [];
    const claims: string[] = [];
    for (const b of d.lastSubmit?.blockers ?? []) {
      if (/another open claim or pull request/i.test(b)) {
        claims.push(b);
        continue;
      }
      const path = /^([\w./-]+\.(?:cpp|cc|c|h|hpp|hh|inl|inc)):\d+:/.exec(b)?.[1];
      let hit = path ? owners(path) : [];
      if (path && !hit.length) {
        const text = (await repo.baseFile(path).catch(() => null)) ?? '';
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const includes = [...text.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)].map((m) => m[1]!.replace(/\\/g, '/'));
        const all = [...new Set([...filesOf.values()].flat())];
        const included = all.filter((f) => includes.some((inc) => posix.normalize(dir ? `${dir}/${inc}` : inc) === f || f.endsWith(`/${inc}`)));
        hit = tasks.filter((t) => filesOf.get(t.id)!.some((f) => included.includes(f)));
      }
      if (!hit.length) {
        unattributed.push(b);
        continue;
      }
      for (const u of new Set(hit.map((t) => t.unit))) reasons.set(u, [...(reasons.get(u) ?? []), b]);
    }
    // Failed re-verification names packets directly ("task_a,task_b: ...").
    for (const p of d.lastSubmit?.problems ?? []) {
      const ids = (/^([\w,]+):/.exec(p)?.[1] ?? '').split(',');
      const hit = tasks.filter((t) => ids.includes(t.id));
      if (!hit.length) unattributed.push(p);
      for (const u of new Set(hit.map((t) => t.unit))) reasons.set(u, [...(reasons.get(u) ?? []), p]);
    }
    return { units: Object.fromEntries(reasons), unattributed, claims };
  }

  /** Batches whose packets may still be changed: staged, never submitted (a dry run is fine). */
  private changeableBatches(runId: string, batchIds: string[] | null) {
    const { store } = this.deps;
    type Detail = Record<string, unknown> & { lastSubmit?: { dryRun: boolean; submissionStarted?: boolean }; pr?: string; link?: string };
    const ok = (b: NonNullable<ReturnType<Store['getBatch']>>) => {
      const d = (b.detail ?? {}) as Detail;
      const realAttempt = d.lastSubmit?.dryRun === false && d.lastSubmit.submissionStarted !== false;
      return b.status === 'branch_ready' && !d.pr && !d.link && !realAttempt;
    };
    const chosen = batchIds
      ? batchIds.map((id) => {
          const b = store.getBatch(id);
          if (!b || b.runId !== runId) throw new Error('batch not found');
          if (!ok(b)) throw new Error(`batch ${b.seq} is ${b.status}: only an unsubmitted staged batch can set packets aside`);
          return b;
        })
      : store.listBatches(runId).filter(ok);
    return chosen.map((batch) => {
      const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
      if (!tasks.length || tasks.length !== batch.taskIds.length || tasks.some((t) => t.state !== 'staged')) throw new Error(`every packet of batch ${batch.seq} must still be staged`);
      return { batch, tasks };
    });
  }

  /**
   * Hold whole units out of PRs as `set_aside` (with their reasons): each batch that loses units has
   * its local branches deleted and becomes `superseded`; all their other packets are re-verified
   * together as new batches. Call inside `exclusive`.
   */
  private async holdOutUnits(runId: string, plan: Array<{ batch: NonNullable<ReturnType<Store['getBatch']>>; tasks: TaskRow[]; reasons: Record<string, string[]> }>, why: string) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId)!;
    const keep: TaskRow[] = [];
    const affected: string[] = [];
    const results = [];
    for (const [i, { batch, tasks, reasons }] of plan.entries()) {
      const units = new Set(Object.keys(reasons));
      const held = tasks.filter((t) => units.has(t.unit));
      const kept = tasks.filter((t) => !units.has(t.unit));
      const fnCount = held.reduce((n, t) => n + t.functions.length, 0);
      const result = { seq: batch.seq, batchId: batch.id, setAsideTasks: held.length, setAsideFunctions: fnCount, keptTasks: kept.length, keptFunctions: kept.reduce((n, t) => n + t.functions.length, 0), units: reasons, deleted: [] as string[] };
      results.push(result);
      if (!held.length) continue;
      this.progress(`Setting aside units: ${why}`, `batch ${batch.seq}: ${units.size} unit(s), ${fnCount} function(s); deleting its local branches`, i, plan.length);
      if (repo.deleteBatchBranch && batch.branch === `decomp/${runId}-b${batch.seq}`) {
        for (const branch of [`${batch.branch}-pr`, batch.branch]) if (await repo.deleteBatchBranch(branch)) result.deleted.push(branch);
      }
      const prior = { ...(batch.detail as Record<string, unknown> | null) };
      delete prior.dryRunFingerprint;
      delete prior.dryRunUncheckedClaims;
      store.unstageBatch(batch, { ...prior, setAside: { at: Date.now(), why, taskIds: held.map((t) => t.id), units: [...units], reasons } });
      store.updateBatch(batch.id, { status: 'superseded' });
      const hold = store.db.prepare("UPDATE tasks SET state = 'set_aside', updated_at = ? WHERE id = ? AND run_id = ? AND state = 'passed'");
      store.tx(() => held.forEach((t) => hold.run(Date.now(), t.id, runId)));
      events.emit('batch.packets_set_aside', `batch ${batch.seq}: ${fnCount} function(s) in ${units.size} unit(s) set aside (${why}): ${[...units].join(', ')}`, {
        runId, level: 'warn', data: { seq: batch.seq, why, reasons, deleted: result.deleted },
      });
      keep.push(...kept);
      affected.push(batch.id);
    }
    const staged = keep.length ? await stageRun(store, repo, events, runId, row.config.prBatchSize, { only: keep.map((t) => t.id), progress: this.progress }) : null;
    if (staged) for (const id of affected) store.updateBatch(id, { detail: { ...(store.getBatch(id)!.detail as Record<string, unknown> | null), supersededBy: staged.seqs } });
    return {
      batches: results, staged,
      setAsideTasks: results.reduce((n, r) => n + r.setAsideTasks, 0),
      setAsideFunctions: results.reduce((n, r) => n + r.setAsideFunctions, 0),
    };
  }

  /**
   * Hold the units the batch's last dry run blamed out of PRs (`set_aside`, with the reasons), and
   * re-verify the rest as a new batch. Put them back with `putBackSetAside` once they can pass.
   */
  async setAsideBlocking(runId: string, batchId: string) {
    const { store } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.status !== 'completed') throw new Error(`run is ${row.status}; only a completed run's batches can be changed`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish first');
    const [work] = this.changeableBatches(runId, [batchId]);
    const blame = await this.blockingUnits(runId, batchId);
    if (!Object.keys(blame.units).length) {
      throw new Error(blame.claims.length && !blame.unattributed.length
        ? 'the last dry run only found other contributors\' claims: use "Drop colliding packets"'
        : `the last dry run names no unit of this batch${blame.unattributed.length ? `: ${blame.unattributed.slice(0, 3).join('; ')}` : ''}`);
    }
    return this.exclusive(`setting aside blocking units of ${runId} b${work!.batch.seq}`, async () => {
      const r = await this.holdOutUnits(runId, [{ ...work!, reasons: blame.units }], 'blocked the last dry run');
      return { ...r.batches[0]!, staged: r.staged, unattributed: blame.unattributed, claims: blame.claims.length };
    });
  }

  /**
   * Per packet, what upstream (the pinned base) already has: functions it matched (nothing to
   * submit), functions it no longer tracks, and files the batch writes that it changed since the
   * batch was built (submitting would overwrite their version). Messages lead with the unit file.
   */
  private async upstreamFindings(runId: string, batch: NonNullable<ReturnType<Store['getBatch']>>, tasks: TaskRow[]) {
    const { store, repo } = this.deps;
    const found = new Map<string, string[]>();
    if (!repo.upstreamState) return found;
    const filesOf = new Map(tasks.map((t) => [t.id, batchContent(store, runId, [t]).files.map((f) => f.path)]));
    const st = await repo.upstreamState({ rvas: tasks.flatMap((t) => t.functions.map((f) => f.rva)), files: [...new Set([...filesOf.values()].flat())], branch: batch.branch });
    if (!st.checked) return found;
    for (const t of tasks) {
      const out: string[] = [];
      const matched = t.functions.filter((f) => Object.hasOwn(st.matched, f.rva));
      if (matched.length) out.push(`${t.unit}:1: already matched upstream: ${matched.map((f) => `${f.rva}${st.matched[f.rva] ? ` (${st.matched[f.rva]})` : ''}`).join(', ')}; nothing to submit for it`);
      const untracked = t.functions.filter((f) => st.untracked.includes(f.rva));
      if (untracked.length) out.push(`${t.unit}:1: no longer tracked upstream (not in data/progress.json): ${untracked.map((f) => f.rva).join(', ')}`);
      for (const p of filesOf.get(t.id)!.filter((p) => st.changed.includes(p))) out.push(`${p}:1: upstream changed this file since the batch was built; submitting would overwrite their version`);
      if (out.length) found.set(t.id, out);
    }
    return found;
  }

  /**
   * Check every unsubmitted staged batch against upstream and set aside each unit upstream already
   * matched, no longer tracks, or changed since the batch was built; the rest is re-verified.
   */
  async setAsideUpstreamAll(runId: string) {
    const { store } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.status !== 'completed') throw new Error(`run is ${row.status}; only a completed run's batches can be changed`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish first');
    if (!this.deps.repo.upstreamState) throw new Error('this repository adapter cannot read upstream');
    const work = this.changeableBatches(runId, null);
    if (!work.length) throw new Error('no unsubmitted staged batches');
    return this.exclusive(`checking ${work.length} batch(es) of ${runId} against upstream`, async () => {
      const plan = [];
      for (const [i, w] of work.entries()) {
        this.progress('Checking batches against upstream', `batch ${w.batch.seq}: data/progress.json and the files it writes`, i, work.length);
        const found = await this.upstreamFindings(runId, w.batch, w.tasks);
        const reasons: Record<string, string[]> = {};
        for (const t of w.tasks) if (found.has(t.id)) reasons[t.unit] = [...(reasons[t.unit] ?? []), ...found.get(t.id)!];
        plan.push({ ...w, reasons });
      }
      const clear = plan.filter((p) => !Object.keys(p.reasons).length).map((p) => p.batch.seq);
      if (clear.length) this.deps.events.emit('batch.upstream_clear', `batch ${clear.join(', ')}: upstream has none of their functions and changed none of their files`, { runId });
      return { ...(await this.holdOutUnits(runId, plan.filter((p) => Object.keys(p.reasons).length), 'upstream already has it or changed it')), clear };
    });
  }

  /** Put set-aside units back (all, or these units) and re-verify them into batches. */
  async putBackSetAside(runId: string, units?: string[]) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.status !== 'completed') throw new Error(`run is ${row.status}; only a completed run can be staged`);
    const pick = units?.length ? new Set(units) : null;
    const tasks = store.listTasks(runId, { state: 'set_aside', limit: 100_000 }).filter((t) => !pick || pick.has(t.unit));
    if (!tasks.length) throw new Error('no set-aside packets');
    return this.exclusive(`putting back set-aside packets of ${runId}`, async () => {
      const back = store.db.prepare("UPDATE tasks SET state = 'passed', updated_at = ? WHERE id = ? AND run_id = ? AND state = 'set_aside'");
      store.tx(() => tasks.forEach((t) => back.run(Date.now(), t.id, runId)));
      events.emit('run.set_aside_returned', `${tasks.length} set-aside packet(s) in ${new Set(tasks.map((t) => t.unit)).size} unit(s) put back into staging`, { runId });
      const staged = await stageRun(store, repo, events, runId, row.config.prBatchSize, { only: tasks.map((t) => t.id), progress: this.progress });
      return { returnedTasks: tasks.length, staged };
    });
  }

  /** Re-verify every failed or interrupted batch's packets that are still passed, as new batches. */
  async restageFailedAll(runId: string) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.status !== 'completed') throw new Error(`run is ${row.status}; only a completed run can be staged`);
    const batches = store.listBatches(runId).filter((b) => b.status === 'failed' || b.status === 'interrupted');
    const tasks = batches.flatMap((b) => b.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t && t.state === 'passed'));
    if (!tasks.length) throw new Error('no failed batch has passed packets left');
    return this.exclusive(`re-verifying ${batches.length} failed batch(es) of ${runId}`, async () => {
      const staged = await stageRun(store, repo, events, runId, row.config.prBatchSize, { only: tasks.map((t) => t.id), progress: this.progress });
      // Every packet is now in a new batch: staged, or in a new failed batch with its current problems.
      for (const b of batches) store.updateBatch(b.id, { status: 'superseded', detail: { ...(b.detail as Record<string, unknown> | null), supersededBy: staged.seqs } });
      return staged;
    });
  }

  /**
   * When a withheld packet's blocking claim has lapsed (a day without activity), recheck the run's
   * withheld packets on its own: only while nothing else holds the slots, at most every 30 minutes.
   */
  private lastAutoRecheck = new Map<string, number>();
  nextWithheldLapse(runId: string): number | null {
    const { store } = this.deps;
    const withheld = new Set(store.listTasks(runId, { state: 'withheld', limit: 100_000 }).map((t) => t.id));
    if (!withheld.size) return null;
    let soonest: number | null = null;
    const seen = new Set<string>();
    for (const b of [...store.listBatches(runId)].reverse()) {
      const d = b.detail as { withheld?: { taskIds: string[] }; claimCheck?: { collisions?: Record<string, Array<{ updatedAt?: string | null }>> } } | null;
      for (const id of d?.withheld?.taskIds ?? []) {
        if (!withheld.has(id) || seen.has(id)) continue;
        seen.add(id);
        for (const f of store.getTask(id)?.functions ?? []) {
          const items = d?.claimCheck?.collisions?.[f.rva] ?? [];
          // A function is free once every fresh item on it has lapsed.
          const last = Math.max(...items.map((i) => Date.parse(i.updatedAt ?? '') || 0));
          if (items.length && last > 0) soonest = Math.min(soonest ?? Infinity, last + CLAIM_LAPSE_MS);
        }
      }
    }
    return soonest;
  }

  private autoRecheckWithheld() {
    if (this.exclusiveHolder || this.op || this.active.size) return;
    const { store, events } = this.deps;
    for (const r of store.listRuns().filter((x) => x.status === 'completed')) {
      const at = this.nextWithheldLapse(r.id);
      if (at === null || at > Date.now() || Date.now() - (this.lastAutoRecheck.get(r.id) ?? 0) < 30 * 60_000) continue;
      this.lastAutoRecheck.set(r.id, Date.now());
      events.emit('run.withheld_autorecheck', 'a blocking claim has lapsed: rechecking withheld packets automatically', { runId: r.id });
      void this.recheckWithheld(r.id).catch((e) => events.emit('run.withheld_autorecheck_failed', `automatic recheck failed: ${(e as Error).message}`, { runId: r.id, level: 'warn' }));
      return;
    }
  }

  /**
   * Open the pull request for one staged batch with `sr submit` (dryRun: `sr submit --dry-run`, which
   * commits and pushes nothing for the PR). Only ever on the operator's explicit request.
   */
  async submitBatch(runId: string, batchId: string, opts: { dryRun: boolean; allowUncheckedClaims?: boolean }) {
    const { store, events, repo } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (row.status !== 'completed') throw new Error(`run is ${row.status}; submit once it has completed`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish before submitting');
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    const prior = { ...(batch.detail as Record<string, unknown> | null) };
    if (batch.status === 'submitted') throw new Error(`batch ${batch.seq} is already submitted${prior?.pr ? `: ${String(prior.pr)}` : ''}`);
    if (batch.status !== 'branch_ready') throw new Error(`batch ${batch.seq} is ${batch.status}: only a re-verified batch can be submitted`);
    if (!repo.submitBatch) throw new Error('this repository adapter cannot submit pull requests');
    const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
    if (!tasks.length || tasks.length !== batch.taskIds.length || tasks.some((t) => t.state !== 'staged')) throw new Error('every packet of the batch must still be staged');
    const label = `${opts.dryRun ? 'dry-run submitting' : 'submitting'} ${runId} b${batch.seq}`;
    const dryRun = opts.dryRun ? new AbortController() : undefined;
    return this.exclusive(label, async () => {
      if (dryRun) this.dryRuns.set(batchId, dryRun);
      const startedAt = Date.now();
      // Units in a stable order; the last unit's task is the one `sr submit` runs on.
      const ordered = [...tasks].sort((a, b) => a.unit.localeCompare(b.unit));
      const lastUnit = ordered.at(-1)!.unit;
      const submitTask = [...ordered].reverse().find((t) => t.unit === lastUnit)!;
      const sequence = [...ordered.filter((t) => t !== submitTask), submitTask];
      const all = batchContent(store, runId, sequence);
      const before = sequence.filter((t) => t.unit !== lastUnit);
      const message = before.length ? batchContent(store, runId, before).message : all.message;
      const multi = sequence.length > 1;
      const others = sequence.filter((t) => t !== submitTask);
      const title = multi ? `Reconstruct ${all.fnCount} functions` : null;
      const extraBody = multi
        ? [
            '## Every function in this pull request',
            '',
            `${all.fnCount} functions in ${new Set(sequence.map((t) => t.unit)).size} unit(s), assembled by decomp-orchestrator; every packet passed the local comparator with the pinned recipe in this same tree before submission. The summary above covers ${submitTask.functions.map((f) => f.name ?? f.rva).join(', ')}; the others are:`,
            '',
            ...others.flatMap((t) => t.functions.map((f) => `- \`${f.rva}\` ${f.name ?? ''} — \`${t.unit}\`${all.finisher.get(t.id) ? ` (drafted by ${all.finisher.get(t.id)})` : ''}`)),
            ...(all.draftedBy ? ['', `Drafted by ${all.draftedBy}.`] : []),
          ].join('\n')
        : null;
      const branch = `decomp/${runId}-b${batch.seq}-pr`;
      const input: SubmitBatchInput = {
        runId, seq: batch.seq, branch, files: all.files,
        tasks: sequence.map((t) => ({ id: t.id, srTaskId: t.srTaskId, functions: t.functions, task: t })),
        message, draftedBy: all.draftedBy ?? (all.person ?? 'not stated'), title, extraBody, stagedBranch: batch.branch, dryRun: opts.dryRun, signal: dryRun?.signal,
        allowUncheckedClaims: !opts.dryRun && opts.allowUncheckedClaims === true,
      };
      // Hash the exact inputs to the rebuild, including the pinned base and accepted task versions.
      const fingerprint = createHash('sha256').update(JSON.stringify({
        base: repo.baseSha ?? null, batchId, stagedBranch: batch.branch, branch,
        files: input.files, message, draftedBy: input.draftedBy, title, extraBody,
        tasks: sequence.map((t) => [t.id, t.srTaskId, t.unit, t.functions, t.lastVerdictId]),
      })).digest('hex');
      // Server-side prerequisite: a real submission needs a dry run of exactly this batch state.
      // Any change (files, tasks, verdicts, attribution, title, pinned base) changes the fingerprint.
      if (!opts.dryRun && prior.dryRunFingerprint !== fingerprint) {
        if (prior.dryRunFingerprint !== undefined) {
          delete prior.dryRunFingerprint;
          delete prior.dryRunUncheckedClaims;
          store.updateBatch(batchId, { detail: prior });
        }
        throw new Error('Run a clean dry run for the current batch before submitting');
      }
      // A dry run whose claims probes could not all run only allows a real submission that the
      // operator explicitly accepts as unchecked (the real submission probes again either way).
      const acceptedUnchecked = (prior.dryRunUncheckedClaims as string[] | undefined) ?? [];
      if (!opts.dryRun && acceptedUnchecked.length && !input.allowUncheckedClaims) {
        throw new Error(`The last dry run could not check claims for ${acceptedUnchecked.length} task(s): run the dry run again, or explicitly accept an unchecked batch`);
      }
      // The prerequisite is spent by this attempt; only the outcomes below can grant it again.
      delete prior.dryRunFingerprint;
      delete prior.dryRunUncheckedClaims;
      store.updateBatch(batchId, { detail: prior });
      // Upstream first (seconds, no compiler): work it already has or changed is never submitted.
      this.progress(`${opts.dryRun ? 'Dry run' : 'Submission'} of batch ${batch.seq}: checking it against upstream`, 'data/progress.json and the files it writes, at the base');
      const upstream = [...(await this.upstreamFindings(runId, batch, tasks)).values()].flat();
      let result: SubmitBatchResult;
      if (upstream.length) {
        result = { ok: false, dryRun: opts.dryRun, submissionStarted: false, problems: [], blockers: upstream, warnings: [], plan: [], pullRequest: null, link: null, error: 'Upstream already has or changed part of this batch: set those units aside' };
      } else {
        this.progress(`${opts.dryRun ? 'Dry run' : 'Submission'} of batch ${batch.seq}: re-recording claims and drafters`, `sr claim for ${tasks.length} packet(s), skipped where unchanged`);
        await this.reclaim(runId, tasks, dryRun?.signal);
        result = await repo.submitBatch!({ ...input, progress: (step, detail, done, total) => this.progress(`${opts.dryRun ? 'Dry run' : 'Submission'} of batch ${batch.seq}: ${step}`, detail, done, total) });
      }
      const r = dryRun?.signal.aborted ? { ...result, ok: false, cancelled: true, problems: [], blockers: [], uncheckedClaims: [], warnings: [], plan: [], error: null } : result;
      const onlyUnchecked = !r.cancelled && !r.blockers.length && !r.problems.length && !!r.uncheckedClaims?.length && r.submissionStarted !== true;
      if (opts.dryRun && !r.cancelled && !r.blockers.length && !r.problems.length && (r.ok || onlyUnchecked)) {
        prior.dryRunFingerprint = fingerprint;
        if (onlyUnchecked) prior.dryRunUncheckedClaims = r.uncheckedClaims;
      }
      // A real submission refused only because claims could not be checked can be retried, with
      // the operator's explicit acceptance; anything else found wrong needs a new dry run.
      if (!opts.dryRun && !r.ok && onlyUnchecked) {
        prior.dryRunFingerprint = fingerprint;
        prior.dryRunUncheckedClaims = r.uncheckedClaims;
      }
      const detail = { ...prior, lastSubmit: {
        at: Date.now(), dryRun: opts.dryRun, ok: r.ok, cancelled: r.cancelled ?? false, problems: r.problems, blockers: r.blockers,
        uncheckedClaims: r.uncheckedClaims ?? [], allowUncheckedClaims: input.allowUncheckedClaims, submissionStarted: r.submissionStarted,
        compared: r.compared ?? null, reused: r.reused ?? null, durationMs: Date.now() - startedAt,
        warnings: r.warnings, plan: r.plan, error: r.error, branch,
      } };
      if (r.ok && !opts.dryRun) {
        store.updateBatch(batchId, { status: 'submitted', detail: { ...detail, pr: r.pullRequest, link: r.link, prBranch: branch, submittedAt: Date.now() } });
        events.emit('batch.submitted', `batch ${batch.seq}: ${all.fnCount} functions submitted → ${r.pullRequest ?? r.link ?? branch}`, { runId, data: { pr: r.pullRequest, link: r.link, branch, uncheckedClaims: r.uncheckedClaims ?? [], allowUncheckedClaims: input.allowUncheckedClaims } });
      } else {
        store.updateBatch(batchId, { detail });
        const why = r.problems.length ? `re-verification: ${r.problems.join('; ')}` : r.blockers.length ? `sr submit blockers: ${r.blockers.join('; ')}` : (r.error ?? '');
        events.emit(opts.dryRun ? 'batch.submit_dry_run' : 'batch.submit_failed', `batch ${batch.seq}: ${opts.dryRun ? `dry run ${r.cancelled ? 'cancelled' : r.ok ? 'clean' : 'found problems'}` : 'NOT submitted'}${why ? ` — ${why}` : ''}`, { runId, level: r.ok ? 'info' : 'warn', data: { blockers: r.blockers, problems: r.problems } });
      }
      return r;
    }).finally(() => {
      if (dryRun && this.dryRuns.get(batchId) === dryRun) this.dryRuns.delete(batchId);
    });
  }

  /** Run `fn` with exclusive use of the worktree slots (refused while a run is active). */
  async exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.active.size || this.discovering) throw new Error('a run is active; wait for it to finish before using the worktree slots');
    if (this.exclusiveHolder) throw new Error(`worktree slots are busy (${this.exclusiveHolder})`);
    this.exclusiveHolder = label;
    this.beginOperation(label);
    try {
      return await fn();
    } finally {
      this.exclusiveHolder = null;
      this.op = null;
    }
  }

  /** The operation holding the worktree slots, if any, with its current step and recent history. */
  operation(): OperationProgress | null {
    return this.op ? { ...this.op, log: this.op.log.slice(-15) } : null;
  }

  private beginOperation(label: string) {
    const now = Date.now();
    this.op = { runId: /run_[a-z0-9]+/.exec(label)?.[0] ?? null, label, startedAt: now, step: label, detail: null, done: null, total: null, stepStartedAt: now, log: [] };
  }

  /** Report progress of the current operation (a new step is also kept in its history). */
  private progress: ProgressFn = (step, detail = null, done = null, total = null) => {
    const op = this.op;
    if (!op) return;
    const now = Date.now();
    if (step !== op.step) {
      op.log.push({ at: op.stepStartedAt, step: op.step, ms: now - op.stepStartedAt });
      if (op.log.length > 60) op.log.splice(0, op.log.length - 60);
      op.step = step;
      op.stepStartedAt = now;
    }
    op.detail = detail ?? null;
    op.done = done ?? null;
    op.total = total ?? null;
  };

  isIdle() {
    return this.active.size === 0 && this.discovering === null && this.exclusiveHolder === null;
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
    return this.active.get(runId)?.finished ?? this.finishing.get(runId) ?? Promise.resolve();
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
        const parkedUntil = run.parked.get(slot);
        if (parkedUntil !== undefined) {
          if (Date.now() < parkedUntil) {
            await run.wake.wait(Math.min(5_000, parkedUntil - Date.now()), run.cancel.signal);
            continue;
          }
          try {
            await this.deps.repo.reset(slot);
            run.parked.delete(slot);
            run.parkStrikes.delete(slot);
            events.emit('slot.recovered', `slot ${slot} restored; it takes work again`, { runId, level: 'warn' });
          } catch (e) {
            this.parkSlot(run, slot, (e as Error).message);
          }
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
        let [leased] = this.queue.lease(runId, tier, 1, this.opts.leaseMs, { stealFrom: steal, worker });
        let workTier = tier;
        if (!leased && routing.helpUp) {
          // Nothing here or below: run a higher tier's ready packet in this worktree, with that
          // tier's node (models, limits). The packet keeps its tier; only the worktree is lent.
          const myCap = CAPABILITY_RANK[run.plan.tiers[tier]!.capability];
          const higher = run.plan.tiers.filter((t) => t.index !== tier && CAPABILITY_RANK[t.capability] > myCap).sort((a, b) => CAPABILITY_RANK[b.capability] - CAPABILITY_RANK[a.capability]);
          for (const up of higher) {
            [leased] = this.queue.lease(runId, up.index, 1, this.opts.leaseMs, { worker });
            if (leased) {
              workTier = up.index;
              events.emit('task.helped', `${run.plan.tiers[tier]!.node.data.label || run.plan.tiers[tier]!.node.id} is idle; its worktree runs a ${up.node.data.label || up.node.id} packet with that tier's models`, {
                runId, taskId: leased.task.id, level: 'debug', data: { slotTier: tier, tier: up.index },
              });
              break;
            }
          }
        }
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
          await this.processTask(run, workTier, slot, leased.task, leased.leaseId);
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
      // 1. fresh worktree + carry forward units accepted earlier in this run. A slot that cannot be
      // restored is the slot's fault, not the packet's: give the packet back uncharged, park the slot.
      try {
        await repo.reset(slot);
      } catch (e) {
        if (e instanceof AbortedError || signal.aborted) throw e;
        // The finally-block retries reset once; only park if that recovery attempt also fails.
        // Parking here would double-count a single fault and leave a successfully restored slot
        // unavailable until the back-off expires.
        this.infraFailure(run, task, leaseId, `slot ${slot} could not be restored`, undefined, { slotFault: true });
        return;
      }
      const carried = this.carriedFiles(runId, task.unit);
      if (carried.length) await repo.writeFiles(slot, carried);
      // The claim must name a model or the agent, never a guess: the model is chosen per attempt
      // (rotation, help-up), so until a packet passes the claim names the orchestrator, and on a
      // pass recordAttribution rewrites it with the model that finished the packet.
      const modelHint = node.data.pool.model ?? 'decomp-orchestrator';
      let prepared: PreparedTask;
      try {
        prepared = await repo.prepare(slot, task, { draftedBy: cfg.draftedBy, model: modelHint, signal });
      } catch (e) {
        if (e instanceof AbortedError || signal.aborted) throw e;
        return this.infraFailure(run, task, leaseId, `prepare failed: ${(e as Error).message}`);
      }
      if (prepared.srTaskId && !this.queue.transition(task.id, leaseId, ['leased'], 'leased', { srTaskId: prepared.srTaskId })) return;

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
      const history = buildHistory(store, task);
      const feedback = this.lastFeedback(task, history);
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
      // Model rotation: after two attempts without progress, the accounts (= models) that made them
      // go to the back of the queue, so a different model brings different ideas to the packet.
      const recent = history.filter((h) => h.accountId).slice(-2);
      const deprioritize = task.noImprovementStreak >= 2 && recent.length === 2 ? [...new Set(recent.map((h) => h.accountId!))] : [];
      const lease = await pool.acquire(
        { binding, role: 'worker', estInputTokens: estIn, estOutputTokens: Math.min(this.opts.maxOutputTokens, outputMode === 'edits' ? 3_000 : 8_000), deprioritize },
        signal,
        (ms, reason) => {
          if (!waitedEmitted && ms > 3_000) {
            waitedEmitted = true;
            ev('pool.wait', `waiting ${Number.isFinite(ms) ? Math.round(ms / 1000) + 's' : '∞'} for an account (${reason})`, 'debug');
          }
        },
      );
      store.updateAttempt(attempt.id, { accountId: lease.account.id, model: lease.model.id });
      if (deprioritize.length) {
        ev('pool.rotated', deprioritize.includes(lease.account.id)
          ? `no progress in 2 attempts, but only ${lease.account.id} could take this one`
          : `no progress in 2 attempts on ${deprioritize.join(', ')}: switched to ${lease.account.id}/${lease.model.id}`, 'info', { from: deprioritize, to: lease.account.id });
      }
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
      const untouched = await Promise.all(prepared.allowedPaths.filter((p) => !mat.files.some((f) => f.path === p)).map(async (p) => ({ path: p, current: await repo.readFile(slot, p), base: await repo.baseFile(p) })));
      const fixed = await repairAnswer(mat.files, (p) => repo.readFile(slot, p), { codeOrigin: parsed.data.codeOrigin, adaptedBodies: parsed.data.adaptedBodies }, {
        untouched, attribution: { person: personOf(cfg.draftedBy), model: lease.model.id },
      });
      mat.files = fixed.files;
      // The exact code (comments and spacing aside) already failed in the compiler: refuse it without
      // compiling and say which attempt it repeats, so the next try has to change the logic.
      const repeat = findRepeat(history, mat.files);
      if (repeat) {
        store.updateAttempt(attempt.id, { status: 'completed', files: mat.files, finishedAt: Date.now() });
        ev('attempt.repeated', `candidate repeats attempt #${repeat.n}; refused without compiling`, 'debug', { repeats: repeat.n });
        return this.route(run, task, leaseId, attempt, syntheticVerdict(task, attempt, 'REPEATED_CANDIDATE', `the code is identical to attempt #${repeat.n} (comments and spacing do not count), which already failed: ${repeat.outcome}. Change the logic.`), { infra: false, strike: false }, tierIdx);
      }
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
      this.route(run, task, leaseId, attempt, gate.verdict, { infra: gate.infra, strike: gate.strike }, tierIdx, prepared.srTaskId);
      if (gate.verdict.decision === 'pass' && prepared.srTaskId && repo.recordAttribution && store.getTask(task.id)?.lastVerdictId === gate.verdict.id) {
        const draftedBy = draftedByText(personOf(cfg.draftedBy), [lease.model.id]);
        const r = await repo.recordAttribution({ task, srTaskId: prepared.srTaskId, model: lease.model.id, draftedBy, slot }).catch((e: Error) => ({ ok: false, problems: [e.message] }));
        ev(r.ok ? 'task.attributed' : 'task.attribution_failed', r.ok ? `claim and task attributed to ${lease.model.id} (drafted by ${draftedBy})` : `could not record ${lease.model.id} as the finishing model: ${r.problems.join('; ').slice(0, 300)}`, r.ok ? 'debug' : 'warn', { model: lease.model.id });
      }
      return;
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
      await repo.reset(slot).catch((err) => {
        ev('slot.reset_failed', `slot ${slot} reset failed: ${(err as Error).message}`, 'error');
        this.parkSlot(run, slot, (err as Error).message);
      });
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

  /**
   * An infrastructure failure: retry later, or dead-letter after maxInfraFailures. The move and the
   * verdict (when there is one) are one lease-guarded transaction, like settle(). A slot fault
   * (the worktree could not be restored) does not count against the packet.
   */
  private infraFailure(run: ActiveRun, task: TaskRow, leaseId: string, msg: string, verdict?: Verdict, opts: { slotFault?: boolean } = {}) {
    const { store, events } = this.deps;
    const n = opts.slotFault ? task.infraFailures : task.infraFailures + 1;
    const runId = run.row.id;
    const dead = !opts.slotFault && n >= this.opts.maxInfraFailures;
    const moved = store.tx(() => {
      const ok = this.queue.transition(task.id, leaseId, ['leased', 'gating'], dead ? 'dead' : 'pending', dead ? { infraFailures: n } : { infraFailures: n, notBefore: Date.now() + this.opts.infraBackoffMs * Math.max(1, n) });
      if (verdict) store.insertVerdict({ ...verdict, route: ok ? (dead ? 'dead_letter' : 'retry') : 'stale' });
      return ok;
    });
    if (!moved) {
      events.emit('task.stale', `lease lost before handling an infrastructure failure: ${msg.slice(0, 200)}; task not moved`, { runId, taskId: task.id, level: 'warn' });
      return;
    }
    if (dead) events.emit('task.dead', `dead-lettered after ${n} infrastructure failures: ${msg}`, { runId, taskId: task.id, level: 'error' });
    else if (opts.slotFault) events.emit('task.infra', `${msg}; returned to the queue without counting against the packet`, { runId, taskId: task.id, level: 'warn' });
    else events.emit('task.infra', `infrastructure failure (${n}/${this.opts.maxInfraFailures}): ${msg}`, { runId, taskId: task.id, level: 'warn' });
  }

  /** Take a slot out of service until its worktree can be restored (backoff 15 s → 5 min). */
  private parkSlot(run: ActiveRun, slot: number, msg: string) {
    const strikes = (run.parkStrikes.get(slot) ?? 0) + 1;
    run.parkStrikes.set(slot, strikes);
    const wait = Math.min(300_000, this.opts.slotParkBaseMs * 2 ** (strikes - 1));
    run.parked.set(slot, Date.now() + wait);
    this.deps.events.emit('slot.parked', `slot ${slot} out of service for ${Math.round(wait / 1000)}s (${strikes} failed restore(s)): ${msg.slice(0, 300)}`, { runId: run.row.id, level: strikes === 1 ? 'warn' : 'error' });
  }

  /**
   * Persist the verdict and move the task in one transaction, guarded by the lease. When the lease
   * was lost (reclaimed after a stall, or the run was reset) the task is left alone, the verdict is
   * filed as 'stale' and the caller emits nothing: a stale worker must never record an acceptance
   * or announce one.
   */
  private settle(run: ActiveRun, task: TaskRow, leaseId: string, to: TaskState, patch: TaskPatch, verdict: Verdict, route: Route): boolean {
    const { store, events } = this.deps;
    const moved = store.tx(() => {
      const ok = this.queue.transition(task.id, leaseId, ['leased', 'gating'], to, patch);
      store.insertVerdict({ ...verdict, route: ok ? route : 'stale' });
      return ok;
    });
    if (!moved) {
      events.emit('task.stale', `lease lost before routing ${task.functions.map((f) => f.name ?? f.rva).join(', ')}: verdict (${verdict.decision}) kept as stale, task not moved`, {
        runId: run.row.id, taskId: task.id, level: 'warn', data: { decision: verdict.decision, wanted: route },
      });
    }
    return moved;
  }

  /** Final routing: persists the verdict with its effective route and moves the task. */
  private route(run: ActiveRun, task: TaskRow, leaseId: string, attempt: Attempt, verdict: Verdict, flags: { infra: boolean; strike: boolean }, tierIdx: number, srTaskId?: string | null) {
    const { store, events } = this.deps;
    const runId = run.row.id;
    const tierNode = run.plan.tiers[tierIdx]!;
    const common = { lastVerdictId: verdict.id, ...(srTaskId ? { srTaskId } : {}) };
    const fnLabel = task.functions.map((f) => f.name ?? f.rva).join(', ');

    if (flags.infra) return this.infraFailure(run, task, leaseId, verdict.findings.find((f) => f.code.startsWith('INFRA'))?.message ?? 'infra', verdict);
    this.skills.recordOutcome(attempt.id, verdict);
    const attemptsTotal = task.attemptsTotal + 1;
    const attemptsAtTier = task.attemptsAtTier + 1;
    // Progress counts bytes that align with the target, not only bytes exact in place: a candidate
    // whose first instruction is still wrong can be much closer than the last one, and resetting
    // patience on that keeps a packet that is converging from being dead-lettered.
    const prior = store.verdictsForTask(task.id).filter((v) => v.id !== verdict.id).map(progressScore).filter((s): s is number => s !== null);
    const score = progressScore(verdict);
    const improved = verdict.exactBytes > task.bestExactBytes || (score !== null && score > Math.max(task.bestExactBytes, ...prior));
    const bestExactBytes = Math.max(task.bestExactBytes, verdict.exactBytes);
    const noImprovementStreak = improved ? 0 : task.noImprovementStreak + 1;
    const cheatStrikes = task.cheatStrikes + (flags.strike ? 1 : 0);

    if (verdict.decision === 'pass') {
      if (this.settle(run, task, leaseId, 'passed', { ...common, attemptsTotal, attemptsAtTier, bestExactBytes, noImprovementStreak: 0 }, verdict, 'accept')) events.emit('task.passed', `PASS ${fnLabel} (attempt ${attempt.n}, tier ${tierIdx})`, { runId, taskId: task.id, data: { attempt: attempt.n, tier: tierIdx } });
      return;
    }
    if (verdict.decision === 'quarantine') {
      if (this.settle(run, task, leaseId, 'quarantined', { ...common, attemptsTotal, attemptsAtTier, cheatStrikes, bestExactBytes }, verdict, 'quarantine')) events.emit('task.quarantined', `QUARANTINE ${fnLabel}: ${verdict.findings.filter((f) => f.severity === 'block').map((f) => f.code).join(', ')}`, { runId, taskId: task.id, level: 'error' });
      return;
    }
    const limit = tierNode.node.data;
    const routing = run.row.config.routing;

    // Format-only rejections (header/lint/output contract with no byte evidence against the code)
    // say nothing about how hard the function is: retry on the same tier without counting toward
    // promotion or escalation — at most FORMAT_RETRIES times per packet, then normal rules apply.
    if (isFormatOnly(verdict) && store.verdictsForTask(task.id).filter((v) => v.route === 'retry' && isFormatOnly(v)).length < FORMAT_RETRIES) {
      if (this.settle(run, task, leaseId, 'pending', { ...common, attemptsTotal, bestExactBytes, cheatStrikes, notBefore: 0 }, verdict, 'retry')) events.emit('task.retry', `retry ${fnLabel} on the same tier (format only, not counted toward escalation): ${summarise(verdict)}`, { runId, taskId: task.id, level: 'debug' });
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
        const settled = this.settle(run, task, leaseId, 'pending', {
          ...common, difficulty, attemptsAtDifficulty: 0, attemptsTotal, bestExactBytes, cheatStrikes, notBefore: 0,
          ...(moved ? { tier: to, attemptsAtTier: 0, noImprovementStreak: 0 } : { attemptsAtTier, noImprovementStreak }),
        }, verdict, moved ? 'escalate' : 'retry');
        if (settled) events.emit('task.promoted', `promote ${fnLabel}: ${task.difficulty} → ${difficulty} after ${attemptsAtDifficulty} failed attempt(s)${moved ? `; → ${label(to)}` : ` (stays on ${label(tierIdx)})`}: ${summarise(verdict)}`, {
          runId, taskId: task.id, level: 'info', data: { from: task.difficulty, to: difficulty, tierFrom: tierIdx, tierTo: to },
        });
        run.wake.notify();
        return;
      }
    }

    const exhausted = attemptsAtTier >= limit.maxAttempts || noImprovementStreak >= limit.stuckAfter || !tierNode.retryLoop;
    if (!exhausted) {
      if (this.settle(run, task, leaseId, 'pending', { ...common, attemptsTotal, attemptsAtTier, attemptsAtDifficulty, bestExactBytes, noImprovementStreak, cheatStrikes, notBefore: 0 }, verdict, 'retry')) events.emit('task.retry', `retry ${fnLabel}: ${summarise(verdict)}`, { runId, taskId: task.id, level: 'debug' });
      return;
    }
    if (tierIdx + 1 < run.plan.tiers.length) {
      const next = run.plan.tiers[tierIdx + 1]!;
      // Climbing the ladder proves the packet is at least as hard as the next tier is meant for.
      const difficulty = routing.enabled ? harder(task.difficulty, CAPABILITY_DIFFICULTY[next.capability]) : task.difficulty;
      if (this.settle(run, task, leaseId, 'pending', { ...common, tier: tierIdx + 1, difficulty, attemptsAtDifficulty: difficulty === task.difficulty ? attemptsAtDifficulty : 0, attemptsTotal, attemptsAtTier: 0, bestExactBytes, noImprovementStreak: 0, cheatStrikes, notBefore: 0 }, verdict, 'escalate')) events.emit('task.escalated', `escalate ${fnLabel} → tier ${tierIdx + 1} (${label(tierIdx + 1)})`, { runId, taskId: task.id, level: 'info' });
      run.wake.notify();
      return;
    }
    if (this.settle(run, task, leaseId, 'dead', { ...common, attemptsTotal, attemptsAtTier, bestExactBytes, noImprovementStreak, cheatStrikes }, verdict, 'dead_letter')) events.emit('task.dead', `DEAD ${fnLabel} after ${attemptsTotal} attempts (best ${bestExactBytes} bytes exact)`, { runId, taskId: task.id, level: 'warn' });
  }

  private lastFeedback(task: TaskRow, history: HistoryEntry[]): Feedback | null {
    if (!task.lastVerdictId) return null;
    const verdict = this.deps.store.getVerdict(task.lastVerdictId);
    const attempt = verdict ? this.deps.store.getAttempt(verdict.attemptId) : null;
    return verdict && attempt ? { verdict, attempt, history } : null;
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
    const { store } = this.deps;
    const runId = run.row.id;
    // Staging uses the dedicated staging worktree and the claims; hold the slot lock from the
    // moment the run leaves `active` until staging is over, so no other run (or shadow evaluation,
    // or retry) can start and stage over the same worktree in between.
    const stages = !run.cancel.signal.aborted && !this.queue.hasOpenWork(runId);
    if (!stages) {
      this.active.delete(runId);
      return; // cancelled, or paused/hard-stopped with work left
    }
    this.exclusiveHolder = `finishing ${runId}`;
    this.beginOperation(`staging the finished run ${runId}`);
    const staging = this.finishStaging(run);
    this.finishing.set(runId, staging.catch(() => undefined));
    this.active.delete(runId);
    try {
      await staging;
    } finally {
      this.finishing.delete(runId);
      this.exclusiveHolder = null;
      this.op = null;
    }
    // Curation runs shadow evaluations on the slots: only once the slot lock is released.
    if (store.getRun(runId)?.status === 'completed' && run.row.config.skills.enabled && run.row.config.skills.autoCurate) queueMicrotask(() => this.afterRun?.(runId));
  }

  private async finishStaging(run: ActiveRun) {
    const { store, events } = this.deps;
    const runId = run.row.id;
    const stagingOff = run.row.config.staging === 'off';
    // Staging off: nothing will be submitted from this run, so every claim it took goes back.
    await this.releaseUnsubmitted(runId, stagingOff ? 'test run with staging off: nothing is submitted' : 'not matched in this run', stagingOff);
    try {
      if (stagingOff) events.emit('run.staging', 'staging off: nothing committed in the target repository; accepted files stay in this run\'s attempts', { runId });
      const batches = stagingOff ? { staged: 0, failed: 0, seqs: [] } : await stageRun(store, this.deps.repo, events, runId, run.row.config.prBatchSize, { progress: this.progress });
      store.setRunStatus(runId, 'completed', ['running', 'paused']);
      const fc = store.functionCounts(runId);
      const failed = batches.failed ? `, ${batches.failed} batch(es) failed re-verification (packets stay passed; stage again from the run)` : '';
      events.emit('run.completed', `completed: ${(fc.passed ?? 0) + (fc.staged ?? 0)} functions matched, ${fc.dead ?? 0} dead-lettered, ${fc.quarantined ?? 0} quarantined; ${batches.staged} PR batch(es) staged${failed}`, { runId, level: batches.failed ? 'warn' : 'info', data: { ...fc, batches } });
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
/** True when a run has a budget and its spend has reached it (the engine pauses such a run). */
export function budgetReached(row: { costUsd: number; config: { budgetUsd?: number } }): boolean {
  return row.config.budgetUsd !== undefined && row.costUsd >= row.config.budgetUsd;
}

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

/** "#606 V0id-array, #430 awarebayes": who holds the colliding claims, for events. */
function describeCollisions(collisions: Record<string, ClaimCollision[]>): string {
  const seen = new Map<string, string>();
  for (const items of Object.values(collisions)) {
    for (const i of items) seen.set(i.url, `#${/\/(\d+)$/.exec(i.url)?.[1] ?? i.url}${i.author ? ` ${i.author}` : ''}`);
  }
  const all = [...seen.values()];
  return all.length > 8 ? `${all.slice(0, 8).join(', ')} and ${all.length - 8} more` : all.join(', ');
}

/** Live state of the operation holding the worktree slots. */
export interface OperationProgress {
  runId: string | null;
  label: string;
  startedAt: number;
  step: string;
  detail: string | null;
  done: number | null;
  total: number | null;
  stepStartedAt: number;
  /** Finished steps, oldest first, with how long each took. */
  log: Array<{ at: number; step: string; ms: number }>;
}
