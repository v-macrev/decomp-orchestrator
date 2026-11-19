// SPDX-License-Identifier: AGPL-3.0-or-later
// SkillCurator: the closed loop that creates, patches and cost-optimises skills between runs.
//
//   bootstrap  repo history → candidates: cookbook recipes (deterministic triggers; a model drafts
//              triggers for the rest) + clusters of PR review corrections (model-synthesised)
//   mine       retry wins of a run (attempts ≥ 2, passed) → frontier model → candidate skills
//   update     injected failures grouped by (skill version, category, code); ≥ 3 → version + 1
//              (tighten false-positive triggers, or add the missing rule)
//   optimize   >25% coverage → promoted_to_core (next run: cached-prefix price) · compress bloated
//              bodies (proposal) · deprecate skills with clearly negative lift
//   evaluate   every pending proposal goes through the ShadowEvaluator; only winners are used
//
// One job at a time, recorded in skill_jobs and streamed as skills.* events. Nothing here touches a
// running bulk run: snapshots are frozen per run, and shadow evaluation waits for idle slots.
import type { Verdict } from '@decomp/core';
import { clearlyHarmful, compressSkillBody, draftsFromCookbook, estimateTokens, parseCookbook, sanitizeSkillText, scanSkillBody, type JobKind, type SkillDraft, type SkillJob } from '@decomp/skills';
import type { Store, TaskRow } from '../db/store.js';
import { extractFunctions, lex } from '../gatekeeper/cpp.js';
import { tagText } from '../intel/ruleDistiller.js';
import type { RunEngine } from '../orchestrator/engine.js';
import { FINDING_GUIDANCE, failureSignals, primaryFailure } from '../orchestrator/lessons.js';
import type { RepoAdapter } from '../repo/types.js';
import type { EventBus } from '../telemetry/events.js';
import { runBounded } from '../util/proc.js';
import type { SkillRegistry } from './registry.js';
import type { ShadowEvaluator, ShadowOptions } from './shadow.js';
import { CompressReply, MinedSkills, PatchReply, type CuratorModel } from './synth.js';

export interface CuratorDeps {
  store: Store;
  registry: SkillRegistry;
  repo: RepoAdapter;
  events: EventBus;
  engine: RunEngine;
  shadow: ShadowEvaluator;
  model: CuratorModel;
  cwd: string;
}

export interface CuratorOptions {
  /** Optimizer: share of a run's functions above which an active skill moves into the core prefix. */
  coreCoverage?: number;
  /** Optimizer: bodies above this many tokens get a compression proposal. */
  compressAbove?: number;
  /** Updater: injected failures with one (category, code) needed for a patch. */
  clusterMin?: number;
  shadow?: ShadowOptions;
}

