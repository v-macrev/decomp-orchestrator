// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed repositories over the database. Row <-> domain mapping lives here and nowhere else.
import {
  Account, AccountRuntime, Attempt, Flow, FunctionTarget, RunConfig, Task, Verdict,
  type ComplexityAssessment, type Difficulty, type KnowledgeEntry, type KnowledgeKind, type RunStatus, type TaskState, type Usage,
} from '@decomp/core';
import type { DB } from './database.js';

const j = (v: unknown) => JSON.stringify(v);
const p = <T>(s: string | null | undefined, fallback: T): T => (s == null ? fallback : (JSON.parse(s) as T));

export interface RunRow {
  id: string;
  name: string;
  status: RunStatus;
  config: RunConfig;
  flow: Flow;
  costUsd: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface LessonRow {
  id: string;
  source: string;
  topic: string;
  text: string;
  weight: number;
  tags: string[];
}

export interface TaskRow extends Task {
  infraFailures: number;
  providerFailures: number;
  /** Worker instance that last leased the packet (per-worker function cap). */
  assignedWorker?: string | null;
}

type Raw = Record<string, any>;

function toTask(r: Raw): TaskRow {
  return {
    id: r.id, runId: r.run_id, unit: r.unit,
    functions: p<FunctionTarget[]>(r.functions_json, []),
    state: r.state, priority: r.priority, tier: r.tier,
    attemptsTotal: r.attempts_total, attemptsAtTier: r.attempts_at_tier,
    noImprovementStreak: r.no_improvement_streak, bestExactBytes: r.best_exact_bytes,
    cheatStrikes: r.cheat_strikes, infraFailures: r.infra_failures, providerFailures: r.provider_failures,
    leaseId: r.lease_id, leaseExpiresAt: r.lease_expires_at, notBefore: r.not_before,
    lastVerdictId: r.last_verdict_id, srTaskId: r.sr_task_id, updatedAt: r.updated_at,
    difficulty: (r.difficulty ?? 'medium') as Difficulty, complexity: r.complexity ?? 0,
    attemptsAtDifficulty: r.attempts_at_difficulty ?? 0, assessment: p<ComplexityAssessment | null>(r.assessment_json, null),
    assignedWorker: r.assigned_worker ?? null,
  };
}

function toAttempt(r: Raw): Attempt {
  return {
    id: r.id, taskId: r.task_id, runId: r.run_id, n: r.n, tier: r.tier, nodeId: r.node_id,
    accountId: r.account_id, model: r.model, status: r.status, bundleHash: r.bundle_hash,
    usage: p<Usage>(r.usage_json, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    costUsd: r.cost_usd, latencyMs: r.latency_ms, error: r.error,
    files: p(r.files_json, null), startedAt: r.started_at, finishedAt: r.finished_at,
    difficulty: r.difficulty ?? null, contextTokens: r.context_tokens ?? null, contextRawTokens: r.context_raw_tokens ?? null,
  };
}

function toVerdict(r: Raw): Verdict {
  return {
    id: r.id, taskId: r.task_id, attemptId: r.attempt_id, decision: r.decision, route: r.route,
    findings: p(r.findings_json, []), compare: p(r.compare_json, null), exactBytes: r.exact_bytes,
    stages: p(r.stages_json, []), createdAt: r.created_at,
  };
}

function toRun(r: Raw): RunRow {
  const raw = JSON.parse(r.config_json) as Record<string, unknown>;
  // Runs created before Phase 2 keep their behaviour: no difficulty routing, legacy bundles.
  if (!('routing' in raw)) raw.routing = { enabled: false };
  if (!('context' in raw)) raw.context = { mode: 'legacy' };
  // Runs created before Phase 3 keep their behaviour: no core skills, no dynamic skills.
  if (!('skills' in raw)) raw.skills = { enabled: false };
  // Runs created before Phase 4 had no per-worker function cap.
  if (!('maxFunctionsPerWorker' in raw)) raw.maxFunctionsPerWorker = 5_000;
  return {
    id: r.id, name: r.name, status: r.status, config: RunConfig.parse(raw),
    flow: Flow.parse(JSON.parse(r.flow_json)), costUsd: r.cost_usd, error: r.error,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, updatedAt: r.updated_at,
    inputTokens: r.input_tokens ?? 0, cachedInputTokens: r.cached_input_tokens ?? 0,
    cacheWriteTokens: r.cache_write_tokens ?? 0, outputTokens: r.output_tokens ?? 0,
  };
}

function toKnowledge(r: Raw): KnowledgeEntry {
  return {
    runId: r.run_id, kind: r.kind, symbol: r.symbol, content: r.content, symbols: p<string[]>(r.symbols_json, []),
    sourceTaskId: r.source_task_id, sourceUnit: r.source_unit, verifiedAt: r.verified_at, uses: r.uses,
  };
}

export class Store {
  constructor(readonly db: DB) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // ---------------- accounts ----------------
  listAccounts(): Account[] {
    return this.db.prepare('SELECT json FROM accounts ORDER BY id').all().map((r: any) => Account.parse(JSON.parse(r.json)));
  }
  getAccount(id: string): Account | null {
    const r = this.db.prepare('SELECT json FROM accounts WHERE id = ?').get(id) as Raw | undefined;
    return r ? Account.parse(JSON.parse(r.json)) : null;
  }
  upsertAccount(a: Account) {
    const acc = Account.parse(a);
    this.db.prepare('INSERT INTO accounts (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(acc.id, j(acc), Date.now());
    return acc;
  }
  deleteAccount(id: string) {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM account_runtime WHERE account_id = ?').run(id);
  }
  loadRuntime(): AccountRuntime[] {
    return this.db.prepare('SELECT json FROM account_runtime').all().map((r: any) => AccountRuntime.parse(JSON.parse(r.json)));
  }
  saveRuntime(rt: AccountRuntime[]) {
    const stmt = this.db.prepare('INSERT INTO account_runtime (account_id, json) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET json = excluded.json');
    this.tx(() => rt.forEach((r) => stmt.run(r.accountId, j(r))));
  }

  // ---------------- flows ----------------
  listFlows(): Flow[] {
    return this.db.prepare('SELECT json FROM flows ORDER BY id').all().map((r: any) => Flow.parse(JSON.parse(r.json)));
  }
  getFlow(id: string): Flow | null {
    const r = this.db.prepare('SELECT json FROM flows WHERE id = ?').get(id) as Raw | undefined;
    return r ? Flow.parse(JSON.parse(r.json)) : null;
  }
  upsertFlow(f: Flow) {
    const flow = Flow.parse({ ...f, updatedAt: Date.now() });
    this.db.prepare('INSERT INTO flows (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(flow.id, j(flow), flow.updatedAt);
    return flow;
  }
  deleteFlow(id: string) {
    this.db.prepare('DELETE FROM flows WHERE id = ?').run(id);
  }

  // ---------------- runs ----------------
  createRun(r: { id: string; name: string; config: RunConfig; flow: Flow }) {
    const now = Date.now();
    this.db.prepare('INSERT INTO runs (id, name, status, config_json, flow_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.name, 'created', j(r.config), j(r.flow), now, now);
    return this.getRun(r.id)!;
  }
  getRun(id: string): RunRow | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Raw | undefined;
    return r ? toRun(r) : null;
  }
  listRuns(limit = 50): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit).map((r) => toRun(r as Raw));
  }
  /** Conditional status change; returns false when the run is not in one of `from`. */
  setRunStatus(id: string, to: RunStatus, from?: RunStatus[], extra: { error?: string | null } = {}) {
    const now = Date.now();
    const sets = ['status = @to', 'updated_at = @now'];
    if (to === 'running') sets.push('started_at = COALESCE(started_at, @now)', 'finished_at = NULL');
    if (['completed', 'cancelled', 'failed'].includes(to)) sets.push('finished_at = @now');
    if (extra.error !== undefined) sets.push('error = @error');
    const where = from?.length ? `AND status IN (${from.map((_, i) => `@f${i}`).join(',')})` : '';
    const params: Raw = { id, to, now, error: extra.error ?? null };
    from?.forEach((s, i) => (params[`f${i}`] = s));
    return this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = @id ${where}`).run(params).changes > 0;
  }
  addRunCost(id: string, usd: number) {
    this.db.prepare('UPDATE runs SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?').run(usd, Date.now(), id);
  }
  /** Cost + token counters on the run row (one UPDATE per attempt; the dashboard reads these). */
  addRunUsage(id: string, usd: number, u: Usage) {
    this.db.prepare(`UPDATE runs SET cost_usd = cost_usd + @usd, input_tokens = input_tokens + @i, cached_input_tokens = cached_input_tokens + @c,
        cache_write_tokens = cache_write_tokens + @w, output_tokens = output_tokens + @o, updated_at = @now WHERE id = @id`)
      .run({ id, usd, i: u.inputTokens, c: u.cacheReadTokens, w: u.cacheWriteTokens, o: u.outputTokens, now: Date.now() });
  }
  activeRuns(): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE status IN ('discovering','running','paused')").all().map((r) => toRun(r as Raw));
  }

  // ---------------- tasks ----------------
  insertTasks(
    runId: string,
    packets: Array<{ id: string; unit: string; functions: FunctionTarget[]; priority: number; tier?: number; difficulty?: Difficulty; complexity?: number; assessment?: ComplexityAssessment | null }>,
  ) {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO tasks (id, run_id, unit, functions_key, functions_json, state, priority, tier, difficulty, complexity, assessment_json, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    let inserted = 0;
    this.tx(() => {
      for (const t of packets) {
        const key = t.functions.map((f) => f.rva).sort().join(',');
        inserted += stmt.run(t.id, runId, t.unit, key, j(t.functions), t.priority, t.tier ?? 0, t.difficulty ?? 'medium', t.complexity ?? 0, t.assessment ? j(t.assessment) : null, now).changes;
      }
    });
    return inserted;
  }
  /** Failed attempts per RVA in other runs (dead/quarantined/cancelled packets) — a complexity signal. */
  priorFailures(runId: string, rvas: string[]): Map<string, number> {
    if (!rvas.length) return new Map();
    const want = new Set(rvas);
    const rows = this.db.prepare(`SELECT json_extract(f.value, '$.rva') rva, SUM(t.attempts_total) n
      FROM tasks t, json_each(t.functions_json) f
      WHERE t.run_id != ? AND t.state IN ('dead','quarantined','cancelled') GROUP BY rva`).all(runId) as Array<{ rva: string; n: number }>;
    return new Map(rows.filter((r) => want.has(r.rva)).map((r) => [r.rva, r.n]));
  }
  setAssessment(taskId: string, a: ComplexityAssessment) {
    this.db.prepare('UPDATE tasks SET assessment_json = ?, complexity = ? WHERE id = ?').run(j(a), a.score, taskId);
  }
  difficultyCounts(runId: string) {
    return this.db.prepare(`SELECT difficulty, tier, state, COUNT(*) n, SUM(json_array_length(functions_json)) functions
      FROM tasks WHERE run_id = ? GROUP BY difficulty, tier, state`).all(runId) as Array<{ difficulty: Difficulty; tier: number; state: TaskState; n: number; functions: number }>;
  }
  getTask(id: string): TaskRow | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Raw | undefined;
    return r ? toTask(r) : null;
  }
  listTasks(runId: string, opts: { state?: TaskState; limit?: number; offset?: number } = {}): TaskRow[] {
    const where = opts.state ? 'AND state = @state' : '';
    return this.db
      .prepare(`SELECT * FROM tasks WHERE run_id = @runId ${where} ORDER BY priority DESC, rowid LIMIT @limit OFFSET @offset`)
      .all({ runId, state: opts.state, limit: opts.limit ?? 200, offset: opts.offset ?? 0 })
      .map((r) => toTask(r as Raw));
  }
  taskCounts(runId: string): Record<string, number> {
    const rows = this.db.prepare('SELECT state, COUNT(*) n FROM tasks WHERE run_id = ? GROUP BY state').all(runId) as Raw[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
  functionCounts(runId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, SUM(json_array_length(functions_json)) n FROM tasks WHERE run_id = ? GROUP BY state')
      .all(runId) as Raw[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  // ---------------- attempts ----------------
  insertAttempt(a: Attempt) {
    this.db.prepare(`INSERT INTO attempts (id, task_id, run_id, n, tier, node_id, account_id, model, status, bundle_hash,
      usage_json, cost_usd, latency_ms, error, files_json, started_at, finished_at, difficulty, context_tokens, context_raw_tokens,
      input_tokens, cached_input_tokens, cache_write_tokens, output_tokens)
      VALUES (@id, @taskId, @runId, @n, @tier, @nodeId, @accountId, @model, @status, @bundleHash, @usage, @costUsd,
      @latencyMs, @error, @files, @startedAt, @finishedAt, @difficulty, @contextTokens, @contextRawTokens, @i, @c, @w, @o)`).run({
      ...a, usage: j(a.usage), files: a.files ? j(a.files) : null, difficulty: a.difficulty ?? null,
      contextTokens: a.contextTokens ?? null, contextRawTokens: a.contextRawTokens ?? null,
      i: a.usage.inputTokens, c: a.usage.cacheReadTokens, w: a.usage.cacheWriteTokens, o: a.usage.outputTokens,
    });
  }
  updateAttempt(id: string, patch: Partial<Pick<Attempt, 'status' | 'accountId' | 'model' | 'bundleHash' | 'usage' | 'costUsd' | 'latencyMs' | 'error' | 'files' | 'finishedAt'>>) {
    const map: Record<string, string> = {
      status: 'status', accountId: 'account_id', model: 'model', bundleHash: 'bundle_hash', usage: 'usage_json',
      costUsd: 'cost_usd', latencyMs: 'latency_ms', error: 'error', files: 'files_json', finishedAt: 'finished_at',
    };
    const sets: string[] = [];
    const params: Raw = { id };
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${map[k]} = @${k}`);
      params[k] = k === 'usage' || k === 'files' ? (v == null ? null : j(v)) : v;
    }
    if (patch.usage) {
      sets.push('input_tokens = @ui', 'cached_input_tokens = @uc', 'cache_write_tokens = @uw', 'output_tokens = @uo');
      Object.assign(params, { ui: patch.usage.inputTokens, uc: patch.usage.cacheReadTokens, uw: patch.usage.cacheWriteTokens, uo: patch.usage.outputTokens });
    }
    if (sets.length) this.db.prepare(`UPDATE attempts SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
  attemptsForTask(taskId: string): Attempt[] {
    return this.db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY n').all(taskId).map((r) => toAttempt(r as Raw));
  }
  getAttempt(id: string): Attempt | null {
    const r = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as Raw | undefined;
    return r ? toAttempt(r) : null;
  }
  runUsage(runId: string) {
    return this.db.prepare(`SELECT COUNT(*) attempts,
        SUM(CASE WHEN status = 'provider_error' THEN 1 ELSE 0 END) provider_errors,
        SUM(CASE WHEN status = 'parse_error' THEN 1 ELSE 0 END) parse_errors,
        SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
        SUM(cached_input_tokens) cache_read_tokens, SUM(cache_write_tokens) cache_write_tokens,
        SUM(context_tokens) context_tokens, SUM(context_raw_tokens) context_raw_tokens,
        SUM(cost_usd) cost_usd
      FROM attempts WHERE run_id = ?`).get(runId) as Raw;
  }
  usageByAccount(runId: string) {
    return this.db.prepare(`SELECT account_id, model, COUNT(*) attempts,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN status = 'provider_error' THEN 1 ELSE 0 END) provider_errors,
        SUM(input_tokens) input_tokens, SUM(cached_input_tokens) cached_input_tokens,
        SUM(cache_write_tokens) cache_write_tokens, SUM(output_tokens) output_tokens,
        CASE WHEN SUM(input_tokens) > 0 THEN 1.0 * SUM(cached_input_tokens) / SUM(input_tokens) ELSE 0 END cache_hit_rate,
        SUM(cost_usd) cost_usd, AVG(latency_ms) avg_latency_ms
      FROM attempts WHERE run_id = ? GROUP BY account_id, model ORDER BY attempts DESC`).all(runId) as Raw[];
  }
  /** Attempts and outcomes per (difficulty, tier) — the routing matrix on the dashboard. */
  routingMatrix(runId: string) {
    return this.db.prepare(`SELECT a.difficulty, a.tier, COUNT(*) attempts, SUM(CASE WHEN v.decision = 'pass' THEN 1 ELSE 0 END) passed,
        SUM(a.input_tokens) input_tokens, SUM(a.output_tokens) output_tokens, SUM(a.cost_usd) cost_usd
      FROM attempts a LEFT JOIN verdicts v ON v.attempt_id = a.id
      WHERE a.run_id = ? AND a.status IN ('completed','parse_error') GROUP BY a.difficulty, a.tier`).all(runId) as Raw[];
  }

  // ---------------- verdicts ----------------
  insertVerdict(v: Verdict) {
    this.db.prepare(`INSERT INTO verdicts (id, task_id, attempt_id, decision, route, findings_json, compare_json, exact_bytes, stages_json, created_at)
      VALUES (@id, @taskId, @attemptId, @decision, @route, @findings, @compare, @exactBytes, @stages, @createdAt)`)
      .run({ ...v, findings: j(v.findings), compare: v.compare ? j(v.compare) : null, stages: j(v.stages) });
  }
  getVerdict(id: string): Verdict | null {
    const r = this.db.prepare('SELECT * FROM verdicts WHERE id = ?').get(id) as Raw | undefined;
    return r ? toVerdict(r) : null;
  }
  verdictsForTask(taskId: string): Verdict[] {
    return this.db.prepare('SELECT * FROM verdicts WHERE task_id = ? ORDER BY created_at').all(taskId).map((r) => toVerdict(r as Raw));
  }
  /** Most frequent rejection codes in a run — fed back into bundles as "common pitfalls". */
  topFindingCodes(runId: string, limit = 8): Array<{ code: string; n: number }> {
    return this.db.prepare(`SELECT json_extract(f.value, '$.code') code, COUNT(*) n
      FROM verdicts v JOIN tasks t ON t.id = v.task_id, json_each(v.findings_json) f
      WHERE t.run_id = ? AND json_extract(f.value, '$.severity') = 'block'
      GROUP BY code ORDER BY n DESC LIMIT ?`).all(runId, limit) as Array<{ code: string; n: number }>;
  }

  // ---------------- bundles / lessons / batches ----------------
  getBundle(hash: string) {
    const r = this.db.prepare('SELECT json FROM bundles WHERE hash = ?').get(hash) as Raw | undefined;
    return r ? JSON.parse(r.json) : null;
  }
  putBundle(hash: string, bundle: unknown) {
    this.db.prepare('INSERT OR IGNORE INTO bundles (hash, json, created_at) VALUES (?, ?, ?)').run(hash, j(bundle), Date.now());
  }
  upsertLesson(l: { id: string; source: string; topic: string; text: string; weight: number; tags?: string[] }) {
    this.db.prepare(`INSERT INTO lessons (id, source, topic, text, weight, tags_json, created_at) VALUES (@id, @source, @topic, @text, @weight, @tags, @now)
      ON CONFLICT(id) DO UPDATE SET text = excluded.text, weight = excluded.weight, tags_json = excluded.tags_json`)
      .run({ ...l, tags: j(l.tags?.length ? [...l.tags].sort() : ['general']), now: Date.now() });
  }
  lessons(limit = 40): LessonRow[] {
    return (this.db.prepare('SELECT id, source, topic, text, weight, tags_json FROM lessons ORDER BY weight DESC, id LIMIT ?').all(limit) as Raw[])
      .map((r) => ({ id: r.id, source: r.source, topic: r.topic, text: r.text, weight: r.weight, tags: p<string[]>(r.tags_json, ['general']) }));
  }

  // ---------------- run knowledge cache ----------------
  upsertKnowledge(entries: KnowledgeEntry[]) {
    const stmt = this.db.prepare(`INSERT INTO run_knowledge_cache (run_id, kind, symbol, content, symbols_json, source_task_id, source_unit, verified_at, uses)
      VALUES (@runId, @kind, @symbol, @content, @symbols, @sourceTaskId, @sourceUnit, @verifiedAt, 0)
      ON CONFLICT(run_id, kind, symbol) DO UPDATE SET content = excluded.content, symbols_json = excluded.symbols_json,
        source_task_id = excluded.source_task_id, source_unit = excluded.source_unit, verified_at = excluded.verified_at`);
    this.tx(() => entries.forEach((e) => stmt.run({ ...e, symbols: j(e.symbols) })));
    return entries.length;
  }
  /**
   * Candidate entries for a packet: keyed by one of `symbols`, or mentioning one of `mentions`
   * (e.g. the packet's class). The context builder ranks and budgets them.
   */
  knowledgeFor(runId: string, symbols: string[], limit = 64, mentions: string[] = []): KnowledgeEntry[] {
    const keys = [...new Set(symbols)].slice(0, 400);
    const ment = [...new Set(mentions)].slice(0, 50);
    if (!keys.length && !ment.length) return [];
    const q = (n: number) => (n ? Array(n).fill('?').join(',') : `''`);
    const rows = this.db.prepare(`SELECT * FROM run_knowledge_cache k WHERE k.run_id = ? AND (k.symbol IN (${q(keys.length)})
        OR EXISTS (SELECT 1 FROM json_each(k.symbols_json) s WHERE s.value IN (${q(ment.length)})))
      ORDER BY k.verified_at DESC LIMIT ?`).all(runId, ...keys, ...ment, limit) as Raw[];
    return rows.map(toKnowledge);
  }
  listKnowledge(runId: string, limit = 200): KnowledgeEntry[] {
    return (this.db.prepare('SELECT * FROM run_knowledge_cache WHERE run_id = ? ORDER BY uses DESC, verified_at DESC LIMIT ?').all(runId, limit) as Raw[]).map(toKnowledge);
  }
  knowledgeStats(runId: string) {
    return this.db.prepare('SELECT kind, COUNT(*) n, SUM(uses) uses FROM run_knowledge_cache WHERE run_id = ? GROUP BY kind').all(runId) as Array<{ kind: KnowledgeKind; n: number; uses: number }>;
  }
  bumpKnowledgeUses(runId: string, keys: Array<{ kind: KnowledgeKind; symbol: string }>) {
    const stmt = this.db.prepare('UPDATE run_knowledge_cache SET uses = uses + 1 WHERE run_id = ? AND kind = ? AND symbol = ?');
    this.tx(() => keys.forEach((k) => stmt.run(runId, k.kind, k.symbol)));
  }
  createBatch(b: { id: string; runId: string; seq: number; taskIds: string[] }) {
    this.db.prepare(`INSERT OR IGNORE INTO pr_batches (id, run_id, seq, status, task_ids_json, created_at) VALUES (?, ?, ?, 'draft', ?, ?)`)
      .run(b.id, b.runId, b.seq, j(b.taskIds), Date.now());
  }
  updateBatch(id: string, patch: { status?: string; branch?: string | null; detail?: unknown }) {
    this.db.prepare('UPDATE pr_batches SET status = COALESCE(@status, status), branch = COALESCE(@branch, branch), detail_json = COALESCE(@detail, detail_json) WHERE id = @id')
      .run({ id, status: patch.status ?? null, branch: patch.branch ?? null, detail: patch.detail === undefined ? null : j(patch.detail) });
  }
  listBatches(runId: string) {
    return (this.db.prepare('SELECT * FROM pr_batches WHERE run_id = ? ORDER BY seq').all(runId) as Raw[]).map((r) => ({
      id: r.id as string, runId: r.run_id as string, seq: r.seq as number, status: r.status as string,
      taskIds: p<string[]>(r.task_ids_json, []), branch: r.branch as string | null, detail: p(r.detail_json, null),
      createdAt: r.created_at as number,
    }));
  }
  getBatch(id: string) {
    const runId = (this.db.prepare('SELECT run_id FROM pr_batches WHERE id = ?').get(id) as Raw | undefined)?.run_id as string | undefined;
    return runId ? (this.listBatches(runId).find((b) => b.id === id) ?? null) : null;
  }
  unstageBatch(batch: NonNullable<ReturnType<Store['getBatch']>>, detail: unknown) {
    this.tx(() => {
      this.db.prepare("UPDATE pr_batches SET status = 'branch_deleted', branch = NULL, detail_json = ? WHERE id = ?")
        .run(j(detail), batch.id);
      const unstage = this.db.prepare("UPDATE tasks SET state = 'passed', updated_at = ? WHERE id = ? AND run_id = ? AND state = 'staged'");
      for (const id of batch.taskIds) unstage.run(Date.now(), id, batch.runId);
    });
  }
  /** Rename a run and/or replace its config (already validated by the caller). */
  updateRun(id: string, patch: { name?: string; config?: RunConfig }) {
    return this.db.prepare('UPDATE runs SET name = COALESCE(@name, name), config_json = COALESCE(@config, config_json), updated_at = @now WHERE id = @id')
      .run({ id, name: patch.name ?? null, config: patch.config ? j(patch.config) : null, now: Date.now() }).changes > 0;
  }
  /** Delete a run and everything recorded under it (tasks, attempts, verdicts, events, batches...). */
  deleteRun(id: string) {
    return this.tx(() => {
      const tasks = `SELECT id FROM tasks WHERE run_id = @id`;
      for (const sql of [
        `DELETE FROM skill_injections WHERE run_id = @id OR task_id IN (${tasks})`,
        `DELETE FROM worker_assignments WHERE run_id = @id`,
        `DELETE FROM run_workers WHERE run_id = @id`,
        `DELETE FROM gathered_functions WHERE run_id = @id`,
        `DELETE FROM run_knowledge_cache WHERE run_id = @id`,
        `DELETE FROM pr_batches WHERE run_id = @id`,
        `DELETE FROM events WHERE run_id = @id OR task_id IN (${tasks})`,
        `DELETE FROM verdicts WHERE task_id IN (${tasks})`,
        `DELETE FROM attempts WHERE run_id = @id OR task_id IN (${tasks})`,
        `DELETE FROM tasks WHERE run_id = @id`,
      ]) this.db.prepare(sql).run({ id });
      return this.db.prepare('DELETE FROM runs WHERE id = @id').run({ id }).changes > 0;
    });
  }
  /** Functions of the given runs' dead packets (deduplicated, in RVA order). */
  deadFunctions(runIds: string[]): Array<{ rva: string; name: string | null; runId: string }> {
    if (!runIds.length) return [];
    const rows = this.db.prepare(`SELECT t.run_id, json_extract(f.value, '$.rva') rva, json_extract(f.value, '$.name') name FROM tasks t, json_each(t.functions_json) f
      WHERE t.state = 'dead' AND t.run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY rva`).all(...runIds) as Array<{ run_id: string; rva: string; name: string | null }>;
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.rva) && seen.add(r.rva)).map((r) => ({ rva: r.rva, name: r.name, runId: r.run_id }));
  }
  // ---------------- function gathering (Phase 4)
  /** RVAs this tool is still working on (open in any run) or matched but not yet submitted. */
  rvasInFlight(excludeRunId: string | null): Set<string> {
    const rows = this.db.prepare(`SELECT DISTINCT json_extract(f.value, '$.rva') rva FROM tasks t, json_each(t.functions_json) f
      WHERE t.state IN ('pending','leased','gating','passed','staged','withheld') AND t.run_id != COALESCE(?, '')`).all(excludeRunId) as Array<{ rva: string }>;
    return new Set(rows.map((r) => r.rva));
  }
  putGathered(runId: string, fns: Array<{ rva: string; name: string | null; nameOrigin?: string | null; size: number; unit: string; header: string | null; signature: string | null; draft: string; readiness?: number; xrefsIn: number | null; xrefsOut: number | null; basicBlocks: number | null; instructions: number | null; branches: number | null; sources: string[] }>) {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO gathered_functions (run_id, rva, name, name_origin, size, unit, header, signature, draft, readiness, xrefs_in, xrefs_out, basic_blocks, instructions, branches, sources_json)
      VALUES (@runId, @rva, @name, @nameOrigin, @size, @unit, @header, @signature, @draft, @readiness, @xrefsIn, @xrefsOut, @basicBlocks, @instructions, @branches, @sources)`);
    this.tx(() => fns.forEach((f) => stmt.run({ ...f, runId, nameOrigin: f.nameOrigin ?? null, readiness: f.readiness ?? null, sources: j(f.sources) })));
  }
  gathered(runId: string, limit = 1000) {
    return (this.db.prepare('SELECT * FROM gathered_functions WHERE run_id = ? ORDER BY readiness, size LIMIT ?').all(runId, limit) as Raw[]).map((r) => ({
      rva: r.rva as string, name: r.name as string | null, nameOrigin: r.name_origin as string | null, size: r.size as number, unit: r.unit as string, header: r.header as string | null,
      signature: r.signature as string | null, draft: r.draft as string, readiness: r.readiness as number | null, xrefsIn: r.xrefs_in as number | null, xrefsOut: r.xrefs_out as number | null,
      basicBlocks: r.basic_blocks as number | null, instructions: r.instructions as number | null, branches: r.branches as number | null, sources: p<string[]>(r.sources_json, []),
    }));
  }
  setRunJson(runId: string, col: 'gather_json' | 'capacity_json', value: unknown) {
    this.db.prepare(`UPDATE runs SET ${col} = ? WHERE id = ?`).run(value == null ? null : j(value), runId);
  }
  runJson<T>(runId: string, col: 'gather_json' | 'capacity_json'): T | null {
    const r = this.db.prepare(`SELECT ${col} v FROM runs WHERE id = ?`).get(runId) as { v: string | null } | undefined;
    return r?.v ? (JSON.parse(r.v) as T) : null;
  }

  // ---------------- per-worker function caps (Phase 4)
  /** Register a run's worker instances (idempotent: counts survive restarts and resumes). */
  registerWorkers(runId: string, workers: Array<{ workerId: string; nodeId: string; tier: number; capability: string | null }>, maxFunctions: number) {
    const stmt = this.db.prepare(`INSERT INTO run_workers (run_id, worker_id, node_id, tier, capability, max_functions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, worker_id) DO UPDATE SET tier = excluded.tier, capability = excluded.capability`);
    const now = Date.now();
    this.tx(() => workers.forEach((w) => stmt.run(runId, w.workerId, w.nodeId, w.tier, w.capability, maxFunctions, now)));
  }
  /** Replace a run's flow snapshot (live-compatible edits only; the engine checks) and its workers' tier capability. */
  setRunFlow(runId: string, flow: Flow, capabilityByTier: string[]) {
    this.tx(() => {
      this.db.prepare('UPDATE runs SET flow_json = ?, updated_at = ? WHERE id = ?').run(j(flow), Date.now(), runId);
      const stmt = this.db.prepare('UPDATE run_workers SET capability = ? WHERE run_id = ? AND tier = ?');
      capabilityByTier.forEach((c, tier) => stmt.run(c, runId, tier));
    });
  }
  workerStats(runId: string) {
    return this.db.prepare(`SELECT w.worker_id, w.node_id, w.tier, w.capability, w.max_functions, w.assigned_function_count, w.assigned_tasks,
        (SELECT COALESCE(SUM(json_array_length(t.functions_json)), 0) FROM tasks t WHERE t.run_id = w.run_id AND t.assigned_worker = w.worker_id AND t.state IN ('passed','staged','withheld')) passed_functions,
        (SELECT COUNT(*) FROM attempts a WHERE a.run_id = w.run_id AND a.worker_id = w.worker_id) attempts
      FROM run_workers w WHERE w.run_id = ? ORDER BY w.tier, w.worker_id`).all(runId) as Array<{
        worker_id: string; node_id: string; tier: number; capability: string | null; max_functions: number; assigned_function_count: number; assigned_tasks: number; passed_functions: number; attempts: number;
      }>;
  }
  /** Change a run's USD budget (null removes the cap): the operator's way past a budget pause. */
  setRunBudget(runId: string, budgetUsd: number | null): boolean {
    const sql = budgetUsd === null
      ? 'UPDATE runs SET config_json = json_remove(config_json, \'$.budgetUsd\'), updated_at = @now WHERE id = @id'
      : 'UPDATE runs SET config_json = json_set(config_json, \'$.budgetUsd\', @b), updated_at = @now WHERE id = @id';
    return this.db.prepare(sql).run({ id: runId, now: Date.now(), ...(budgetUsd === null ? {} : { b: budgetUsd }) }).changes > 0;
  }

  /** Raise (never lower) the per-worker cap of a run: the operator's way out of a capacity stall. */
  raiseWorkerCap(runId: string, max: number): boolean {
    const run = this.getRun(runId);
    if (!run) return false;
    const cur = (this.db.prepare('SELECT MAX(max_functions) m FROM run_workers WHERE run_id = ?').get(runId) as { m: number | null }).m ?? run.config.maxFunctionsPerWorker;
    if (max <= cur) return false;
    this.tx(() => {
      this.db.prepare('UPDATE runs SET config_json = json_set(config_json, \'$.maxFunctionsPerWorker\', ?), updated_at = ? WHERE id = ?').run(max, Date.now(), runId);
      this.db.prepare('UPDATE run_workers SET max_functions = ? WHERE run_id = ? AND max_functions < ?').run(max, runId, max);
    });
    return true;
  }

  maxBatchSeq(runId: string): number {
    return ((this.db.prepare('SELECT MAX(seq) m FROM pr_batches WHERE run_id = ?').get(runId) as Raw).m as number | null) ?? 0;
  }
}
