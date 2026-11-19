// SPDX-License-Identifier: AGPL-3.0-or-later
// SQLite persistence (WAL). The SQL is deliberately portable: plain tables, JSON stored as TEXT,
// integer epoch-ms timestamps and conditional UPDATEs for state transitions. Porting to Postgres
// means swapping this module (JSON -> jsonb, lease query -> FOR UPDATE SKIP LOCKED); the rest of
// the server talks to the typed repositories in store.ts only.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE account_runtime (
    account_id TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE flows (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    config_json TEXT NOT NULL,
    flow_json TEXT NOT NULL,          -- snapshot: editing a flow never changes a running run
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    unit TEXT NOT NULL,
    functions_key TEXT NOT NULL,      -- sorted RVAs; makes discovery idempotent
    functions_json TEXT NOT NULL,
    state TEXT NOT NULL,
    priority REAL NOT NULL DEFAULT 0,
    tier INTEGER NOT NULL DEFAULT 0,
    attempts_total INTEGER NOT NULL DEFAULT 0,
    attempts_at_tier INTEGER NOT NULL DEFAULT 0,
    no_improvement_streak INTEGER NOT NULL DEFAULT 0,
    best_exact_bytes INTEGER NOT NULL DEFAULT 0,
    cheat_strikes INTEGER NOT NULL DEFAULT 0,
    infra_failures INTEGER NOT NULL DEFAULT 0,
    provider_failures INTEGER NOT NULL DEFAULT 0,
    lease_id TEXT,
    lease_expires_at INTEGER,
    not_before INTEGER NOT NULL DEFAULT 0,
    last_verdict_id TEXT,
    sr_task_id TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (run_id, unit, functions_key)
  );
  CREATE INDEX tasks_lease ON tasks (run_id, state, tier, not_before, priority);
  CREATE INDEX tasks_unit ON tasks (run_id, unit, state);
  CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    run_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    tier INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    account_id TEXT,
    model TEXT,
    status TEXT NOT NULL,
    bundle_hash TEXT,
    usage_json TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    error TEXT,
    files_json TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX attempts_task ON attempts (task_id, n);
  CREATE INDEX attempts_run ON attempts (run_id, status);
  CREATE TABLE verdicts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    decision TEXT NOT NULL,
    route TEXT NOT NULL,
    findings_json TEXT NOT NULL,
    compare_json TEXT,
    exact_bytes INTEGER NOT NULL DEFAULT 0,
    stages_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX verdicts_task ON verdicts (task_id, created_at);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    run_id TEXT,
    task_id TEXT,
    kind TEXT NOT NULL,
    level TEXT NOT NULL,
    msg TEXT NOT NULL,
    data_json TEXT
  );
  CREATE INDEX events_run ON events (run_id, seq);
  CREATE INDEX events_task ON events (task_id, seq);
  CREATE TABLE bundles (
    hash TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE lessons (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    topic TEXT NOT NULL,
    text TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE pr_batches (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL,             -- draft | branch_ready | submitted | failed
    task_ids_json TEXT NOT NULL,
    branch TEXT,
    detail_json TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (run_id, seq)
  );
  `,
  // v2 — Phase 2: complexity routing, token/caching telemetry, run knowledge cache, tagged lessons.
  // Additive only: pre-existing rows get neutral defaults and usage columns are backfilled.
  `
  ALTER TABLE tasks ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'medium';
  ALTER TABLE tasks ADD COLUMN complexity REAL NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN attempts_at_difficulty INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN assessment_json TEXT;
  CREATE INDEX tasks_difficulty ON tasks (run_id, difficulty, state);

  ALTER TABLE attempts ADD COLUMN difficulty TEXT;
  ALTER TABLE attempts ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;         -- all input, cached or not
  ALTER TABLE attempts ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;  -- served from the prompt cache
  ALTER TABLE attempts ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE attempts ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE attempts ADD COLUMN context_tokens INTEGER;                          -- bundle as sent (estimate)
  ALTER TABLE attempts ADD COLUMN context_raw_tokens INTEGER;                      -- unsliced sources (estimate)
  UPDATE attempts SET
    input_tokens = COALESCE(json_extract(usage_json, '$.inputTokens'), 0),
    cached_input_tokens = COALESCE(json_extract(usage_json, '$.cacheReadTokens'), 0),
    cache_write_tokens = COALESCE(json_extract(usage_json, '$.cacheWriteTokens'), 0),
    output_tokens = COALESCE(json_extract(usage_json, '$.outputTokens'), 0);
  CREATE INDEX attempts_account ON attempts (run_id, account_id, model);

  ALTER TABLE runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
  UPDATE runs SET
    input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM attempts a WHERE a.run_id = runs.id),
    cached_input_tokens = (SELECT COALESCE(SUM(cached_input_tokens), 0) FROM attempts a WHERE a.run_id = runs.id),
    cache_write_tokens = (SELECT COALESCE(SUM(cache_write_tokens), 0) FROM attempts a WHERE a.run_id = runs.id),
    output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM attempts a WHERE a.run_id = runs.id);

  ALTER TABLE lessons ADD COLUMN tags_json TEXT NOT NULL DEFAULT '["general"]';

  CREATE TABLE run_knowledge_cache (
    run_id TEXT NOT NULL REFERENCES runs(id),
    kind TEXT NOT NULL,               -- function_signature | struct_layout | global | type_decl
    symbol TEXT NOT NULL,             -- key: struct / function / global name
    content TEXT NOT NULL,            -- the verified declaration as accepted (public source)
    symbols_json TEXT NOT NULL,       -- identifiers it mentions, for matching
    source_task_id TEXT NOT NULL,
    source_unit TEXT NOT NULL,
    verified_at INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, kind, symbol)
  );
  CREATE INDEX knowledge_symbol ON run_knowledge_cache (run_id, symbol);
  `,
  // v3 — Phase 3: skill registry, immutable skill versions, shadow evaluations, per-attempt skill
  // injections (the telemetry behind lift, failure clusters and core promotion), curator jobs.
  `
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,                 -- candidate | active | promoted_to_core | deprecated
    version INTEGER NOT NULL,             -- current version (candidates: their proposed v1)
    origin TEXT NOT NULL,                 -- repo_bootstrap | pr_history | retry_mining | failure_patch | compression | manual
    token_count INTEGER NOT NULL,
    triggers_json TEXT NOT NULL,
    body TEXT NOT NULL,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    status_reason TEXT,
    trigger_count INTEGER NOT NULL DEFAULT 0,      -- eligible (attempt, skill) pairs, injected or held out
    inject_count INTEGER NOT NULL DEFAULT 0,
    pass_count INTEGER NOT NULL DEFAULT 0,         -- injected attempts that passed the Gate Keeper
    fail_count INTEGER NOT NULL DEFAULT 0,
    holdout_count INTEGER NOT NULL DEFAULT 0,
    holdout_pass_count INTEGER NOT NULL DEFAULT 0,
    tokens_injected INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX skills_status ON skills (status);
  CREATE TABLE skill_versions (
    skill_id TEXT NOT NULL REFERENCES skills(id),
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    triggers_json TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    state TEXT NOT NULL,                  -- proposed | accepted | rejected | superseded
    change_kind TEXT NOT NULL,            -- create | patch | tighten | compress | manual
    rationale TEXT,
    evidence_json TEXT,
    parent_version INTEGER,
    eval_run_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY (skill_id, version)
  );
  CREATE INDEX skill_versions_state ON skill_versions (state, created_at);
  CREATE TABLE skill_eval_runs (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id),
    version INTEGER NOT NULL,
    baseline_version INTEGER,             -- NULL: baseline is "without this skill"
    status TEXT NOT NULL,                 -- running | passed | failed | error
    cases INTEGER NOT NULL DEFAULT 0,
    baseline_pass INTEGER NOT NULL DEFAULT 0,
    candidate_pass INTEGER NOT NULL DEFAULT 0,
    baseline_tokens INTEGER NOT NULL DEFAULT 0,
    candidate_tokens INTEGER NOT NULL DEFAULT 0,
    baseline_exact INTEGER NOT NULL DEFAULT 0,
    candidate_exact INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    decision TEXT,                        -- accept | reject
    reason TEXT,
    details_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX skill_eval_skill ON skill_eval_runs (skill_id, created_at);
  CREATE TABLE skill_injections (
    attempt_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    placement TEXT NOT NULL,              -- packet | retry
    injected INTEGER NOT NULL,            -- 0 = eligible but held out (control group)
    tokens INTEGER NOT NULL,
    score REAL NOT NULL,
    matched_json TEXT NOT NULL,
    difficulty TEXT,
    functions INTEGER NOT NULL DEFAULT 1,
    decision TEXT,                        -- verdict decision, filled when the attempt is routed
    category TEXT,                        -- BYTE_MISMATCH | COMPILE_ERROR | ... (first blocking finding)
    code TEXT,                            -- first blocking finding code
    created_at INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, skill_id)
  );
  CREATE INDEX skill_inj_skill ON skill_injections (skill_id, decision);
  CREATE INDEX skill_inj_run ON skill_injections (run_id, skill_id);
  CREATE TABLE skill_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                   -- bootstrap | mine | update | optimize | shadow | curate
    status TEXT NOT NULL,                 -- running | done | failed
    summary_json TEXT NOT NULL DEFAULT '{}',
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  ALTER TABLE runs ADD COLUMN skills_json TEXT;   -- frozen RunSkillSnapshot (core prefix + dynamic set)
  `,
  // v4 — Phase 4: function gathering, per-worker function caps, capacity plans.
  `
  CREATE TABLE run_workers (
    run_id TEXT NOT NULL REFERENCES runs(id),
    worker_id TEXT NOT NULL,              -- <flow node id>#<instance>, stable across restarts
    node_id TEXT NOT NULL,
    tier INTEGER NOT NULL,
    capability TEXT,
    max_functions INTEGER NOT NULL,       -- RunConfig.maxFunctionsPerWorker (default 60)
    assigned_function_count INTEGER NOT NULL DEFAULT 0,   -- distinct functions claimed in this run
    assigned_tasks INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, worker_id),
    CHECK (assigned_function_count <= max_functions)
  );
  CREATE TABLE worker_assignments (
    run_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    functions INTEGER NOT NULL,
    assigned_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, worker_id, task_id)
  );
  CREATE INDEX worker_assign_task ON worker_assignments (run_id, task_id);
  ALTER TABLE tasks ADD COLUMN assigned_worker TEXT;
  ALTER TABLE attempts ADD COLUMN worker_id TEXT;

  CREATE TABLE gathered_functions (
    run_id TEXT NOT NULL REFERENCES runs(id),
    rva TEXT NOT NULL,
    name TEXT,
    name_origin TEXT,
    size INTEGER NOT NULL,
    unit TEXT NOT NULL,
    header TEXT,
    signature TEXT,
    draft TEXT NOT NULL,                  -- none | stub | present
    readiness INTEGER,
    xrefs_in INTEGER,
    xrefs_out INTEGER,
    basic_blocks INTEGER,
    instructions INTEGER,
    branches INTEGER,
    sources_json TEXT NOT NULL,
    PRIMARY KEY (run_id, rva)
  );
  ALTER TABLE runs ADD COLUMN gather_json TEXT;     -- GatherReport without the function list
  ALTER TABLE runs ADD COLUMN capacity_json TEXT;   -- per-tier demand vs worker capacity

  -- Names used by the Phase 4 spec, over the Phase 2 columns/tables that already hold the data.
  CREATE VIEW task_complexity AS SELECT id AS task_id, run_id, difficulty AS complexity_tier, complexity AS complexity_score, assigned_worker FROM tasks;
  CREATE VIEW shared_run_discoveries AS SELECT * FROM run_knowledge_cache;
  `,
];

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL'); // WAL + NORMAL: durable at checkpoint, survives process crash
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