type Work = { summary: Record<string, unknown>; costUsd: number };
const flat = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export class SkillCurator {
  private busy: JobKind | null = null;
  readonly opts: Required<Omit<CuratorOptions, 'shadow'>> & { shadow: ShadowOptions };

  constructor(private d: CuratorDeps, opts: CuratorOptions = {}) {
    this.opts = { coreCoverage: opts.coreCoverage ?? 0.25, compressAbove: opts.compressAbove ?? 300, clusterMin: opts.clusterMin ?? 3, shadow: opts.shadow ?? {} };
  }

  status() {
    return { busy: this.busy, modelAvailable: this.d.model.available(), engineIdle: this.d.engine.isIdle() };
  }

  /** Start a job in the background. Throws when another curator job is running. */
  run(kind: JobKind, args: { runId?: string; github?: boolean; repoSlug?: string; useModel?: boolean; skillId?: string; version?: number; evaluate?: boolean } = {}): { jobId: string; done: Promise<SkillJob> } {
    if (this.busy) throw new Error(`the curator is busy (${this.busy})`);
    const { registry, events } = this.d;
    const jobId = registry.startJob(kind);
    this.busy = kind;
    events.emit('skills.job', `skill curator: ${kind} started`, { data: { jobId, kind } });
    const work = (): Promise<Work> => {
      switch (kind) {
        case 'bootstrap': return this.bootstrap(args);
        case 'mine': return this.mine(args.runId, args.evaluate ?? true);
        case 'update': return this.update(args.runId, args.evaluate ?? true);
        case 'optimize': return this.optimize(args.runId, args.evaluate ?? true);
        case 'shadow': return args.skillId && args.version ? this.evaluateOne(args.skillId, args.version) : this.evaluatePending();
        case 'curate': return this.curate(args.runId);
      }
    };
    const done = work()
      .then((r) => {
        registry.finishJob(jobId, { summary: r.summary, costUsd: r.costUsd });
        events.emit('skills.job', `skill curator: ${kind} finished ${summaryLine(r.summary)} ($${r.costUsd.toFixed(3)})`, { data: { jobId, kind, ...r.summary } });
      })
      .catch((e: Error) => {
        registry.finishJob(jobId, { summary: {}, error: e.message });
        events.emit('skills.job', `skill curator: ${kind} failed: ${e.message}`, { level: 'error', data: { jobId, kind } });
      })
      .finally(() => {
        this.busy = null;
      })
      .then(() => registry.jobs(10).find((j) => j.id === jobId)!);
    return { jobId, done };
  }

  latestRun(): string | null {
    const r = this.d.store.db.prepare(`SELECT id FROM runs WHERE status IN ('completed', 'cancelled', 'failed') ORDER BY COALESCE(finished_at, updated_at) DESC LIMIT 1`).get() as { id: string } | undefined;
    return r?.id ?? null;
  }

  // ------------------------------------------------------------------ 1. bootstrap (repo history)

  private async bootstrap(args: { github?: boolean; repoSlug?: string; useModel?: boolean; evaluate?: boolean }): Promise<Work> {
    const { registry, repo, model } = this.d;
    let cost = 0;
    const out = { recipes: 0, created: [] as string[], duplicates: 0, invalid: [] as string[], untriggered: 0, modelDrafted: 0, prClusters: 0, prSkills: 0, notes: [] as string[] };
    const md = (await repo.docFile?.('docs/matching-cookbook.md')) ?? (await repo.docs()).find((d) => d.id === 'matching-cookbook')?.content ?? null;
    if (md) {
      const recipes = parseCookbook(md).filter((r) => !/unsolved|permuter|method/i.test(r.section));
      out.recipes = recipes.length;
      const drafts = draftsFromCookbook(md);
      for (const dft of drafts) this.store(registry.create(dft, 'repo_bootstrap', { provenance: { source: 'docs/matching-cookbook.md', recipe: dft.recipe, section: dft.section } }), out);
      const covered = new Set(drafts.map((x) => x.recipe));
      const rest = recipes.filter((r) => !covered.has(r.number));
      out.untriggered = rest.length;
      if (rest.length && (args.useModel ?? true) && model.available()) {
        for (let i = 0; i < rest.length; i += 8) {
          const batch = rest.slice(i, i + 8).map((r) => ({ number: r.number, section: r.section, title: r.title, text: sanitizeSkillText(r.text).slice(0, 2_500) }));
          const r = await model.call('recipe_triggers', { task: 'For each recipe that can be recognised from a listing, shape counts or a verdict, return one skill with specific triggers; skip recipes that cannot.', recipes: batch, existingSkills: registry.list().map((s) => s.name) }, MinedSkills);
          cost += r.costUsd;
          if (r.error) out.notes.push(`recipes ${batch[0]!.number}–${batch.at(-1)!.number}: ${r.error}`);
          for (const s of r.data?.skills ?? []) {
            const res = registry.create(s, 'repo_bootstrap', { provenance: { source: 'docs/matching-cookbook.md', via: 'model', model: r.model } });
            if (res.skill) out.modelDrafted++;
            this.store(res, out);
          }
        }
      }
    } else out.notes.push('no matching cookbook in this repository');

    if (args.github) {
      const clusters = await this.prCorrections(args.repoSlug ?? 'awarebayes/skyrim_decomp');
      out.prClusters = clusters.length;
      if (clusters.length && model.available()) {
        for (let i = 0; i < clusters.length; i += 4) {
          const r = await model.call('pr_corrections', { task: 'Each cluster holds review comments that corrected contributors. Synthesise one skill per cluster that shares a single, recognisable root cause; skip the rest.', clusters: clusters.slice(i, i + 4), existingSkills: registry.list().map((s) => s.name) }, MinedSkills);
          cost += r.costUsd;
          if (r.error) out.notes.push(`PR clusters: ${r.error}`);
          for (const s of r.data?.skills ?? []) {
            const res = registry.create(s, 'pr_history', { provenance: { source: `github:${args.repoSlug ?? 'awarebayes/skyrim_decomp'}`, model: r.model } });
            if (res.skill) out.prSkills++;
            this.store(res, out);
          }
        }
      } else if (clusters.length) out.notes.push('PR clusters found but no model in the pool to synthesise them (review comments are never turned into prompts verbatim)');
    }
    const evals = args.evaluate ? await this.evaluatePending() : null;
    return { summary: { ...out, created: out.created.length, createdIds: out.created, ...(evals ? { evaluated: evals.summary } : {}) }, costUsd: cost + (evals?.costUsd ?? 0) };
  }

  private store(res: { skill: { id: string } | null; reason: string; duplicateOf?: string }, out: { created: string[]; duplicates: number; invalid: string[] }) {
    if (res.skill) out.created.push(res.skill.id);
    else if (res.duplicateOf) out.duplicates++;
    else out.invalid.push(res.reason.slice(0, 200));
  }

  /**
   * Review comments on past PRs via the operator's own `gh` login, clustered by topic. Comment text is
   * third-party: sanitized, capped, injection-scanned, and only ever shown to the curator model as data.
   */
  private async prCorrections(slug: string): Promise<Array<{ key: string; n: number; comments: string[] }>> {
    const byKey = new Map<string, string[]>();
    for (let page = 1; page <= 5; page++) {
      const r = await runBounded('gh', ['api', `repos/${slug}/pulls/comments?per_page=100&sort=created&direction=desc&page=${page}`], { cwd: this.d.cwd, timeoutMs: 60_000, inheritEnv: true, maxOutputBytes: 32 * 1024 * 1024 });
      if (r.code !== 0) break;
      const items = JSON.parse(r.stdout) as Array<{ body?: string; path?: string; diff_hunk?: string }>;
      if (!items.length) break;
      for (const c of items) {
        let body = sanitizeSkillText((c.body ?? '').replace(/```[\s\S]*?```/g, (m) => (m.split('\n').length > 12 ? '[long code block omitted]' : m)));
        if (body.length < 25 || scanSkillBody(body, 10_000).some((f) => f.code === 'INJECTION')) continue;
        body = body.slice(0, 500);
        const tags = tagText(`${body} ${c.diff_hunk?.slice(0, 400) ?? ''}`).filter((t) => t !== 'general' && t !== 'header');
        const key = tags[0] ?? 'general';
        byKey.set(key, [...(byKey.get(key) ?? []), body]);
      }
    }
    return [...byKey].filter(([, v]) => v.length >= 3).map(([key, v]) => ({ key, n: v.length, comments: v.slice(0, 12) }));
  }

  // ------------------------------------------------------------------ 2. mine retry wins

  private async mine(runId: string | undefined, evaluate: boolean): Promise<Work> {
    const { store, registry, model, repo } = this.d;
    const id = runId ?? this.latestRun();
    if (!id) return { summary: { note: 'no finished run to mine' }, costUsd: 0 };
    const run = store.getRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    const rows = store.db.prepare(`SELECT id FROM tasks WHERE run_id = ? AND attempts_total >= 2 AND state IN ('passed', 'staged') ORDER BY attempts_total DESC, priority DESC LIMIT 60`).all(id) as Array<{ id: string }>;
    if (!rows.length) return { summary: { runId: id, wins: 0, note: 'no retry wins in this run' }, costUsd: 0 };
    if (!model.available()) return { summary: { runId: id, wins: rows.length, note: 'no model in the pool can serve the curator; retry-win mining needs one' }, costUsd: 0 };
    const wins: unknown[] = [];
    for (const { id: taskId } of rows) {
      const task = store.getTask(taskId)!;
      const verdicts = store.verdictsForTask(taskId);
      const firstFail = verdicts.find((v) => v.decision !== 'pass');
      const final = [...verdicts].reverse().find((v) => v.decision === 'pass');
      if (!firstFail || !final) continue;
      const failed = store.getAttempt(firstFail.attemptId);
      const passed = store.getAttempt(final.attemptId);
      let listing: string | null = null;
      if (run.config.exposureConsent && repo.packFor && repo.readPackSlice) {
        const parts: string[] = [];
        for (const f of task.functions) {
          const pack = await repo.packFor(f).catch(() => null);
          const sl = pack ? await repo.readPackSlice(pack, 1_500).catch(() => null) : null;
          if (sl) parts.push(sl.text);
        }
        listing = parts.join('\n') || null;
      }
      wins.push({
        id: taskId,
        functions: task.functions.map((f) => ({ rva: f.rva, name: f.name, size: f.size })),
        difficulty: task.difficulty,
        shape: shapeOf(task),
        attempts: task.attemptsTotal,
        firstFailure: describeVerdict(firstFail),
        failedVersion: targetBodies(task, failed?.files ?? []),
        passingVersion: targetBodies(task, passed?.files ?? []),
        ...(listing ? { listing } : {}),
      });
    }
    let cost = 0;
    const created: string[] = [];
    const rejected: string[] = [];
    let duplicates = 0;
    for (let i = 0; i < wins.length; i += 10) {
      const r = await model.call('skill_mining', {
        task: 'Each win failed first and passed later. Extract generalisable MSVC matching rules that explain the difference between failedVersion and passingVersion; one skill per root cause shared by at least two wins; return {"skills": []} if none generalise.',
        wins: wins.slice(i, i + 10), existingSkills: registry.list().map((s) => s.name), maxSkills: 4,
      }, MinedSkills, { maxOutputTokens: 6_000 });
      cost += r.costUsd;
      if (r.error) rejected.push(r.error);
      for (const s of r.data?.skills ?? []) {
        const res = registry.create(s, 'retry_mining', { provenance: { runId: id, model: r.model, winIds: s.winIds }, evidence: { wins: s.winIds } });
        if (res.skill) created.push(res.skill.id);
        else if (res.duplicateOf) duplicates++;
        else rejected.push(`${s.name}: ${res.reason.slice(0, 160)}`);
      }
    }
    const evals = evaluate && created.length ? await this.evaluatePending() : null;
    return { summary: { runId: id, wins: wins.length, created: created.length, createdIds: created, duplicates, rejected, ...(evals ? { evaluated: evals.summary } : {}) }, costUsd: cost + (evals?.costUsd ?? 0) };
  }

  // ------------------------------------------------------------------ 3. failure-cluster patching

  private async update(runId: string | undefined, evaluate: boolean): Promise<Work> {
    const { registry, store, model } = this.d;
    const clusters = registry.failureClusters({ min: this.opts.clusterMin, runId });
    const seen = new Set<string>();
    const proposals: Array<{ skillId: string; version: number; kind: string; why: string }> = [];
    const skipped: string[] = [];
    let cost = 0;
    for (const c of clusters) {
      if (seen.has(c.skillId)) continue;
      seen.add(c.skillId);
      const skill = registry.get(c.skillId);
      if (!skill) continue;
      const inj = registry.injections(skill.id, skill.version);
      const failing = inj.filter((x) => x.injected && x.decision === 'reject' && (x.code ?? x.category) === c.code);
      const passing = inj.filter((x) => x.injected && x.decision === 'pass');
      const groups = (x: { matched_json: string }) => JSON.parse(x.matched_json) as string[];
      const t = skill.triggers;
      const strongest = t.mnemonics.length ? 'mnemonics' : t.symbols.length ? 'symbols' : null;
      const share = (xs: typeof inj, pred: (x: (typeof inj)[number]) => boolean) => (xs.length ? xs.filter(pred).length / xs.length : 0);
      // (a) false positives: failures fire without the strong signal that passing packets have
      if (strongest && !t.require.includes(strongest as never) && share(failing, (x) => !groups(x).includes(strongest)) >= 0.6 && share(passing, (x) => groups(x).includes(strongest)) >= 0.6) {
        const r = registry.propose(skill.id, { triggers: { ...t, require: [...t.require, strongest as 'mnemonics' | 'symbols'] } }, 'tighten',
          `${c.n} ${c.code} failures fired without the ${strongest} signature that ${Math.round(share(passing, (x) => groups(x).includes(strongest)) * 100)}% of passing packets had`, { cluster: c });
        if (r.version) proposals.push({ skillId: skill.id, version: r.version.version, kind: 'tighten', why: r.version.rationale ?? '' });
        else skipped.push(`${skill.name}: ${r.reason}`);
        continue;
      }
      // (b) a rule is missing: ask the frontier model with contrastive evidence
      if (model.available()) {
        const ev = (xs: typeof inj) => xs.slice(0, 12).map((x) => {
          const task = store.getTask(x.task_id);
          return task ? { taskId: task.id, functions: task.functions.map((f) => ({ rva: f.rva, name: f.name, size: f.size })), shape: shapeOf(task), matched: groups(x), code: x.code } : null;
        }).filter(Boolean);
        const r = await model.call('skill_patch', {
          task: `This skill was injected into ${c.n} packets that still failed with ${c.category}/${c.code}. Decide whether the failures share one root cause the skill could address. Reply {"action":"add_rule","body":"<full revised body>","triggers":{...}} to add a targeted rule, {"action":"tighten","triggers":{...}} if it fires where it should not, or {"action":"none"}.`,
          skill: { id: skill.id, name: skill.name, body: skill.body, triggers: skill.triggers }, cluster: { category: c.category, code: c.code, n: c.n }, failing: ev(failing), passing: ev(passing),
        }, PatchReply);
        cost += r.costUsd;
        if (!r.data || r.data.action === 'none') {
          skipped.push(`${skill.name}: ${r.error ?? r.data?.rationale ?? 'no shared root cause'}`);
          continue;
        }
        const kind = r.data.action === 'tighten' ? 'tighten' : 'patch';
        const res = registry.propose(skill.id, { ...(r.data.body ? { body: r.data.body } : {}), ...(r.data.triggers ? { triggers: r.data.triggers } : {}) }, kind, r.data.rationale || `${c.n} × ${c.code}`, { cluster: c, model: r.model });
        if (res.version) proposals.push({ skillId: skill.id, version: res.version.version, kind, why: res.version.rationale ?? '' });
        else skipped.push(`${skill.name}: ${res.reason}`);
        continue;
      }
      // (c) no model: add the Gate Keeper's own guidance for the code, if the body lacks it
      const guide = FINDING_GUIDANCE[c.code];
      if (guide && !skill.body.includes(guide)) {
        const res = registry.propose(skill.id, { body: `${skill.body.trim()}\nIf the comparator still reports ${c.code}: ${guide}` }, 'patch', `${c.n} × ${c.code}; added the Gate Keeper guidance for it`, { cluster: c });
        if (res.version) proposals.push({ skillId: skill.id, version: res.version.version, kind: 'patch', why: res.version.rationale ?? '' });
      } else skipped.push(`${skill.name}: no model and no deterministic patch for ${c.code}`);
    }
    const evals = evaluate && proposals.length ? await this.evaluatePending() : null;
    return { summary: { clusters: clusters.length, proposals: proposals.length, proposalList: proposals, skipped, ...(evals ? { evaluated: evals.summary } : {}) }, costUsd: cost + (evals?.costUsd ?? 0) };
  }

  // ------------------------------------------------------------------ 4. optimize (core promotion, compression, pruning)

  private async optimize(runId: string | undefined, evaluate: boolean): Promise<Work> {
    const { registry, model } = this.d;
    const id = runId ?? this.latestRun();
    const promoted: Array<{ id: string; name: string; coverage: number }> = [];
    const deprecated: Array<{ id: string; name: string; lift: number | null }> = [];
    const compressions: Array<{ id: string; name: string; from: number; to: number }> = [];
    let cost = 0;
    if (id) {
      const stats = registry.runStats(id);
      for (const s of stats.skills) {
        if (s.status !== 'active' || s.coverage <= this.opts.coreCoverage) continue;
        const lift = registry.lift(s.skillId);
        if (lift.lift !== null && lift.lift < -0.02) continue; // never promote a skill that hurts
        registry.setStatus(s.skillId, 'promoted_to_core', `triggered on ${Math.round(s.coverage * 100)}% of the functions of run ${id}: moved into the cached static prefix for the next runs`);
        promoted.push({ id: s.skillId, name: s.name, coverage: Math.round(s.coverage * 1000) / 1000 });
      }
    }
    for (const s of registry.list({ status: ['active'] })) {
      const lift = registry.lift(s.id);
      if (clearlyHarmful(lift)) {
        registry.setStatus(s.id, 'deprecated', `negative pass-rate lift ${lift.lift} (±${lift.se}, ${lift.method}, n=${lift.treated}/${lift.control})`);
        deprecated.push({ id: s.id, name: s.name, lift: lift.lift });
      }
    }
    const pending = new Set(registry.proposals().map((p) => p.skill.id));
    for (const s of registry.list({ status: ['active', 'promoted_to_core'] })) {
      if (s.tokenCount <= this.opts.compressAbove || pending.has(s.id)) continue;
      const target = Math.round(s.tokenCount * 0.7);
      let best = compressSkillBody(s.body, { target }).body;
      if (model.available()) {
        const r = await model.call('skill_compress', { task: 'Shorten this skill body to about targetTokens tokens: keep every rule, the Fix and the shortest example; drop narrative and repetition.', body: s.body, targetTokens: target }, CompressReply, { maxOutputTokens: 2_000 });
        cost += r.costUsd;
        if (r.data && estimateTokens(r.data.body) < estimateTokens(best) && !scanSkillBody(r.data.body).length) best = r.data.body;
      }
      const to = estimateTokens(best);
      if (to > s.tokenCount * 0.85) continue;
      const res = registry.propose(s.id, { body: best }, 'compress', `compressed ${s.tokenCount} → ${to} tokens`);
      if (res.version) compressions.push({ id: s.id, name: s.name, from: s.tokenCount, to });
    }
    const evals = evaluate && compressions.length ? await this.evaluatePending() : null;
    return { summary: { runId: id, promoted, deprecated, compressions, ...(evals ? { evaluated: evals.summary } : {}) }, costUsd: cost + (evals?.costUsd ?? 0) };
  }

  // ------------------------------------------------------------------ 5. shadow evaluation of pending proposals

  private async evaluateOne(skillId: string, version: number): Promise<Work> {
    const r = await this.d.shadow.evaluate(skillId, version, this.opts.shadow);
    return { summary: { evaluated: 1, decision: r.decision, status: r.status, reason: r.reason }, costUsd: r.costUsd };
  }

  private async evaluatePending(): Promise<Work> {
    if (!this.d.engine.isIdle()) return { summary: { evaluated: 0, note: 'a run is active; proposals stay pending until it finishes' }, costUsd: 0 };
    const results: Array<{ skillId: string; name: string; version: number; decision: string | null; reason: string | null }> = [];
    let cost = 0;
    for (const p of this.d.registry.proposals()) {
      const r = await this.d.shadow.evaluate(p.skill.id, p.version.version, this.opts.shadow);
      cost += r.costUsd;
      results.push({ skillId: p.skill.id, name: p.version.name, version: p.version.version, decision: r.decision, reason: r.reason });
    }
    return { summary: { evaluated: results.length, accepted: results.filter((r) => r.decision === 'accept').length, rejected: results.filter((r) => r.decision === 'reject').length, results }, costUsd: cost };
  }

  /** The whole loop after a run: mine → update → optimize → shadow-evaluate everything pending. */
  private async curate(runId: string | undefined): Promise<Work> {
    const id = runId ?? this.latestRun() ?? undefined;
    const mined = await this.mine(id, false);
    const updated = await this.update(id, false);
    const optimized = await this.optimize(id, false);
    const evals = await this.evaluatePending();
    return {
      summary: { runId: id, mine: mined.summary, update: updated.summary, optimize: optimized.summary, evaluate: evals.summary },
      costUsd: mined.costUsd + updated.costUsd + optimized.costUsd + evals.costUsd,
    };
  }
}

