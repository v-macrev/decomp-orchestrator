// SPDX-License-Identifier: AGPL-3.0-or-later
// ShadowEvaluator: the gate between "a curator proposed it" and "workers see it".
//
// For a proposal (new candidate or version + 1) it picks 10–15 historical packets from finished runs
// where the skill's triggers fire — previous failures first, then first-try passes as a regression
// check — and replays each one twice through the real pipeline (bundle → model → materialise →
// Gate Keeper with compare): once with the baseline (without the skill / current version) and once
// with the candidate. Same model tier per case for both arms; holdout is off and the skill under test
// is forced in, so the only difference between arms is the skill text.
//
// Decision: accept when the candidate passes clearly more cases (≥ max(1, 10% of trials) more), or —
// for edits of an existing skill — passes at least as many while sending fewer tokens. Anything else
// discards the edit. Fewer than 3 usable cases is an error (the proposal stays pending).
//
// Runs between bulk runs only (engine.exclusive): it needs worktree slots, and a bulk run's caches
// are never touched by it.
import { createHash } from 'node:crypto';
import { ContextConfig, WorkerOutput, patternsOf, sizeOnlyFeatures, type CapabilityTier, type Difficulty, type FunctionFeatures, type PoolBinding, type SkillsConfig, type Verdict } from '@decomp/core';
import { SkillMatcher, type EvalCase, type MatchableSkill, type MatchContext, type SkillEvalRun } from '@decomp/skills';
import type { Store, TaskRow } from '../db/store.js';
import { GateKeeper } from '../gatekeeper/gatekeeper.js';
import { extractJson } from '../gatekeeper/review.js';
import type { RunEngine } from '../orchestrator/engine.js';
import type { RunSkills, TaskContextBuilder } from '../orchestrator/contextBuilder.js';
import { materialise } from '../orchestrator/edits.js';
import { failureSignals } from '../orchestrator/lessons.js';
import { WORKER_OUTPUT_SCHEMA_V2, renderBundle, type Feedback } from '../orchestrator/prompts.js';
import type { AccountPool } from '../pool/scheduler.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { costUsd } from '../providers/types.js';
import type { RepoAdapter } from '../repo/types.js';
import type { EventBus } from '../telemetry/events.js';
import { Semaphore, newId } from '../util/async.js';
import type { SkillRegistry } from './registry.js';

export interface ShadowDeps {
  store: Store;
  registry: SkillRegistry;
  repo: RepoAdapter;
  pool: AccountPool;
  providers: ProviderRegistry;
  events: EventBus;
  engine: RunEngine;
  context: TaskContextBuilder;
}

export interface ShadowOptions {
  /** Benchmark size (10–15 recommended). */
  cases?: number;
  /** Replays per case and arm (more = less noise, more cost). */
  repeats?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

interface BenchCase {
  task: TaskRow;
  runId: string;
  why: string;
  feedback: Feedback | null;
  exposureConsent: boolean;
  context: ContextConfig;
  compareTimeoutMs: number;
  failedBefore: boolean;
}

const SHADOW_SKILLS: SkillsConfig = { enabled: true, maxDynamic: 2, holdoutRate: 0, coreMaxTokens: 1_500, prewarm: false, autoCurate: false };
const CAP: Record<Difficulty, CapabilityTier> = { easy: 'fast', medium: 'balanced', hard: 'frontier' };
const h = (s: string) => createHash('sha1').update(s).digest('hex');

/** One-sided sign test on discordant pairs: P(X ≥ wins) for X ~ Binomial(wins + losses, ½). */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  let p = 0;
  let c = 1; // C(n, 0)
  for (let k = 0; k <= n; k++) {
    if (k >= wins) p += c;
    c = (c * (n - k)) / (k + 1);
  }
  return Math.min(1, p / 2 ** n);
}

/**
 * Accept a proposal only on evidence. Arms are paired per case, so the test looks at the cases where
 * they disagree (candidate passed and baseline failed = win, the reverse = loss): the gain must be at
 * least max(1, 10% of trials) and unlikely under "no effect" (one-sided sign test, p ≤ 0.15). Edits of
 * an existing skill may also win by holding the pass rate while sending ≥3% fewer tokens.
 */
