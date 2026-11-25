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
  CAPABILITY_RANK, DIFFICULTIES, DIFFICULTY_RANK, Flow, RunConfig, WorkerOutput, compileFlowPlan, harder, stealSources, tierFor, validateFlow,
  type Attempt, type CapabilityTier, type Difficulty, type FlowPlan, type FunctionTarget, type PoolBinding, type Route, type SkillSelection, type TaskState, type Verdict,
} from '@decomp/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { BatchFix, RunRow, Store, TaskRow } from '../db/store.js';
import { GateKeeper, type Reviewer } from '../gatekeeper/gatekeeper.js';
import { LlmReviewer, extractJson } from '../gatekeeper/review.js';
import { ComplexityClassifier } from '../intel/complexity.js';
import { extractKnowledge } from '../intel/knowledge.js';
import { NoEligibleAccountError, type AccountPool } from '../pool/scheduler.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { ProviderError, costUsd, type PromptBlock } from '../providers/types.js';
import { TaskQueue, type StealSource, type TaskPatch } from '../queue/taskQueue.js';
import type { BaseDrift, ClaimCollision, DiscoveredFunction, ProgressFn, PrStatus, RepoAdapter, PreparedTask, SubmitBatchInput, SubmitBatchResult } from '../repo/types.js';
import { EXPLAIN_SCHEMA, EXPLAIN_SYSTEM, ExplainOut, TRIAGE_SCHEMA, TRIAGE_SYSTEM, TriageOut, commentsKey, explainPrompt, reviewComments, triagePrompt, triageTargets, type Explanation, type ReviewPlan } from './review.js';
import type { EventBus } from '../telemetry/events.js';
import { AbortedError, Notifier, Semaphore, newId } from '../util/async.js';
import { ContextBuilder } from './context.js';
import { TaskContextBuilder, shouldCacheTaskPrefix } from './contextBuilder.js';
import { STRIKE_CODES, cheatScan } from '../gatekeeper/rules.js';
import { declareMembers, memberDefs } from './classDecls.js';
import { materialise, restoreAccepted } from './edits.js';
import type { Elision } from './unitView.js';
import { repairAnswer } from './headerRepair.js';
import { buildHistory, findRepeat, progressScore, type HistoryEntry } from './history.js';
import { draftedByText, personOf } from './attribution.js';
import { runPitfalls } from './lessons.js';
import { WORKER_OUTPUT_SCHEMA, WORKER_OUTPUT_SCHEMA_V2, WORKER_SYSTEM, buildWorkerPrompt, renderBundle, type Feedback } from './prompts.js';
import { removeFunctions, spliceUnit, stillDefines } from './splice.js';
import { extractFunctions, lex } from '../gatekeeper/cpp.js';
import { lostProvenance } from '../gatekeeper/provenance.js';
import { PR_BATCH_MAX, batchContent, finishingModel, freeAttemptModel, packUnits, stageRun, writerOf, type StageSummary } from './staging.js';
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
  /** How often to check whether every AI account a run's workers use is down (or back). */
  outageCheckMs: number;
  providerTimeoutMs: number;
  maxOutputTokens: number;
  idlePollMs: number;
  /** Backoff after an infra failure before the task is retried. */
  infraBackoffMs: number;
}

/** Run states whose batches the PR pipeline may work on (on the staging worktree while the run goes on). */
const PIPELINE_STATES = new Set(['completed', 'running', 'paused']);