// ------------------------------------------------------------------ helpers

function shapeOf(task: TaskRow) {
  const f = task.assessment?.features;
  return f && f.source !== 'size_only'
    ? { size: f.size, branches: f.condBranches, loops: f.backEdges, indirectCalls: f.indirectCalls, indirectJumps: f.indirectJumps, sseOps: f.sseOps, eh: (f.unwindEntries ?? 0) > 1, tailCall: f.tailCall }
    : { size: task.functions.reduce((s, x) => s + x.size, 0) };
}

function describeVerdict(v: Verdict) {
  const pf = primaryFailure(v);
  return {
    category: pf.category, signals: failureSignals(v).slice(0, 8),
    findings: v.findings.filter((f) => f.severity === 'block').slice(0, 3).map((f) => `[${f.code}] ${f.message.slice(0, 200)}`),
    compare: (v.compare ?? []).filter((c) => c.result !== 'pass').slice(0, 4).map((c) => ({ name: c.name, exactBytes: c.exactBytes, targetSize: c.targetSize, firstMismatch: c.firstMismatch, reason: c.reason })),
  };
}

/** The target functions' definitions in an attempt's files (our own C++, never game-derived). */
function targetBodies(task: TaskRow, files: Array<{ path: string; content: string }>): string {
  const want = new Set(task.functions.flatMap((f) => (f.name ? [f.name, flat(f.name)] : [])));
  const out: string[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.cpp')) continue;
    for (const d of extractFunctions(lex(file.content).code)) {
      if (!want.has(d.name) && !want.has(flat(d.name))) continue;
      out.push(file.content.slice(d.start, d.close + 1).slice(0, 1_500));
    }
  }
  return out.join('\n\n').slice(0, 4_000);
}

function summaryLine(s: Record<string, unknown>): string {
  const keys = ['created', 'proposals', 'evaluated', 'accepted', 'rejected'];
  const parts = keys.filter((k) => typeof s[k] === 'number').map((k) => `${k} ${s[k]}`);
  for (const k of ['promoted', 'deprecated', 'compressions']) if (Array.isArray(s[k]) && (s[k] as unknown[]).length) parts.push(`${k} ${(s[k] as unknown[]).length}`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

