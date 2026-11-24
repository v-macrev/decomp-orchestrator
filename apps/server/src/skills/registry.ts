// SPDX-License-Identifier: AGPL-3.0-or-later
// SkillRegistry: SQLite is the source of truth (skills, immutable skill_versions, shadow evaluations,
// per-attempt injections); every version is mirrored to disk as SKILL.md so changes are reviewable
// and git-diffable. All writes validate the body (sanitize → scan → 600-token cap) and the triggers
// (regex safety) — whoever drafted them (cookbook, PR history, a model, an operator).
//
// Runs never see the registry directly: at run start a RunSkillSnapshot freezes the core block
// (static prefix bytes) and the dynamic set (id@version + lift), so curator activity during a bulk
// run cannot change a single byte of any cached prefix or any packet's selection.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillSelection, SkillsConfig, Verdict } from '@decomp/core';
import {
  SKILL_TOKEN_CAP, SkillTrigger, compressSkillBody, computeLift, estimateTokens, parseSkillMd, regexProblem, renderSkillMd, sanitizeSkillText, scanSkillBody,
  type ChangeKind, type EvalCase, type JobKind, type Lift, type MatchableSkill, type RunSkillSnapshot, type Skill, type SkillDraft, type SkillEvalRun,
  type SkillJob, type SkillOrigin, type SkillStatus, type SkillVersion,
} from '@decomp/skills';
import type { Store } from '../db/store.js';
import { primaryFailure } from '../orchestrator/lessons.js';
import { newId } from '../util/async.js';

type Raw = Record<string, any>;
const j = (v: unknown) => JSON.stringify(v);
const p = <T>(s: string | null | undefined, fallback: T): T => (s == null ? fallback : (JSON.parse(s) as T));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface DraftCheck {
  ok: boolean;
  draft: SkillDraft;
  problems: string[];
  tokens: number;
}

export interface CreateResult {
  skill: Skill | null;
  reason: string;
  duplicateOf?: string;
}

export interface Proposal {
  skill: Skill;
  version: SkillVersion;
  current: SkillVersion | null;
  evalRun: SkillEvalRun | null;
}

export interface RunSkillStat {
  skillId: string;
  name: string;
  status: SkillStatus;
  tasks: number;
  functions: number;
  coverage: number;
  injected: number;
  injectedPass: number;
  heldOut: number;
  heldOutPass: number;
}

