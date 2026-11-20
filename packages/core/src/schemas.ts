// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared domain model. Every persisted or transported shape is a Zod schema so the
// server, the UI and stored JSON columns all validate against the same source of truth.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Roles, providers, accounts
// ---------------------------------------------------------------------------

export const Role = z.enum(['orchestrator', 'worker', 'gatekeeper']);
export type Role = z.infer<typeof Role>;

/** How hard a function is to match (the routing input). Spec name: ComplexityTier. */
export const Difficulty = z.enum(['easy', 'medium', 'hard']);
export type Difficulty = z.infer<typeof Difficulty>;
export const ComplexityTier = Difficulty;
export type ComplexityTier = Difficulty;

/** What a worker tier / model is good for (the routing target). */
export const CapabilityTier = z.enum(['fast', 'balanced', 'frontier']);
export type CapabilityTier = z.infer<typeof CapabilityTier>;

export const DIFFICULTY_RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };
export const CAPABILITY_RANK: Record<CapabilityTier, number> = { fast: 0, balanced: 1, frontier: 2 };
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
export const CAPABILITIES: CapabilityTier[] = ['fast', 'balanced', 'frontier'];

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
  /** 5-minute cache writes (Anthropic bills 1.25x input). Unset: billed as plain input. */
  priceCacheWritePerMTok: z.number().nonnegative().optional(),
  roles: z.array(Role).default(['worker']),
  /** Capability tier this model serves in tiered routing (fast ≈ Haiku/mini, frontier ≈ Opus). */
  capability: CapabilityTier.optional(),
  /** Relative cost used to break ties between equally healthy accounts (lower wins). */
  costWeight: z.number().positive().optional(),
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
  /** Prefer models declaring this capability (falls back to role matching when none do). */
  capability: CapabilityTier.optional(),
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
  /** Worker: capability tier. Unset = inferred from the node's position on the escalation ladder. */
  capability: CapabilityTier.optional(),
  /** Worker: relative cost of this tier (display + tie-breaking). */
  costWeight: z.number().positive().optional(),
  /** Worker: when idle, pull backlog routed to lower-capability tiers (work stealing). */
  stealDown: z.boolean().default(true),
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
  /** Dispatch edges only: routing rule — which difficulties enter the ladder at this edge's target. */
  difficulties: z.array(Difficulty).optional(),
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
  /** Orchestrator FunctionGatherer: inventory scan + source/pack/table enrichment + filters. */
  z.object({ source: z.literal('gather'), filter: z.lazy(() => GatherFilter).default(() => GatherFilter.parse({})) }),
]);
export type SelectionSpec = z.infer<typeof SelectionSpec>;

const RvaHex = z.string().regex(/^0x[0-9a-fA-F]+$/);

/** What the FunctionGatherer selects from the repository's backlog. */
export const GatherFilter = z.object({
  /** Functions in this batch (after every other filter); the per-run cap. */
  maxFunctions: z.number().int().positive().max(5_000).default(500),
  minSize: z.number().int().nonnegative().optional(),
  maxSize: z.number().int().positive().default(256),
  /** Half-open RVA ranges [start, end). */
  rvaRanges: z.array(z.object({ start: RvaHex, end: RvaHex })).max(64).default([]),
  /** Qualified-name prefixes on `::` boundaries ("RE", "BSTArray", "RE::TESForm"). */
  namespaces: z.array(z.string().min(1).max(200)).max(64).default([]),
  /** Reconstruction areas (`reconstruction/<area>/...`). */
  modules: z.array(z.string().min(1).max(120)).max(64).default([]),
  /** Explicit units (`reconstruction/<area>/<Class>.cpp`). */
  units: z.array(z.string().min(1).max(300)).max(256).default([]),
  /** Drop functions whose name origin is in this list (e.g. GUESS). */
  excludeNameOrigins: z.array(z.string().min(1).max(40)).max(16).default([]),
  /** Skip functions claimed locally or (when reachable) by others. */
  excludeLocked: z.boolean().default(true),
  /** Skip functions open in another run or matched by this tool but not yet submitted. */
  excludeInFlight: z.boolean().default(true),
  /** Skip functions whose unit already holds a non-trivial draft of them. */
  excludeDrafted: z.boolean().default(false),
  /** Order of the selection before the cap. */
  order: z.enum(['readiness', 'size', 'rva']).default('readiness'),
});
export type GatherFilter = z.infer<typeof GatherFilter>;