const DEFAULTS: EngineOptions = {
  leaseMs: 120_000,
  heartbeatMs: 20_000,
  maxInfraFailures: 5,
  slotParkBaseMs: 15_000,
  maxProviderFailures: 40,
  outageCheckMs: 5_000,
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
  /** The slot-lock holder also uses the idle worker slots: no run may start until it is done. */
  private idleBorrowed = false;
  private slotWaiters: Array<() => void> = [];
  /** Runs whose ready functions are being batched while they go on. */
  private rolling = new Set<string>();
  /** What the slot-holding operation is doing right now (batch staging, dry runs, claims checks). */
  private op: OperationProgress | null = null;
  private discovering: string | null = null;
  private dryRuns = new Map<string, AbortController>();
  private editingAttribution = new Set<string>();
  /** Runs that left `active` and are still staging: waitFor() resolves only once staging is over. */
  private finishing = new Map<string, Promise<void>>();
  private reaper: NodeJS.Timeout;
  private outageWatch: ReturnType<typeof setInterval>;
  private claimWatch: NodeJS.Timeout;
  private prWatch: NodeJS.Timeout;
  private rollWatch: NodeJS.Timeout;

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
    this.prWatch = setInterval(() => void this.autoRefreshPullRequests(), 10 * 60_000).unref();
    // Ready functions that waited long enough are batched even when no verdict arrives meanwhile.
    this.rollWatch = setInterval(() => {
      for (const id of this.active.keys()) this.stageReadySoon(id);
    }, 60_000).unref();
    // Every AI account down: pause the run; one back: resume it (only runs this watcher paused).
    this.outageWatch = setInterval(() => void this.watchOutages(), this.opts.outageCheckMs).unref();
  }

  // ---------------------------------------------------------------- AI account outages

  /**
   * The accounts the run's worker tiers can use, when every one of them is down (null otherwise,
   * or when the flow resolves to no account at all: that is a configuration problem, not an outage).
   */
  workerOutage(runId: string, plan?: FlowPlan): OutageInfo | null {
    const { pool, store } = this.deps;
    const row = store.getRun(runId);
    if (!row) return null;
    const p = plan ?? this.active.get(runId)?.plan ?? compileFlowPlan(row.flow);
    const routing = row.config.routing;
    const ids = new Set<string>();
    for (const tier of p.tiers) {
      const own = tier.node.data.pool;
      const binding: PoolBinding = { ...own, capability: own.capability ?? (routing.enabled ? tier.capability : undefined) };
      for (const c of pool.resolve(binding, 'worker')) ids.add(c.slot.account.id);
    }
    if (!ids.size) return null;
    const health = pool.health([...ids]);
    if (!health.length || health.some((h) => !h.down)) return null;
    const until = health.map((h) => h.until).filter((u): u is number => u !== null);
    return { since: Date.now(), nextBackAt: until.length ? Math.min(...until) : null, accounts: health.map(({ id, status, until: u, reason }) => ({ id, status, until: u, reason })) };
  }

  /** Pause a running run because every account is down; the watcher resumes it when one is back. */
  private outagePause(runId: string, outage: OutageInfo) {
    const { store, events } = this.deps;
    const run = this.active.get(runId);
    if (!run || run.paused || run.cancel.signal.aborted || store.getRun(runId)?.status !== 'running') return;
    store.setRunJson(runId, 'outage_json', outage);
    this.pause(runId);
    const list = outage.accounts.map((a) => a.status === 'disabled' ? `${a.id} (disabled)` : `${a.id} (${a.status.replace('_', ' ')}${a.until ? ` until ${new Date(a.until).toLocaleTimeString()}` : ''})`).join(', ');
    events.emit('run.outage_paused', `paused: no AI account can work right now: ${list}. It resumes on its own as soon as one is back`, {
      runId, level: 'warn', data: { ...outage },
    });
  }

  private watchingOutages = false;

  /** Pause runs whose accounts are all down; resume the runs this watcher paused once one is back. */
  async watchOutages() {
    if (this.watchingOutages) return;
    this.watchingOutages = true;
    try {
      const { store, events } = this.deps;
      for (const [id, run] of this.active) {
        if (run.paused || run.cancel.signal.aborted) continue;
        const outage = this.workerOutage(id, run.plan);
        if (outage) this.outagePause(id, outage);
      }
      const waiting = store.db.prepare("SELECT id FROM runs WHERE status = 'paused' AND outage_json IS NOT NULL").all() as Array<{ id: string }>;
      for (const { id } of waiting) {
        const prev = store.runJson<OutageInfo>(id, 'outage_json');
        const outage = this.workerOutage(id);
        if (outage) {
          // Still down: keep the account list current for the run screen; since stays the first pause.
          store.setRunJson(id, 'outage_json', { ...outage, since: prev?.since ?? outage.since });
          continue;
        }
        const row = store.getRun(id);
        if (!row || budgetReached(row)) {
          store.setRunJson(id, 'outage_json', null);
          continue;
        }
        // Not loaded (a restart) while another run holds the slots: try again on the next check.
        if (!this.active.has(id) && (this.active.size || this.discovering || this.idleBorrowed || this.finishing.size)) continue;
        store.setRunJson(id, 'outage_json', null);
        events.emit('run.outage_resumed', 'an AI account is back: resuming', { runId: id });
        await this.resumeRun(id).catch((e) => events.emit('run.failed', `could not resume after the outage: ${(e as Error).message}`, { runId: id, level: 'error' }));
      }
    } finally {
      this.watchingOutages = false;
    }
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
    if (this.idleBorrowed || this.finishing.size) throw new Error(`worktree slots are busy (${this.exclusiveHolder ?? "a run is staging"}); start the run when it finishes`);
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
        if (row.config.skipThunks) {
          const thunks = await this.adjustorThunks(found);
          if (thunks.size) {
            found = found.filter((f) => !thunks.has(f.rva));
            events.emit('run.thunks_skipped', `left out ${thunks.size} adjustor thunk(s) (two-instruction stubs the compiler emits from a class layout; no function body compiles to one)`, {
              runId, data: { rvas: [...thunks] },
            });
          }
        }
        if (store.getRun(runId)?.status === 'cancelled') return;
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
    // The operator takes over: if every account is still down, the watcher pauses it again.
    this.deps.store.setRunJson(runId, 'outage_json', null);
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
    if (!active && (this.idleBorrowed || this.finishing.size)) return { ok: false, reason: `worktree slots are busy (${this.exclusiveHolder}); retry when they are free` };

    const plan = compileFlowPlan(row.flow);
    const fromFast = opts.from === 'fast';
    const fast = plan.tiers.findIndex((t) => t.capability === 'fast');
    if (fromFast && fast < 0) return { ok: false, reason: 'flow has no fast worker tier; add one before retrying failed tasks' };
    const dead = store.db.prepare("SELECT MAX(tier) t FROM tasks WHERE run_id = ? AND state = 'dead'").get(runId) as { t: number | null };
    const tier = fromFast ? fast : Math.min(dead.t ?? 0, plan.tiers.length - 1);
    const tierLabel = fromFast ? plan.tiers[tier]!.node.data.label || plan.tiers[tier]!.node.id : 'the tier where each packet stopped';
    await this.clearFalseQuarantines(runId);
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

  /**
   * Packets quarantined for changing an accepted function whose candidates did no such thing by the
   * rules as they are now (overloads used to be mistaken for each other): dead instead, so a retry
   * takes them. Any other strike, or one the rules still find, keeps the packet quarantined.
   */
  private async clearFalseQuarantines(runId: string) {
    const { store, repo, events } = this.deps;
    for (const t of store.listTasks(runId, { state: 'quarantined', limit: 10_000 })) {
      const struck = store.verdictsForTask(t.id).filter((v) => v.findings.some((f) => f.severity === 'block' && STRIKE_CODES.has(f.code)));
      if (!struck.length) continue;
      const carried = new Map(this.carriedFiles(runId, t.unit).map((f) => [f.path, f.content]));
      let holds = false;
      for (const v of struck) {
        const files = store.getAttempt(v.attemptId)?.files ?? [];
        const only = v.findings.every((f) => f.severity !== 'block' || !STRIKE_CODES.has(f.code) || f.code === 'CHEAT_MATCHED_BODY_MODIFIED');
        if (!only || !files.length) holds = true;
        for (const f of files) {
          const before = carried.get(f.path) ?? (await repo.baseFile(f.path));
          if (cheatScan({ path: f.path, before, after: f.content, targets: t.functions as FunctionTarget[] }).some((x) => STRIKE_CODES.has(x.code))) holds = true;
        }
      }
      if (holds) continue;
      store.db.prepare("UPDATE tasks SET state = 'dead', cheat_strikes = 0, updated_at = ? WHERE id = ? AND state = 'quarantined'").run(Date.now(), t.id);
      events.emit('task.released', `${t.functions.map((f) => f.name ?? f.rva).join(', ')}: its candidates changed no accepted function after all; out of quarantine`, { runId, taskId: t.id, level: 'warn' });
    }
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
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run can be staged`);
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    if (batch.status !== 'interrupted' && batch.status !== 'failed') throw new Error(`batch ${batch.seq} is ${batch.status}: only an interrupted or failed batch can be re-verified again`);
    const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t && t.state === 'passed');
    if (!tasks.length) throw new Error(`batch ${batch.seq} has no passed packets left`);
    return this.exclusive(`re-verifying the packets of ${batch.status} batch ${batch.seq} of ${runId}`, async () => {
      const staged = await stageRun(store, repo, events, runId, row.config.prBatchSize, { only: tasks.map((t) => t.id), progress: this.progress });
      store.updateBatch(batchId, { status: 'superseded', detail: { ...(batch.detail as Record<string, unknown> | null), supersededBy: staged.seqs } });
      return staged;
    }, { besideRun: true });
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
    clearInterval(this.prWatch);
    clearInterval(this.outageWatch);
    clearInterval(this.rollWatch);
    for (const t of this.rollTimers.values()) clearTimeout(t);
    this.rollTimers.clear();
  }

  close() {
    clearInterval(this.reaper);
    clearInterval(this.claimWatch);
    clearInterval(this.prWatch);
    clearInterval(this.outageWatch);
    clearInterval(this.rollWatch);
    for (const t of this.rollTimers.values()) clearTimeout(t);
    this.rollTimers.clear();
  }

  /**
   * Stage the run's packets that are still 'passed' (a batch failed re-verification, staging was
   * interrupted, or the run is still going), under the slot lock. While the run is going, only
   * units with no packet left to work on are batched: a later packet would rewrite their files.
   */
  async restage(runId: string): Promise<StageSummary> {
    const { store, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run can be staged`);
    if (!this.readyTasks(runId).length) throw new Error(store.listTasks(runId, { state: 'passed', limit: 1 }).length ? 'the matched packets left are in units the run is still working on' : 'no passed packets left to stage');
    return this.exclusive(`staging ${runId}`, async () => {
      const ready = this.readyTasks(runId);
      // A run with staging off gave its claims back when it finished: batching its functions for a
      // PR takes them again, under the run's current draftedBy.
      if (row.config.staging === 'off' && store.getRun(runId)?.status === 'completed') await this.reclaim(runId, ready);
      const r = await stageRun(store, this.deps.repo, events, runId, row.config.prBatchSize, { only: ready.map((t) => t.id), progress: this.progress });
      events.emit('run.restaged', `staged: ${r.staged} batch(es) staged, ${r.failed} failed`, { runId, level: r.failed ? 'warn' : 'info', data: { ...r } });
      return r;
    }, { besideRun: true });
  }

  /**
   * Matched packets that can be batched now: 'passed', in units where no packet of the run is still
   * pending, leased or being gated (once the run is over, every passed packet). Open-PR review
   * fixes are left out with `rolling` (they go to their own PR when the run finishes).
   */
  readyTasks(runId: string, opts: { rolling?: boolean } = {}): TaskRow[] {
    const { store } = this.deps;
    const open = new Set((store.db.prepare(`SELECT DISTINCT unit FROM tasks WHERE run_id = ? AND state IN ('pending','leased','gating')`).all(runId) as Array<{ unit: string }>).map((r) => r.unit));
    return store.listTasks(runId, { state: 'passed', limit: 100_000 }).filter((t) => !open.has(t.unit) && !(opts.rolling && t.fix?.check === 'review' && t.fix.prOpen));
  }

  /** Units with matched packets in a failed or interrupted batch: they wait for the run's end or Prepare all. */
  private failedBatchUnits(runId: string): Set<string> {
    const { store } = this.deps;
    const ids = store.listBatches(runId).filter((b) => b.status === 'failed' || b.status === 'interrupted').flatMap((b) => b.taskIds);
    const units = new Set<string>();
    for (const id of ids) {
      const t = store.getTask(id);
      if (t?.state === 'passed') units.add(t.unit);
    }
    return units;
  }

  /**
   * How close the run is to its next batch: matched functions ready to batch (their unit is done),
   * those of them no failed batch holds (what a rolling batch takes), matched functions still
   * waiting on packets of their unit, and the batch size. Read only; aggregate queries only.
   */
  batchingStatus(runId: string) {
    const { store } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    const units = store.readyUnits(runId);
    const failed = this.failedBatchUnits(runId);
    const passed = store.passedTotals(runId);
    const sum = (us: typeof units) => ({ functions: us.reduce((n, u) => n + u.functions, 0), packets: us.reduce((n, u) => n + u.packets, 0), units: us.length });
    const ready = sum(units);
    return {
      batchSize: row.config.prBatchSize,
      fullAt: readyThreshold(row.config.prBatchSize),
      rolling: row.config.staging !== 'off' && row.status !== 'completed',
      ready,
      fresh: sum(units.filter((u) => !failed.has(u.unit))),
      waiting: { functions: Math.max(0, passed.functions - ready.functions), packets: Math.max(0, passed.packets - ready.packets), units: Math.max(0, passed.units - ready.units) },
      batching: this.rolling.has(runId),
      // Set aside with every function matching: the preflight blocks on lines they did not write.
      held: (store.db.prepare("SELECT id FROM tasks WHERE run_id = ? AND state = 'set_aside' AND hold_json IS NOT NULL ORDER BY updated_at DESC LIMIT 500").all(runId) as Array<{ id: string }>)
        .map(({ id }) => store.getTask(id)!)
        .map((t) => ({ taskId: t.id, unit: t.unit, functions: t.functions.map((f) => ({ rva: f.rva, name: f.name ?? null })), problems: t.hold!.problems, at: t.hold!.at })),
    };
  }

  /**
   * Rolling batches: while a run is going, every time the ready functions fill a PR batch, batch
   * them at once (re-verified on the staging worktree, beside the workers), so a PR can be opened
   * before other contributors claim the same functions. Whole units only, packed densely; batches
   * under `readyThreshold` wait for more (the run's end batches whatever is left).
   * Verdicts come in bursts: checks are coalesced per run, and each is one aggregate query unless
   * the ready set changed and fills a batch.
   */
  private rollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per run: the ready set (unit:functions list) that last packed into no batch full enough. */
  private rollSeen = new Map<string, string>();

  private stageReadySoon(runId: string, delayMs = 250) {
    if (this.rollTimers.has(runId)) return;
    const t = setTimeout(() => {
      this.rollTimers.delete(runId);
      this.stageReady(runId);
    }, delayMs);
    t.unref?.();
    this.rollTimers.set(runId, t);
  }

  private stageReady(runId: string) {
    const run = this.active.get(runId);
    if (!run || run.cancel.signal.aborted || this.rolling.has(runId) || this.finishing.has(runId)) return;
    if (this.exclusiveHolder || this.discovering) return; // tried again when the slot lock is released
    const { store, repo, events } = this.deps;
    const config = store.getRun(runId)?.config ?? run.row.config;
    if (config.staging === 'off') return;
    const size = config.prBatchSize;
    const units = store.readyUnits(runId);
    const total = units.reduce((n, u) => n + u.functions, 0);
    // Waited long enough: a smaller batch now beats a full one after someone else got there first.
    const aged = this.waitedEnough(runId, total, config);
    if (total < size && !aged) return;
    const min = aged ? Math.min(config.batchMinFunctions, size) : undefined;
    const key = `${size}|${aged ? 'aged' : 'full'}|${units.map((u) => `${u.unit}:${u.functions}`).join('|')}`;
    if (this.rollSeen.get(runId) === key) return; // this exact ready set already packed into no batch
    if (!this.fullBins(runId, size, min).length) {
      this.rollSeen.set(runId, key);
      return;
    }
    this.rollSeen.delete(runId);
    this.rolling.add(runId);
    const seqs: number[] = [];
    void this.exclusive(`batching the ready functions of ${runId}`, async () => {
      let failed = 0;
      for (let bin = this.fullBins(runId, size, min)[0]; bin; bin = this.fullBins(runId, size, min)[0]) {
        if (run.cancel.signal.aborted) break;
        const s = await stageRun(store, repo, events, runId, size, { only: bin.taskIds, pack: 'dense', progress: this.progress });
        seqs.push(...s.seqs);
        failed += s.failed;
        if (!s.seqs.length) break; // nothing left to stage from that bin (its packets moved on)
      }
      if (seqs.length) {
        events.emit('run.batched_early', `${seqs.length} batch(es) of ready functions made while the run goes on (batch ${seqs.join(', ')}${aged ? `; the oldest had waited ${config.batchMaxAgeMinutes} min` : ''})${failed ? `; ${failed} failed re-verification` : ''}: they can be dry-run and submitted now`, {
          runId, level: failed ? 'warn' : 'info', data: { seqs, failed },
        });
      }
    }, { besideRun: true })
      .then(() => (seqs.length ? this.autoPrepare(runId) : undefined))
      .catch((e) => events.emit('run.batch_early_failed', `could not batch the ready functions: ${(e as Error).message}`, { runId, level: 'warn' }))
      .finally(() => {
        this.rolling.delete(runId);
        this.stageReadySoon(runId);
      });
  }

  /** At least `batchMinFunctions` are ready and the oldest of them passed `batchMaxAgeMinutes` ago. */
  private waitedEnough(runId: string, total: number, config: RunRow['config']): boolean {
    if (!config.batchMaxAgeMinutes || total < Math.min(config.batchMinFunctions, config.prBatchSize)) return false;
    const failed = this.failedBatchUnits(runId);
    const since = this.readyTasks(runId, { rolling: true }).filter((t) => !failed.has(t.unit)).map((t) => t.updatedAt);
    return since.length > 0 && Math.min(...since) <= Date.now() - config.batchMaxAgeMinutes * 60_000;
  }

  /** The batch's last dry run was clean at the current base. */
  private cleanDryRun(b: { detail: unknown }): boolean {
    const d = (b.detail ?? {}) as { dryRunFingerprint?: string; dryRunBase?: string | null; dryRunUncheckedClaims?: string[]; lastSubmit?: { ok?: boolean; dryRun?: boolean } };
    return !!d.dryRunFingerprint && d.dryRunBase === (this.deps.repo.baseSha ?? null) && !d.dryRunUncheckedClaims?.length && d.lastSubmit?.ok === true;
  }

  /**
   * "Prepare all" on its own, after batches were staged: set aside what upstream already has,
   * dry-run the rest. Submits and publishes nothing; the operator still opens each pull request.
   */
  private async autoPrepare(runId: string) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row?.config.autoPrepare || row.config.staging === 'off' || !repo.submitBatch || !PIPELINE_STATES.has(row.status)) return;
    if (!store.listBatches(runId).some((b) => b.status === 'branch_ready' && !this.cleanDryRun(b))) return;
    if (this.exclusiveHolder || this.discovering) return; // a finishing run prepares its own batches
    await this.prepareAll(runId).catch((e) => events.emit('run.prepare_failed', `could not dry-run the new batches: ${(e as Error).message}; use "Prepare all" when the slots are free`, { runId, level: 'warn' }));
  }

  /**
   * Ready units packed into batches of `size` functions; only batches full enough to stage now
   * (`min` functions, by default a nearly full batch).
   * Packets of a batch that failed re-verification wait for the run's end (or Prepare all).
   */
  private fullBins(runId: string, size: number, min = readyThreshold(size), floor = min < readyThreshold(size) ? min : size) {
    const failedUnits = this.failedBatchUnits(runId);
    const byUnit = new Map<string, TaskRow[]>();
    for (const t of this.readyTasks(runId, { rolling: true })) {
      if (failedUnits.has(t.unit)) continue;
      const list = byUnit.get(t.unit);
      if (list) list.push(t);
      else byUnit.set(t.unit, [t]);
    }
    const fnsOf = (items: TaskRow[]) => items.reduce((n, t) => n + t.functions.length, 0);
    const total = [...byUnit.values()].reduce((n, items) => n + fnsOf(items), 0);
    if (total < floor) return [];
    const bins = packUnits([...byUnit].map(([unit, items]) => ({ unit, functions: fnsOf(items), items })), size);
    return bins
      .map((items) => ({ taskIds: items.map((t) => t.id), functions: fnsOf(items) }))
      .filter((b) => b.functions >= min)
      .sort((a, b) => b.functions - a.functions);
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
  async updateRun(runId: string, patch: { name?: string; draftedBy?: string; budgetUsd?: number | null; prBatchSize?: number; staging?: 'branches' | 'off'; autoPrepare?: boolean }) {
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
    if (patch.autoPrepare !== undefined && patch.autoPrepare !== cfg.autoPrepare) {
      changes.push(`dry-run new batches ${cfg.autoPrepare ? 'automatically' : 'when asked'} → ${patch.autoPrepare ? 'automatically' : 'when asked'}`);
      cfg.autoPrepare = patch.autoPrepare;
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
      if (a.maxAttempts !== b.maxAttempts) out.push(`attempts ${a.maxAttempts} → ${b.maxAttempts}`);
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
      // A failed dry run's findings in files the batch does not write (see blockingUnits).
      const last = (batch.detail as { lastSubmit?: { ok?: boolean; blockers?: string[] } } | null)?.lastSubmit;
      let outside: string[] = [];
      if (batch.status === 'branch_ready' && last?.ok === false && last.blockers?.length) {
        const files = new Set(batchContent(store, runId, batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t)).files.map((f) => f.path));
        outside = last.blockers.filter((b) => {
          const p = findingPath(b);
          return !!p && !files.has(p) && !batch.taskIds.some((id) => store.getTask(id)?.unit === p);
        });
      }
      return { ...batch, functions, outside, dryRunState: dryRun ? (dryRun.signal.aborted ? 'cancelling' : 'running') : null };
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
    }, { besideRun: true });
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
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run's batches can be changed`);
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
    }, { besideRun: true });
  }

  /**
   * Check the run's withheld packets against open claims again and stage every unit that no other
   * contributor's open claim or pull request names any more (claims lapse after a day without activity).
   */
  async recheckWithheld(runId: string) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run can be staged`);
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
    }, { besideRun: true });
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
    const d = (batch.detail ?? {}) as { lastSubmit?: { blockers?: string[]; problems?: string[]; base?: string | null } };
    const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
    const filesOf = new Map(tasks.map((t) => [t.id, batchContent(store, runId, [t]).files.map((f) => f.path)]));
    const owners = (path: string) => tasks.filter((t) => t.unit === path || filesOf.get(t.id)!.includes(path));
    const reasons = new Map<string, string[]>();
    const unattributed: string[] = [];
    const claims: string[] = [];
    // Findings in files the batch does not write (reached because they include a header it
    // changes): the line is wrong upstream, so no change to these packets fixes it.
    const outside: string[] = [];
    // Includes of a file, from the batch's version where it writes it, else the base's.
    const content = new Map(batchContent(store, runId, tasks).files.map((f) => [f.path, f.content]));
    const includesOf = new Map<string, string[]>();
    const includes = async (path: string) => {
      if (!includesOf.has(path)) {
        const text = content.get(path) ?? (await repo.baseFile(path).catch(() => null)) ?? '';
        includesOf.set(path, [...text.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)].map((m) => m[1]!.replace(/\\/g, '/')));
      }
      return includesOf.get(path)!;
    };
    const resolves = (from: string, inc: string, to: string) => {
      const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
      return posix.normalize(dir ? `${dir}/${inc}` : inc) === to || to.endsWith(`/${posix.normalize(inc)}`);
    };
    // Whether `from` reaches `target` through its includes (a few levels, a bounded number of files).
    const reaches = async (from: string, target: string) => {
      const seen = new Set([from]);
      let frontier = [from];
      for (let depth = 0; depth < 6 && frontier.length && seen.size < 400; depth++) {
        const next: string[] = [];
        for (const f of frontier) {
          for (const inc of await includes(f)) {
            if (resolves(f, inc, target)) return true;
            const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
            const local = posix.normalize(dir ? `${dir}/${inc}` : inc);
            const root = f.match(/^([^/]+)\//)?.[1];
            for (const cand of [local, ...(root ? [`${root}/${posix.normalize(inc)}`] : [])]) {
              if (!seen.has(cand) && !cand.startsWith('..') && /\.(h|hpp|hh|inl)$/i.test(cand)) {
                seen.add(cand);
                next.push(cand);
              }
            }
          }
        }
        frontier = next;
      }
      return false;
    };
    for (const b of d.lastSubmit?.blockers ?? []) {
      if (/another open claim or pull request/i.test(b)) {
        claims.push(b);
        continue;
      }
      const path = findingPath(b);
      let hit = path ? owners(path) : [];
      if (path && !hit.length) {
        outside.push(b);
        // The file includes a header the batch changes, or a file the batch writes includes it
        // (directly or through other headers) and the screen followed that include.
        const all = [...new Set([...filesOf.values()].flat())];
        const own = await includes(path);
        const included = all.filter((f) => own.some((inc) => resolves(path, inc, f)));
        const reaching: string[] = [];
        if (!included.length) for (const f of all) if (await reaches(f, path)) reaching.push(f);
        hit = tasks.filter((t) => filesOf.get(t.id)!.some((f) => included.includes(f) || reaching.includes(f)));
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
    // Upstream may have changed (fixed) a file the batch does not write after the base the dry run
    // checked (recorded on newer dry runs; else the staged branch's base): then the finding is
    // stale, and setting packets aside would hold back work for nothing.
    const outsideFiles = [...new Set(outside.map((b) => findingPath(b)!))];
    let since = d.lastSubmit?.base ?? null;
    if (!since && outsideFiles.length && repo.upstreamState) since = (await repo.upstreamState({ rvas: [], files: [], branch: batch.branch }).catch(() => null))?.builtOn ?? null;
    const drift = outsideFiles.length && repo.baseDrift ? await repo.baseDrift(outsideFiles, since).catch(() => null) : null;
    const fixedUpstream = drift?.changed.length ? outside.filter((b) => drift.changed.includes(findingPath(b)!)) : [];
    return { units: Object.fromEntries(reasons), unattributed, claims, outside, fixedUpstream, drift: fixedUpstream.length ? drift : null };
  }

  /** Why a batch's dry-run findings are stale: upstream changed those files after the base the dry run checked. */
  private staleBaseMessage(blame: { fixedUpstream: string[]; drift: BaseDrift | null }) {
    const drift = blame.drift;
    if (!drift || !blame.fixedUpstream.length) return null;
    const files = [...new Set(blame.fixedUpstream.map((b) => findingPath(b)!))];
    const atPin = files.every((f) => drift.changedAtPin.includes(f));
    return `upstream changed ${files.join(', ')} after the base the last dry run checked (${drift.since.slice(0, 10)}; upstream is ${drift.behind} commit(s) ahead of it), so the finding may already be fixed. Nothing in this batch needs setting aside for it: ${atPin ? 'the server already works on that newer base, so run the dry run again' : 'restart the server (it pins the current upstream when it starts) and run the dry run again'}`;
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
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run's batches can be changed`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish first');
    const [work] = this.changeableBatches(runId, [batchId]);
    const blame = await this.blockingUnits(runId, batchId);
    // Every blocker in a file upstream changed since the pin: a restart, not a set-aside.
    const stale = this.staleBaseMessage(blame);
    const live = (d: string[] | undefined) => (d ?? []).filter((b) => !blame.fixedUpstream.includes(b));
    for (const u of Object.keys(blame.units)) {
      const rs = live(blame.units[u]);
      if (rs.length) blame.units[u] = rs;
      else delete blame.units[u];
    }
    if (stale && !Object.keys(blame.units).length) throw new Error(stale);
    if (!Object.keys(blame.units).length) {
      throw new Error(blame.claims.length && !blame.unattributed.length
        ? 'the last dry run only found other contributors\' claims: use "Drop colliding packets"'
        : `the last dry run names no unit of this batch${blame.unattributed.length ? `: ${blame.unattributed.slice(0, 3).join('; ')}` : ''}`);
    }
    return this.exclusive(`setting aside blocking units of ${runId} b${work!.batch.seq}`, async () => {
      const r = await this.holdOutUnits(runId, [{ ...work!, reasons: blame.units }], 'blocked the last dry run');
      return { ...r.batches[0]!, staged: r.staged, unattributed: blame.unattributed, claims: blame.claims.length };
    }, { besideRun: true });
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
      for (const f of t.functions) {
        const at = st.marked?.[f.rva] ?? [];
        const other = at.find((m) => m.unit !== t.unit);
        const renamed = at.find((m) => m.unit === t.unit && m.name && f.name && m.name !== f.name);
        if (other) out.push(`${t.unit}:1: ${f.rva} already has a unit upstream (${other.unit}); a second one is refused as a duplicate`);
        else if (renamed) out.push(`${t.unit}:1: ${f.rva} is already in this unit upstream as ${renamed.name}; a second definition is refused`);
      }
      for (const x of batchContent(store, runId, [t]).files) {
        const base = await repo.baseFile(x.path);
        const lost = base === null ? [] : lostProvenance(base, x.content);
        if (lost.length) out.push(`${x.path}:1: the header drops ${lost.length} statement(s) upstream's file makes (${lost.slice(0, 2).map((l) => l[0]!.slice(0, 80)).join(' | ')}); rebuild it on upstream's current file`);
      }
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
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run's batches can be changed`);
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
    }, { besideRun: true });
  }

  /**
   * Rebuild set-aside units on upstream: a unit set aside because upstream has since matched (or
   * stopped publishing) some of its functions still holds functions nobody else has, but a pull
   * request sends whole files. Each set-aside packet of those units is narrowed to the functions
   * still worth sending and goes back to the queue as a 'rebuild' fix: its first attempt splices
   * its accepted definitions into upstream's current file, with no model call, and the Gate Keeper
   * checks that; a packet the splice does not get through goes on to the workers from there.
   * Units given by name are rebuilt even when nothing in them was dropped. A function that already
   * has a unit upstream is dropped too: a second one is refused as a duplicate.
   * `free`: only the splice; a packet it does not get through is set aside again, as it was.
   */
  async rebuildOnUpstream(runId: string, units?: string[], opts: { free?: boolean } = {}) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run can be rebuilt`);
    if (!repo.upstreamState) throw new Error('this repository adapter cannot read upstream');
    if (budgetReached(row)) throw new Error(`run budget ${row.config.budgetUsd} reached (${row.costUsd.toFixed(2)} spent): raise it first`);
    const pick = units?.length ? new Set(units) : null;
    const tasks = store.listTasks(runId, { state: 'set_aside', limit: 100_000 }).filter((t) => !pick || pick.has(t.unit));
    if (!tasks.length) throw new Error('no set-aside packets');
    const st = await repo.upstreamState({ rvas: tasks.flatMap((t) => t.functions.map((f) => f.rva)), files: [], branch: null });
    if (!st.checked) throw new Error('upstream data/progress.json could not be read');
    const why = (rva: string, unit: string, name: string | null | undefined) => {
      if (Object.hasOwn(st.matched, rva)) return `matched upstream${st.matched[rva] ? ` (${st.matched[rva]})` : ''}`;
      if (st.untracked.includes(rva)) return 'no longer published upstream';
      const at = st.marked?.[rva] ?? [];
      const other = at.find((m) => m.unit !== unit);
      if (other) return `already in ${other.unit} upstream`;
      const renamed = at.find((m) => m.unit === unit && m.name && name && m.name !== name);
      return renamed ? `already in this unit upstream as ${renamed.name}` : null;
    };
    const byUnit = new Map<string, TaskRow[]>();
    for (const t of tasks) byUnit.set(t.unit, [...(byUnit.get(t.unit) ?? []), t]);
    const plan: Array<{ task: TaskRow; keep: FunctionTarget[]; dropped: NonNullable<BatchFix['dropped']> }> = [];
    let unitsDone = 0;
    for (const [unit, ts] of byUnit) {
      const dropsAny = ts.some((t) => t.functions.some((f) => why(f.rva, unit, f.name)));
      if (!dropsAny && !pick?.has(unit)) continue;
      let any = false;
      for (const t of ts) {
        const keep = t.functions.filter((f) => !why(f.rva, unit, f.name));
        if (!keep.length) continue;
        plan.push({ task: t, keep, dropped: t.functions.flatMap((f) => { const w = why(f.rva, unit, f.name); return w ? [{ rva: f.rva, name: f.name ?? null, why: w }] : []; }) });
        any = true;
      }
      if (any) unitsDone++;
    }
    if (!plan.length) throw new Error('none of these set-aside units has a function left that upstream still needs');
    const at = Date.now();
    let requeued = 0;
    const functions = plan.reduce((n, p) => n + p.keep.length, 0);
    await this.exclusive(`rebuilding ${unitsDone} set-aside unit(s) of ${runId} on upstream`, async () => {
      for (const p of plan) {
        const fix: BatchFix = {
          batchId: '', seq: 0, check: 'rebuild', at, verdictId: p.task.lastVerdictId, dropped: p.dropped,
          ...(opts.free ? { freeOnly: true } : {}),
          reasons: [`rebuild on upstream's current ${p.task.unit}${p.dropped.length ? `; left out: ${p.dropped.map((d) => `${d.rva} (${d.why})`).join(', ')}` : ''}`],
        };
        store.tx(() => {
          if (store.requeueForFix(runId, p.task.id, fix, ['set_aside'])) {
            if (p.keep.length !== p.task.functions.length) store.setTaskFunctions(p.task.id, p.keep);
            requeued++;
          }
        });
      }
      if (requeued) store.setRunStatus(runId, 'running', ['completed']);
      events.emit('run.rebuild_on_upstream', `${functions} function(s) in ${requeued} packet(s) of ${unitsDone} set-aside unit(s) go back to be rebuilt on upstream's current files (first try: a splice, no model call)`, {
        runId, level: 'warn', data: { units: unitsDone, packets: requeued, functions, dropped: plan.reduce((n, p) => n + p.dropped.length, 0) },
      });
    }, { besideRun: true });
    if (requeued) await this.wakeOrStart(runId);
    return { units: unitsDone, packets: requeued, functions, dropped: plan.flatMap((p) => p.dropped), status: store.getRun(runId)?.status ?? 'running' };
  }

  /**
   * Dead or quarantined packets whose own functions all matched in some candidate that only
   * compare results for functions outside the packet blocked (`sr start` keeps one task per class,
   * so its compare also checked dead packets' functions and dropped ones; see GateInput.compared).
   * Each goes back to the queue as a 'regate' fix: its first attempt submits that candidate again,
   * with no model call, to the Gate Keeper, which now counts only the packet's own results.
   */
  async regateMatched(runId: string, opts: { partial?: boolean; preview?: boolean } = {}) {
    const { store, events, repo } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run can re-gate packets`);
    const plan: Array<{ task: TaskRow; verdictId: string }> = [];
    const waiting = store.listTasks(runId, { state: 'pending', limit: 100_000 }).filter((t) => t.fix?.check === 'regate'
      || (!t.fix && store.verdictsForTask(t.id).some((v) => v.findings.some((f) => f.code.startsWith('INFRA')) && this.matchedButBlocked(t, v))));
    for (const t of [...store.listTasks(runId, { state: 'dead', limit: 100_000 }), ...store.listTasks(runId, { state: 'quarantined', limit: 100_000 }), ...waiting]) {
      const found = store.verdictsForTask(t.id).find((v) => this.matchedButBlocked(t, v) && store.getAttempt(v.attemptId)?.files?.length);
      if (found) plan.push({ task: t, verdictId: found.id });
    }
    const partial = opts.partial ? this.partialPlan(runId, new Set(plan.map((p) => p.task.id))) : [];
    if (!plan.length && !partial.length) return { packets: 0, functions: 0, status: row.status };
    // Upstream may have matched (or stopped publishing) some of these functions since: `sr claim`
    // refuses those, so such a packet keeps only the rest and is rebuilt from that candidate on
    // upstream's current file instead; a packet with nothing left stays where it is.
    const st = this.deps.repo.upstreamState
      ? await this.deps.repo.upstreamState({ rvas: [...plan, ...partial].flatMap((p) => p.task.functions.map((f) => f.rva)), files: [], branch: null })
      : null;
    const now = new Map<string, string>();
    for (const p of [...plan, ...partial]) {
      const r = await repo.takenUpstream?.(p.task.functions.map((f) => f.rva), p.task.unit).catch(() => null);
      for (const [rva, w] of Object.entries(r?.checked ? r.taken : {})) now.set(rva, w);
    }
    const why = (rva: string) => now.get(rva) ?? (!st?.checked ? null : Object.hasOwn(st.matched, rva) ? `matched upstream${st.matched[rva] ? ` (${st.matched[rva]})` : ''}` : st.untracked.includes(rva) ? 'no longer published upstream' : null);
    const at = Date.now();
    let requeued = 0;
    let functions = 0;
    let rebuilt = 0;
    const salvage = partial
      .map((p) => {
        const matched = p.matched.filter((f) => !why(f.rva));
        return { ...p, matched, rest: p.task.functions.filter((f) => !matched.some((m) => m.rva === f.rva)) };
      })
      .filter((p) => p.matched.length);
    if (opts.preview) {
      const whole = plan.map((p) => p.task.functions.filter((f) => !why(f.rva))).filter((k) => k.length);
      return {
        preview: true, packets: whole.length + salvage.length, functions: whole.flat().length + salvage.flatMap((p) => p.matched).length,
        bytes: [...whole.flat(), ...salvage.flatMap((p) => p.matched)].reduce((n, f) => n + f.size, 0),
        partial: salvage.map((p) => ({ taskId: p.task.id, unit: p.task.unit, matched: p.matched.map((f) => f.rva) })),
        takenUpstream: [...new Set(partial.flatMap((p) => p.matched.filter((f) => why(f.rva)).map((f) => f.rva)))].length, status: row.status,
      };
    }
    await this.exclusive(`re-gating ${plan.length + salvage.length} matched packet(s) of ${runId}`, async () => {
      for (const p of salvage) {
        // Rest holds what does not match and what upstream took; neither is submitted.
        if (!store.tx(() => store.getTask(p.task.id)?.state === 'dead' && this.splitOff(p.task, newId('task'), p.matched, p.rest, p.verdictId, { freeOnly: true }))) continue;
        requeued++;
        functions += p.matched.length;
      }
      for (const p of plan) {
        const keep = p.task.functions.filter((f) => !why(f.rva));
        if (!keep.length) continue;
        const dropped = p.task.functions.filter((f) => why(f.rva)).map((f) => ({ rva: f.rva, name: f.name ?? null, why: why(f.rva)! }));
        const fix: BatchFix = dropped.length
          ? {
            batchId: '', seq: 0, check: 'rebuild', at, verdictId: p.verdictId, dropped,
            reasons: [`its functions all matched in an earlier candidate that only results for functions outside the packet blocked; rebuilt from it on upstream's current ${p.task.unit}; left out: ${dropped.map((d) => `${d.rva} (${d.why})`).join(', ')}`],
          }
          : {
            batchId: '', seq: 0, check: 'regate', at, verdictId: p.verdictId,
            reasons: [`its functions all matched in an earlier candidate that only results for functions outside the packet blocked; that candidate goes to the Gate Keeper again`],
          };
        // A salvage pass (`partial`) makes free attempts only, for packets that matched whole too.
        if (opts.partial) fix.freeOnly = true;
        store.tx(() => {
          if (store.requeueForFix(runId, p.task.id, fix, ['dead', 'quarantined', 'pending'])) {
            store.db.prepare('UPDATE tasks SET last_verdict_id = ? WHERE id = ?').run(p.verdictId, p.task.id);
            if (dropped.length) {
              store.setTaskFunctions(p.task.id, keep);
              rebuilt++;
            }
            requeued++;
            functions += keep.length;
          }
        });
      }
      if (requeued) store.setRunStatus(runId, 'running', ['completed']);
      events.emit('run.regate_matched', `${functions} function(s) in ${requeued} dead or quarantined packet(s) matched in a candidate only other functions' results blocked: re-gating those candidates (no model call)${rebuilt ? `; ${rebuilt} of them rebuilt on upstream's current file without the functions upstream matched or dropped since` : ''}`, {
        runId, level: 'warn', data: { packets: requeued, functions, rebuilt },
      });
    }, { besideRun: true });
    if (requeued) await this.wakeOrStart(runId);
    return { packets: requeued, functions, rebuilt, status: store.getRun(runId)?.status ?? "running" };
  }

  /** Every function of the packet matched; only results for other functions, or checks that could not be run, block it. */
  private matchedButBlocked(task: TaskRow, v: Verdict): boolean {
    const key = (rva: string) => Number.parseInt(rva, 16);
    const own = new Set(task.functions.map((f) => key(f.rva)));
    const mine = (v.compare ?? []).filter((c) => own.has(key(c.rva)));
    if (mine.length !== own.size || !mine.every((c) => c.result === 'pass')) return false;
    return v.findings.filter((f) => f.severity === 'block').every((f) => f.code.startsWith('INFRA')
      || (f.code.startsWith('COMPARE_') && f.code !== 'COMPARE_COMPILE_ERROR' && /^0x[0-9a-f]+\b/i.test(f.message) && !own.has(key(f.message.split(/\s/)[0]!))));
  }

  /** Dead packets some of whose functions matched in a candidate only the others' compare results blocked: the best such candidate. */
  private partialPlan(runId: string, skip: Set<string>) {
    const { store } = this.deps;
    const out: Array<{ task: TaskRow; verdictId: string; matched: FunctionTarget[] }> = [];
    for (const task of store.listTasks(runId, { state: 'dead', limit: 100_000 })) {
      if (skip.has(task.id) || task.functions.length < 2) continue;
      let best: { verdictId: string; matched: FunctionTarget[]; bytes: number } | null = null;
      for (const v of store.verdictsForTask(task.id)) {
        const m = matchedSides(task, v)?.matched;
        const bytes = m?.reduce((n, f) => n + f.size, 0) ?? 0;
        if (m && bytes > (best?.bytes ?? 0) && store.getAttempt(v.attemptId)?.files?.length) best = { verdictId: v.id, matched: m, bytes };
      }
      if (best) out.push({ task, verdictId: best.verdictId, matched: best.matched });
    }
    return out;
  }

  /**
   * The candidate a 'regate' fix submits again, as the free attempt's answer, while it still keeps
   * every function body upstream's current unit has. Upstream moved on since (it matched more of
   * the unit): the old file would take those bodies out, so the packet's functions are spliced into
   * upstream's current file instead.
   */
  private async storedCandidate(task: TaskRow, slot: number) {
    const { store, repo } = this.deps;
    const v = task.fix?.verdictId ? store.getVerdict(task.fix.verdictId) : null;
    const a = v ? store.getAttempt(v.attemptId) : null;
    if (!a?.files?.length) return null;
    const mine = new Set(task.functions.map((f) => (f.name ?? '').split('::').pop()));
    // What the unit holds now: accepted by other packets of this run, else upstream's file.
    const up = this.carriedFiles(task.runId, task.unit).find((f) => f.path === task.unit)?.content ?? (await repo.baseFile(task.unit)) ?? '';
    const without = (task.fix?.without ?? []).map((f) => ({ rva: f.rva, name: f.name, size: 0 }));
    const files = without.length ? a.files.map((f) => (f.path === task.unit ? { ...f, content: removeFunctions(f.content, without) } : f)) : a.files;
    const ours = extractFunctions(lex(files.find((f) => f.path === task.unit)?.content ?? '').code);
    const lost = extractFunctions(lex(up).code)
      .filter((d) => !mine.has(d.name.split('::').pop()))
      .filter((d) => !ours.some((o) => o.name === d.name && o.body === d.body));
    if (lost.length) {
      const s = await this.spliceForRebuild(task, slot);
      if (s) return { ...s, notes: [`the unit's current file has ${lost.length} body(ies) the stored candidate lacks (${lost.slice(0, 4).map((d) => d.name).join(', ')}): spliced into it instead`, ...s.notes] };
    }
    return { files, notes: [`attempt #${a.n} (${a.model ?? 'unknown model'}) again${without.length ? ` without ${without.map((f) => f.name ?? f.rva).join(', ')}` : ''}`], model: writerOf(store, task, v!.id) ?? undefined, codeOrigin: undefined as string | undefined, adaptedBodies: undefined as string | undefined };
  }

  /** Upstream's unit files (as the slot has them) with the packet's accepted functions spliced in. */
  private async spliceForRebuild(task: TaskRow, slot: number) {
    const { store, repo } = this.deps;
    const v = task.fix?.verdictId ? store.getVerdict(task.fix.verdictId) : null;
    const a = v ? store.getAttempt(v.attemptId) : null;
    if (!a?.files?.length) return null;
    const h = task.unit.replace(/.cpp$/, '.h');
    const ours = new Map(a.files.map((f) => [f.path, f.content]));
    const upstream = new Map<string, string | null>([[task.unit, await repo.readFile(slot, task.unit)], [h, await repo.readFile(slot, h)]]);
    const drop = [...(task.fix?.dropped ?? []), ...(task.fix?.without ?? [])].map((d) => ({ rva: d.rva, name: d.name, size: 0 }));
    const r = spliceUnit({ cpp: task.unit, ours, upstream, keep: task.functions as FunctionTarget[], drop });
    // The origin statements the accepted attempt made: `sr start` adds a placeholder for the carried
    // functions, and the header repair fills it from these, as it does from a worker's reply.
    const statement = (key: string) => (ours.get(task.unit) ?? '').split('\n')
      .map((l) => new RegExp(`^\\s*//\\s*${key}:\\s*(.+)$`, 'i').exec(l)?.[1]?.trim())
      .find((x): x is string => !!x && !/SKELETON_TODO|<fill/i.test(x));
    const codeOrigin = statement('Code origin');
    // No statement at all: the accepted attempt adapted nothing (it passed the origin check without
    // naming an adapted body), so "none", which leaves upstream's own statement as it is.
    const adaptedBodies = statement('Adapted bodies') ?? statement('Adapted code') ?? 'none';
    return {
      ...r, model: writerOf(store, task, v!.id),
      codeOrigin: codeOrigin && codeOrigin.length >= 8 ? codeOrigin.slice(0, 300) : undefined,
      adaptedBodies: adaptedBodies && adaptedBodies.length >= 4 ? adaptedBodies.slice(0, 300) : undefined,
    };
  }

  /** Put set-aside units back (all, or these units) and re-verify them into batches. */
  async putBackSetAside(runId: string, units?: string[]) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run can be staged`);
    const pick = units?.length ? new Set(units) : null;
    const tasks = store.listTasks(runId, { state: 'set_aside', limit: 100_000 }).filter((t) => !pick || pick.has(t.unit));
    if (!tasks.length) throw new Error('no set-aside packets');
    return this.exclusive(`putting back set-aside packets of ${runId}`, async () => {
      const back = store.db.prepare("UPDATE tasks SET state = 'passed', hold_json = NULL, updated_at = ? WHERE id = ? AND run_id = ? AND state = 'set_aside'");
      store.tx(() => tasks.forEach((t) => back.run(Date.now(), t.id, runId)));
      events.emit('run.set_aside_returned', `${tasks.length} set-aside packet(s) in ${new Set(tasks.map((t) => t.unit)).size} unit(s) put back into staging`, { runId });
      const staged = await stageRun(store, repo, events, runId, row.config.prBatchSize, { only: tasks.map((t) => t.id), progress: this.progress });
      return { returnedTasks: tasks.length, staged };
    }, { besideRun: true });
  }

  /** Re-verify every failed or interrupted batch's packets that are still passed, as new batches. */
  async restageFailedAll(runId: string) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run can be staged`);
    const batches = store.listBatches(runId).filter((b) => b.status === 'failed' || b.status === 'interrupted');
    const tasks = batches.flatMap((b) => b.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t && t.state === 'passed'));
    if (!tasks.length) throw new Error('no failed batch has passed packets left');
    return this.exclusive(`re-verifying ${batches.length} failed batch(es) of ${runId}`, async () => {
      const staged = await stageRun(store, repo, events, runId, row.config.prBatchSize, { only: tasks.map((t) => t.id), progress: this.progress });
      // Every packet is now in a new batch: staged, or in a new failed batch with its current problems.
      for (const b of batches) store.updateBatch(b.id, { status: 'superseded', detail: { ...(b.detail as Record<string, unknown> | null), supersededBy: staged.seqs } });
      return staged;
    }, { besideRun: true });
  }

  /**
   * What fixing a batch with the AI agents would send back to the workers. A batch that failed
   * re-verification: the packets its combined tree no longer matched, with the comparator's lines. A
   * staged batch whose dry run failed: the packets of the units the dry run blamed, with its lines.
   * Other contributors' claims and upstream findings are not code problems, so they are left out.
   */
  async fixPlan(runId: string, batchId: string): Promise<{ check: BatchFix['check']; targets: Array<{ task: TaskRow; reasons: string[] }>; why: string | null }> {
    const { store } = this.deps;
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    const named = (p: string) => (/^(task_[\w,]+):/.exec(p)?.[1] ?? '').split(',').filter(Boolean);
    if (batch.status === 'failed') {
      const d = (batch.detail ?? {}) as { problems?: string[]; failedTaskIds?: string[] };
      const problems = d.problems ?? [];
      const ids = new Set(d.failedTaskIds?.length ? d.failedTaskIds : problems.flatMap(named));
      const passed = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t && t.state === 'passed');
      const targets = passed.filter((t) => ids.has(t.id)).map((task) => {
        const own = problems.filter((p) => named(p).includes(task.id));
        return { task, reasons: own.length ? own : problems };
      });
      return { check: 're-verify', targets, why: targets.length ? null : 'its re-verification names no packet that is still matched (a git or tooling problem, not the code): re-verify it again instead' };
    }
    if (batch.status !== 'branch_ready') return { check: 're-verify', targets: [], why: `it is ${batch.status}` };
    const [work] = this.changeableBatches(runId, [batchId]);
    const last = (batch.detail as { lastSubmit?: { ok?: boolean; dryRun?: boolean } } | null)?.lastSubmit;
    if (!last || last.ok !== false) return { check: 'dry-run', targets: [], why: 'its last dry run did not fail' };
    const blame = await this.blockingUnits(runId, batchId);
    // Only findings in files these packets write go to the agents: one in a file the batch does
    // not write cannot be fixed by them (they would match again unchanged and fail the same way).
    const notOurs = new Set(blame.outside);
    const units = new Map(Object.entries(blame.units).map(([u, rs]) => [u, rs.filter((r) => !/upstream/i.test(r) && !notOurs.has(r))] as const).filter(([, rs]) => rs.length));
    const targets = work!.tasks.filter((t) => units.has(t.unit)).map((task) => ({ task, reasons: units.get(task.unit)! }));
    const outsideFiles = [...new Set(blame.outside.map((b) => findingPath(b)!))];
    const stale = this.staleBaseMessage(blame);
    const why = targets.length ? null
      : stale && blame.fixedUpstream.length === blame.outside.length ? stale
      : outsideFiles.length ? `the dry run blames ${outsideFiles.join(', ')}, which this batch does not write: ${outsideFiles.length === 1 ? 'it includes' : 'they include'} a header the batch changes, and the line is wrong upstream. No change to these packets fixes that: set aside the units that change the header (they come back once upstream fixes the file)`
      : Object.keys(blame.units).length ? 'upstream already has or changed what the dry run blamed: set those units aside'
      : blame.claims.length ? 'only other contributors\' claims block it, and no code change fixes that'
      : `the dry run names no unit of this batch${blame.unattributed.length ? `: ${blame.unattributed[0]!.slice(0, 200)}` : ''}`;
    return { check: 'dry-run', targets, why };
  }

  /**
   * Fix a batch that failed a check with the run's AI workers: its failing packets go back to the
   * worker queue at the tier that matched them, with what the check reported, and the run runs again
   * through its own flow (workers, Gate Keeper, escalation). The batch is superseded; its other
   * packets stay matched and, with the fixed ones, are batched and re-verified when the run finishes.
   */
  async fixBatchWithAgents(runId: string, batchId: string) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run's batches can be fixed`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish first');
    if (budgetReached(row)) throw new Error(`run budget $${row.config.budgetUsd} reached ($${row.costUsd.toFixed(2)} spent): raise it before fixing with the agents`);
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    const plan = await this.fixPlan(runId, batchId);
    if (!plan.targets.length) throw new Error(`batch ${batch.seq} has nothing the agents can fix: ${plan.why}`);
    const fns = plan.targets.reduce((n, t) => n + t.task.functions.length, 0);
    const r = await this.exclusive(`sending batch ${batch.seq} of ${runId} to the AI agents`, async () => {
      const b = store.getBatch(batchId)!;
      const at = Date.now();
      const prior = { ...(b.detail as Record<string, unknown> | null) };
      delete prior.dryRunFingerprint;
      delete prior.dryRunUncheckedClaims;
      const fixed = { at, check: plan.check, taskIds: plan.targets.map((t) => t.task.id), functions: fns, reasons: Object.fromEntries(plan.targets.map((t) => [t.task.id, t.reasons])) };
      if (b.status === 'branch_ready') {
        if (repo.deleteBatchBranch && b.branch === `decomp/${runId}-b${b.seq}`) for (const branch of [`${b.branch}-pr`, b.branch]) await repo.deleteBatchBranch(branch);
        store.unstageBatch(b, { ...prior, fixed });
      } else {
        store.updateBatch(batchId, { detail: { ...prior, fixed } });
      }
      store.updateBatch(batchId, { status: 'superseded' });
      let requeued = 0;
      for (const { task, reasons } of plan.targets) {
        if (store.requeueForFix(runId, task.id, { batchId, seq: b.seq, check: plan.check, reasons, at, verdictId: task.lastVerdictId })) requeued++;
      }
      store.setRunStatus(runId, 'running', ['completed']);
      events.emit('batch.sent_to_agents', `batch ${b.seq}: ${fns} function(s) in ${requeued} packet(s) sent back to the AI agents to fix what its ${plan.check === 're-verify' ? 're-verification' : 'dry run'} reported; the rest stays matched and is batched again when the run finishes`, {
        runId, level: 'warn', data: { seq: b.seq, check: plan.check, requeued, functions: fns },
      });
      return { requeued, functions: fns, kept: b.taskIds.length - requeued };
    }, { besideRun: true });
    await this.wakeOrStart(runId);
    return { ok: true as const, seq: batch.seq, check: plan.check, ...r, status: store.getRun(runId)?.status ?? 'running' };
  }

  /** Packets went back to the queue: a loaded run picks them up, otherwise the run starts again. */
  private async wakeOrStart(runId: string) {
    const live = this.active.get(runId);
    if (!live) return this.start(runId);
    live.capacityStalled = false;
    live.wake.notify();
  }

  /**
   * How the run's unsubmitted staged batches would regroup into as few batches as fit `max`
   * functions (whole units, biggest first). Read only.
   */
  rebalancePlan(runId: string, max = PR_BATCH_MAX) {
    const work = this.changeableBatches(runId, null);
    const byUnit = new Map<string, number>();
    for (const t of work.flatMap((w) => w.tasks)) byUnit.set(t.unit, (byUnit.get(t.unit) ?? 0) + t.functions.length);
    const bins = packUnits([...byUnit].map(([unit, functions]) => ({ unit, functions, items: [functions] })), max);
    return {
      max,
      batches: work.map((w) => ({ seq: w.batch.seq, functions: w.tasks.reduce((n, t) => n + t.functions.length, 0) })),
      after: bins.map((b) => b.reduce((n, x) => n + x, 0)),
      functions: [...byUnit.values()].reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Regroup the run's unsubmitted staged batches into as few batches as fit `max` functions each
   * (the repository's PR guidance: bigger PRs, at most 60): their local branches are deleted, they
   * become `superseded`, and their packets are re-verified as the new batches. A batch with a PR,
   * or a submission attempt, is never touched. New batches need a dry run again.
   */
  async rebalanceBatches(runId: string, max = PR_BATCH_MAX) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run's batches can be regrouped`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish first');
    if (!Number.isInteger(max) || max < 1 || max > PR_BATCH_MAX) throw new Error(`a batch holds 1 to ${PR_BATCH_MAX} functions`);
    const plan = this.rebalancePlan(runId, max);
    if (plan.batches.length < 2 || plan.after.length >= plan.batches.length) {
      throw new Error(plan.batches.length < 2 ? 'there is nothing to regroup: fewer than two unsubmitted batches' : `the ${plan.batches.length} batches are already as few as ${max} functions per PR allows`);
    }
    return this.exclusive(`regrouping the batches of ${runId}`, async () => {
      const work = this.changeableBatches(runId, null);
      const at = Date.now();
      for (const [i, { batch }] of work.entries()) {
        this.progress('Regrouping batches', `batch ${batch.seq}: deleting its local branches`, i, work.length);
        if (repo.deleteBatchBranch && batch.branch === `decomp/${runId}-b${batch.seq}`) for (const branch of [`${batch.branch}-pr`, batch.branch]) await repo.deleteBatchBranch(branch);
        const prior = { ...(batch.detail as Record<string, unknown> | null) };
        delete prior.dryRunFingerprint;
        delete prior.dryRunUncheckedClaims;
        store.unstageBatch(batch, { ...prior, rebalanced: { at, max } });
        store.updateBatch(batch.id, { status: 'superseded' });
      }
      const tasks = work.flatMap((w) => w.tasks);
      const staged = await stageRun(store, repo, events, runId, max, { only: tasks.map((t) => t.id), progress: this.progress, pack: 'dense' });
      for (const { batch } of work) store.updateBatch(batch.id, { detail: { ...(store.getBatch(batch.id)!.detail as Record<string, unknown> | null), supersededBy: staged.seqs } });
      events.emit('batch.rebalanced', `regrouped batch ${work.map((w) => w.batch.seq).join(', ')} (${plan.functions} functions) into ${staged.seqs.length} batch(es) of at most ${max}: ${staged.seqs.join(', ')}${staged.failed ? `; ${staged.failed} did not pass their check` : ''}`, {
        runId, level: staged.failed ? 'warn' : 'info', data: { from: work.map((w) => w.batch.seq), to: staged.seqs, max },
      });
      return { from: work.map((w) => w.batch.seq), functions: plan.functions, staged };
    }, { besideRun: true });
  }

  // ---------------------------------------------------------------- pull requests after submission

  /** Batches that opened a pull request (not the ones that only pushed fixes to another batch's PR). */
  private prBatches(runId: string) {
    return this.deps.store.listBatches(runId).filter((b) => {
      const d = (b.detail ?? {}) as { pr?: string | null; prUpdateOf?: number };
      return !!d.pr && d.prUpdateOf === undefined;
    });
  }

  /**
   * Read each PR batch's pull request from GitHub (state, comments, reviews) into `detail.prStatus`.
   * A merged PR is final and is read again only when asked for by batch. Read only on GitHub.
   */
  async refreshPullRequests(runId: string, opts: { batchId?: string } = {}) {
    const { store, repo, events } = this.deps;
    if (!store.getRun(runId)) throw new Error(`run ${runId} not found`);
    if (!repo.pullRequestStatus) throw new Error('this repository adapter cannot read pull requests');
    const batches = this.prBatches(runId).filter((b) => !opts.batchId || b.id === opts.batchId);
    if (opts.batchId && !batches.length) throw new Error('that batch has no pull request');
    const out: Array<{ seq: number; state: string | null; comments: number; error: string | null }> = [];
    for (const b of batches) {
      const d = (b.detail ?? {}) as { pr: string; prStatus?: PrStatus & { checkedAt?: number } };
      if (!opts.batchId && d.prStatus?.state === 'merged') {
        out.push({ seq: b.seq, state: 'merged', comments: reviewComments(d.prStatus).length, error: null });
        continue;
      }
      const st = await repo.pullRequestStatus(d.pr);
      const now = store.getBatch(b.id)!.detail as Record<string, unknown> | null;
      if (!st.checked) {
        store.updateBatch(b.id, { detail: { ...now, prStatus: { ...(d.prStatus ?? {}), error: st.error, checkedAt: Date.now() } } });
        out.push({ seq: b.seq, state: d.prStatus?.state ?? null, comments: reviewComments(d.prStatus).length, error: st.error });
        continue;
      }
      store.updateBatch(b.id, { detail: { ...now, prStatus: { ...st, checkedAt: Date.now() } } });
      const before = reviewComments(d.prStatus).length;
      const after = reviewComments(st).length;
      if (d.prStatus?.state && d.prStatus.state !== st.state) {
        events.emit('batch.pr_state', `batch ${b.seq}: pull request ${st.state === 'merged' ? 'merged upstream' : st.state === 'closed' ? 'closed without merging' : 'open again'} (${d.pr})`, { runId, level: st.state === 'closed' ? 'warn' : 'info', data: { seq: b.seq, state: st.state } });
      }
      if (after > before) events.emit('batch.pr_comments', `batch ${b.seq}: ${after - before} new review comment(s) on ${d.pr}`, { runId, level: 'warn', data: { seq: b.seq, comments: after } });
      out.push({ seq: b.seq, state: st.state, comments: after, error: null });
    }
    return out;
  }

  /** Every 10 minutes: read the open pull requests of finished runs again (state and new comments). */
  private async autoRefreshPullRequests() {
    if (!this.deps.repo.pullRequestStatus) return;
    for (const r of this.deps.store.listRuns().filter((x) => PIPELINE_STATES.has(x.status))) {
      if (!this.prBatches(r.id).some((b) => ((b.detail as { prStatus?: PrStatus } | null)?.prStatus?.state ?? 'open') === 'open')) continue;
      await this.refreshPullRequests(r.id).catch((e) => this.deps.events.emit('batch.pr_refresh_failed', `could not read pull requests: ${(e as Error).message}`, { runId: r.id, level: 'warn' }));
    }
  }

  /**
   * Explain a PR's review comments in plain words with one model call (the run's most capable
   * worker tier). Cached in `detail.prExplain` until the comments change.
   */
  async explainPrComments(runId: string, batchId: string) {
    const { store, pool, providers } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    await this.refreshPullRequests(runId, { batchId });
    const batch = store.getBatch(batchId)!;
    const d = (batch.detail ?? {}) as { prStatus?: PrStatus; prExplain?: Explanation & { key: string; at: number; model: string } };
    if (d.prStatus?.checked === false && !d.prStatus.comments?.length) throw new Error(d.prStatus.error ?? 'GitHub could not be read');
    const comments = reviewComments(d.prStatus);
    if (!comments.length) throw new Error('nobody else has commented on this pull request yet');
    const key = commentsKey(comments);
    if (d.prExplain?.key === key) return { ...d.prExplain, cached: true };
    const plan = compileFlowPlan(row.flow);
    const binding = plan.tiers.at(-1)!.node.data.pool;
    const functions = batch.taskIds.flatMap((id) => store.getTask(id)?.functions ?? []);
    const prompt = explainPrompt({ title: d.prStatus?.title ?? null, state: d.prStatus?.state ?? null, functions, comments });
    const lease = await pool.acquire({ binding, role: 'worker', estInputTokens: Math.ceil(prompt.length / 3.5), estOutputTokens: 2_000 });
    const t = Date.now();
    let text: string;
    try {
      const r = await providers.complete(lease.account, { system: EXPLAIN_SYSTEM, prompt, model: lease.model, effort: 'low', jsonSchema: EXPLAIN_SCHEMA, maxOutputTokens: 6_000, timeoutMs: 180_000, signal: new AbortController().signal });
      pool.release(lease, { kind: 'ok', usage: r.usage, latencyMs: Date.now() - t, rateLimit: r.rateLimit });
      store.addRunUsage(runId, costUsd(lease.model, r.usage), r.usage);
      text = r.text;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError('network', String(e));
      pool.release(lease, { kind: pe.kind, retryAfterMs: pe.retryAfterMs, message: pe.message });
      throw new Error(`the model could not be reached (${pe.kind}): try again`);
    }
    const parsed = ExplainOut.safeParse(extractJson(text));
    if (!parsed.success) throw new Error('the model did not answer in the expected form: try again');
    const explained = { ...parsed.data, key, at: Date.now(), model: lease.model.id };
    store.updateBatch(batchId, { detail: { ...(store.getBatch(batchId)!.detail as Record<string, unknown> | null), prExplain: explained } });
    return { ...explained, cached: false };
  }

  /** An open PR's fixes are pushed on top of our commit: refuse early when someone else has pushed to its branch. */
  private async assertPrBranchOurs(prBranch: string | undefined, st: PrStatus) {
    if (st.state !== 'open' || !prBranch || !st.headSha || !this.deps.repo.branchHead) return;
    const ours = await this.deps.repo.branchHead(prBranch);
    if (ours && ours !== st.headSha) {
      throw new Error(`someone else pushed to the pull request (it is at ${st.headSha.slice(0, 10)}, your commit is ${ours.slice(0, 10)}): fixes could not be pushed to it, so nothing was sent. Read what was pushed first: it may already hold the fix`);
    }
  }

  /**
   * Ask the run's orchestrator which packets a PR's comments really need changed, and what to change.
   * One model call; sends nothing to the workers. Kept in `detail.reviewPlan` until the comments change.
   */
  async triageReview(runId: string, batchId: string): Promise<ReviewPlan & { cached: boolean }> {
    const { store, pool, providers, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    await this.refreshPullRequests(runId, { batchId });
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    const d = (batch.detail ?? {}) as { prBranch?: string; prStatus?: PrStatus; reviewPlan?: ReviewPlan; reviewFix?: unknown };
    const st = d.prStatus;
    if (!st?.state) throw new Error(st?.error ?? 'the pull request could not be read');
    if (st.state === 'merged') throw new Error('the pull request is merged: there is nothing to fix');
    if (d.reviewFix) throw new Error('this pull request is already being fixed: take the packets back first');
    const comments = reviewComments(st);
    if (!comments.length) throw new Error(`the pull request is ${st.state} and nobody else has commented: there is nothing to fix from`);
    await this.assertPrBranchOurs(d.prBranch, st);
    const key = commentsKey(comments);
    if (d.reviewPlan?.key === key) return { ...d.reviewPlan, cached: true };
    if (budgetReached(row)) throw new Error(`run budget $${row.config.budgetUsd} reached ($${row.costUsd.toFixed(2)} spent): raise it first`);
    const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
    const prompt = triagePrompt({
      title: st.title, state: st.state, comments,
      packets: tasks.map((t) => ({ unit: t.unit, files: batchContent(store, runId, [t]).files.map((f) => f.path), functions: t.functions })),
    });
    const binding = compileFlowPlan(row.flow).orchestrator.data.pool;
    const lease = await pool.acquire({ binding, role: 'orchestrator', estInputTokens: Math.ceil(prompt.length / 3.5), estOutputTokens: 2_000 });
    const t = Date.now();
    let text: string;
    try {
      const r = await providers.complete(lease.account, { system: TRIAGE_SYSTEM, prompt, model: lease.model, effort: 'low', jsonSchema: TRIAGE_SCHEMA, maxOutputTokens: 6_000, timeoutMs: 180_000, signal: new AbortController().signal });
      pool.release(lease, { kind: 'ok', usage: r.usage, latencyMs: Date.now() - t, rateLimit: r.rateLimit });
      store.addRunUsage(runId, costUsd(lease.model, r.usage), r.usage);
      text = r.text;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError('network', String(e));
      pool.release(lease, { kind: pe.kind, retryAfterMs: pe.retryAfterMs, message: pe.message });
      throw new Error(`the orchestrator could not be reached (${pe.kind}): nothing was sent, try again`);
    }
    const parsed = TriageOut.safeParse(extractJson(text));
    if (!parsed.success) throw new Error('the orchestrator did not answer in the expected form: nothing was sent, try again');
    let targets: ReturnType<typeof triageTargets<TaskRow>>;
    try {
      targets = triageTargets(parsed.data, tasks, comments);
    } catch (e) {
      throw new Error(`the orchestrator's answer does not fit the pull request (${(e as Error).message}): nothing was sent, try again`);
    }
    const plan: ReviewPlan = {
      key, at: Date.now(), model: lease.model.id, summary: parsed.data.summary, skipped: targets.skipped,
      fix: [...targets.fix].map(([p, instructions]) => ({ taskId: p.id, unit: p.unit, functions: p.functions.map((f) => f.rva), instructions })),
    };
    store.updateBatch(batchId, { detail: { ...(store.getBatch(batchId)!.detail as Record<string, unknown> | null), reviewPlan: plan } });
    events.emit('batch.review_triaged', `batch ${batch.seq}: the orchestrator (${plan.model}) read ${comments.length} review comment(s): ${plan.fix.length} of ${tasks.length} packet(s) need work`, { runId, data: { seq: batch.seq, fix: plan.fix.length, packets: tasks.length } });
    return { ...plan, cached: false };
  }

  /**
   * Take back packets sent to the workers from an open PR's comments: each returns to the PR's batch
   * with the verdict (and so the files) it was submitted with, as if it had never been sent. Refused
   * while a worker holds one of them, or once their fixes are a batch of their own.
   */
  async recallReviewFix(runId: string, batchId: string) {
    const { store, events } = this.deps;
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    const r = await this.exclusive(`taking back the review fix of batch ${batch.seq} of ${runId}`, async () => {
      const detail = (store.getBatch(batchId)!.detail ?? {}) as { reviewFix?: { taskIds: string[] } } & Record<string, unknown>;
      if (!detail.reviewFix || batch.status !== 'submitted') throw new Error('nothing of this pull request is with the AI agents');
      const fixes = store.listBatches(runId).find((b) => (b.detail as { updatesPr?: { batchId: string } } | null)?.updatesPr?.batchId === batchId && ['draft', 'branch_ready'].includes(b.status));
      if (fixes) throw new Error(`the fixes are already in batch ${fixes.seq}: clear that batch first`);
      const tasks = detail.reviewFix.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t && t.fix?.check === 'review' && t.fix.batchId === batchId);
      const held = tasks.filter((t) => t.state === 'leased' || t.state === 'gating');
      if (held.length || this.status(runId).busySlots) throw new Error('workers are still on this run: pause it now, then take the packets back');
      const bad = tasks.find((t) => !t.fix!.verdictId || !store.getVerdict(t.fix!.verdictId));
      if (bad) throw new Error(`${bad.unit} has no record of the verdict it was submitted with: nothing was changed`);
      const { reviewFix: _gone, ...rest } = detail;
      store.tx(() => {
        for (const t of tasks) if (!store.recallFix(runId, t.id, t.fix!.verdictId!)) throw new Error(`${t.unit} changed meanwhile: nothing was taken back`);
        store.updateBatch(batchId, { detail: rest });
      });
      const open = store.listTasks(runId, { limit: 100_000 }).some((t) => ['pending', 'leased', 'gating'].includes(t.state));
      events.emit('batch.review_recalled', `batch ${batch.seq}: ${tasks.length} packet(s) taken back from the AI agents; each is as it was submitted`, { runId, level: 'warn', data: { seq: batch.seq, packets: tasks.length } });
      // `sr start` named the worker tier in the local task records: name the finishing models again.
      await this.reclaim(runId, tasks.map((t) => store.getTask(t.id)!));
      return { packets: tasks.length, functions: tasks.reduce((n, t) => n + t.functions.length, 0), open };
    }, { besideRun: true });
    if (!r.open && store.getRun(runId)?.status === 'paused') {
      // Nothing is left to do: a loaded run ends on its own, one that is not loaded just goes back.
      if (this.active.has(runId)) await this.resumeRun(runId);
      else store.setRunStatus(runId, 'completed', ['paused']);
    }
    return { ok: true as const, seq: batch.seq, packets: r.packets, functions: r.functions, status: store.getRun(runId)?.status ?? 'completed' };
  }

  /**
   * Fix a pull request from its review comments with the run's AI workers. The orchestrator decides
   * first (`triageReview`): only the packets it names go back to the worker queue, with its
   * instructions (`only` narrows them further), and the run goes through its flow again. An open PR keeps its other packets; when the run finishes its fixed packets form
   * a batch of their own, pushed to the same PR with `pushReviewFixes`. A closed PR's batch is
   * replaced: every packet goes back into batching and the result is a new PR.
   */
  async fixFromReview(runId: string, batchId: string, opts: { only?: string[] } = {}) {
    const { store, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; fix from a review once the run has finished`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish first');
    if (budgetReached(row)) throw new Error(`run budget $${row.config.budgetUsd} reached ($${row.costUsd.toFixed(2)} spent): raise it before fixing with the agents`);
    await this.refreshPullRequests(runId, { batchId });
    const batch = store.getBatch(batchId)!;
    const d = (batch.detail ?? {}) as { pr: string; prBranch?: string; prStatus?: PrStatus; reviewPlan?: ReviewPlan };
    const st = d.prStatus;
    if (!st?.state) throw new Error(st?.error ?? 'the pull request could not be read');
    if (st.state === 'merged') throw new Error('the pull request is merged: there is nothing to fix');
    const comments = reviewComments(st);
    if (!comments.length) throw new Error(`the pull request is ${st.state} and nobody else has commented: there is nothing to fix from`);
    await this.assertPrBranchOurs(d.prBranch, st);
    if (!d.reviewPlan) throw new Error('ask the orchestrator first which packets the comments need changed');
    if (d.reviewPlan.key !== commentsKey(comments)) throw new Error('the comments changed since the orchestrator read them: ask it again');
    const only = opts.only ? new Set(opts.only) : null;
    const chosen = d.reviewPlan.fix.filter((f) => !only || only.has(f.taskId));
    if (!chosen.length) throw new Error(d.reviewPlan.fix.length ? 'no packet was chosen' : 'the orchestrator found nothing that needs fixing');
    const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
    if (tasks.some((t) => t.state !== 'staged')) throw new Error('part of this pull request is already being fixed or changed');
    const reasons = new Map(chosen.map((f) => [f.taskId, f.instructions]));
    const targets = tasks.filter((t) => reasons.has(t.id));
    const open = st.state === 'open';
    const r = await this.exclusive(`sending the review of batch ${batch.seq} of ${runId} to the AI agents`, async () => {
      const at = Date.now();
      const reviewFix = { at, state: st.state, taskIds: targets.map((t) => t.id), comments: comments.length, key: commentsKey(comments) };
      let requeued = 0;
      for (const t of targets) {
        const fix: BatchFix = { batchId, seq: batch.seq, check: 'review', reasons: reasons.get(t.id)!, at, verdictId: t.lastVerdictId, pr: d.pr, prOpen: open };
        if (store.requeueForFix(runId, t.id, fix, ['staged'])) requeued++;
      }
      if (open) {
        store.updateBatch(batchId, { detail: { ...(store.getBatch(batchId)!.detail as Record<string, unknown> | null), reviewFix } });
      } else {
        // Closed: the rest is batched again with the fixed packets, into a new pull request.
        const back = store.db.prepare("UPDATE tasks SET state = 'passed', updated_at = ? WHERE id = ? AND run_id = ? AND state = 'staged'");
        store.tx(() => tasks.filter((t) => !reasons.has(t.id)).forEach((t) => back.run(at, t.id, runId)));
        store.updateBatch(batchId, { status: 'superseded', detail: { ...(store.getBatch(batchId)!.detail as Record<string, unknown> | null), reviewFix } });
      }
      store.setRunStatus(runId, 'running', ['completed']);
      const fns = targets.reduce((n, t) => n + t.functions.length, 0);
      events.emit('batch.review_to_agents', `batch ${batch.seq}: ${fns} function(s) in ${requeued} packet(s) sent to the AI agents with ${comments.length} review comment(s) from ${d.pr}; ${open ? 'the fixes go to the same pull request' : 'the pull request was closed, so the result becomes a new one'}`, {
        runId, level: 'warn', data: { seq: batch.seq, requeued, comments: comments.length, open },
      });
      return { requeued, functions: fns, comments: comments.length, open };
    }, { besideRun: true });
    await this.wakeOrStart(runId);
    return { ok: true as const, seq: batch.seq, ...r, status: store.getRun(runId)?.status ?? 'running' };
  }

  /**
   * Push a review-fix batch (its packets fixed from an open PR's comments, re-verified) to that PR as
   * one more commit, after re-verifying every packet of the PR with the fixes. Never a new PR.
   */
  async pushReviewFixes(runId: string, batchId: string) {
    const { store, repo, events } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; push once it has completed`);
    if (!repo.updatePullRequest) throw new Error('this repository adapter cannot update pull requests');
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    const d = (batch.detail ?? {}) as { updatesPr?: { batchId: string; seq: number; pr: string | null } };
    if (!d.updatesPr) throw new Error(`batch ${batch.seq} holds no fixes for a pull request`);
    if (batch.status !== 'branch_ready') throw new Error(`batch ${batch.seq} is ${batch.status}: only a re-verified batch can be pushed`);
    const orig = store.getBatch(d.updatesPr.batchId);
    const od = (orig?.detail ?? {}) as { pr?: string; prBranch?: string; prUpdates?: unknown[] };
    if (!orig || orig.status !== 'submitted' || !od.pr || !od.prBranch) throw new Error(`batch ${d.updatesPr.seq}'s pull request is gone`);
    const fixed = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
    if (fixed.length !== batch.taskIds.length || fixed.some((t) => t.state !== 'staged')) throw new Error('every packet of the batch must still be staged');
    // Every packet of the PR, with the fixed ones as they are now: the PR's tree must match them all.
    const prTasks = [...new Set([...orig.taskIds, ...batch.taskIds])].map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
    const content = batchContent(store, runId, fixed);
    const message = [`Address review comments on ${content.fnCount} function(s)`, '', ...content.message.split('\n').slice(2)].join('\n');
    return this.exclusive(`pushing the review fixes of batch ${batch.seq} to ${od.pr}`, async () => {
      const r = await repo.updatePullRequest!({
        branch: od.prBranch!, pullRequest: od.pr!, files: content.files, message, progress: this.progress,
        tasks: prTasks.map((t) => ({ id: t.id, srTaskId: t.srTaskId, functions: t.functions, task: t })),
      });
      if (!r.ok) {
        events.emit('batch.pr_update_failed', `batch ${batch.seq}: fixes not pushed to ${od.pr}: ${r.error}${r.problems.length ? ` (${r.problems.slice(0, 3).join('; ')})` : ''}`, { runId, level: 'warn' });
        return r;
      }
      const at = Date.now();
      if (repo.deleteBatchBranch && batch.branch === `decomp/${runId}-b${batch.seq}`) await repo.deleteBatchBranch(batch.branch);
      store.updateBatch(batchId, { status: 'submitted', branch: null, detail: { ...(batch.detail as unknown as Record<string, unknown>), pr: od.pr, prBranch: od.prBranch, prUpdateOf: orig.seq, commit: r.commit, submittedAt: at } });
      const now = (store.getBatch(orig.id)!.detail ?? {}) as Record<string, unknown>;
      const { reviewFix: _done, ...rest } = now;
      store.updateBatch(orig.id, { detail: { ...rest, prUpdates: [...(od.prUpdates ?? []), { at, commit: r.commit, seq: batch.seq }] } });
      store.clearFix(fixed.map((t) => t.id));
      events.emit('batch.pr_updated', `batch ${batch.seq}: review fixes for ${content.fnCount} function(s) pushed to ${od.pr} as ${r.commit?.slice(0, 10)}`, { runId, data: { seq: batch.seq, pr: od.pr, commit: r.commit } });
      return r;
    }, { besideRun: true });
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
   * Everything that gets a finished run's batches ready for pull requests, in one operation:
   * re-verify failed batches, set aside what upstream already has or changed, then dry-run every
   * batch without a clean dry run at this base. A dry run that blames units of the batch sets them
   * aside; one that finds other contributors' claims withholds those units (never acknowledged);
   * the rest is re-verified and dry-run again. Submits nothing: the operator still opens each PR.
   */
  async prepareAll(runId: string) {
    const { store, repo } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; only a running or completed run's batches can be prepared`);
    if (this.editingAttribution.has(runId)) throw new Error('wait for claim attribution to finish first');
    if (!repo.submitBatch) throw new Error('this repository adapter cannot submit pull requests');
    const steps = 4;
    return this.exclusive(`preparing ${runId} for pull requests`, async () => {
      const startedAt = Date.now();
      const done: string[] = [];
      const needsYou: Array<{ seq: number; why: string }> = [];
      const phase = (n: number, what: string) => {
        if (this.op) this.op.label = `Preparing ${runId} for pull requests — step ${n} of ${steps}: ${what}`;
      };
      const failedLeft = () => store.listBatches(runId).filter((b) => (b.status === 'failed' || b.status === 'interrupted') && b.taskIds.some((id) => store.getTask(id)?.state === 'passed'));
      const changeable = () => {
        try {
          return this.changeableBatches(runId, null);
        } catch {
          return [];
        }
      };
      const clean = (b: { detail: unknown }) => this.cleanDryRun(b);

      phase(1, 'batching and re-verifying');
      if (failedLeft().length) {
        const s = await this.restageFailedAll(runId);
        done.push(`re-verified the failed batches: ${s.staged} staged, ${s.failed} still failing`);
      }
      // Matched packets in no batch yet (staging was off, or a batch was cleared): batch them too.
      // While the run goes on with staging on, only ready units that fill a batch: the rest waits
      // for more matches (rolling batches) instead of becoming small pull requests.
      const going = store.getRun(runId)?.status !== 'completed';
      const failedNow = new Set(failedLeft().flatMap((b) => b.taskIds));
      const loose = going && row.config.staging !== 'off' ? [] : this.readyTasks(runId).filter((t) => !failedNow.has(t.id));
      if (going && row.config.staging !== 'off') {
        let staged = 0;
        let failed = 0;
        for (let bin = this.fullBins(runId, row.config.prBatchSize)[0]; bin; bin = this.fullBins(runId, row.config.prBatchSize)[0]) {
          if (this.active.get(runId)?.cancel.signal.aborted) break;
          const s = await stageRun(store, repo, this.deps.events, runId, row.config.prBatchSize, { only: bin.taskIds, pack: 'dense', progress: this.progress });
          staged += s.staged;
          failed += s.failed;
          if (!s.seqs.length) break;
        }
        if (staged + failed) done.push(`batched the ready functions that fill a batch: ${staged} staged, ${failed} failing`);
      }
      if (loose.length) {
        if (row.config.staging === 'off' && store.getRun(runId)?.status === 'completed') await this.reclaim(runId, loose);
        const s = await stageRun(store, repo, this.deps.events, runId, row.config.prBatchSize, { only: loose.map((t) => t.id), progress: this.progress });
        done.push(`batched the matched packets that had no batch: ${s.staged} staged, ${s.failed} failing`);
      }

      phase(2, 'checking against upstream');
      if (repo.upstreamState && changeable().length) {
        const u = await this.setAsideUpstreamAll(runId);
        if (u.setAsideFunctions) done.push(`set aside ${u.setAsideFunctions} function(s) upstream already has or changed`);
      }

      phase(3, 'dry runs');
      const tried = new Set<string>();
      for (let round = 0; round < 4; round++) {
        const todo = changeable().filter((w) => !tried.has(w.batch.id) && !clean(w.batch));
        if (!todo.length) break;
        const claimed: string[] = [];
        for (const [i, w] of todo.entries()) {
          tried.add(w.batch.id);
          phase(3, `dry run ${i + 1} of ${todo.length} (batch ${w.batch.seq})`);
          const r = await this.submitBatch(runId, w.batch.id, { dryRun: true });
          if (r.cancelled) return { cancelled: true, done, needsYou, ready: [], durationMs: Date.now() - startedAt };
          if (r.ok && !r.uncheckedClaims?.length) continue;
          if (r.uncheckedClaims?.length && !r.blockers.length && !r.problems.length) {
            needsYou.push({ seq: w.batch.seq, why: 'claims could not be checked (GitHub unreachable?): run its dry run again later' });
            continue;
          }
          const blame = await this.blockingUnits(runId, w.batch.id);
          const stale = this.staleBaseMessage(blame);
          const live = Object.values(blame.units).some((rs) => rs.some((b) => !blame.fixedUpstream.includes(b)));
          if (stale && !live) {
            needsYou.push({ seq: w.batch.seq, why: stale.slice(0, 400) });
          } else if (live) {
            phase(3, `setting aside what blocked batch ${w.batch.seq}`);
            const s = await this.setAsideBlocking(runId, w.batch.id);
            done.push(`batch ${w.batch.seq}: set aside ${s.setAsideFunctions} function(s) its dry run blamed`);
          } else if (blame.claims.length) {
            claimed.push(w.batch.id);
          } else {
            needsYou.push({ seq: w.batch.seq, why: (blame.unattributed[0] ?? r.error ?? 'the dry run failed').slice(0, 300) });
          }
        }
        if (claimed.length && repo.claimCollisions) {
          phase(3, `withholding units other contributors claimed (${claimed.length} batch(es))`);
          const d = await this.dropCollisions(runId, claimed);
          done.push(`withheld ${d.withheldFunctions} function(s) others have claimed; they come back on their own when the claims lapse`);
        }
      }

      phase(4, 'summing up');
      for (const b of failedLeft()) needsYou.push({ seq: b.seq, why: 'its re-verification fails: open it to see which packets' });
      const ready = store.listBatches(runId).filter((b) => b.status === 'branch_ready' && clean(b)).map((b) => b.seq);
      for (const w of changeable()) if (!clean(w.batch) && !needsYou.some((n) => n.seq === w.batch.seq)) needsYou.push({ seq: w.batch.seq, why: 'still has no clean dry run' });
      this.deps.events.emit('run.prepared', `prepared for pull requests: ${ready.length} batch(es) ready to submit${needsYou.length ? `, ${needsYou.length} need you` : ''}`, { runId, level: needsYou.length ? 'warn' : 'info', data: { ready, needsYou, done } });
      return { cancelled: false, done, needsYou, ready, durationMs: Date.now() - startedAt };
    }, { besideRun: true });
  }

  /**
   * Open the pull request for one staged batch with `sr submit` (dryRun: `sr submit --dry-run`, which
   * commits and pushes nothing for the PR). Only ever on the operator's explicit request.
   */
  async submitBatch(runId: string, batchId: string, opts: { dryRun: boolean; allowUncheckedClaims?: boolean }) {
    const { store, events, repo } = this.deps;
    const row = store.getRun(runId);
    if (!row) throw new Error(`run ${runId} not found`);
    if (!PIPELINE_STATES.has(row.status)) throw new Error(`run is ${row.status}; submit once it has completed`);
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
        prior.dryRunBase = repo.baseSha ?? null;
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
        warnings: r.warnings, plan: r.plan, error: r.error, branch, base: repo.baseSha ?? null,
      } };
      if (r.ok && !opts.dryRun) {
        store.updateBatch(batchId, { status: 'submitted', detail: { ...detail, pr: r.pullRequest, link: r.link, prBranch: branch, prTitle: r.title ?? null, claims: r.claims ?? [], submittedAt: Date.now() } });
        events.emit('batch.submitted', `batch ${batch.seq}: ${all.fnCount} functions submitted → ${r.pullRequest ?? r.link ?? branch}`, { runId, data: { pr: r.pullRequest, link: r.link, branch, uncheckedClaims: r.uncheckedClaims ?? [], allowUncheckedClaims: input.allowUncheckedClaims } });
      } else {
        store.updateBatch(batchId, { detail });
        const why = r.problems.length ? `re-verification: ${r.problems.join('; ')}` : r.blockers.length ? `sr submit blockers: ${r.blockers.join('; ')}` : (r.error ?? '');
        events.emit(opts.dryRun ? 'batch.submit_dry_run' : 'batch.submit_failed', `batch ${batch.seq}: ${opts.dryRun ? `dry run ${r.cancelled ? 'cancelled' : r.ok ? 'clean' : 'found problems'}` : 'NOT submitted'}${why ? ` — ${why}` : ''}`, { runId, level: r.ok ? 'info' : 'warn', data: { blockers: r.blockers, problems: r.problems } });
      }
      return r;
    }, { besideRun: true }).finally(() => {
      if (dryRun && this.dryRuns.get(batchId) === dryRun) this.dryRuns.delete(batchId);
    });
  }

  /**
   * Rewrite a submitted batch's open PR as one commit on its base, with a commit message, title and
   * description that name every function of the batch (PRs opened before submissions did this).
   * Force-pushes the fork's PR branch only while it still matches the local copy.
   */
  async tidyPullRequest(runId: string, batchId: string) {
    const { store, events, repo } = this.deps;
    const batch = store.getBatch(batchId);
    if (!batch || batch.runId !== runId) throw new Error('batch not found');
    const d = { ...(batch.detail as Record<string, unknown> | null) } as Record<string, unknown> & { pr?: string | null; prBranch?: string; claims?: string[] };
    if (batch.status !== 'submitted' || !d.prBranch) throw new Error(`batch ${batch.seq} has no open pull request`);
    if (!repo.tidyPullRequest) throw new Error('this repository adapter cannot rewrite pull requests');
    const tasks = batch.taskIds.map((id) => store.getTask(id)).filter((t): t is TaskRow => !!t);
    const ordered = [...tasks].sort((a, b) => a.unit.localeCompare(b.unit));
    const lastUnit = ordered.at(-1)!.unit;
    const submitTask = [...ordered].reverse().find((t) => t.unit === lastUnit)!;
    const sequence = [...ordered.filter((t) => t !== submitTask), submitTask];
    const all = batchContent(store, runId, sequence);
    return this.exclusive(`tidying the pull request of ${runId} b${batch.seq}`, async () => {
      this.progress(`Batch ${batch.seq}: one commit, and a title and description naming every function`, d.pr ?? d.prBranch ?? null);
      const r = await repo.tidyPullRequest!({
        branch: d.prBranch!, draftedBy: all.draftedBy ?? (all.person ?? 'not stated'), pullRequest: d.pr ?? null, claimUrls: d.claims ?? [],
        tasks: sequence.map((t) => ({ id: t.id, srTaskId: t.srTaskId, functions: t.functions, task: t })),
      });
      if (r.ok) store.updateBatch(batchId, { detail: { ...d, prTitle: r.title, claims: r.claims?.length ? r.claims : d.claims ?? [], tidiedAt: Date.now() } });
      events.emit(r.ok ? 'batch.pr_tidied' : 'batch.pr_tidy_failed', `batch ${batch.seq}: ${r.ok ? `pull request is one commit titled "${r.title}"` : `pull request not rewritten: ${r.error}`}`, { runId, level: r.ok ? 'info' : 'warn', data: { pr: d.pr, warnings: r.warnings } });
      return r;
    }, { besideRun: true });
  }

  /**
   * Run `fn` holding the slot lock. With no run loaded it may also borrow the idle worker slots
   * (and no run can start meanwhile). `besideRun` steps use only the dedicated staging worktree,
   * so they may also run while a run's workers are busy; other steps are refused then.
   */
  async exclusive<T>(label: string, fn: () => Promise<T>, opts: { besideRun?: boolean } = {}): Promise<T> {
    // A step of an operation that already holds the slots (Prepare all for PR) runs inside it.
    if (this.slotsHeld.getStore() === this) return fn();
    if (this.discovering || (this.active.size && !opts.besideRun)) throw new Error('a run is active; wait for it to finish before using the worktree slots');
    if (this.exclusiveHolder) throw new Error(`worktree slots are busy (${this.exclusiveHolder})`);
    const borrow = this.active.size === 0;
    this.exclusiveHolder = label;
    this.idleBorrowed = borrow;
    this.beginOperation(label);
    if (borrow) this.deps.repo.useIdleSlots?.(true);
    try {
      return await this.slotsHeld.run(this, fn);
    } finally {
      if (borrow) this.deps.repo.useIdleSlots?.(false);
      this.exclusiveHolder = null;
      this.idleBorrowed = false;
      this.op = null;
      this.releaseSlotLock();
    }
  }

  /** Whoever waits for the slot lock (a finishing run) goes first; then rolling batches get a turn. */
  private releaseSlotLock() {
    const waiters = this.slotWaiters.splice(0);
    for (const w of waiters) w();
    if (!waiters.length) for (const id of this.active.keys()) this.stageReadySoon(id);
  }

  private slotLockFree(): Promise<void> {
    return new Promise((resolve) => this.slotWaiters.push(resolve));
  }

  private slotsHeld = new AsyncLocalStorage<RunEngine>();

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
      // 1a. nobody pays for a function upstream has matched since it was selected (fixes of packets
      // already accepted have their own checks: they change code a pull request or batch holds).
      if (!task.fix || task.fix.check === 'regate') {
        const taken = await this.takenNow(task);
        if (signal.aborted) throw new AbortedError();
        if (taken.size) return this.skipFunctions(run, task, leaseId, taken, tierIdx, slot);
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
      if (cfg.skipThunks && !task.fix) {
        const thunks = await this.adjustorThunks(task.functions, prepared.packs);
        if (signal.aborted) throw new AbortedError();
        if (thunks.size) {
          return this.skipFunctions(run, task, leaseId, new Map([...thunks].map((r) => [r, { code: 'SKIP_ADJUSTOR_THUNK', why: 'an adjustor thunk (two instructions: adjust `this`, jump): the compiler emits it from the class layout, no function body compiles to it' }])), tierIdx, slot, prepared.srTaskId);
        }
      }
      // A unit rebuilt on upstream: every attempt starts from upstream's file with the packet's
      // accepted functions spliced in (the first attempt submits exactly that).
      // A packet re-gated: every attempt starts from the candidate whose functions all matched.
      const spliced = task.fix?.check === 'rebuild' ? await this.spliceForRebuild(task, slot) : task.fix?.check === 'regate' ? await this.storedCandidate(task, slot) : null;
      if (spliced) await repo.writeFiles(slot, spliced.files);
      if (task.fix?.freeOnly && !(spliced && task.fix.verdictId === task.lastVerdictId)) {
        // Accepted work whose rebuild cannot start stays what it was: matched, set aside.
        const back = task.fix.check === 'rebuild' ? 'set_aside' : 'dead';
        this.queue.transition(task.id, leaseId, ['leased'], back);
        ev(back === 'dead' ? 'task.dead' : 'task.held', back === 'dead' ? 'its stored candidate is gone: dead again without a model call' : 'its accepted candidate cannot be spliced: set aside again without a model call', 'warn');
        return;
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
      let elisions: Elision[] = [];
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
        elisions = bundle.elisions;
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
      // A unit rebuilt on upstream: its first attempt is the splice itself, with no model call.
      let text: string;
      let finisher: string;
      const freeAttempt = !!spliced && task.fix?.verdictId === task.lastVerdictId;
      if (spliced && freeAttempt) {
        text = JSON.stringify({ files: spliced.files, ...(spliced.codeOrigin ? { codeOrigin: spliced.codeOrigin } : {}), ...(spliced.adaptedBodies ? { adaptedBodies: spliced.adaptedBodies } : {}) });
        finisher = spliced.model ?? 'decomp-orchestrator';
        const regate = task.fix?.check === 'regate';
        store.updateAttempt(attempt.id, { model: freeAttemptModel(regate ? 'stored candidate' : 'splice', spliced.model), latencyMs: 0 });
        ev('attempt.spliced', `${regate ? 're-gated' : 'rebuilt on upstream'} without a model call: ${spliced.notes.join('; ').slice(0, 600)}`, 'info', { notes: spliced.notes });
      } else {
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
          // Every account the workers use is down: not this packet's fault, so it is not charged
          // (a long outage would otherwise dead-letter packets); the run pauses until one is back.
          const outage = this.workerOutage(run.row.id, run.plan);
          if (outage) {
            this.outagePause(run.row.id, outage);
            this.queue.transition(task.id, leaseId, ['leased'], 'pending', { notBefore: Date.now() + 5_000 });
            return;
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

        finisher = lease.model.id;
      }
      // 4. parse output; materialise function-level edits into complete files
      const json = extractJson(text);
      const parsed = WorkerOutput.safeParse(json);
      if (!parsed.success) {
        // Say what was wrong and what came back: "did not match" alone gets the same reply again.
        const issues = json === null || json === undefined
          ? 'no JSON object was found in the reply'
          : parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(top level)'}: ${i.message}`).join('; ');
        const reply = text.trim().replace(/\s+/g, ' ');
        const why = `reply was not the JSON object of the output contract (${issues}). It began: "${reply.slice(0, 300)}${reply.length > 300 ? '…' : ''}". Return only {"files": [...]} or {"edits": [...]} as the contract describes, with no text around it.`;
        store.updateAttempt(attempt.id, { status: 'parse_error', error: why.slice(0, 500), finishedAt: Date.now() });
        return this.route(run, task, leaseId, attempt, syntheticVerdict(task, attempt, 'OUTPUT_PARSE', why), { infra: false, strike: false }, tierIdx);
      }
      if (!freeAttempt && outputMode === 'edits' && elided.length && parsed.data.files?.some((f) => f.path.endsWith('.cpp'))) {
        // Complete files cannot contain bodies the worker never saw: reject as a contract error, not a cheat strike.
        store.updateAttempt(attempt.id, { status: 'parse_error', error: 'returned complete files in edits mode', finishedAt: Date.now() });
        return this.route(run, task, leaseId, attempt, syntheticVerdict(task, attempt, 'OUTPUT_MODE', `accepted bodies were elided (${elided.length} function(s)); return "edits" with only the functions you add or change, never complete files`), { infra: false, strike: false }, tierIdx);
      }
      const mat = await materialise(parsed.data, (p) => repo.readFile(slot, p), freeAttempt ? [] : elisions);
      if (mat.problems.length) {
        store.updateAttempt(attempt.id, { status: 'parse_error', error: mat.problems.join('; ').slice(0, 500), files: mat.files, finishedAt: Date.now() });
        return this.route(run, task, leaseId, attempt, syntheticVerdict(task, attempt, 'OUTPUT_EDIT', mat.problems.join('; ').slice(0, 1_000)), { infra: false, strike: false }, tierIdx);
      }
      // An answer built on a stored candidate may return only the file it changed. The candidate's
      // other files are in the slot, so the gate would compile with them: they are part of the answer
      // too, or the packet would be accepted without (say) the header that declares its functions.
      if (spliced && !freeAttempt) {
        const kept: string[] = [];
        for (const f of spliced.files) {
          if (!prepared.allowedPaths.includes(f.path) || mat.files.some((x) => x.path === f.path)) continue;
          const content = await repo.readFile(slot, f.path);
          if (content === null || content === (await repo.baseFile(f.path)) || content === carried.find((c) => c.path === f.path)?.content) continue;
          mat.files.push({ path: f.path, content });
          kept.push(f.path);
        }
        if (kept.length) ev('attempt.kept_files', `kept from the candidate the answer started from: ${kept.join(', ')}`, 'debug', { kept });
      }
      // Accepted functions stay as they are, also when the answer rewrote one.
      const ownNames = task.functions.flatMap((f) => (f.name ? [f.name] : []));
      for (const f of mat.files) {
        const before = carried.find((c) => c.path === f.path)?.content ?? (await repo.baseFile(f.path));
        const r = restoreAccepted(f.content, before, (n) => ownNames.some((o) => o === n || o.endsWith(`::${n}`) || n.endsWith(`::${o}`)));
        f.content = r.content;
        if (r.restored.length) ev('attempt.restored', `accepted function(s) put back as they were: ${r.restored.slice(0, 8).join(', ')}`, 'debug', { restored: r.restored });
      }
      // A member function the packet defines must be in its class: the declaration follows from the definition.
      const had = new Map<string, Set<string>>();
      const key = (d: { cls: string; name: string }) => `${d.cls}::${d.name}`;
      const declared = await declareMembers(mat.files, prepared.allowedPaths, (p) => repo.readFile(slot, p), async (p, d) => {
        if (!had.has(p)) had.set(p, new Set(memberDefs((await repo.baseFile(p)) ?? '').map(key)));
        return !had.get(p)!.has(key(d));
      });
      mat.files = declared.files;
      if (declared.changes.length) ev('attempt.declared', `declared in their classes: ${declared.changes.join('; ').slice(0, 600)}`, 'debug', { changes: declared.changes });
      // Deterministic header repair (skeleton placeholders, duplicate keys, banned lines, origin in .h).
      const untouched = await Promise.all(prepared.allowedPaths.filter((p) => !mat.files.some((f) => f.path === p)).map(async (p) => ({ path: p, current: await repo.readFile(slot, p), base: await repo.baseFile(p) })));
      const fixed = await repairAnswer(mat.files, (p) => repo.readFile(slot, p), { codeOrigin: parsed.data.codeOrigin, adaptedBodies: parsed.data.adaptedBodies }, {
        untouched, attribution: { person: personOf(cfg.draftedBy), model: finisher },
        base: (p) => repo.baseFile(p), own: task.functions.map((f) => (f.name ?? f.rva).split('::').pop()!),
      });
      mat.files = fixed.files;
      // The exact code (comments and spacing aside) already failed in the compiler: refuse it without
      // compiling and say which attempt it repeats, so the next try has to change the logic.
      // (A free attempt re-submits a stored candidate on purpose: the gate decides it again.)
      const repeat = freeAttempt ? null : findRepeat(history, mat.files);
      if (repeat) {
        store.updateAttempt(attempt.id, { status: 'completed', files: mat.files, finishedAt: Date.now() });
        // The same code whose functions all matched, blocked only by lines it did not write: the
        // worker kept them on purpose (another body needs them). Same code, same verdict: hold it.
        const prior = store.verdictsForTask(task.id).find((v) => store.getAttempt(v.attemptId)?.n === repeat.n);
        if (prior && isHeldOnly(prior)) {
          ev('attempt.repeated', `candidate repeats attempt #${repeat.n}, whose functions all match; only lines it did not write block it`, 'debug', { repeats: repeat.n });
          return this.route(run, task, leaseId, attempt, { ...prior, id: newId('vd'), attemptId: attempt.id, createdAt: Date.now() }, { infra: false, strike: false }, tierIdx);
        }
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
        compareTimeoutMs: cfg.compareTimeoutMs, signal, carried: carriedMap, compared: this.comparedRvas(run.row.id, task),
      });
      if (signal.aborted) throw new AbortedError();
      const written = gate.written.length ? gate.written : mat.files;
      store.updateAttempt(attempt.id, { status: 'completed', files: written, finishedAt: Date.now() });
      if (gate.verdict.decision === 'pass') await this.learn(run, task, written, carriedMap).catch((e) => ev('knowledge.failed', `knowledge extraction failed: ${(e as Error).message}`, 'warn'));
      this.route(run, task, leaseId, attempt, gate.verdict, { infra: gate.infra, strike: gate.strike }, tierIdx, prepared.srTaskId);
      if (gate.verdict.decision === 'reject' && !gate.infra && !gate.strike) this.splitMatched(run, task, gate.verdict);
      if (gate.verdict.decision === 'pass' && prepared.srTaskId && repo.recordAttribution && store.getTask(task.id)?.lastVerdictId === gate.verdict.id) {
        const draftedBy = draftedByText(personOf(cfg.draftedBy), [finisher]);
        const r = await repo.recordAttribution({ task, srTaskId: prepared.srTaskId, model: finisher, draftedBy, slot }).catch((e: Error) => ({ ok: false, problems: [e.message] }));
        ev(r.ok ? 'task.attributed' : 'task.attribution_failed', r.ok ? `claim and task attributed to ${finisher} (drafted by ${draftedBy})` : `could not record ${finisher} as the finishing model: ${r.problems.join('; ').slice(0, 300)}`, r.ok ? 'debug' : 'warn', { model: finisher });
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

  /** Which of these functions are adjustor thunks, as far as local packs tell (none without a pack). */
  private async adjustorThunks(fns: FunctionTarget[], packs?: string[]): Promise<Set<string>> {
    const got = await this.deps.repo.analyze?.(fns, packs ? { packs } : {}).catch(() => null);
    return new Set(fns.filter((f) => got?.get(f.rva)?.adjustorThunk).map((f) => f.rva));
  }

  /** The packet's functions upstream has by now; a check that cannot be made takes nothing out. */
  private async takenNow(task: TaskRow): Promise<Map<string, { code: string; why: string }>> {
    const r = await this.deps.repo.takenUpstream?.(task.functions.map((f) => f.rva), task.unit).catch(() => null);
    return new Map(Object.entries(r?.checked ? r.taken : {}).map(([rva, why]) => [rva, { code: 'SKIP_MATCHED_UPSTREAM', why }]));
  }

  /**
   * Take functions out of a leased packet without a model call. The rest goes back to the queue and
   * is prepared again without them; the ones taken out are dead, in a packet of their own (or this
   * one, when nothing is left), with the reason as its verdict.
   */
  private skipFunctions(run: ActiveRun, task: TaskRow, leaseId: string, skip: Map<string, { code: string; why: string }>, tierIdx: number, slot: number, srTaskId?: string | null) {
    const { store, events } = this.deps;
    const runId = run.row.id;
    const out = task.functions.filter((f) => skip.has(f.rva));
    const keep = task.functions.filter((f) => !skip.has(f.rva));
    const now = Date.now();
    const record = (taskId: string, n: number) => {
      const attempt: Attempt = {
        id: newId('att'), taskId, runId, n, tier: tierIdx, nodeId: run.plan.tiers[tierIdx]!.node.id, accountId: null, model: 'skipped (no model call)', status: 'completed',
        bundleHash: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0,
        latencyMs: 0, error: null, files: null, startedAt: now, finishedAt: now, difficulty: task.difficulty, contextTokens: 0, contextRawTokens: 0,
      };
      store.insertAttempt(attempt);
      const verdict: Verdict = {
        id: newId('vd'), taskId, attemptId: attempt.id, decision: 'reject', route: 'dead_letter', compare: null, exactBytes: 0, createdAt: now,
        findings: out.map((f) => ({ stage: 'worker', code: skip.get(f.rva)!.code, severity: 'block' as const, message: `${f.rva} ${f.name ?? ''}: ${skip.get(f.rva)!.why}` })),
        stages: [{ name: 'skip', ok: false, ms: 0, skipped: false }],
      };
      store.insertVerdict(verdict);
      store.db.prepare('UPDATE tasks SET last_verdict_id = ? WHERE id = ?').run(verdict.id, taskId);
    };
    const moved = store.tx(() => {
      const sr = srTaskId ? { srTaskId } : {};
      if (!keep.length) {
        if (!this.queue.transition(task.id, leaseId, ['leased'], 'dead', sr)) return false;
        record(task.id, task.attemptsTotal + 1);
        return true;
      }
      if (!this.queue.transition(task.id, leaseId, ['leased'], 'pending', { ...sr, notBefore: 0 })) return false;
      const id = newId('task');
      if (!store.narrowTask(task.id, keep)) store.setTaskFunctions(task.id, keep);
      if (task.fix?.check === 'regate') {
        const gone = out.map((f) => ({ rva: f.rva, name: f.name ?? null, why: skip.get(f.rva)!.why }));
        store.db.prepare('UPDATE tasks SET fix_json = ? WHERE id = ?').run(JSON.stringify({ ...task.fix, without: [...(task.fix.without ?? []), ...gone] }), task.id);
      }
      if (store.splitTask(task.id, id, out, { state: 'dead', srTaskId: srTaskId ?? null })) record(id, 1);
      return true;
    });
    if (!moved) return;
    const worker = run.workerBySlot.get(slot);
    if (worker && task.attemptsTotal === 0) this.queue.unassign(runId, worker, task.id);
    const why = [...new Set(out.map((f) => skip.get(f.rva)!.why))];
    events.emit('task.skipped', `skipped ${out.map((f) => f.name ?? f.rva).join(', ')} without a model call: ${why.join('; ').slice(0, 300)}${keep.length ? `; ${keep.length} function(s) of the packet go on` : ''}`, {
      runId, taskId: task.id, data: { skipped: out.map((f) => ({ rva: f.rva, code: skip.get(f.rva)!.code })), kept: keep.length },
    });
    this.stageReadySoon(runId);
    run.wake.notify();
  }

  /**
   * Functions are accepted one by one: when a candidate matched some of the packet's functions and
   * only compare results block the others, the matched ones become a packet of their own, whose
   * first attempt submits that candidate without the others (no model call). The packet goes on
   * with the functions that do not match yet. Nothing is accepted here: the Gate Keeper decides it.
   */
  private splitMatched(run: ActiveRun, task: TaskRow, verdict: Verdict) {
    const { store, events } = this.deps;
    if (task.fix && task.fix.check !== 'regate') return;
    const sides = matchedSides(task, verdict);
    if (!sides) return;
    const id = newId('task');
    const done = store.tx(() => {
      const t = store.getTask(task.id);
      if (!t || (t.state !== 'pending' && t.state !== 'dead') || t.lastVerdictId !== verdict.id) return false;
      return this.splitOff(t, id, sides.matched, sides.rest, verdict.id, { freeOnly: task.fix?.freeOnly, without: task.fix?.without });
    });
    if (!done) return;
    events.emit('task.split', `${sides.matched.map((f) => f.name ?? f.rva).join(', ')} matched; on their own now, re-gated without ${sides.rest.map((f) => f.name ?? f.rva).join(', ')} (no model call), which go on alone`, {
      runId: run.row.id, taskId: id, data: { from: task.id, matched: sides.matched.map((f) => f.rva), rest: sides.rest.map((f) => f.rva) },
    });
    run.wake.notify();
  }

  /** In a transaction: `matched` leave packet `t` as a 're-gate' packet of their own; `rest` stay in it. */
  private splitOff(t: TaskRow, id: string, matched: FunctionTarget[], rest: FunctionTarget[], verdictId: string, opts: { freeOnly?: boolean; without?: BatchFix['without'] } = {}): boolean {
    const { store } = this.deps;
    // The others must come out of the candidate cleanly: accepting their unmatched bodies with it
    // would put them into the unit (and its pull request). Otherwise the packet stays whole.
    const a = store.getAttempt(store.getVerdict(verdictId)?.attemptId ?? '');
    const src = a?.files?.find((f) => f.path === t.unit)?.content;
    if (src === undefined || stillDefines(removeFunctions(src, rest), rest)) return false;
    if (a!.files!.some((f) => f.path !== t.unit && stillDefines(f.content, rest))) return false;
    const fix: BatchFix = {
      batchId: '', seq: 0, check: 'regate', at: Date.now(), verdictId,
      reasons: [`${matched.length} function(s) matched in a candidate that only ${rest.map((f) => f.name ?? f.rva).join(', ')} blocked; that candidate goes to the Gate Keeper again without them`],
      without: [...(opts.without ?? []), ...rest.map((f) => ({ rva: f.rva, name: f.name ?? null, why: 'does not match yet' }))],
      ...(opts.freeOnly ? { freeOnly: true } : {}),
    };
    if (!store.splitTask(t.id, id, matched, { state: 'pending', fix, lastVerdictId: verdictId })) return false;
    if (!store.narrowTask(t.id, rest)) store.setTaskFunctions(t.id, rest);
    store.db.prepare('UPDATE tasks SET best_exact_bytes = 0 WHERE id = ?').run(t.id);
    return true;
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
    // The reviewer's account is out (a quota, an outage): that passes by itself, so wait longer for it.
    const review = verdict?.findings.some((f) => f.code === 'INFRA_REVIEW') ?? false;
    const dead = !opts.slotFault && n >= (review ? Math.max(12, this.opts.maxInfraFailures) : this.opts.maxInfraFailures);
    const backoff = review ? this.opts.infraBackoffMs * 20 : this.opts.infraBackoffMs * Math.max(1, n);
    // Every function matched and only the machinery failed (a preflight that timed out): the next
    // attempt gates that candidate again instead of paying a worker for the same code.
    const keep = verdict && (!task.fix || task.fix.check === 'regate') && this.matchedButBlocked(task, verdict) && store.getAttempt(verdict.attemptId)?.files?.length;
    const moved = store.tx(() => {
      const ok = this.queue.transition(task.id, leaseId, ['leased', 'gating'], dead ? 'dead' : 'pending', dead ? { infraFailures: n } : { infraFailures: n, notBefore: Date.now() + backoff });
      if (verdict) store.insertVerdict({ ...verdict, route: ok ? (dead ? 'dead_letter' : 'retry') : 'stale' });
      if (ok && keep) {
        const fix: BatchFix = {
          ...task.fix, batchId: '', seq: 0, check: 'regate', at: Date.now(), verdictId: verdict.id,
          reasons: [`its functions all matched, but a check could not be run (${msg.slice(0, 200)}); that candidate goes to the Gate Keeper again`],
        };
        store.db.prepare('UPDATE tasks SET fix_json = ?, last_verdict_id = ? WHERE id = ?').run(JSON.stringify(fix), verdict.id, task.id);
      }
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
    // A packet left the queue for good: its unit may be done, and the ready functions may fill a batch.
    if (moved && to !== 'pending') this.stageReadySoon(run.row.id);
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
    const own = new Set(task.functions.map((f) => Number.parseInt(f.rva, 16)));
    const prior = store.verdictsForTask(task.id).filter((v) => v.id !== verdict.id).map((v) => progressScore(v, own)).filter((s): s is number => s !== null);
    const score = progressScore(verdict, own);
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
    // Every function matches and the preflight blocks only on lines that were in the file before
    // this packet: the worker had one retry to change them and could not (or must not: another
    // body needs them). Set it aside, matched, with the reason, instead of retrying forever.
    if (isHeldOnly(verdict) && store.verdictsForTask(task.id).some((v) => v.id !== verdict.id && isHeldOnly(v))) {
      const problems = verdict.findings.filter((x) => x.severity === 'block').map((x) => ({ file: x.file ?? null, line: x.line ?? null, message: x.message }));
      if (this.settle(run, task, leaseId, 'set_aside', { ...common, attemptsTotal, attemptsAtTier, bestExactBytes, noImprovementStreak: 0 }, verdict, 'hold')) {
        store.setHold([task.id], { verdictId: verdict.id, at: Date.now(), problems });
        events.emit('task.held', `HELD ${fnLabel}: every function matches, but the repository preflight blocks on line(s) that were in the file before this packet: ${problems.map((p) => `${p.file ?? '?'}:${p.line ?? '?'}`).join(', ')}; set aside until they are fixed`, {
          runId, taskId: task.id, level: 'warn', data: { problems },
        });
      }
      return;
    }
    // A packet put back only to try its stored candidate again: no model call follows.
    if (task.fix?.freeOnly && task.fix.check === 'rebuild') {
      // Accepted work: it keeps the verdict it passed with, and why the splice did not pass.
      const { lastVerdictId: _reject, ...rest } = common;
      if (this.settle(run, task, leaseId, 'set_aside', { ...rest, attemptsTotal }, verdict, 'hold')) {
        const problems = verdict.findings.filter((x) => x.severity === 'block').map((x) => ({ file: x.file ?? null, line: x.line ?? null, message: x.message }));
        store.setHold([task.id], { verdictId: verdict.id, at: Date.now(), problems });
        events.emit('task.held', `HELD ${fnLabel}: its splice into upstream's current file does not pass (${summarise(verdict)}); set aside again, no model call was made`, { runId, taskId: task.id, level: 'warn', data: { problems } });
      }
      return;
    }
    if (task.fix?.freeOnly) {
      if (this.settle(run, task, leaseId, 'dead', { ...common, attemptsTotal, attemptsAtTier, bestExactBytes }, verdict, 'dead_letter')) events.emit('task.dead', `DEAD ${fnLabel}: the stored candidate does not pass on its own (${summarise(verdict)}); no model call was made`, { runId, taskId: task.id, level: 'warn' });
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

    // One setting decides how long a packet stays on a tier: the flow node's attempts. Neither the
    // run's old "promote after failures" nor the node's "stuck after" moves it on any earlier.
    const exhausted = attemptsAtTier >= limit.maxAttempts || !tierNode.retryLoop;
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
    // A packet sent back from a failed batch check: its first fix attempt reads what the check reported.
    const fix = task.fix && task.fix.verdictId === task.lastVerdictId ? task.fix : undefined;
    return verdict && attempt ? { verdict, attempt, history, ...(fix ? { fix } : {}) } : null;
  }

  /** The packet's RVAs and those of packets of its unit this run accepted (the carried functions). */
  private comparedRvas(runId: string, task: TaskRow): Set<string> {
    const rows = this.deps.store.db
      .prepare(`SELECT json_extract(f.value, '$.rva') rva FROM tasks t, json_each(t.functions_json) f
        WHERE t.run_id = ? AND t.unit = ? AND t.state IN ('passed','staged')`)
      .all(runId, task.unit) as Array<{ rva: string }>;
    return new Set([...task.functions.map((f) => f.rva), ...rows.map((r) => r.rva)]);
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
    // A PR step beside the run (or a rolling batch) may hold the staging worktree: wait for it,
    // still loaded, so no other run starts in between.
    while (this.exclusiveHolder) await this.slotLockFree();
    if (!run.cancel.signal.aborted && this.queue.hasOpenWork(runId)) {
      // That step sent packets back to the agents (a fix): the run goes on instead of finishing.
      this.active.delete(runId);
      await this.start(runId);
      return this.waitFor(runId);
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
      this.releaseSlotLock();
    }
    if (store.getRun(runId)?.status === 'completed') void this.autoPrepare(runId).finally(() => this.curateAfter(run));
  }

  /** Curation runs shadow evaluations on the slots: only once the slot lock is released. */
  private curateAfter(run: ActiveRun) {
    if (this.deps.store.db.open === false) return;
    const runId = run.row.id;
    if (this.deps.store.getRun(runId)?.status === 'completed' && run.row.config.skills.enabled && run.row.config.skills.autoCurate) queueMicrotask(() => this.afterRun?.(runId));
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

/** The source file a dry-run finding names (`path:line: ...`), or null. */
export function findingPath(finding: string): string | null {
  return /^([\w./-]+\.(?:cpp|cc|c|h|hpp|hh|inl|inc)):\d+:/.exec(finding)?.[1] ?? null;
}

/** Why a run is paused for an AI account outage (runs.outage_json). */
export interface OutageInfo {
  since: number;
  /** The earliest time an account's cooldown ends (null: only the operator can bring one back). */
  nextBackAt: number | null;
  accounts: Array<{ id: string; status: string; until: number | null; reason: string | null }>;
}

/** A rolling batch is made once its ready units fill this much of a PR batch (90%, at least one function). */
export function readyThreshold(batchSize: number) {
  return Math.max(1, Math.ceil(batchSize * 0.9));
}

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

/**
 * Every compared function passes and every blocking finding is a preflight problem on a line that
 * was in the file before the packet: the functions are ready, the file is not the packet's to fix.
 */
export function isHeldOnly(v: Verdict): boolean {
  const blocks = v.findings.filter((f) => f.severity === 'block');
  const compare = v.compare ?? [];
  return v.decision === 'reject' && blocks.length > 0 && blocks.every((f) => f.code === 'PREFLIGHT_PREEXISTING') && compare.length > 0 && compare.every((c) => c.result === 'pass');
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

/**
 * The packet's functions a rejected candidate matched and the ones it did not, when compare results
 * alone block it and both sides exist; null otherwise (nothing to accept, or another kind of fault).
 */
export function matchedSides(task: Pick<TaskRow, 'functions'>, v: Verdict): { matched: FunctionTarget[]; rest: FunctionTarget[] } | null {
  if (v.decision !== 'reject' || !v.compare?.length) return null;
  const blocks = v.findings.filter((f) => f.severity === 'block');
  if (!blocks.length || !blocks.every((f) => f.code.startsWith('COMPARE_') && f.code !== 'COMPARE_COMPILE_ERROR')) return null;
  const result = new Map(v.compare.map((c) => [Number.parseInt(c.rva, 16), c.result]));
  if (!task.functions.every((f) => result.has(Number.parseInt(f.rva, 16)))) return null;
  const matched = task.functions.filter((f) => result.get(Number.parseInt(f.rva, 16)) === 'pass');
  const rest = task.functions.filter((f) => !matched.includes(f));
  return matched.length && rest.length ? { matched, rest } : null;
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