export interface FailureCluster {
  skillId: string;
  version: number;
  category: string;
  code: string;
  n: number;
  taskIds: string[];
  attemptIds: string[];
  /** Injected attempts of this skill version that passed (for contrast). */
  passed: number;
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []);
function overlap(a: string, b: string) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export class SkillRegistry {
  constructor(private store: Store, private dir: string | null) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  private get db() {
    return this.store.db;
  }

  // ------------------------------------------------------------------ validation

  /** Sanitize, cap and scan a draft. Over-cap bodies are compressed deterministically first. */
  check(input: SkillDraft): DraftCheck {
    const problems: string[] = [];
    let body = sanitizeSkillText(input.body);
    if (estimateTokens(body) > SKILL_TOKEN_CAP) body = compressSkillBody(body).body;
    for (const f of scanSkillBody(body, SKILL_TOKEN_CAP, estimateTokens)) problems.push(`${f.code}: ${f.message}`);
    const parsed = SkillTrigger.safeParse(input.triggers);
    if (!parsed.success) problems.push(`triggers: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const triggers = parsed.success ? parsed.data : SkillTrigger.parse({});
    for (const re of [...triggers.mnemonics, ...triggers.exclude.mnemonics]) {
      const prob = regexProblem(re);
      if (prob) problems.push(`trigger /${re}/: ${prob}`);
    }
    const anyTrigger = triggers.mnemonics.length || triggers.symbols.length || triggers.patterns.length || triggers.failures.length || Object.values(triggers.features).some((v) => v !== undefined);
    if (!anyTrigger) problems.push('triggers: no trigger group set (the skill could never fire)');
    const name = sanitizeSkillText(input.name).slice(0, 120);
    const draft: SkillDraft = { name: name.length >= 3 ? name : 'Unnamed skill', description: sanitizeSkillText(input.description ?? '').slice(0, 400), body, triggers, rationale: (input.rationale ?? '').slice(0, 2_000) };
    return { ok: problems.length === 0, draft, problems, tokens: estimateTokens(body) };
  }

  // ------------------------------------------------------------------ reads

  list(opts: { status?: SkillStatus[] } = {}): Skill[] {
    const where = opts.status?.length ? `WHERE status IN (${opts.status.map(() => '?').join(',')})` : '';
    const rows = this.db.prepare(`SELECT * FROM skills ${where} ORDER BY CASE status WHEN 'promoted_to_core' THEN 0 WHEN 'active' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END, name`).all(...(opts.status ?? [])) as Raw[];
    return rows.map((r) => this.toSkill(r));
  }

  get(id: string): Skill | null {
    const r = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Raw | undefined;
    return r ? this.toSkill(r) : null;
  }

  versions(id: string): SkillVersion[] {
    return (this.db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC').all(id) as Raw[]).map(toVersion);
  }

  version(id: string, v: number): SkillVersion | null {
    const r = this.db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?').get(id, v) as Raw | undefined;
    return r ? toVersion(r) : null;
  }

  /** Pending proposals (new candidates and version+1 updates) with their latest shadow evaluation. */
  proposals(): Proposal[] {
    const rows = this.db.prepare(`SELECT * FROM skill_versions WHERE state = 'proposed' ORDER BY created_at`).all() as Raw[];
    return rows.flatMap((r) => {
      const v = toVersion(r);
      const skill = this.get(v.skillId);
      if (!skill) return [];
      const current = skill.status === 'candidate' ? null : this.version(skill.id, skill.version);
      return [{ skill, version: v, current: current && current.version !== v.version ? current : null, evalRun: this.latestEval(skill.id, v.version) }];
    });
  }

  /** Telemetry-derived lift for a skill's current version. */
  lift(id: string): Lift {
    const r = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Raw | undefined;
    if (!r) return { lift: null, method: 'none', se: null, treated: 0, control: 0 };
    return computeLift({ injected: r.pass_count + r.fail_count, injectedPass: r.pass_count, holdout: r.holdout_count, holdoutPass: r.holdout_pass_count, baseline: this.baseline(id, r.version) });
  }

  /** Attempts in the same runs where this skill was not eligible (confounded fallback control). */
  private baseline(id: string, version: number) {
    const b = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN v.decision = 'pass' THEN 1 ELSE 0 END), 0) pass
      FROM attempts a JOIN verdicts v ON v.attempt_id = a.id
      WHERE a.run_id IN (SELECT DISTINCT run_id FROM skill_injections WHERE skill_id = ? AND version = ?)
        AND COALESCE(a.model, '') NOT LIKE '%(no model call)%'
        AND NOT EXISTS (SELECT 1 FROM skill_injections si WHERE si.attempt_id = a.id AND si.skill_id = ?)`).get(id, version, id) as Raw;
    return { n: b.n as number, pass: b.pass as number };
  }

  private toSkill(r: Raw): Skill {
    const injected = r.pass_count + r.fail_count;
    const l = computeLift({ injected, injectedPass: r.pass_count, holdout: r.holdout_count, holdoutPass: r.holdout_pass_count, baseline: injected >= 5 && r.holdout_count < 6 ? this.baseline(r.id, r.version) : null });
    return {
      id: r.id, name: r.name, description: r.description, version: r.version, status: r.status, origin: r.origin, tokenCount: r.token_count,
      triggers: SkillTrigger.parse(p(r.triggers_json, {})), body: r.body, provenance: p(r.provenance_json, {}), statusReason: r.status_reason ?? null,
      telemetry: {
        triggerCount: r.trigger_count, injectCount: r.inject_count, passCount: r.pass_count, failCount: r.fail_count,
        holdoutCount: r.holdout_count, holdoutPassCount: r.holdout_pass_count,
        avgTokensInjected: r.inject_count ? Math.round(r.tokens_injected / r.inject_count) : 0, lift: l.lift, liftMethod: l.method,
      },
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  // ------------------------------------------------------------------ writes

  /**
   * Store a new skill as a candidate (v1 proposed). Rejects invalid drafts and near-duplicates of any
   * existing skill — including deprecated ones, so a rejected idea is not re-mined every run.
   */
  create(input: SkillDraft, origin: SkillOrigin, opts: { provenance?: Record<string, unknown>; evidence?: Record<string, unknown>; status?: 'candidate' | 'active' } = {}): CreateResult {
    const c = this.check(input);
    if (!c.ok) return { skill: null, reason: c.problems.join('; ') };
    const d = c.draft;
    for (const s of this.list()) {
      const sameName = s.name.toLowerCase() === d.name.toLowerCase();
      const sameTrigger = j(s.triggers) === j(d.triggers);
      if (sameName || (sameTrigger && overlap(s.body, d.body) > 0.6) || overlap(s.body, d.body) > 0.8) return { skill: null, reason: `duplicate of ${s.id} (${s.name})`, duplicateOf: s.id };
    }
    const id = `sk_${sha(`${origin}\0${d.name}`).slice(0, 10)}`;
    const now = Date.now();
    const status = opts.status ?? 'candidate';
    this.store.tx(() => {
      this.db.prepare(`INSERT INTO skills (id, name, description, status, version, origin, token_count, triggers_json, body, provenance_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(id, d.name, d.description, status, origin, c.tokens, j(d.triggers), d.body, j(opts.provenance ?? {}), now, now);
      this.db.prepare(`INSERT INTO skill_versions (skill_id, version, name, description, body, triggers_json, token_count, state, change_kind, rationale, evidence_json, parent_version, created_at, decided_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'create', ?, ?, NULL, ?, ?)`).run(id, d.name, d.description, d.body, j(d.triggers), c.tokens, status === 'active' ? 'accepted' : 'proposed', d.rationale || null, opts.evidence ? j(opts.evidence) : null, now, status === 'active' ? now : null);
    });
    this.mirror(id);
    return { skill: this.get(id), reason: 'created' };
  }

  /** Propose version + 1 of an existing skill (patch / tighten / compress / manual edit). */
  propose(id: string, change: Partial<SkillDraft>, kind: ChangeKind, rationale: string, evidence?: Record<string, unknown>): { version: SkillVersion | null; reason: string } {
    const s = this.get(id);
    if (!s) return { version: null, reason: 'unknown skill' };
    const c = this.check({ name: change.name ?? s.name, description: change.description ?? s.description, body: change.body ?? s.body, triggers: change.triggers ?? s.triggers, rationale });
    if (!c.ok) return { version: null, reason: c.problems.join('; ') };
    if (c.draft.body === s.body && j(c.draft.triggers) === j(s.triggers)) return { version: null, reason: 'no change' };
    const pending = this.db.prepare(`SELECT version FROM skill_versions WHERE skill_id = ? AND state = 'proposed'`).get(id) as Raw | undefined;
    if (pending) return { version: null, reason: `v${pending.version} is already awaiting evaluation` };
    const next = ((this.db.prepare('SELECT MAX(version) m FROM skill_versions WHERE skill_id = ?').get(id) as Raw).m as number) + 1;
    this.db.prepare(`INSERT INTO skill_versions (skill_id, version, name, description, body, triggers_json, token_count, state, change_kind, rationale, evidence_json, parent_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`).run(id, next, c.draft.name, c.draft.description, c.draft.body, j(c.draft.triggers), c.tokens, kind, rationale, evidence ? j(evidence) : null, s.version, Date.now());
    this.mirror(id);
    return { version: this.version(id, next), reason: 'proposed' };
  }

  /** A proposal won its shadow evaluation (or an operator accepted it): it becomes the current version. */
  accept(id: string, version: number, evalRunId: string | null, reason = 'shadow evaluation passed') {
    const v = this.version(id, version);
    const s = this.get(id);
    if (!v || !s) return false;
    const now = Date.now();
    this.store.tx(() => {
      this.db.prepare(`UPDATE skill_versions SET state = 'superseded' WHERE skill_id = ? AND state = 'accepted'`).run(id);
      this.db.prepare(`UPDATE skill_versions SET state = 'accepted', decided_at = ?, eval_run_id = COALESCE(?, eval_run_id) WHERE skill_id = ? AND version = ?`).run(now, evalRunId, id, version);
      // Telemetry describes the current version: counters restart (history stays in skill_injections).
      this.db.prepare(`UPDATE skills SET version = ?, name = ?, description = ?, body = ?, triggers_json = ?, token_count = ?,
          status = CASE WHEN status IN ('candidate', 'deprecated') THEN 'active' ELSE status END, status_reason = ?,
          trigger_count = 0, inject_count = 0, pass_count = 0, fail_count = 0, holdout_count = 0, holdout_pass_count = 0, tokens_injected = 0, updated_at = ?
        WHERE id = ?`).run(version, v.name, v.description, v.body, j(v.triggers), v.tokenCount, reason, now, id);
    });
    this.mirror(id);
    return true;
  }

  /** A proposal lost: the edit is discarded; a never-activated candidate is deprecated. */
  reject(id: string, version: number, evalRunId: string | null, reason: string) {
    const s = this.get(id);
    if (!s) return false;
    const now = Date.now();
    this.store.tx(() => {
      this.db.prepare(`UPDATE skill_versions SET state = 'rejected', decided_at = ?, eval_run_id = COALESCE(?, eval_run_id), rationale = COALESCE(rationale, '') || ? WHERE skill_id = ? AND version = ?`)
        .run(now, evalRunId, `\n[rejected] ${reason}`, id, version);
      if (s.status === 'candidate') this.db.prepare(`UPDATE skills SET status = 'deprecated', status_reason = ?, updated_at = ? WHERE id = ?`).run(`rejected: ${reason}`, now, id);
    });
    this.mirror(id);
    return true;
  }

  /**
   * Put a rejected version back up for evaluation (a 12-case replay can reject a helpful skill by
   * chance). A never-activated candidate goes back to 'candidate'; it still needs a shadow win.
   */
  reopen(id: string, version: number): { ok: boolean; reason: string } {
    const s = this.get(id);
    const v = this.version(id, version);
    if (!s || !v) return { ok: false, reason: 'unknown skill version' };
    if (v.state !== 'rejected') return { ok: false, reason: `v${version} is ${v.state}` };
    if (this.db.prepare(`SELECT 1 FROM skill_versions WHERE skill_id = ? AND state = 'proposed'`).get(id)) return { ok: false, reason: 'another version is already pending' };
    const neverActive = !this.versions(id).some((x) => x.state === 'accepted' || x.state === 'superseded');
    this.store.tx(() => {
      this.db.prepare(`UPDATE skill_versions SET state = 'proposed', decided_at = NULL WHERE skill_id = ? AND version = ?`).run(id, version);
      if (neverActive && s.status === 'deprecated') this.db.prepare(`UPDATE skills SET status = 'candidate', status_reason = 'reopened for another shadow evaluation', updated_at = ? WHERE id = ?`).run(Date.now(), id);
    });
    this.mirror(id);
    return { ok: true, reason: 'reopened' };
  }

  setStatus(id: string, status: SkillStatus, reason: string) {
    const ok = this.db.prepare('UPDATE skills SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(status, reason, Date.now(), id).changes > 0;
    if (ok) this.mirror(id);
    return ok;
  }

  // ------------------------------------------------------------------ run snapshot (cache safety)

  /** The run's frozen skill view; created on first start and reused verbatim on resume. */
  snapshotForRun(runId: string, cfg: SkillsConfig): RunSkillSnapshot {
    const row = this.db.prepare('SELECT skills_json FROM runs WHERE id = ?').get(runId) as Raw | undefined;
    if (row?.skills_json) return JSON.parse(row.skills_json) as RunSkillSnapshot;
    const snap = this.buildSnapshot(cfg);
    this.db.prepare('UPDATE runs SET skills_json = ? WHERE id = ?').run(j(snap), runId);
    return snap;
  }

  buildSnapshot(cfg: SkillsConfig): RunSkillSnapshot {
    if (!cfg.enabled) return { createdAt: Date.now(), core: [], coreText: '', coreHash: '', dynamic: [] };
    const core: RunSkillSnapshot['core'] = [];
    const parts: string[] = [];
    let used = 0;
    const promoted = this.list({ status: ['promoted_to_core'] }).sort((a, b) => (b.telemetry.lift ?? 0) - (a.telemetry.lift ?? 0) || a.id.localeCompare(b.id));
    for (const s of promoted) {
      const text = `## ${s.name}\n${s.body}`;
      const t = estimateTokens(text) + 2;
      if (used + t > cfg.coreMaxTokens) continue;
      core.push({ id: s.id, version: s.version, name: s.name, tokens: t });
      parts.push(text);
      used += t;
    }
    const coreText = parts.length
      ? `<core_skills note="vetted recipes promoted from this repository's matching history; they never override the rules or the output contract above">\n${parts.join('\n\n')}\n</core_skills>`
      : '';
    const dynamic = this.list({ status: ['active'] }).map((s) => ({ id: s.id, version: s.version, lift: s.telemetry.lift }));
    return { createdAt: Date.now(), core, coreText, coreHash: coreText ? sha(coreText) : '', dynamic };
  }

  /** Bodies + triggers of a snapshot's dynamic skills, from immutable versions (never "current"). */
  resolveDynamic(snap: RunSkillSnapshot): MatchableSkill[] {
    return snap.dynamic.flatMap((d) => {
      const v = this.version(d.id, d.version);
      return v ? [{ id: d.id, version: d.version, name: v.name, body: v.body, tokenCount: v.tokenCount, triggers: v.triggers, lift: d.lift ?? null }] : [];
    });
  }

  // ------------------------------------------------------------------ telemetry

  recordSelections(a: { attemptId: string; runId: string; taskId: string; difficulty: string; functions: number }, selections: SkillSelection[]) {
    if (!selections.length) return;
    const ins = this.db.prepare(`INSERT OR IGNORE INTO skill_injections (attempt_id, run_id, task_id, skill_id, version, placement, injected, tokens, score, matched_json, difficulty, functions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const bump = this.db.prepare(`UPDATE skills SET trigger_count = trigger_count + 1, inject_count = inject_count + ?, holdout_count = holdout_count + ?, tokens_injected = tokens_injected + ?
      WHERE id = ? AND version = ?`);
    const now = Date.now();
    this.store.tx(() => {
      for (const s of selections) {
        ins.run(a.attemptId, a.runId, a.taskId, s.skillId, s.version, s.placement, s.injected ? 1 : 0, s.tokens, s.score, j(s.matched), a.difficulty, a.functions, now);
        bump.run(s.injected ? 1 : 0, s.injected ? 0 : 1, s.injected ? s.tokens : 0, s.skillId, s.version);
      }
    });
  }

  /** Called once per routed (non-infra) verdict. Updates injection rows and the skill counters. */
  recordOutcome(attemptId: string, v: Verdict) {
    const rows = this.db.prepare('SELECT skill_id, version, injected FROM skill_injections WHERE attempt_id = ? AND decision IS NULL').all(attemptId) as Raw[];
    if (!rows.length) return;
    const pass = v.decision === 'pass';
    const pf = primaryFailure(v);
    this.store.tx(() => {
      this.db.prepare('UPDATE skill_injections SET decision = ?, category = ?, code = ? WHERE attempt_id = ?').run(v.decision, pf.category, pf.code, attemptId);
      const inj = this.db.prepare('UPDATE skills SET pass_count = pass_count + ?, fail_count = fail_count + ? WHERE id = ? AND version = ?');
      const held = this.db.prepare('UPDATE skills SET holdout_pass_count = holdout_pass_count + ? WHERE id = ? AND version = ?');
      for (const r of rows) {
        if (r.injected) inj.run(pass ? 1 : 0, pass ? 0 : 1, r.skill_id, r.version);
        else held.run(pass ? 1 : 0, r.skill_id, r.version);
      }
    });
  }

  /** Per-skill coverage and outcomes in one run (core promotion uses coverage = functions share). */
  runStats(runId: string): { totalFunctions: number; skills: RunSkillStat[] } {
    const total = ((this.db.prepare('SELECT COALESCE(SUM(json_array_length(functions_json)), 0) n FROM tasks WHERE run_id = ?').get(runId) as Raw).n as number) || 0;
    const rows = this.db.prepare(`SELECT c.skill_id, c.tasks, c.functions, o.injected, o.injected_pass, o.held, o.held_pass, s.name, s.status
      FROM (SELECT skill_id, COUNT(*) tasks, SUM(functions) functions FROM (SELECT DISTINCT si.skill_id, si.task_id, json_array_length(t.functions_json) functions FROM skill_injections si JOIN tasks t ON t.id = si.task_id WHERE si.run_id = ?) GROUP BY skill_id) c
      JOIN (SELECT skill_id, SUM(injected) injected, SUM(CASE WHEN injected = 1 AND decision = 'pass' THEN 1 ELSE 0 END) injected_pass,
              SUM(1 - injected) held, SUM(CASE WHEN injected = 0 AND decision = 'pass' THEN 1 ELSE 0 END) held_pass
            FROM skill_injections WHERE run_id = ? GROUP BY skill_id) o ON o.skill_id = c.skill_id
      JOIN skills s ON s.id = c.skill_id ORDER BY c.functions DESC`).all(runId, runId) as Raw[];
    return {
      totalFunctions: total,
      skills: rows.map((r) => ({
        skillId: r.skill_id, name: r.name, status: r.status, tasks: r.tasks, functions: r.functions, coverage: total ? r.functions / total : 0,
        injected: r.injected, injectedPass: r.injected_pass, heldOut: r.held, heldOutPass: r.held_pass,
      })),
    };
  }

  /** Injected failures grouped by (skill version, category, code) with at least `min` members. */
  failureClusters(opts: { min?: number; runId?: string } = {}): FailureCluster[] {
    const min = opts.min ?? 3;
    const runFilter = opts.runId ? 'AND si.run_id = @runId' : '';
    const rows = this.db.prepare(`SELECT si.skill_id, si.version, si.category, si.code, COUNT(*) n, json_group_array(si.task_id) tasks, json_group_array(si.attempt_id) attempts
      FROM skill_injections si JOIN skills s ON s.id = si.skill_id AND s.version = si.version
      WHERE si.injected = 1 AND si.decision = 'reject' AND si.category IS NOT NULL AND s.status IN ('active', 'promoted_to_core') ${runFilter}
      GROUP BY si.skill_id, si.version, si.category, si.code HAVING n >= @min ORDER BY n DESC`).all({ min, runId: opts.runId }) as Raw[];
    return rows.map((r) => ({
      skillId: r.skill_id, version: r.version, category: r.category, code: r.code ?? r.category, n: r.n,
      taskIds: [...new Set(p<string[]>(r.tasks, []))], attemptIds: p<string[]>(r.attempts, []),
      passed: ((this.db.prepare(`SELECT COUNT(*) n FROM skill_injections WHERE skill_id = ? AND version = ? AND injected = 1 AND decision = 'pass'`).get(r.skill_id, r.version) as Raw).n as number),
    }));
  }

  /** Injections of a skill (for the updater's contrast between passing and failing packets). */
  injections(skillId: string, version: number, limit = 400) {
    return this.db.prepare(`SELECT attempt_id, run_id, task_id, injected, decision, category, code, matched_json FROM skill_injections WHERE skill_id = ? AND version = ? ORDER BY created_at DESC LIMIT ?`)
      .all(skillId, version, limit) as Array<{ attempt_id: string; run_id: string; task_id: string; injected: number; decision: string | null; category: string | null; code: string | null; matched_json: string }>;
  }

  // ------------------------------------------------------------------ shadow evaluations

  createEval(skillId: string, version: number, baselineVersion: number | null): string {
    const id = newId('sev');
    this.db.prepare(`INSERT INTO skill_eval_runs (id, skill_id, version, baseline_version, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)`).run(id, skillId, version, baselineVersion, Date.now());
    this.db.prepare('UPDATE skill_versions SET eval_run_id = ? WHERE skill_id = ? AND version = ?').run(id, skillId, version);
    return id;
  }

  finishEval(id: string, r: { status: 'passed' | 'failed' | 'error'; details: EvalCase[]; costUsd: number; decision: 'accept' | 'reject' | null; reason: string }) {
    const sum = (f: (c: EvalCase) => number) => r.details.reduce((s, c) => s + f(c), 0);
    this.db.prepare(`UPDATE skill_eval_runs SET status = ?, cases = ?, baseline_pass = ?, candidate_pass = ?, baseline_tokens = ?, candidate_tokens = ?,
        baseline_exact = ?, candidate_exact = ?, cost_usd = ?, decision = ?, reason = ?, details_json = ?, finished_at = ? WHERE id = ?`)
      .run(r.status, r.details.length, sum((c) => +c.baseline.pass), sum((c) => +c.candidate.pass), sum((c) => c.baseline.tokens), sum((c) => c.candidate.tokens),
        sum((c) => c.baseline.exactBytes), sum((c) => c.candidate.exactBytes), r.costUsd, r.decision, r.reason, j(r.details), Date.now(), id);
  }

  latestEval(skillId: string, version?: number): SkillEvalRun | null {
    const r = (version === undefined
      ? this.db.prepare('SELECT * FROM skill_eval_runs WHERE skill_id = ? ORDER BY created_at DESC LIMIT 1').get(skillId)
      : this.db.prepare('SELECT * FROM skill_eval_runs WHERE skill_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1').get(skillId, version)) as Raw | undefined;
    return r ? toEval(r) : null;
  }

  evals(limit = 50): SkillEvalRun[] {
    return (this.db.prepare('SELECT * FROM skill_eval_runs ORDER BY created_at DESC LIMIT ?').all(limit) as Raw[]).map(toEval);
  }

  // ------------------------------------------------------------------ jobs

  startJob(kind: JobKind): string {
    const id = newId('sjob');
    this.db.prepare(`INSERT INTO skill_jobs (id, kind, status, started_at) VALUES (?, ?, 'running', ?)`).run(id, kind, Date.now());
    return id;
  }

  finishJob(id: string, r: { summary: Record<string, unknown>; costUsd?: number; error?: string | null }) {
    this.db.prepare(`UPDATE skill_jobs SET status = ?, summary_json = ?, cost_usd = ?, error = ?, finished_at = ? WHERE id = ?`)
      .run(r.error ? 'failed' : 'done', j(r.summary), r.costUsd ?? 0, r.error ?? null, Date.now(), id);
  }

  jobs(limit = 30): SkillJob[] {
    return (this.db.prepare('SELECT * FROM skill_jobs ORDER BY started_at DESC LIMIT ?').all(limit) as Raw[]).map((r) => ({
      id: r.id, kind: r.kind, status: r.status, summary: p(r.summary_json, {}), costUsd: r.cost_usd, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
    }));
  }

  runningJob(): SkillJob | null {
    return this.jobs(5).find((j) => j.status === 'running') ?? null;
  }

  /** Jobs interrupted by a restart can never finish: mark them failed on boot. */
  failStaleJobs() {
    this.db.prepare(`UPDATE skill_jobs SET status = 'failed', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'`).run(Date.now());
    this.db.prepare(`UPDATE skill_eval_runs SET status = 'error', reason = 'interrupted by restart', finished_at = ? WHERE status = 'running'`).run(Date.now());
  }

  // ------------------------------------------------------------------ SKILL.md mirror

  renderMd(skillId: string, version?: number): string | null {
    const s = this.get(skillId);
    if (!s) return null;
    const v = this.version(skillId, version ?? s.version);
    if (!v) return null;
    const status = v.state === 'proposed' ? 'proposed' : v.version === s.version ? s.status : 'deprecated';
    return renderSkillMd({ id: s.id, name: v.name, description: v.description, version: v.version, status, origin: s.origin, tokens: v.tokenCount, triggers: v.triggers, body: v.body });
  }

  private mirror(id: string) {
    if (!this.dir) return;
    const s = this.get(id);
    if (!s) return;
    const folder = join(this.dir, id);
    mkdirSync(folder, { recursive: true });
    for (const v of this.versions(id)) {
      const md = this.renderMd(id, v.version);
      if (md) writeFileSync(join(folder, `v${v.version}.md`), md);
    }
    writeFileSync(join(folder, 'SKILL.md'), this.renderMd(id)!);
  }

  /**
   * Import hand-written SKILL.md folders that the registry does not know yet (as candidates, which
   * still need a shadow evaluation) and edits to known skills' SKILL.md (as manual proposals).
   */
  importFromDisk(): { created: string[]; proposed: string[]; problems: string[] } {
    const out = { created: [] as string[], proposed: [] as string[], problems: [] as string[] };
    if (!this.dir || !existsSync(this.dir)) return out;
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const doc = parseSkillMd(readFileSync(file, 'utf8'));
        const known = doc.id ? this.get(doc.id) : null;
        if (known) {
          if (known.body.trim() !== doc.body.trim() || j(known.triggers) !== j(doc.triggers)) {
            const r = this.propose(known.id, { name: doc.name, description: doc.description, body: doc.body, triggers: doc.triggers }, 'manual', 'edited on disk');
            if (r.version) out.proposed.push(known.id);
            else if (r.reason !== 'no change') out.problems.push(`${name}: ${r.reason}`);
          }
          continue;
        }
        const r = this.create({ name: doc.name, description: doc.description, body: doc.body, triggers: doc.triggers, rationale: 'imported from disk' }, 'manual', { provenance: { file: `${name}/SKILL.md` } });
        if (r.skill) out.created.push(r.skill.id);
        else out.problems.push(`${name}: ${r.reason}`);
      } catch (e) {
        out.problems.push(`${name}: ${(e as Error).message}`);
      }
    }
    return out;
  }
}

function toVersion(r: Raw): SkillVersion {
  return {
    skillId: r.skill_id, version: r.version, name: r.name, description: r.description, body: r.body, triggers: SkillTrigger.parse(p(r.triggers_json, {})),
    tokenCount: r.token_count, state: r.state, changeKind: r.change_kind, rationale: r.rationale ?? null, evidence: p(r.evidence_json, null),
    parentVersion: r.parent_version ?? null, evalRunId: r.eval_run_id ?? null, createdAt: r.created_at, decidedAt: r.decided_at ?? null,
  };
}

function toEval(r: Raw): SkillEvalRun {
  return {
    id: r.id, skillId: r.skill_id, version: r.version, baselineVersion: r.baseline_version ?? null, status: r.status, cases: r.cases,
    baselinePass: r.baseline_pass, candidatePass: r.candidate_pass, baselineTokens: r.baseline_tokens, candidateTokens: r.candidate_tokens,
    baselineExact: r.baseline_exact, candidateExact: r.candidate_exact, costUsd: r.cost_usd, decision: r.decision ?? null, reason: r.reason ?? null,
    details: p(r.details_json, []), createdAt: r.created_at, finishedAt: r.finished_at ?? null,
  };
}