export const RunConfig = z.object({
  flowId: z.string(),
  selection: SelectionSpec,
  /** Functions of one unit (class) per packet; packets on the same unit never run concurrently. */
  packetMaxFunctions: z.number().int().min(1).max(60).default(4),
  /** Concurrent repo compares (CPU bound, independent of LLM concurrency). */
  gateConcurrency: z.number().int().min(1).max(64).default(4),
  /**
   * Hard ceiling of distinct functions one worker instance may take in this run (claimed atomically
   * with the lease). Balances load across the topology and bounds each worker's session/quota exposure.
   */
  maxFunctionsPerWorker: z.number().int().min(1).max(5_000).default(60),
  /**
   * branches: accepted units are committed to local branches (decomp/<run>-b<n>) and re-verified.
   * off: nothing is committed in the target repository; accepted files stay in this tool's
   * database (task drawer / API) and every local claim of the run is released at the end.
   */
  staging: z.enum(['branches', 'off']).default('branches'),
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
  /**
   * Earlier values of `draftedBy` when the run was edited: "Drafted by" lines this run wrote under
   * those names are rewritten to the current one when its functions are staged or submitted.
   */
  formerDraftedBy: z.array(z.string()).max(20).default([]),
  /** Dead functions carried over from earlier runs: added to the selection at discovery. */
  carry: z
    .object({ fromRuns: z.array(z.string()).max(50).default([]), rvas: z.array(RvaHex).max(5_000).default([]) })
    .default(() => ({ fromRuns: [], rvas: [] })),
  routing: z.lazy(() => RoutingConfig).default(() => RoutingConfig.parse({})),
  context: z.lazy(() => ContextConfig).default(() => ContextConfig.parse({})),
  skills: z.lazy(() => SkillsConfig).default(() => SkillsConfig.parse({})),
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
  /** Current routing difficulty (raised by retry promotion, never lowered). */
  difficulty: Difficulty,
  /** Static complexity score of the packet (max over its functions + packing penalty). */
  complexity: z.number(),
  /** Attempts since the difficulty last changed (drives retry promotion). */
  attemptsAtDifficulty: z.number().int(),
  assessment: z.lazy(() => ComplexityAssessment).nullable(),
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
  /** Difficulty the attempt was routed at. */
  difficulty: Difficulty.nullable().default(null),
  /** Estimated tokens of the bundle as sent, and what the unsliced sources would have cost. */
  contextTokens: z.number().int().nullable().default(null),
  contextRawTokens: z.number().int().nullable().default(null),
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
  /** Bytes that match the target after alignment (the repo's diagnostic progress metric): a count only, never target content. */
  alignedBytes: z.number().nullable().optional(),
  alignedRegions: z.number().nullable().optional(),
  /** sha256 of the candidate's own compiled code section: equal hashes mean the same machine code. */
  codeSha256: z.string().nullable().optional(),
});
export type CompareFunctionResult = z.infer<typeof CompareFunctionResult>;

export const Decision = z.enum(['pass', 'reject', 'quarantine']);
/** 'stale': the attempt's lease was lost before routing, so its verdict moved nothing. */
export const Route = z.enum(['accept', 'retry', 'escalate', 'quarantine', 'dead_letter', 'stale']);
export type Route = z.infer<typeof Route>;
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

/** A function-level edit: the orchestrator splices it into the current unit (replace same name, else append). */
export const FunctionEdit = z.object({ name: z.string().min(1).max(300), code: z.string().min(1).max(200_000) });
export type FunctionEdit = z.infer<typeof FunctionEdit>;

export const UnitEdit = z.object({
  path: z.string().min(1).max(260),
  /** Replacement for the file's leading `//` comment block. */
  header: z.string().max(4_000).optional(),
  /** Declarations (types, callees, globals) inserted after the includes if not already present. */
  declarations: z.string().max(50_000).optional(),
  functions: z.array(FunctionEdit).max(60).default([]),
});
export type UnitEdit = z.infer<typeof UnitEdit>;

