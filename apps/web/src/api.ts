// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account, Attempt, CapabilityTier, Difficulty, Flow, KnowledgeEntry, Task, TaskContextBundle, TelemetryEvent, Verdict } from '@decomp/core';
import type { RunSkillSnapshot, Skill, SkillEvalRun, SkillJob, SkillVersion } from '@decomp/skills';

const TOKEN_KEY = 'decomp.apiToken';
export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
};
export const setToken = (t: string) => {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* storage unavailable */
  }
};

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const tok = getToken();
  if (tok) headers.authorization = `Bearer ${tok}`;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

export interface AccountView {
  accountId: string;
  label: string;
  provider: string;
  workspace: string | null;
  tags: string[];
  enabled: boolean;
  status: string;
  cooldownUntil: number | null;
  inFlight: number;
  concurrencyLimit: number;
  maxConcurrency: number;
  requestsTotal: number;
  failuresTotal: number;
  rateLimitedTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  costUsdToday: number;
  ewmaLatencyMs: number | null;
  lastError: string | null;
  headroom: { requests: number; inputTokens: number; outputTokens: number };
  models: string[];
}

export interface SubscriptionUsage {
  buckets: Array<{
    id: string;
    label: string;
    plan: string | null;
    windows: Array<{ usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null }>;
  }>;
}

/** Which account·model serves each node of a flow (the scheduler's own matching). */
export interface NodeAssignment {
  nodeId: string;
  label: string;
  role: 'orchestrator' | 'worker' | 'gatekeeper';
  capability: CapabilityTier | null;
  instances: number;
  binding: { strategy: 'bound' | 'pool'; tags: string[]; accountIds: string[]; model: string | null };
  usesModel: boolean;
  serves: Array<{ accountId: string; modelId: string; enabled: boolean }>;
  fallback: boolean;
  excluded: Array<{ accountId: string; reason: string }>;
}
export interface FlowAssignments { flowId: string; nodes: NodeAssignment[] }

