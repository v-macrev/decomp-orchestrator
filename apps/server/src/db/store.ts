// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed repositories over the database. Row <-> domain mapping lives here and nowhere else.
import {
  Account, AccountRuntime, Attempt, Flow, FunctionTarget, RunConfig, Task, Verdict,
  type RunStatus, type TaskState, type Usage,
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
}

export interface TaskRow extends Task {
  infraFailures: number;
  providerFailures: number;
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
  };
}

function toAttempt(r: Raw): Attempt {
  return {
    id: r.id, taskId: r.task_id, runId: r.run_id, n: r.n, tier: r.tier, nodeId: r.node_id,
    accountId: r.account_id, model: r.model, status: r.status, bundleHash: r.bundle_hash,
    usage: p<Usage>(r.usage_json, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    costUsd: r.cost_usd, latencyMs: r.latency_ms, error: r.error,
    files: p(r.files_json, null), startedAt: r.started_at, finishedAt: r.finished_at,
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
  return {
    id: r.id, name: r.name, status: r.status, config: RunConfig.parse(JSON.parse(r.config_json)),
    flow: Flow.parse(JSON.parse(r.flow_json)), costUsd: r.cost_usd, error: r.error,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, updatedAt: r.updated_at,
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
    if (to === 'running') sets.push('started_at = COALESCE(started_at, @now)');
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
  activeRuns(): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE status IN ('discovering','running','paused')").all().map((r) => toRun(r as Raw));
  }

  // ---------------- tasks ----------------
  insertTasks(runId: string, packets: Array<{ id: string; unit: string; functions: FunctionTarget[]; priority: number }>) {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO tasks (id, run_id, unit, functions_key, functions_json, state, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`);
    const now = Date.now();
    let inserted = 0;
    this.tx(() => {
      for (const t of packets) {
        const key = t.functions.map((f) => f.rva).sort().join(',');
        inserted += stmt.run(t.id, runId, t.unit, key, j(t.functions), t.priority, now).changes;
      }
    });
    return inserted;
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
      usage_json, cost_usd, latency_ms, error, files_json, started_at, finished_at)
      VALUES (@id, @taskId, @runId, @n, @tier, @nodeId, @accountId, @model, @status, @bundleHash, @usage, @costUsd,
      @latencyMs, @error, @files, @startedAt, @finishedAt)`).run({ ...a, usage: j(a.usage), files: a.files ? j(a.files) : null });
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
        SUM(json_extract(usage_json, '$.inputTokens')) input_tokens,
        SUM(json_extract(usage_json, '$.outputTokens')) output_tokens,
        SUM(json_extract(usage_json, '$.cacheReadTokens')) cache_read_tokens,
        SUM(cost_usd) cost_usd
      FROM attempts WHERE run_id = ?`).get(runId) as Raw;
  }
  usageByAccount(runId: string) {
    return this.db.prepare(`SELECT account_id, model, COUNT(*) attempts,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN status = 'provider_error' THEN 1 ELSE 0 END) provider_errors,
        SUM(json_extract(usage_json, '$.inputTokens')) input_tokens,
        SUM(json_extract(usage_json, '$.outputTokens')) output_tokens,
        SUM(cost_usd) cost_usd, AVG(latency_ms) avg_latency_ms
      FROM attempts WHERE run_id = ? GROUP BY account_id, model ORDER BY attempts DESC`).all(runId) as Raw[];
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
  upsertLesson(l: { id: string; source: string; topic: string; text: string; weight: number }) {
    this.db.prepare(`INSERT INTO lessons (id, source, topic, text, weight, created_at) VALUES (@id, @source, @topic, @text, @weight, @now)
      ON CONFLICT(id) DO UPDATE SET text = excluded.text, weight = excluded.weight`).run({ ...l, now: Date.now() });
  }
  lessons(limit = 40): Array<{ id: string; source: string; topic: string; text: string; weight: number }> {
    return this.db.prepare('SELECT id, source, topic, text, weight FROM lessons ORDER BY weight DESC, id LIMIT ?').all(limit) as any;
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
  maxBatchSeq(runId: string): number {
    return ((this.db.prepare('SELECT MAX(seq) m FROM pr_batches WHERE run_id = ?').get(runId) as Raw).m as number | null) ?? 0;
  }
}