export function shadowDecision(r: { baselinePass: number; candidatePass: number; baselineTokens: number; candidateTokens: number; trials: number; isNew: boolean; wins?: number; losses?: number }): { accept: boolean; reason: string } {
  const gain = r.candidatePass - r.baselinePass;
  const wins = r.wins ?? Math.max(0, gain);
  const losses = r.losses ?? Math.max(0, -gain);
  const minGain = Math.max(1, Math.round(0.1 * r.trials));
  const p = signTestP(wins, losses);
  const rate = `${r.baselinePass}/${r.trials} → ${r.candidatePass}/${r.trials}`;
  const pair = `${wins} won / ${losses} lost, p=${p.toFixed(2)}`;
  if (gain >= minGain && p <= 0.15) return { accept: true, reason: `pass rate improved ${rate} (${pair})` };
  const saved = r.baselineTokens > 0 ? 1 - r.candidateTokens / r.baselineTokens : 0;
  if (!r.isNew && gain >= 0 && saved >= 0.03) return { accept: true, reason: `pass rate held (${rate}) with ${Math.round(saved * 100)}% fewer context tokens` };
  if (gain > 0) return { accept: false, reason: `improvement not significant (${rate}; ${pair}; needs +${minGain} and p ≤ 0.15)` };
  return { accept: false, reason: r.isNew ? `no improvement (${rate}; ${pair})` : `no improvement and no token saving (${rate}, ${Math.round(saved * 100)}% tokens)` };
}

export class ShadowEvaluator {
  private matcher = new SkillMatcher();
  constructor(private d: ShadowDeps) {}