export interface FlowIssue {
  level: 'error' | 'warn';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface RunSummary {
  id: string;
  name: string;
  status: string;
  costUsd: number;
  createdAt: number;
  config: Record<string, unknown>;
  counts: Record<string, number>;
  engine: { active: boolean; paused: boolean; activeSlots: number; busySlots: number };
}

export interface Metrics {
  run: { id: string; name: string; status: string; costUsd: number; startedAt: number | null; finishedAt: number | null; budgetUsd: number | null; error: string | null; contextMode: 'budgeted' | 'legacy'; routingEnabled: boolean };
  routing: RoutingMetrics | null;
  knowledge: { byKind: Array<{ kind: string; n: number; uses: number }>; recent: Array<{ kind: string; symbol: string; sourceUnit: string; uses: number }> };
  skills: RunSkillMetrics;
  workers: { maxPerWorker: number; list: WorkerQuota[] };
  capacity: (CapacityPlan & { stalled?: { at: number; packets: number; functions: number } }) | null;
  gather: Omit<GatherPreview, 'functions' | 'byTier'> | null;
  engine: { active: boolean; paused: boolean; activeSlots: number; busySlots: number };
  tasks: Record<string, number>;
  functions: Record<string, number>;
  totalFunctions: number;
  queueDepth: number;
  routes: Record<string, number>;
  tiers: Array<{ tier: number; state: string; n: number }>;
  usage: {
    attempts: number; providerErrors: number; parseErrors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
    cacheHitRate: number; contextTokens: number; contextRawTokens: number; contextSavedPct: number; tokensPerMatchedFunction: number | null;
    costPerMatchedFunction: number | null; savedByCachingUsd: number; costUsd: number;
  };
  throughput: { passedPerMin5: number; etaMinutes: number | null; series: Array<{ t: number; passed: number }> };
  byAccount: Array<{ account_id: string; model: string; attempts: number; completed: number; provider_errors: number; input_tokens: number; cached_input_tokens: number; cache_write_tokens: number; output_tokens: number; cache_hit_rate: number; cost_usd: number; avg_latency_ms: number }>;
  accounts: AccountView[];
}

export interface WorkerQuota {
  workerId: string; nodeId: string; tier: number; capability: CapabilityTier | null; max: number; assigned: number; packets: number; matched: number; attempts: number; busy: boolean; capped: boolean;
}

export interface CapacityPlan {
  maxPerWorker: number; workers: number; workersWanted: number; repoSlots: number; capacity: number; batch: number; workersNeeded: number;
  perTier: Array<{ tier: number; label: string; capability: CapabilityTier; workers: number; capacity: number; demand: number | null; overflow: number }>;
  unplaced: number; headroom: number; ok: boolean; warnings: string[];
}

export interface GatheredFunctionView {
  rva: string; name: string | null; size: number; unit: string; nameOrigin: string | null; readiness?: number; signature: string | null; draft: 'none' | 'stub' | 'present';
  xrefsIn: number | null; xrefsOut: number | null; basicBlocks: number | null; instructions: number | null; branches: number | null; sources: string[];
  complexityScore: number; complexityTier: Difficulty; reasons: string[];
}

export interface GatherPreview {
  source: string; at: number; inventory: { total: number; matched: number; mapped: number; other: number }; candidates: number; claimsChecked: boolean;
  excluded: Record<string, number>; selected: number; selectedBytes: number; withPackFeatures: number; withTableFacts: number; units: number; byModule: Record<string, number>;
  functions: GatheredFunctionView[]; byTier: Record<Difficulty, number>;
}

export type RunSkillMetrics =
  | { enabled: false }
  | {
      enabled: true;
      core: Array<{ id: string; name: string; tokens: number }>;
      coreTokens: number;
      dynamic: number;
      staticPrefixes: number;
      bySkill: Array<{ skillId: string; name: string; tasks: number; injected: number; heldOut: number; tokens: number; passRate: number | null; heldOutPassRate: number | null }>;
    };

export interface SkillProposal {
  skill: Skill;
  version: SkillVersion;
  current: SkillVersion | null;
  evalRun: SkillEvalRun | null;
  diff: { before: string | null; after: string | null };
}

export interface SkillsOverview {
  skills: Skill[];
  proposals: SkillProposal[];
  jobs: SkillJob[];
  evals: SkillEvalRun[];
  curator: { busy: string | null; modelAvailable: boolean; engineIdle: boolean };
  lastRun: null | { id: string; name: string; totalFunctions: number; skills: Array<{ skillId: string; name: string; status: string; tasks: number; functions: number; coverage: number; injected: number; injectedPass: number; heldOut: number; heldOutPass: number }> };
  nextRun: RunSkillSnapshot;
}

export interface SkillDetail {
  skill: Skill;
  versions: Array<SkillVersion & { md: string | null }>;
  evals: SkillEvalRun[];
  lift: { lift: number | null; method: string; se: number | null; treated: number; control: number };
}

export interface RoutingMetrics {
  enabled: boolean;
  tiers: Array<{ index: number; node: string; label: string; capability: CapabilityTier; inferred: boolean; instances: number }>;
  route: Record<Difficulty, number>;
  routeSource: Record<Difficulty, 'edge' | 'capability'>;
  byDifficulty: Record<Difficulty, { packets: number; functions: number; open: number; matched: number; dead: number }>;
  matrix: Array<{ difficulty: Difficulty | null; tier: number; attempts: number; passed: number; input_tokens: number; output_tokens: number; cost_usd: number }>;
  moves: Partial<Record<'stolen' | 'promoted' | 'rerouted' | 'escalated', number>>;
}

export interface FlowPlanView {
  tiers: Array<{ node: string; label: string; instances: number; retryLoop: boolean; capability: CapabilityTier; capabilityInferred: boolean }>;
  workerSlots: number;
  gatekeepers: number;
  route: Record<Difficulty, number>;
  routeSource: Record<Difficulty, 'edge' | 'capability'>;
}

export interface TaskDetail {
  task: Task;
  attempts: Attempt[];
  verdicts: Verdict[];
  baseFiles: Record<string, string | null>;
  events: TelemetryEvent[];
}

export interface Batch {
  id: string;
  seq: number;
  status: string;
  taskIds: string[];
  branch: string | null;
  dryRunState: 'running' | 'cancelling' | null;
  /** Every function of the batch, with its unit and its packet's state now. */
  functions: Array<{ rva: string; name: string | null; unit: string; taskId: string; state: string }>;
  detail: {
    functions?: number; problems?: string[]; draftedBy?: string | null; models?: string[];
    pr?: string | null; link?: string | null; prBranch?: string; submittedAt?: number;
    dryRunFingerprint?: string;
    /** Tasks whose claims the last dry run could not check: a real submission must accept them explicitly. */
    dryRunUncheckedClaims?: string[];
    /** Last claims check: functions other contributors' open claims or PRs name. */
    claimCheck?: { at: number; collisions: Record<string, ClaimCollision[]> };
    /** Packets this batch withheld for colliding claims, and the batches its other packets went to. */
    withheld?: { taskIds: string[]; units: string[] };
    supersededBy?: number[];
    lastSubmit?: { at: number; dryRun: boolean; ok: boolean; cancelled?: boolean; submissionStarted?: boolean; problems: string[]; blockers: string[]; uncheckedClaims?: string[]; warnings: string[]; plan: string[]; error: string | null; branch: string };
  } | null;
}

export interface ClaimCollision {
  url: string;
  author: string | null;
  updatedAt: string | null;
}

interface StageResult { staged: number; failed: number; seqs: number[] }

/** What holds the worktree slots right now (staging, a dry run, a claims check). */
export interface OperationProgress {
  runId: string | null;
  label: string;
  startedAt: number;
  step: string;
  detail: string | null;
  done: number | null;
  total: number | null;
  stepStartedAt: number;
  log: Array<{ at: number; step: string; ms: number }>;
}

export interface BatchDropResult {
  seq: number;
  batchId: string;
  withheldTasks: number;
  withheldFunctions: number;
  keptTasks: number;
  keptFunctions: number;
  units: string[];
  deleted: string[];
}

export interface DropCollisionsResult extends BatchDropResult {
  ok: true;
  collisions: Record<string, ClaimCollision[]>;
  staged: StageResult | null;
}

export interface DropAllCollisionsResult {
  ok: true;
  batches: BatchDropResult[];
  withheldTasks: number;
  withheldFunctions: number;
  collisions: Record<string, ClaimCollision[]>;
  staged: StageResult | null;
}

export interface RecheckWithheldResult {
  ok: true;
  returnedTasks: number;
  stillWithheldTasks: number;
  collisions: Record<string, ClaimCollision[]>;
  staged: StageResult | null;
}

export interface SubmitResult {
  ok: boolean;
  dryRun: boolean;
  cancelled?: boolean;
  problems: string[];
  blockers: string[];
  uncheckedClaims?: string[];
  warnings: string[];
  plan: string[];
  pullRequest: string | null;
  link: string | null;
  error: string | null;
}

export interface RunEdit {
  name?: string;
  draftedBy?: string;
  budgetUsd?: number | null;
  prBatchSize?: number;
  staging?: 'branches' | 'off';
}

export const api = {
  selectionPreview: (count: number, maxSize: number) => req<{ requested: number; selected: number; units: number }>('POST', '/api/selection/preview', { source: 'sr_next', count, maxSize }),
  health: () => req<{ ok: boolean; mode: string; repo: string; slots: number; runDefaults?: { draftedBy?: string } }>('GET', '/api/health'),
  accounts: () => req<Account[]>('GET', '/api/accounts'),
  accountRuntime: () => req<AccountView[]>('GET', '/api/accounts/runtime'),
  subscriptionUsage: (id: string) => req<SubscriptionUsage>('GET', `/api/accounts/${encodeURIComponent(id)}/subscription-usage`),
  saveAccount: (a: Account) => req<Account>('PUT', `/api/accounts/${encodeURIComponent(a.id)}`, a),
  deleteAccount: (id: string) => req('DELETE', `/api/accounts/${encodeURIComponent(id)}`),
  accountAction: (id: string, action: 'enable' | 'disable') => req('POST', `/api/accounts/${encodeURIComponent(id)}/${action}`),
  flows: () => req<Flow[]>('GET', '/api/flows'),
  saveFlow: (f: Flow) => req<{ flow: Flow; issues: FlowIssue[] }>('PUT', `/api/flows/${encodeURIComponent(f.id)}`, f),
  deleteFlow: (id: string) => req('DELETE', `/api/flows/${encodeURIComponent(id)}`),
  flowAssignments: (flowId: string, accounts?: Account[]) => req<FlowAssignments>('POST', `/api/flows/${encodeURIComponent(flowId)}/assignments`, accounts ? { accounts } : {}),
  validateFlow: (f: Flow, capacity?: { batch: number; cap: number; stealing?: boolean }) =>
    req<{ issues: FlowIssue[]; plan: FlowPlanView | null; repoSlots: number; capacity: CapacityPlan | null }>('POST', `/api/flows/validate${capacity ? `?batch=${capacity.batch}&cap=${capacity.cap}&stealing=${capacity.stealing === false ? 0 : 1}` : ''}`, f),
  gatherPreview: (filter: Record<string, unknown>) => req<GatherPreview>('POST', '/api/gather/preview', filter),
  raiseWorkerCap: (runId: string, maxFunctionsPerWorker: number) => req('POST', `/api/runs/${runId}/capacity`, { maxFunctionsPerWorker, resume: true }),
  runs: () => req<RunSummary[]>('GET', '/api/runs'),
  createRun: (name: string, flowId: string, config: Record<string, unknown>) => req<{ id: string }>('POST', '/api/runs', { name, flowId, config }),
  retryFailedTasks: (id: string) => req<{ ok: boolean; requeued: number; tier: number; tierLabel: string; status: string }>('POST', `/api/runs/${id}/retry-failed`, {}),
  metrics: (id: string) => req<Metrics>('GET', `/api/runs/${id}/metrics`),
  runAction: (id: string, action: 'pause' | 'resume' | 'cancel', body?: unknown) => req('POST', `/api/runs/${id}/${action}`, body ?? {}),
  tasks: (id: string, state?: string, offset = 0) => req<Task[]>('GET', `/api/runs/${id}/tasks?limit=200&offset=${offset}${state ? `&state=${state}` : ''}`),
  batches: (id: string) => req<Batch[]>('GET', `/api/runs/${id}/batches`),
  applyRunFlow: (id: string) => req<RunSummary>('POST', `/api/runs/${id}/flow`, {}),
  updateRun: (id: string, patch: RunEdit) => req<RunSummary>('PATCH', `/api/runs/${id}`, patch),
  deleteRun: (id: string) => req<{ ok: boolean; released: number; failed?: Array<{ rva: string; error: string }> }>('DELETE', `/api/runs/${id}`),
  stageRun: (id: string) => req<{ ok: boolean; staged: number; failed: number }>('POST', `/api/runs/${id}/stage`, {}),
  submitBatch: (id: string, batchId: string, real: boolean, allowUncheckedClaims = false) => req<SubmitResult>('POST', `/api/runs/${id}/batches/${batchId}/submit`, real ? { dryRun: false, confirm: true, allowUncheckedClaims } : { dryRun: true }),
  dropCollisions: (id: string, batchId: string) => req<DropCollisionsResult>('POST', `/api/runs/${id}/batches/${batchId}/drop-collisions`, {}),
  operation: () => req<{ operation: OperationProgress | null }>('GET', '/api/operation'),
  restageBatch: (id: string, batchId: string) => req<{ ok: true } & StageResult>('POST', `/api/runs/${id}/batches/${batchId}/restage`, {}),
  dropAllCollisions: (id: string) => req<DropAllCollisionsResult>('POST', `/api/runs/${id}/batches/drop-collisions`, {}),
  recheckWithheld: (id: string) => req<RecheckWithheldResult>('POST', `/api/runs/${id}/withheld/recheck`, {}),
  cancelBatchDryRun: (id: string, batchId: string) => req<{ ok: true }>('POST', `/api/runs/${id}/batches/${batchId}/cancel-dry-run`, {}),
  clearBatchBranches: (id: string, batchId: string, scope: 'preview' | 'batch') => req<{ deleted: string[] }>('DELETE', `/api/runs/${id}/batches/${batchId}/branches`, { scope }),
  knowledge: (id: string) => req<KnowledgeEntry[]>('GET', `/api/runs/${id}/knowledge`),
  bundle: (hash: string) => req<TaskContextBundle | { sections: Array<{ id: string; title: string; content: string }>; approxTokens: number }>('GET', `/api/bundles/${hash}`),
  task: (id: string) => req<TaskDetail>('GET', `/api/tasks/${id}`),
  requeue: (id: string, tier = 0) => req('POST', `/api/tasks/${id}/requeue`, { tier }),
  events: (runId: string) => req<TelemetryEvent[]>('GET', `/api/events?runId=${runId}&limit=200&minLevel=info`),
  lessons: () => req<Array<{ id: string; source: string; topic: string; text: string; weight: number }>>('GET', '/api/lessons'),
  skills: () => req<SkillsOverview>('GET', '/api/skills'),
  skill: (id: string) => req<SkillDetail>('GET', `/api/skills/${encodeURIComponent(id)}`),
  skillJob: (kind: 'bootstrap' | 'mine' | 'update' | 'optimize' | 'curate' | 'shadow', body: Record<string, unknown> = {}) => req<{ jobId: string }>('POST', `/api/skills/jobs/${kind}`, body),
  skillVersionAction: (id: string, v: number, action: 'evaluate' | 'reject' | 'reopen') => req('POST', `/api/skills/${encodeURIComponent(id)}/versions/${v}/${action}`, {}),
  skillStatus: (id: string, status: 'active' | 'deprecated' | 'promoted_to_core') => req('POST', `/api/skills/${encodeURIComponent(id)}/status`, { status }),
  importSkills: () => req<{ created: string[]; proposed: string[]; problems: string[] }>('POST', '/api/skills/import', {}),
  refreshLessons: (github: boolean) => req<{ repoLessons: number; github: { codes: number; comments: number } | null }>('POST', '/api/lessons/refresh', { github }),
};

export function stream(runId: string | null, on: { event?: (e: TelemetryEvent) => void; metrics?: (m: Metrics) => void; accounts?: (a: AccountView[]) => void }) {
  const tok = getToken();
  const qs = new URLSearchParams();
  if (runId) qs.set('runId', runId);
  if (tok) qs.set('token', tok);
  const es = new EventSource(`/api/stream?${qs}`);
  if (on.event) es.addEventListener('event', (m) => on.event!(JSON.parse((m as MessageEvent).data)));
  if (on.metrics) es.addEventListener('metrics', (m) => on.metrics!(JSON.parse((m as MessageEvent).data)));
  if (on.accounts) es.addEventListener('accounts', (m) => on.accounts!(JSON.parse((m as MessageEvent).data)));
  return () => es.close();
}
