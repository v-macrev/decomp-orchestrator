// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared domain model. Every persisted or transported shape is a Zod schema so the
// server, the UI and stored JSON columns all validate against the same source of truth.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Roles, providers, accounts
// ---------------------------------------------------------------------------

export const Role = z.enum(['orchestrator', 'worker', 'gatekeeper']);
export type Role = z.infer<typeof Role>;

export const ProviderKind = z.enum([
  'anthropic', // Messages API via @anthropic-ai/sdk (API key or OAuth token)
  'openai', // OpenAI API via openai SDK
  'openai_compat', // any OpenAI-compatible endpoint (vLLM, Ollama, OpenRouter, LM Studio...)
  'claude_cli', // Claude Code CLI with an isolated CLAUDE_CONFIG_DIR per account
  'codex_cli', // Codex CLI with an isolated CODEX_HOME per account
  'mock', // deterministic offline provider for simulation and tests
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * Secrets are never stored in the database. A secretRef points at where the secret lives:
 *   env:ANTHROPIC_KEY_WORKSPACE_A   -> process.env
 *   file:C:/secrets/openai.key      -> file contents (trimmed)
 */
export const SecretRef = z
  .string()
  .regex(/^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/, 'secretRef must be env:NAME or file:PATH');

export const AuthSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('api_key'), secretRef: SecretRef }),
  z.object({ type: z.literal('oauth_token'), secretRef: SecretRef }),
  z.object({
    type: z.literal('cli_profile'),
    /** Isolated config dir (CLAUDE_CONFIG_DIR / CODEX_HOME) holding that account's login. */
    configDir: z.string().min(1),
    binary: z.string().optional(),
  }),
  z.object({ type: z.literal('none') }),
]);
export type AuthSpec = z.infer<typeof AuthSpec>;

export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

export const ModelSpec = z.object({
  id: z.string().min(1),
  contextTokens: z.number().int().positive().default(200_000),
  maxOutputTokens: z.number().int().positive().default(32_000),
  defaultEffort: Effort.optional(),
  priceInPerMTok: z.number().nonnegative().default(0),
  priceOutPerMTok: z.number().nonnegative().default(0),
  priceCacheReadPerMTok: z.number().nonnegative().default(0),
  roles: z.array(Role).default(['worker']),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

export const AccountLimits = z.object({
  requestsPerMinute: z.number().positive().default(50),
  inputTokensPerMinute: z.number().positive().default(200_000),
  outputTokensPerMinute: z.number().positive().default(40_000),
  maxConcurrency: z.number().int().positive().default(4),
  /** Hard spend guard per UTC day, in USD. Account goes to quota_exhausted when hit. */
  dailyBudgetUsd: z.number().positive().optional(),
});
export type AccountLimits = z.infer<typeof AccountLimits>;

export const Account = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: z.string().min(1),
  provider: ProviderKind,
  /** Free-form workspace/org label, e.g. "anthropic:workspace-b". Purely informational. */
  workspace: z.string().optional(),
  baseUrl: z.string().url().optional(),
  auth: AuthSpec,
  models: z.array(ModelSpec).min(1),
  limits: AccountLimits.default(AccountLimits.parse({})),
  tags: z.array(z.string()).default([]),
  /** Higher wins ties. Use to prefer a cheaper/committed-spend account. */
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  /** Provider-specific knobs (mock failure rates, extra headers, ...). */
  options: z.record(z.string(), z.unknown()).default({}),
});
export type Account = z.infer<typeof Account>;

export const AccountStatus = z.enum([
  'ok',
  'cooling', // 429 / retry-after: temporarily unavailable
  'circuit_open', // repeated failures: stop sending until probe
  'half_open', // one probe request allowed
  'quota_exhausted', // budget / billing / quota error: long cooldown
  'disabled', // auth failure or operator action
]);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const AccountRuntime = z.object({
  accountId: z.string(),
  status: AccountStatus,
  cooldownUntil: z.number().nullable(),
  inFlight: z.number().int(),
  consecutiveFailures: z.number().int(),
  requestsTotal: z.number().int(),
  failuresTotal: z.number().int(),
  rateLimitedTotal: z.number().int(),
  inputTokensTotal: z.number().int(),
  outputTokensTotal: z.number().int(),
  costUsdToday: z.number(),
  costDay: z.string(),
  ewmaLatencyMs: z.number().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.number(),
});
export type AccountRuntime = z.infer<typeof AccountRuntime>;

// ---------------------------------------------------------------------------
// Flow graph (hierarchy + execution topology)
// ---------------------------------------------------------------------------

export const PoolBinding = z.object({
  /** bound: use exactly these accounts. pool: any enabled account matching tags. */
  strategy: z.enum(['bound', 'pool']).default('pool'),
  accountIds: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  /** Optional model override; otherwise the first model on the account that serves the role. */
  model: z.string().optional(),
  effort: Effort.optional(),
});
export type PoolBinding = z.infer<typeof PoolBinding>;