/**
 * What a Worker model must return. Paths are validated against the packet's allowlist.
 * `files` = complete files; `edits` = function-level patches (far fewer output tokens on large units).
 * Either way the Gate Keeper only ever sees the materialised complete files.
 */
export const WorkerOutput = z
  .object({
    files: z.array(z.object({ path: z.string().min(1).max(260), content: z.string().max(400_000) })).max(4).optional(),
    edits: z.array(UnitEdit).max(4).optional(),
    notes: z.string().max(4000).optional(),
    /** The worker's own provenance statement; the orchestrator writes it into header placeholders. */
    codeOrigin: z.string().min(8).max(300).optional(),
    /** "none", or each adapted body with its upstream file, revision and licence. */
    adaptedBodies: z.string().min(4).max(300).optional(),
  })
  .refine((o) => (o.files?.length ?? 0) + (o.edits?.length ?? 0) > 0, { message: 'return at least one file or edit' });
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

// ---------------------------------------------------------------------------
// Phase 2: complexity routing, budgeted context, run knowledge
// ---------------------------------------------------------------------------

/**
 * Static features of one target function. `size_only` = only the backlog size was known (no local
 * pack yet); `pack` = decoded from the repo's local pack.json (counts only — no bytes are kept).
 */
export const FunctionFeatures = z.object({
  source: z.enum(['size_only', 'pack', 'synthetic']),
  size: z.number().int().nonnegative(),
  instructions: z.number().int().nonnegative().nullable().default(null),
  basicBlocks: z.number().int().nonnegative().nullable().default(null),
  condBranches: z.number().int().nonnegative().nullable().default(null),
  /** Backward intra-function branches (loops). */
  backEdges: z.number().int().nonnegative().nullable().default(null),
  calls: z.number().int().nonnegative().nullable().default(null),
  /** Calls through memory (vtable / function pointer). */
  indirectCalls: z.number().int().nonnegative().nullable().default(null),
  /** Jumps through registers/memory (switch tables, vtable tail calls). */
  indirectJumps: z.number().int().nonnegative().nullable().default(null),
  sseOps: z.number().int().nonnegative().nullable().default(null),
  /** RIP-relative references (globals, constants, imports). */
  dataRefs: z.number().int().nonnegative().nullable().default(null),
  xrefsIn: z.number().int().nonnegative().nullable().default(null),
  /** Template instantiation (name carries template arguments): COMDAT/inlining shape is harder to hit. */
  templated: z.boolean().optional(),
  /** .pdata entries in the function: >1 means funclets (C++ EH / SEH). */
  unwindEntries: z.number().int().nonnegative().nullable().default(null),
  tailCall: z.boolean().nullable().default(null),
  /** Failed attempts on this RVA in earlier runs. */
  priorFailures: z.number().int().nonnegative().default(0),
  nameConfidence: z.enum(['named', 'guess', 'unnamed']).default('named'),
  cautions: z.number().int().nonnegative().default(0),
});
export type FunctionFeatures = z.infer<typeof FunctionFeatures>;

export const ComplexityThresholds = z.object({
  /** score ≥ medium → medium */
  medium: z.number().default(2.5),
  /** score ≥ hard → hard */
  hard: z.number().default(5.5),
  /** |score − threshold| < band → borderline (eligible for the LLM tie-breaker) */
  borderlineBand: z.number().nonnegative().default(0.4),
});
export type ComplexityThresholds = z.infer<typeof ComplexityThresholds>;

export const ComplexityAssessment = z.object({
  difficulty: Difficulty,
  score: z.number(),
  reasons: z.array(z.string()),
  borderline: z.boolean(),
  decidedBy: z.enum(['static', 'llm', 'promotion', 'operator']),
  /** Hardest function's features (the packet's driver). */
  features: FunctionFeatures,
  /** Features per RVA for every function in the packet (shape counts for the prompt spec). */
  functions: z.record(z.string(), FunctionFeatures).optional(),
  version: z.number().int(),
});
export type ComplexityAssessment = z.infer<typeof ComplexityAssessment>;

