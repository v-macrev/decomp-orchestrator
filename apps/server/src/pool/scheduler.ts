// SPDX-License-Identifier: AGPL-3.0-or-later
// Multi-account, rate-limit-aware scheduler.
//
// Each account carries:
//   * three token buckets (requests/min, input tokens/min, output tokens/min), reserved from
//     estimates on acquire and reconciled with actual usage on release; clamped to the provider's
//     own "remaining" headers when it reports them;
//   * an adaptive concurrency limit (AIMD): +1/limit per success, halved on every 429, never above
//     the configured cap — so unknown or shifting provider limits are discovered, not guessed;
//   * a health state machine: ok → cooling (429, honours retry-after, exponential backoff without
//     it) → ok; ok → circuit_open (N consecutive 5xx/timeouts) → half_open (single probe) → ok/open
//     with doubled open time; quota_exhausted (billing/credits/daily budget) until reset;
//     disabled (auth failure) until an operator re-enables it.
// Request-caused failures (400, refusals, our own aborts) never penalise an account.
//
// acquire() never fails because one account is throttled: it scores every eligible account in the
// binding and only waits when none can admit the request, sleeping exactly until the earliest
// account becomes eligible or a lease is released.
import type { Account, AccountRuntime, AccountStatus, ModelSpec, PoolBinding, Role, Usage } from '@decomp/core';
import type { Store } from '../db/store.js';
import type { EventBus } from '../telemetry/events.js';
import { AbortedError, Notifier, jitter, newId, utcDay } from '../util/async.js';
import { costUsd, type OutcomeKind, type RateLimitInfo } from '../providers/types.js';
import { TokenBucket } from './tokenBucket.js';

export interface AcquireRequest {
  binding: PoolBinding;
  role: Role;
  estInputTokens: number;
  estOutputTokens: number;
  /** Accounts to avoid for this request (e.g. the one that just refused or failed it). */
  avoid?: string[];
}

export interface Lease {
  id: string;
  account: Account;
  model: ModelSpec;
  reservedIn: number;
  reservedOut: number;
  probe: boolean;
  startedAt: number;
}

export interface Outcome {
  kind: OutcomeKind;
  usage?: Usage;
  latencyMs?: number;
  retryAfterMs?: number;
  message?: string;
  rateLimit?: RateLimitInfo;
}

export interface SchedulerOptions {
  failureThreshold: number; // consecutive failures that open the circuit
  circuitBaseMs: number;
  circuitMaxMs: number;
  rateLimitBaseMs: number; // backoff when a 429 carries no retry-after
  rateLimitMaxMs: number;
  overloadCooldownMs: number;
  quotaCooldownMs: number;
  /** Fraction of the estimated output reserved up front against the output-token bucket. */
  outputReserveFraction: number;
  persistEveryMs: number;
}

const DEFAULTS: SchedulerOptions = {
  failureThreshold: 4,
  circuitBaseMs: 30_000,
  circuitMaxMs: 10 * 60_000,
  rateLimitBaseMs: 10_000,
  rateLimitMaxMs: 5 * 60_000,
  overloadCooldownMs: 5_000,
  quotaCooldownMs: 60 * 60_000,
  outputReserveFraction: 0.5,
  persistEveryMs: 1_000,
};

export class NoEligibleAccountError extends Error {}

class AccountSlot {
  rpm: TokenBucket;
  itpm: TokenBucket;
  otpm: TokenBucket;
  limit: number; // AIMD concurrency limit (float)
  inFlight = 0;
  probeInFlight = false;
  openCount = 0;
  rateLimitStreak = 0;
  rt: AccountRuntime;

  constructor(public account: Account, now: () => number, saved?: AccountRuntime) {
    const l = account.limits;
    this.rpm = TokenBucket.perMinute(l.requestsPerMinute, now);
    this.itpm = TokenBucket.perMinute(l.inputTokensPerMinute, now);
    this.otpm = TokenBucket.perMinute(l.outputTokensPerMinute, now);
    this.limit = l.maxConcurrency;
    const t = now();
    this.rt = saved
      ? { ...saved, inFlight: 0 }
      : {
          accountId: account.id, status: 'ok', cooldownUntil: null, inFlight: 0, consecutiveFailures: 0,
          requestsTotal: 0, failuresTotal: 0, rateLimitedTotal: 0, inputTokensTotal: 0, outputTokensTotal: 0,
          costUsdToday: 0, costDay: utcDay(t), ewmaLatencyMs: null, lastError: null, updatedAt: t,
        };
    if (!account.enabled) this.rt.status = 'disabled';
  }

  get errorRate() {
    return this.rt.requestsTotal ? this.rt.failuresTotal / this.rt.requestsTotal : 0;
  }
}