export const GateChecks = z.object({
  scope: z.boolean().default(true),
  leak: z.boolean().default(true),
  cheat: z.boolean().default(true),
  integrity: z.boolean().default(true),
  repoCompare: z.boolean().default(true),
  repoPreflight: z.boolean().default(true),
  /** LLM review: may block, never override a deterministic failure. */
  llmReview: z.boolean().default(false),
});
export type GateChecks = z.infer<typeof GateChecks>;

export const FlowNodeData = z.object({
  label: z.string().default(''),
  instances: z.number().int().min(1).max(256).default(1),
  pool: PoolBinding.default(PoolBinding.parse({})),
  /** Worker: max attempts at this tier before escalating / dead-lettering. */
  maxAttempts: z.number().int().min(1).max(20).default(6),
  /** Worker: stop the tier after N attempts without improvement in matching bytes. */
  stuckAfter: z.number().int().min(1).max(20).default(3),
  gate: GateChecks.default(GateChecks.parse({})),
  notes: z.string().optional(),
});
export type FlowNodeData = z.infer<typeof FlowNodeData>;

export const FlowNode = z.object({
  id: z.string().min(1),
  type: Role,
  position: z.object({ x: z.number(), y: z.number() }),
  data: FlowNodeData,
});
export type FlowNode = z.infer<typeof FlowNode>;

export const EdgeKind = z.enum([
  'dispatch', // orchestrator -> worker (tier 0 entry)
  'submit', // worker -> gatekeeper
  'reject_retry', // gatekeeper -> worker (feedback loop with failure trace)
  'escalate', // worker -> worker (next tier when stuck / attempts exhausted)
  'report', // gatekeeper -> orchestrator (aggregation of verdicts)
]);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const FlowEdge = z.object({
  id: z.string().min(1),
  source: z.string(),
  target: z.string(),
  kind: EdgeKind,
  /** Canvas only: which connection point (l/t/r/b) the edge leaves from and arrives at. */
  sourceHandle: z.string().max(16).nullable().optional(),
  targetHandle: z.string().max(16).nullable().optional(),
});
export type FlowEdge = z.infer<typeof FlowEdge>;

export const Flow = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().min(1),
  nodes: z.array(FlowNode),
  edges: z.array(FlowEdge),
  updatedAt: z.number().optional(),
});
export type Flow = z.infer<typeof Flow>;

// ---------------------------------------------------------------------------
// Runs, tasks, attempts, verdicts
// ---------------------------------------------------------------------------

export const SelectionSpec = z.discriminatedUnion('source', [
  /** `sr --json next --count N --max-size S`: readiness-ranked mapped, unclaimed functions. */
  z.object({ source: z.literal('sr_next'), count: z.number().int().positive().max(5000), maxSize: z.number().int().positive().default(64) }),
  /** Explicit RVAs (hex strings). */
  z.object({ source: z.literal('rva_list'), rvas: z.array(z.string().regex(/^0x[0-9a-fA-F]+$/)).min(1) }),
  /** Synthetic backlog for the simulator. */
  z.object({ source: z.literal('synthetic'), count: z.number().int().positive().max(100_000), seed: z.number().int().default(1) }),
]);
export type SelectionSpec = z.infer<typeof SelectionSpec>;

export const RunConfig = z.object({
  flowId: z.string(),
  selection: SelectionSpec,
  /** Functions of one unit (class) per packet; packets on the same unit never run concurrently. */
  packetMaxFunctions: z.number().int().min(1).max(60).default(4),
  /** Concurrent repo compares (CPU bound, independent of LLM concurrency). */
  gateConcurrency: z.number().int().min(1).max(64).default(4),
  /** Passing functions per staged PR batch (repo cap is 60). */
  prBatchSize: z.number().int().min(1).max(60).default(40),
  /**
   * The repo requires the owner to agree before any game-derived listing is sent to an AI provider.
   * When false, bundles contain only public repo context and the private pack is never read.
   */
  exposureConsent: z.boolean().default(false),
  /** Wall-clock budget for one repo compare, ms. */
  compareTimeoutMs: z.number().int().positive().default(240_000),
  /** Stop leasing new work when the run's spend reaches this, USD. */
  budgetUsd: z.number().positive().optional(),
  draftedBy: z.string().default('operator'),
});
export type RunConfig = z.infer<typeof RunConfig>;

export const RunStatus = z.enum(['created', 'discovering', 'running', 'paused', 'cancelled', 'completed', 'failed']);
export type RunStatus = z.infer<typeof RunStatus>;