  async evaluate(skillId: string, version: number, opts: ShadowOptions = {}): Promise<SkillEvalRun> {
    const { registry, events } = this.d;
    const skill = registry.get(skillId);
    const cand = registry.version(skillId, version);
    if (!skill || !cand) throw new Error(`unknown skill version ${skillId}@${version}`);
    if (cand.state !== 'proposed') throw new Error(`${skillId}@v${version} is ${cand.state}, not a pending proposal`);
    const isNew = skill.status === 'candidate';
    const base = isNew ? null : registry.version(skillId, skill.version);
    const evalId = registry.createEval(skillId, version, base?.version ?? null);
    const asMatchable = (v: NonNullable<typeof cand>): MatchableSkill => ({ id: skillId, version: v.version, name: v.name, body: v.body, tokenCount: v.tokenCount, triggers: v.triggers });
    const candSkill = asMatchable(cand);
    const baseSkill = base ? asMatchable(base) : null;
    events.emit('skills.shadow', `shadow evaluation of ${skill.name} v${version} started (${isNew ? 'new skill vs without it' : `v${base!.version} vs v${version}`})`, { data: { skillId, version, evalId } });

    let costTotal = 0;
    try {
      const bench = await this.benchmark(candSkill, baseSkill, opts.cases ?? 12);
      if (bench.length < 3) {
        const reason = `only ${bench.length} historical packet(s) trigger this skill; run a batch that covers its pattern first`;
        registry.finishEval(evalId, { status: 'error', details: [], costUsd: 0, decision: null, reason });
        events.emit('skills.shadow', `shadow evaluation of ${skill.name} v${version}: ${reason}`, { level: 'warn', data: { skillId, version, evalId } });
        return registry.latestEval(skillId, version)!;
      }
      const repeats = Math.max(1, Math.min(4, opts.repeats ?? 1));
      const details: EvalCase[] = await this.d.engine.exclusive(`shadow evaluation of ${skill.name}`, async () => {
        const slots = Math.max(1, Math.min(opts.concurrency ?? 4, this.d.repo.slotCount));
        const gate = new GateKeeper(this.d.repo, new Semaphore(slots), null);
        const queue = bench.flatMap((c) => Array.from({ length: repeats }, (_, r) => ({ c, r })));
        const out: EvalCase[] = [];
        // Both arms see today's registry (core block + other dynamic skills); the skill under test is
        // taken out of the core block and forced in as a dynamic skill, so the arms differ only in it.
        const snapshot = registry.buildSnapshot(SHADOW_SKILLS);
        const others = registry.resolveDynamic(snapshot).filter((s) => s.id !== skillId);
        const keptCore = snapshot.core.filter((c) => c.id !== skillId);
        const coreSnap = keptCore.length === snapshot.core.length ? snapshot : { ...snapshot, core: [], coreText: '', coreHash: '' };
        const skillsFor = (arm: MatchableSkill | null): RunSkills => ({
          snapshot: coreSnap,
          dynamic: arm ? [...others, arm] : others,
          config: SHADOW_SKILLS,
          reserveRetrySlot: false, replacesCookbookLessons: false, holdout: false,
          force: arm ? [skillId] : [], suppress: arm ? [] : [skillId],
        });
        const worker = async (slot: number) => {
          for (;;) {
            const next = queue.shift();
            if (!next) return;
            const { c, r } = next;
            const run = async (arm: MatchableSkill | null) => {
              const res = await this.arm(c, slot, skillsFor(arm), gate, skillId, opts.signal);
              costTotal += res.cost;
              return res;
            };
            // Alternate arm order per repeat so slot warm-up effects cannot favour one arm.
            let bb: Awaited<ReturnType<typeof run>>;
            let kk: Awaited<ReturnType<typeof run>>;
            if (r % 2 === 0) {
              bb = await run(baseSkill);
              kk = await run(candSkill);
            } else {
              kk = await run(candSkill);
              bb = await run(baseSkill);
            }
            out.push({
              taskId: c.task.id, runId: c.runId, label: `${c.task.functions.map((f) => f.name ?? f.rva).join(', ')}${repeats > 1 ? ` #${r + 1}` : ''}`,
              difficulty: c.task.difficulty, why: c.why,
              baseline: { pass: bb.pass, exactBytes: bb.exact, tokens: bb.tokens, skillInjected: bb.injected, error: bb.error },
              candidate: { pass: kk.pass, exactBytes: kk.exact, tokens: kk.tokens, skillInjected: kk.injected, error: kk.error },
            });
          }
        };
        await Promise.all(Array.from({ length: slots }, (_, i) => worker(i)));
        return out;
      });
      const usable = details.filter((c) => !c.baseline.error && !c.candidate.error);
      if (usable.length < 3) {
        const reason = `only ${usable.length} replay(s) completed (${details.length - usable.length} errored)`;
        registry.finishEval(evalId, { status: 'error', details, costUsd: costTotal, decision: null, reason });
        return registry.latestEval(skillId, version)!;
      }
      const sum = (f: (c: EvalCase) => number) => usable.reduce((s, c) => s + f(c), 0);
      const d = shadowDecision({
        baselinePass: sum((c) => +c.baseline.pass), candidatePass: sum((c) => +c.candidate.pass),
        baselineTokens: sum((c) => c.baseline.tokens), candidateTokens: sum((c) => c.candidate.tokens), trials: usable.length, isNew,
        wins: sum((c) => +(c.candidate.pass && !c.baseline.pass)), losses: sum((c) => +(c.baseline.pass && !c.candidate.pass)),
      });
      registry.finishEval(evalId, { status: d.accept ? 'passed' : 'failed', details, costUsd: costTotal, decision: d.accept ? 'accept' : 'reject', reason: d.reason });
      if (d.accept) registry.accept(skillId, version, evalId, `shadow evaluation: ${d.reason}`);
      else registry.reject(skillId, version, evalId, d.reason);
      events.emit('skills.shadow', `${skill.name} v${version}: ${d.accept ? 'ACCEPTED' : 'rejected'}: ${d.reason} ($${costTotal.toFixed(3)})`, { level: d.accept ? 'info' : 'warn', data: { skillId, version, evalId, accept: d.accept } });
      await this.releaseClaims(bench);
      return registry.latestEval(skillId, version)!;
    } catch (e) {
      registry.finishEval(evalId, { status: 'error', details: [], costUsd: costTotal, decision: null, reason: (e as Error).message });
      events.emit('skills.shadow', `shadow evaluation of ${skill.name} v${version} failed: ${(e as Error).message}`, { level: 'error', data: { skillId, version, evalId } });
      return registry.latestEval(skillId, version)!;
    }
  }