export interface AccountView extends AccountRuntime {
  label: string;
  provider: string;
  workspace: string | null;
  tags: string[];
  enabled: boolean;
  concurrencyLimit: number;
  maxConcurrency: number;
  headroom: { requests: number; inputTokens: number; outputTokens: number };
  models: string[];
}

export class AccountPool {
  private slots = new Map<string, AccountSlot>();
  private released = new Notifier();
  private opts: SchedulerOptions;
  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    accounts: Account[],
    private store: Store | null,
    private events: EventBus | null,
    opts: Partial<SchedulerOptions> = {},
    private now: () => number = Date.now,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.setAccounts(accounts);
    if (store) this.persistTimer = setInterval(() => this.flush(), this.opts.persistEveryMs).unref();
  }

  /** Hot-reload the account set; runtime state of surviving accounts is preserved. */
  setAccounts(accounts: Account[]) {
    const saved = new Map((this.store?.loadRuntime() ?? []).map((r) => [r.accountId, r]));
    const next = new Map<string, AccountSlot>();
    for (const a of accounts) {
      const prev = this.slots.get(a.id);
      if (prev) {
        const limitsChanged = JSON.stringify(prev.account.limits) !== JSON.stringify(a.limits);
        const slot = limitsChanged ? new AccountSlot(a, this.now, prev.rt) : prev;
        slot.account = a;
        slot.inFlight = prev.inFlight;
        if (!a.enabled) slot.rt.status = 'disabled';
        else if (slot.rt.status === 'disabled' && prev.account.enabled === false) this.setStatus(slot, 'ok', null);
        next.set(a.id, slot);
      } else {
        next.set(a.id, new AccountSlot(a, this.now, saved.get(a.id)));
      }
    }
    this.slots = next;
    this.released.notify();
  }

  // ---------------------------------------------------------------- selection

  /** Accounts + model a binding resolves to for a role (ignores health). */
  resolve(binding: PoolBinding, role: Role): Array<{ slot: AccountSlot; model: ModelSpec }> {
    const out: Array<{ slot: AccountSlot; model: ModelSpec }> = [];
    for (const slot of this.slots.values()) {
      const a = slot.account;
      if (binding.strategy === 'bound') {
        if (!binding.accountIds.includes(a.id)) continue;
      } else if (binding.tags.length && !binding.tags.every((t) => a.tags.includes(t))) continue;
      const model = binding.model ? a.models.find((m) => m.id === binding.model) : a.models.find((m) => m.roles.includes(role));
      if (model) out.push({ slot, model });
    }
    return out;
  }

  private refresh(slot: AccountSlot) {
    const t = this.now();
    const rt = slot.rt;
    if (rt.costDay !== utcDay(t)) {
      rt.costDay = utcDay(t);
      rt.costUsdToday = 0;
      if (rt.status === 'quota_exhausted' && rt.lastError?.startsWith('daily budget')) this.setStatus(slot, 'ok', null);
    }
    if (rt.cooldownUntil !== null && rt.cooldownUntil <= t) {
      if (rt.status === 'cooling' || rt.status === 'quota_exhausted') this.setStatus(slot, 'ok', null);
      else if (rt.status === 'circuit_open') this.setStatus(slot, 'half_open', null);
    }
  }

  private admits(slot: AccountSlot, req: AcquireRequest): { ok: true } | { ok: false; waitMs: number } {
    const rt = slot.rt;
    const t = this.now();
    if (rt.status === 'disabled') return { ok: false, waitMs: Infinity };
    if (rt.status === 'cooling' || rt.status === 'circuit_open' || rt.status === 'quota_exhausted') {
      return { ok: false, waitMs: Math.max(1, (rt.cooldownUntil ?? t + 60_000) - t) };
    }
    if (rt.status === 'half_open' && slot.probeInFlight) return { ok: false, waitMs: 1_000 };
    const budget = slot.account.limits.dailyBudgetUsd;
    if (budget !== undefined && rt.costUsdToday >= budget) return { ok: false, waitMs: Infinity };
    const cap = rt.status === 'half_open' ? 1 : Math.max(1, Math.floor(slot.limit));
    if (slot.inFlight >= cap) return { ok: false, waitMs: 5_000 }; // woken early by release()
    const outRes = Math.ceil(req.estOutputTokens * this.opts.outputReserveFraction);
    const w = Math.max(slot.rpm.timeUntil(1), slot.itpm.timeUntil(req.estInputTokens), slot.otpm.timeUntil(outRes));
    return w > 0 ? { ok: false, waitMs: w } : { ok: true };
  }

  private score(slot: AccountSlot): number {
    const head = Math.min(slot.rpm.headroom, slot.itpm.headroom, slot.otpm.headroom);
    const free = 1 - slot.inFlight / Math.max(1, slot.limit);
    const lat = (slot.rt.ewmaLatencyMs ?? 20_000) / 10_000;
    return slot.account.priority * 1000 + 60 * head + 30 * free - 40 * slot.errorRate - lat + Math.random() * 3;
  }

  tryAcquire(req: AcquireRequest): { lease: Lease } | { waitMs: number; reason: string } {
    const cands = this.resolve(req.binding, req.role);
    if (!cands.length) throw new NoEligibleAccountError(`no account/model serves role "${req.role}" for binding ${JSON.stringify(req.binding)}`);
    let best: { slot: AccountSlot; model: ModelSpec; s: number } | null = null;
    let minWait = Infinity;
    const reasons: string[] = [];
    const avoid = new Set(req.avoid ?? []);
    const pool = cands.length > avoid.size ? cands.filter((c) => !avoid.has(c.slot.account.id)) : cands;
    for (const { slot, model } of pool) {
      this.refresh(slot);
      const a = this.admits(slot, req);
      if (a.ok) {
        const s = this.score(slot);
        if (!best || s > best.s) best = { slot, model, s };
      } else {
        minWait = Math.min(minWait, a.waitMs);
        reasons.push(`${slot.account.id}:${slot.rt.status}`);
      }
    }
    if (!best) return { waitMs: minWait, reason: reasons.join(' ') };
    const { slot, model } = best;
    const outRes = Math.ceil(req.estOutputTokens * this.opts.outputReserveFraction);
    slot.rpm.tryTake(1);
    slot.itpm.adjust(-req.estInputTokens);
    slot.otpm.adjust(-outRes);
    slot.inFlight++;
    const probe = slot.rt.status === 'half_open';
    if (probe) slot.probeInFlight = true;
    slot.rt.inFlight = slot.inFlight;
    this.dirty = true;
    return { lease: { id: newId('acq'), account: slot.account, model, reservedIn: req.estInputTokens, reservedOut: outRes, probe, startedAt: this.now() } };
  }

  /** Wait until some account in the binding can take the request. Throws AbortedError on abort. */
  async acquire(req: AcquireRequest, signal?: AbortSignal, onWait?: (ms: number, reason: string) => void): Promise<Lease> {
    for (;;) {
      if (signal?.aborted) throw new AbortedError();
      const r = this.tryAcquire(req);
      if ('lease' in r) return r.lease;
      const ms = Number.isFinite(r.waitMs) ? Math.min(Math.max(r.waitMs, 25), 2_000) : 2_000;
      onWait?.(r.waitMs, r.reason);
      await this.released.wait(ms, signal);
    }
  }

  // ---------------------------------------------------------------- release

  release(lease: Lease, out: Outcome) {
    const slot = this.slots.get(lease.account.id);
    if (!slot) return; // account removed mid-flight
    const o = this.opts;
    const rt = slot.rt;
    const t = this.now();
    slot.inFlight = Math.max(0, slot.inFlight - 1);
    rt.inFlight = slot.inFlight;
    if (lease.probe) slot.probeInFlight = false;
    rt.updatedAt = t;

    // Reconcile reservations with actual usage (refund or go into debt).
    const u = out.usage;
    if (u) {
      slot.itpm.adjust(lease.reservedIn - u.inputTokens);
      slot.otpm.adjust(lease.reservedOut - u.outputTokens);
      rt.inputTokensTotal += u.inputTokens;
      rt.outputTokensTotal += u.outputTokens;
      const c = costUsd(lease.model, u);
      if (rt.costDay !== utcDay(t)) {
        rt.costDay = utcDay(t);
        rt.costUsdToday = 0;
      }
      rt.costUsdToday += c;
    } else {
      slot.itpm.adjust(lease.reservedIn);
      slot.otpm.adjust(lease.reservedOut);
    }
    if (out.rateLimit) {
      const rl = out.rateLimit;
      if (rl.requestsRemaining !== undefined) slot.rpm.clampTo(rl.requestsRemaining);
      if (rl.inputTokensRemaining !== undefined) slot.itpm.clampTo(rl.inputTokensRemaining);
      if (rl.outputTokensRemaining !== undefined) slot.otpm.clampTo(rl.outputTokensRemaining);
    }

    const penalise = !['bad_request', 'refusal', 'aborted'].includes(out.kind);
    if (penalise || out.kind === 'refusal') rt.requestsTotal++;

    switch (out.kind) {
      case 'ok':
      case 'refusal':
      case 'bad_request': {
        rt.consecutiveFailures = 0;
        slot.rateLimitStreak = 0;
        if (out.kind === 'ok') slot.limit = Math.min(slot.account.limits.maxConcurrency, slot.limit + 1 / Math.max(1, slot.limit));
        if (out.latencyMs !== undefined) rt.ewmaLatencyMs = rt.ewmaLatencyMs === null ? out.latencyMs : rt.ewmaLatencyMs * 0.8 + out.latencyMs * 0.2;
        if (rt.status === 'half_open') {
          slot.openCount = 0;
          this.setStatus(slot, 'ok', null);
        }
        break;
      }
      case 'rate_limited': {
        rt.rateLimitedTotal++;
        slot.rateLimitStreak++;
        slot.limit = Math.max(1, slot.limit / 2);
        slot.rpm.drain();
        const backoff = out.retryAfterMs ?? jitter(Math.min(o.rateLimitMaxMs, o.rateLimitBaseMs * 2 ** (slot.rateLimitStreak - 1)));
        this.cool(slot, 'cooling', backoff, `rate limited${out.message ? `: ${out.message}` : ''}`);
        break;
      }
      case 'quota': {
        rt.failuresTotal++;
        this.cool(slot, 'quota_exhausted', out.retryAfterMs ?? o.quotaCooldownMs, `quota: ${out.message ?? 'exhausted'}`);
        break;
      }
      case 'auth': {
        rt.failuresTotal++;
        this.setStatus(slot, 'disabled', `auth: ${out.message ?? 'rejected'}`);
        break;
      }
      case 'overloaded':
      case 'server_error':
      case 'timeout':
      case 'network': {
        rt.failuresTotal++;
        rt.consecutiveFailures++;
        const msg = `${out.kind}${out.message ? `: ${out.message}` : ''}`;
        if (rt.status === 'half_open' || rt.consecutiveFailures >= o.failureThreshold) {
          const ms = Math.min(o.circuitMaxMs, o.circuitBaseMs * 2 ** slot.openCount);
          slot.openCount++;
          this.cool(slot, 'circuit_open', jitter(ms, 0.1), msg);
        } else if (out.kind === 'overloaded') {
          this.cool(slot, 'cooling', out.retryAfterMs ?? jitter(o.overloadCooldownMs), msg);
        } else {
          rt.lastError = msg;
        }
        break;
      }
      case 'aborted':
        break;
    }

    const budget = slot.account.limits.dailyBudgetUsd;
    if (budget !== undefined && rt.costUsdToday >= budget && rt.status !== 'disabled') {
      const midnight = Date.parse(`${utcDay(t)}T00:00:00Z`) + 86_400_000;
      this.cool(slot, 'quota_exhausted', midnight - t, `daily budget $${budget} reached`);
    }
    this.dirty = true;
    this.released.notify();
  }

  private cool(slot: AccountSlot, status: AccountStatus, ms: number, reason: string) {
    slot.rt.cooldownUntil = this.now() + Math.max(0, ms);
    this.setStatus(slot, status, reason);
  }

  private setStatus(slot: AccountSlot, status: AccountStatus, reason: string | null) {
    const prev = slot.rt.status;
    slot.rt.status = status;
    if (status === 'ok') slot.rt.cooldownUntil = null;
    if (reason !== null) slot.rt.lastError = reason;
    this.dirty = true;
    if (prev !== status) {
      const level = status === 'ok' || status === 'half_open' ? 'info' : status === 'cooling' ? 'warn' : 'error';
      this.events?.emit('account.status', `${slot.account.id}: ${prev} → ${status}${reason ? ` (${reason})` : ''}`, {
        level,
        data: { accountId: slot.account.id, from: prev, to: status, cooldownUntil: slot.rt.cooldownUntil, reason },
      });
    }
  }

  // ---------------------------------------------------------------- operator + views

  operatorEnable(id: string) {
    const s = this.slots.get(id);
    if (!s) return false;
    s.rt.consecutiveFailures = 0;
    s.openCount = 0;
    this.setStatus(s, 'ok', 'enabled by operator');
    this.released.notify();
    return true;
  }
  operatorDisable(id: string) {
    const s = this.slots.get(id);
    if (!s) return false;
    this.setStatus(s, 'disabled', 'disabled by operator');
    return true;
  }

  view(): AccountView[] {
    return [...this.slots.values()].map((s) => {
      this.refresh(s);
      return {
        ...s.rt,
        label: s.account.label, provider: s.account.provider, workspace: s.account.workspace ?? null, tags: s.account.tags,
        enabled: s.account.enabled, concurrencyLimit: Math.round(s.limit * 100) / 100, maxConcurrency: s.account.limits.maxConcurrency,
        headroom: { requests: round2(s.rpm.headroom), inputTokens: round2(s.itpm.headroom), outputTokens: round2(s.otpm.headroom) },
        models: s.account.models.map((m) => m.id),
      };
    });
  }

  flush() {
    if (!this.dirty || !this.store) return;
    this.dirty = false;
    this.store.saveRuntime([...this.slots.values()].map((s) => s.rt));
  }

  close() {
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.flush();
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