export const TaskState = z.enum([
  'pending', // ready to lease (respecting notBefore)
  'leased', // a dispatcher slot owns it (lease + heartbeat)
  'gating', // output written, Gate Keeper running
  'passed', // all gates green, awaiting PR staging
  'staged', // included in a staged PR batch
  'quarantined', // suspected gaming / host tamper: needs a human
  'dead', // attempts exhausted on every tier
  'cancelled',
]);
export type TaskState = z.infer<typeof TaskState>;

export const FunctionTarget = z.object({
  rva: z.string().regex(/^0x[0-9a-f]+$/),
  name: z.string().nullable(),
  size: z.number().int().nonnegative(),
  nameOrigin: z.string().nullable().optional(),
});
export type FunctionTarget = z.infer<typeof FunctionTarget>;

export const Task = z.object({
  id: z.string(),
  runId: z.string(),
  /** reconstruction/<area>/<Class>.cpp — the packet's unit and its lock key. */
  unit: z.string(),
  functions: z.array(FunctionTarget).min(1),
  state: TaskState,
  priority: z.number(),
  /** Escalation tier index into the compiled flow plan's worker tiers. */
  tier: z.number().int(),
  attemptsTotal: z.number().int(),
  attemptsAtTier: z.number().int(),
  noImprovementStreak: z.number().int(),
  bestExactBytes: z.number().int(),
  cheatStrikes: z.number().int(),
  leaseId: z.string().nullable(),
  leaseExpiresAt: z.number().nullable(),
  notBefore: z.number(),
  lastVerdictId: z.string().nullable(),
  srTaskId: z.string().nullable(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof Task>;

export const Usage = z.object({
  inputTokens: z.number().int().default(0),
  outputTokens: z.number().int().default(0),
  cacheReadTokens: z.number().int().default(0),
  cacheWriteTokens: z.number().int().default(0),
});
export type Usage = z.infer<typeof Usage>;

export const AttemptStatus = z.enum(['running', 'completed', 'provider_error', 'parse_error', 'abandoned']);
export const Attempt = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string(),
  n: z.number().int(),
  tier: z.number().int(),
  nodeId: z.string(),
  accountId: z.string().nullable(),
  model: z.string().nullable(),
  status: AttemptStatus,
  bundleHash: z.string().nullable(),
  usage: Usage,
  costUsd: z.number(),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
  /** Candidate files exactly as written into the worktree. */
  files: z.array(z.object({ path: z.string(), content: z.string() })).nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type Attempt = z.infer<typeof Attempt>;

export const Severity = z.enum(['block', 'warn', 'info']);
export const Finding = z.object({
  stage: z.string(),
  code: z.string(),
  severity: Severity,
  file: z.string().optional(),
  line: z.number().int().optional(),
  message: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const CompareFunctionResult = z.object({
  rva: z.string(),
  name: z.string().nullable(),
  result: z.string(),
  reason: z.string().nullable(),
  hint: z.string().nullable(),
  firstMismatch: z.string().nullable(),
  candidateSize: z.number().nullable(),
  targetSize: z.number().nullable(),
  exactBytes: z.number().nullable(),
  totalBytes: z.number().nullable(),
});
export type CompareFunctionResult = z.infer<typeof CompareFunctionResult>;

export const Decision = z.enum(['pass', 'reject', 'quarantine']);
export const Route = z.enum(['accept', 'retry', 'escalate', 'quarantine', 'dead_letter']);
export const Verdict = z.object({
  id: z.string(),
  taskId: z.string(),
  attemptId: z.string(),
  decision: Decision,
  route: Route,
  findings: z.array(Finding),
  compare: z.array(CompareFunctionResult).nullable(),
  exactBytes: z.number().int(),
  stages: z.array(z.object({ name: z.string(), ok: z.boolean(), ms: z.number(), skipped: z.boolean().default(false) })),
  createdAt: z.number(),
});
export type Verdict = z.infer<typeof Verdict>;

/** What a Worker model must return. Paths are validated against the packet's allowlist. */
export const WorkerOutput = z.object({
  files: z
    .array(z.object({ path: z.string().min(1).max(260), content: z.string().max(400_000) }))
    .min(1)
    .max(4),
  notes: z.string().max(4000).optional(),
});
export type WorkerOutput = z.infer<typeof WorkerOutput>;

export const BundleSection = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  content: z.string(),
  privacy: z.enum(['public', 'private']),
});
export type BundleSection = z.infer<typeof BundleSection>;

export const ContextBundle = z.object({
  hash: z.string(),
  taskId: z.string(),
  allowedPaths: z.array(z.string()),
  sections: z.array(BundleSection),
  approxTokens: z.number().int(),
  containsPrivate: z.boolean(),
});
export type ContextBundle = z.infer<typeof ContextBundle>;

export const TelemetryEvent = z.object({
  seq: z.number().int(),
  ts: z.number(),
  runId: z.string().nullable(),
  taskId: z.string().nullable(),
  kind: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  msg: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEvent>;
