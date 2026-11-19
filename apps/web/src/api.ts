// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account, Attempt, CapabilityTier, Difficulty, Flow, KnowledgeEntry, Task, TaskContextBundle, TelemetryEvent, Verdict } from '@decomp/core';

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
  detail: { functions?: number; problems?: string[] } | null;
}

export const api = {
  health: () => req<{ ok: boolean; mode: string; repo: string; slots: number }>('GET', '/api/health'),
  accounts: () => req<Account[]>('GET', '/api/accounts'),
  accountRuntime: () => req<AccountView[]>('GET', '/api/accounts/runtime'),
  saveAccount: (a: Account) => req<Account>('PUT', `/api/accounts/${encodeURIComponent(a.id)}`, a),
  deleteAccount: (id: string) => req('DELETE', `/api/accounts/${encodeURIComponent(id)}`),
  accountAction: (id: string, action: 'enable' | 'disable') => req('POST', `/api/accounts/${encodeURIComponent(id)}/${action}`),
  flows: () => req<Flow[]>('GET', '/api/flows'),
  saveFlow: (f: Flow) => req<{ flow: Flow; issues: FlowIssue[] }>('PUT', `/api/flows/${encodeURIComponent(f.id)}`, f),
  deleteFlow: (id: string) => req('DELETE', `/api/flows/${encodeURIComponent(id)}`),
  validateFlow: (f: Flow) => req<{ issues: FlowIssue[]; plan: FlowPlanView | null; repoSlots: number }>('POST', '/api/flows/validate', f),
  runs: () => req<RunSummary[]>('GET', '/api/runs'),
  createRun: (name: string, flowId: string, config: Record<string, unknown>) => req<{ id: string }>('POST', '/api/runs', { name, flowId, config }),
  metrics: (id: string) => req<Metrics>('GET', `/api/runs/${id}/metrics`),
  runAction: (id: string, action: 'pause' | 'resume' | 'cancel', body?: unknown) => req('POST', `/api/runs/${id}/${action}`, body ?? {}),
  tasks: (id: string, state?: string, offset = 0) => req<Task[]>('GET', `/api/runs/${id}/tasks?limit=200&offset=${offset}${state ? `&state=${state}` : ''}`),
  batches: (id: string) => req<Batch[]>('GET', `/api/runs/${id}/batches`),
  knowledge: (id: string) => req<KnowledgeEntry[]>('GET', `/api/runs/${id}/knowledge`),
  bundle: (hash: string) => req<TaskContextBundle | { sections: Array<{ id: string; title: string; content: string }>; approxTokens: number }>('GET', `/api/bundles/${hash}`),
  task: (id: string) => req<TaskDetail>('GET', `/api/tasks/${id}`),
  requeue: (id: string, tier = 0) => req('POST', `/api/tasks/${id}/requeue`, { tier }),
  events: (runId: string) => req<TelemetryEvent[]>('GET', `/api/events?runId=${runId}&limit=200&minLevel=info`),
  lessons: () => req<Array<{ id: string; source: string; topic: string; text: string; weight: number }>>('GET', '/api/lessons'),
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