  /** Historical packets where the candidate (or the version it replaces) fires. */
  private async benchmark(cand: MatchableSkill, base: MatchableSkill | null, n: number): Promise<BenchCase[]> {
    const { store } = this.d;
    const rows = store.db.prepare(`SELECT t.id FROM tasks t JOIN runs r ON r.id = t.run_id
      WHERE r.status IN ('completed', 'cancelled', 'failed') AND t.attempts_total > 0 AND t.state IN ('passed', 'staged', 'dead', 'quarantined', 'cancelled')
      ORDER BY t.updated_at DESC LIMIT 800`).all() as Array<{ id: string }>;
    const failed: BenchCase[] = [];
    const passed: BenchCase[] = [];
    const runs = new Map<string, ReturnType<Store['getRun']>>();
    for (const { id } of rows) {
      const task = store.getTask(id);
      if (!task || task.state === 'quarantined') continue; // quarantine = cheating, not difficulty
      if (!runs.has(task.runId)) runs.set(task.runId, store.getRun(task.runId));
      const run = runs.get(task.runId);
      if (!run) continue;
      const verdicts = store.verdictsForTask(task.id);
      const firstFail = verdicts.find((v) => v.decision !== 'pass') ?? null;
      const failedBefore = task.state !== 'passed' && task.state !== 'staged' ? true : task.attemptsTotal >= 2;
      const ctx = await this.matchContext(task, firstFail);
      const hit = this.matcher.evaluate(cand, ctx) ?? (base ? this.matcher.evaluate(base, ctx) : null);
      if (!hit) continue;
      const attempt = firstFail ? store.getAttempt(firstFail.attemptId) : null;
      const replayRetry = hit.placement === 'retry' && firstFail && attempt;
      const c: BenchCase = {
        task, runId: task.runId, failedBefore,
        why: `${failedBefore ? (task.state === 'dead' ? 'dead-lettered' : `passed after ${task.attemptsTotal} attempts`) : 'passed first try'}; triggers ${hit.matched.join('+')}${replayRetry ? '; replayed as a retry of the first failure' : ''}`,
        feedback: replayRetry ? { verdict: firstFail!, attempt: attempt! } : null,
        exposureConsent: run.config.exposureConsent,
        context: run.config.context.mode === 'budgeted' ? run.config.context : ContextConfig.parse({}),
        compareTimeoutMs: run.config.compareTimeoutMs,
      };
      (failedBefore ? failed : passed).push(c);
    }
    // Deterministic order per skill: the same proposal is benchmarked on the same packets.
    const order = (a: BenchCase, b: BenchCase) => h(`${cand.id}:${a.task.id}`).localeCompare(h(`${cand.id}:${b.task.id}`));
    failed.sort(order);
    passed.sort(order);
    // Mostly previous failures (where a skill can show it helps), a quarter first-try passes (regressions).
    const wantPassed = Math.min(passed.length, Math.max(Math.ceil(n / 4), n - failed.length));
    return [...failed.slice(0, n - wantPassed), ...passed.slice(0, wantPassed)];
  }

  private async matchContext(task: TaskRow, firstFail: Verdict | null): Promise<MatchContext> {
    const feats: FunctionFeatures[] = task.functions.map((f) => task.assessment?.functions?.[f.rva] ?? (task.assessment && task.functions.length === 1 ? task.assessment.features : null) ?? sizeOnlyFeatures(f.size));
    let listing: string | null = null;
    if (this.d.repo.packFor && this.d.repo.readPackSlice) {
      const parts: string[] = [];
      for (const f of task.functions) {
        const pack = await this.d.repo.packFor(f).catch(() => null);
        const s = pack ? await this.d.repo.readPackSlice(pack, 200_000).catch(() => null) : null;
        if (s) parts.push(s.text);
      }
      listing = parts.length ? parts.join('\n') : null;
    }
    const classes = task.functions.flatMap((f) => (f.name?.includes('::') ? [f.name.split('::').slice(-2, -1)[0]!] : []));
    const failures = failureSignals(firstFail);
    return {
      taskId: task.id, difficulty: task.difficulty,
      functions: task.functions.map((f, i) => ({ name: f.name, features: feats[i]! })),
      patterns: [...new Set(task.functions.flatMap((f, i) => patternsOf(feats[i]!, f.name)))],
      symbols: [...new Set([...task.functions.flatMap((f) => (f.name ? [f.name] : [])), ...classes])],
      listing, failures: failures.length ? failures : null,
    };
  }