export const RoutingConfig = z.object({
  /** Off = every packet enters at the ladder's first tier (pre-Phase-2 behaviour). */
  enabled: z.boolean().default(true),
  thresholds: ComplexityThresholds.default(() => ComplexityThresholds.parse({})),
  /** Ask the Orchestrator's model (features only, no listing) to settle borderline scores. */
  llmTieBreak: z.boolean().default(false),
  llmTieBreakMax: z.number().int().min(0).max(5000).default(200),
  /** Promote difficulty (and the routing tier) after this many failed attempts at a difficulty. */
  promoteAfterFailures: z.number().int().min(1).max(20).default(2),
  /** Idle higher-capability slots pull lower-tier backlog. */
  workStealing: z.boolean().default(true),
  /** How many capability steps down a slot may steal (1: frontier takes balanced work, never fast). */
  stealMaxGap: z.number().int().min(1).max(2).default(1),
  /**
   * A slot with nothing to do on its own tier (or below) runs a higher tier's ready packet with that
   * tier's models. Worktrees are the scarce resource; without this, the last hard packets of a run
   * queue behind one frontier slot while the other worktrees sit idle.
   */
  helpUp: z.boolean().default(true),
});
export type RoutingConfig = z.infer<typeof RoutingConfig>;

export const ContextSectionKind = z.enum([
  'static_system_prefix',
  'function_spec',
  'disassembly_slice',
  'minimal_local_context',
  'unit_files',
  'matched_pr_lessons',
  'shared_run_discoveries',
  'retry_delta',
  /** Every earlier distinct candidate of the packet with its outcome, best first (retries only). */
  'attempt_history',
  /** Triggered skills whose triggers are packet-static (stable across retries → inside the per-packet cache block). */
  'dynamic_skills',
  /** Skills triggered by the previous verdict's failure codes (volatile block, after every breakpoint). */
  'retry_skills',
]);
export type ContextSectionKind = z.infer<typeof ContextSectionKind>;

export const SectionBudget = z.object({ min: z.number().int().nonnegative(), max: z.number().int().positive() });
export type SectionBudget = z.infer<typeof SectionBudget>;

/** Token budgets per section (estimates; ~3.3 chars/token for code). */
export const ContextBudgets = z.object({
  static_system_prefix: SectionBudget.default({ min: 800, max: 1_400 }),
  function_spec: SectionBudget.default({ min: 150, max: 300 }),
  disassembly_slice: SectionBudget.default({ min: 500, max: 2_500 }),
  minimal_local_context: SectionBudget.default({ min: 400, max: 2_000 }),
  /** The packet's own files; above max, accepted bodies are elided and the worker must return edits. */
  unit_files: SectionBudget.default({ min: 0, max: 5_000 }),
  matched_pr_lessons: SectionBudget.default({ min: 200, max: 500 }),
  shared_run_discoveries: SectionBudget.default({ min: 100, max: 400 }),
  retry_delta: SectionBudget.default({ min: 200, max: 600 }),
  attempt_history: SectionBudget.default({ min: 0, max: 1_200 }),
  /** Top 0–2 triggered skills (each ≤ 600 tokens). */
  dynamic_skills: SectionBudget.default({ min: 0, max: 1_200 }),
  retry_skills: SectionBudget.default({ min: 0, max: 600 }),
});
export type ContextBudgets = z.infer<typeof ContextBudgets>;

export const ContextConfig = z.object({
  /** budgeted = TaskContextBundle v2; legacy = pre-Phase-2 bundles (raw docs/headers/previous file). */
  mode: z.enum(['budgeted', 'legacy']).default('budgeted'),
  budgets: ContextBudgets.default(() => ContextBudgets.parse({})),
  /**
   * Second cache breakpoint after the per-task block, so retries re-read it at cache price.
   * auto = only when a retry is likely (medium/hard, or easy from attempt 2).
   */
  cacheTaskPrefix: z.enum(['auto', 'always', 'never']).default('auto'),
  /** Function-level edits instead of complete files: auto = only when accepted bodies are elided. */
  outputMode: z.enum(['auto', 'files', 'edits']).default('auto'),
});
export type ContextConfig = z.infer<typeof ContextConfig>;

export const ContextSection = z.object({
  kind: ContextSectionKind,
  title: z.string(),
  content: z.string(),
  privacy: z.enum(['public', 'private']),
  tokens: z.number().int(),
  budgetTokens: z.number().int(),
  /** What the unsliced sources would have cost (full docs/headers/listing/previous file). */
  rawTokens: z.number().int(),
  truncated: z.boolean(),
  sources: z.array(z.string()),
});
export type ContextSection = z.infer<typeof ContextSection>;

export const TaskContextBundle = z.object({
  version: z.literal(2),
  hash: z.string(),
  taskId: z.string(),
  difficulty: Difficulty,
  allowedPaths: z.array(z.string()),
  /** sha256 of the static system prefix — identical for every call of a run (cache key). */
  staticPrefixHash: z.string(),
  sections: z.array(ContextSection),
  tokens: z.object({ sent: z.number().int(), raw: z.number().int(), staticPrefix: z.number().int(), taskPrefix: z.number().int() }),
  containsPrivate: z.boolean(),
  outputMode: z.enum(['files', 'edits', 'either']),
  /** Accepted functions whose bodies were hidden from the prompt (must not be returned). */
  elidedFunctions: z.array(z.string()),
  /** Detected code patterns used to match lessons (sse, vtable, eh, loop, switch, ...). */
  patterns: z.array(z.string()),
  /** Skills considered for this attempt (injected or held out) — recorded per attempt for lift telemetry. */
  skills: z.array(z.lazy(() => SkillSelection)).default([]),
  /** sha256 of the frozen core-skills block inside the static prefix ('' when none). */
  coreSkillsHash: z.string().default(''),
});
export type TaskContextBundle = z.infer<typeof TaskContextBundle>;

export const KnowledgeKind = z.enum(['function_signature', 'struct_layout', 'global', 'type_decl']);
export type KnowledgeKind = z.infer<typeof KnowledgeKind>;

/** A verified fact from a packet that passed the Gate Keeper, shared with the rest of the run. */
export const KnowledgeEntry = z.object({
  runId: z.string(),
  kind: KnowledgeKind,
  /** Symbol / struct name the entry is keyed by (e.g. "TESForm", "TESForm::GetFormID"). */
  symbol: z.string(),
  content: z.string(),
  /** Identifiers the entry mentions (for matching against a packet's references). */
  symbols: z.array(z.string()),
  sourceTaskId: z.string(),
  sourceUnit: z.string(),
  verifiedAt: z.number(),
  uses: z.number().int(),
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;

// ---------------------------------------------------------------------------
// Skills (Phase 3): run-level config + the per-attempt selection record. The registry, matcher and
// curator live in @decomp/skills and the server; these types are here because RunConfig and the
// context bundle carry them.
// ---------------------------------------------------------------------------

export const SkillsConfig = z.object({
  /** Off = no core skills in the prefix and no dynamic skills (pre-Phase-3 behaviour). */
  enabled: z.boolean().default(true),
  /** Dynamic skills injected per attempt (packet + retry placements combined). */
  maxDynamic: z.number().int().min(0).max(4).default(2),
  /**
   * Fraction of eligible (packet, skill) pairs that are deliberately held out, deterministically per
   * task, so pass-rate lift is measured against a real control group rather than assumed.
   */
  holdoutRate: z.number().min(0).max(0.5).default(0.1),
  /** Token cap of the promoted_to_core block frozen into the static prefix. */
  coreMaxTokens: z.number().int().min(0).max(8_000).default(1_500),
  /** Warm each (account, model) prefix cache once before worker slots fan out. */
  prewarm: z.boolean().default(true),
  /** Run the curator (mine → update → optimize → shadow-evaluate) automatically when the run completes. */
  autoCurate: z.boolean().default(false),
});
export type SkillsConfig = z.infer<typeof SkillsConfig>;

export const SkillPlacement = z.enum(['packet', 'retry']);
export type SkillPlacement = z.infer<typeof SkillPlacement>;

export const SkillSelection = z.object({
  skillId: z.string(),
  version: z.number().int(),
  placement: SkillPlacement,
  /** false = eligible but held out (control group). */
  injected: z.boolean(),
  tokens: z.number().int(),
  score: z.number(),
  /** Trigger groups that matched (mnemonics, symbols, features, patterns, failures). */
  matched: z.array(z.string()),
});
export type SkillSelection = z.infer<typeof SkillSelection>;

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