  /** One replay: fresh worktree → prepare → bundle → model → materialise → Gate Keeper. */
  private async arm(c: BenchCase, slot: number, skills: RunSkills, gate: GateKeeper, skillId: string, outer?: AbortSignal) {
    const { repo, pool, providers, context } = this.d;
    const signal = AbortSignal.any([AbortSignal.timeout(20 * 60_000), ...(outer ? [outer] : [])]);
    const attemptNo = c.feedback ? 2 : 1;
    const task: TaskRow = { ...c.task, attemptsTotal: attemptNo - 1, attemptsAtTier: 0, cheatStrikes: 0, lastVerdictId: null, state: 'leased' };
    const res = { pass: false, exact: 0, tokens: 0, injected: false, error: null as string | null, cost: 0 };
    try {
      await repo.reset(slot);
      const prepared = await repo.prepare(slot, task, { draftedBy: 'shadow-eval', model: 'shadow', signal });
      const bundle = await context.build(task, prepared, slot, {
        runId: `shadow:${skillId}`, exposureConsent: c.exposureConsent, carried: [], attemptNo, feedback: c.feedback, pitfalls: [], context: c.context, skills,
      });
      res.tokens = bundle.tokens.sent;
      res.injected = bundle.skills.some((s) => s.skillId === skillId && s.injected);
      const r = renderBundle(bundle, attemptNo, false);
      const binding: PoolBinding = { strategy: 'pool', accountIds: [], tags: [], capability: CAP[task.difficulty] };
      const lease = await pool.acquire({ binding, role: 'worker', estInputTokens: bundle.tokens.sent, estOutputTokens: 4_000 }, signal);
      const t0 = Date.now();
      let text: string;
      try {
        const resp = await providers.complete(lease.account, {
          system: r.system, prompt: r.prompt, blocks: r.blocks, cacheKey: `decomp-shadow:${bundle.staticPrefixHash.slice(0, 24)}`, model: lease.model,
          jsonSchema: WORKER_OUTPUT_SCHEMA_V2, maxOutputTokens: Math.min(16_000, lease.model.maxOutputTokens), timeoutMs: 15 * 60_000, signal,
        });
        pool.release(lease, { kind: 'ok', usage: resp.usage, latencyMs: Date.now() - t0, rateLimit: resp.rateLimit });
        res.cost = costUsd(lease.model, resp.usage);
        text = resp.text;
      } catch (e) {
        pool.release(lease, { kind: (e as { kind?: never }).kind ?? 'network', message: (e as Error).message, latencyMs: Date.now() - t0 });
        throw e;
      }
      const parsed = WorkerOutput.safeParse(extractJson(text));
      if (!parsed.success) return res; // a contract failure is a fail, not an error
      const mat = await materialise(parsed.data, (p) => repo.readFile(slot, p));
      if (mat.problems.length) return res;
      const g = await gate.evaluate({
        task, attemptId: newId('shadow'), slot, prepared, files: mat.files, compareTimeoutMs: c.compareTimeoutMs, signal, carried: new Map(),
        checks: { scope: true, leak: true, cheat: true, integrity: true, repoCompare: true, repoPreflight: true, llmReview: false },
      });
      if (g.infra) res.error = 'infrastructure failure during compare';
      res.pass = g.verdict.decision === 'pass';
      res.exact = g.verdict.exactBytes;
      return res;
    } catch (e) {
      res.error = (e as Error).message.slice(0, 300);
      return res;
    } finally {
      await repo.reset(slot).catch(() => undefined);
    }
  }

  /** Replays re-claim functions through prepare; give back those no run will submit. */
  private async releaseClaims(bench: BenchCase[]) {
    if (!this.d.repo.releaseClaims) return;
    const rvas = bench.filter((c) => c.task.state === 'dead' || c.task.state === 'cancelled').flatMap((c) => c.task.functions.map((f) => f.rva));
    if (rvas.length) await this.d.repo.releaseClaims([...new Set(rvas)], 'decomp-orchestrator: shadow evaluation replay').catch(() => undefined);
  }
}
