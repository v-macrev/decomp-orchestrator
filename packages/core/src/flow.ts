// SPDX-License-Identifier: AGPL-3.0-or-later
// Flow validation and compilation. The canvas is free-form, but the engine only needs a small,
// well-defined plan: one orchestrator, an ordered ladder of worker tiers, and the gate chain.
import type { Flow, FlowNode, FlowEdge } from './schemas.js';

export interface FlowIssue {
  level: 'error' | 'warn';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface WorkerTier {
  index: number;
  node: FlowNode;
  /** True when a reject_retry edge from a gatekeeper loops back into this tier. */
  retryLoop: boolean;
}

export interface FlowPlan {
  orchestrator: FlowNode;
  tiers: WorkerTier[];
  gatekeepers: FlowNode[];
  /** Total concurrent worker slots = sum of tier instances (each slot runs one packet). */
  workerSlots: number;
}

const ALLOWED: Record<FlowEdge['kind'], [FlowNode['type'], FlowNode['type']]> = {
  dispatch: ['orchestrator', 'worker'],
  submit: ['worker', 'gatekeeper'],
  reject_retry: ['gatekeeper', 'worker'],
  escalate: ['worker', 'worker'],
  report: ['gatekeeper', 'orchestrator'],
};

export function validateFlow(flow: Flow): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  if (byId.size !== flow.nodes.length) issues.push({ level: 'error', message: 'duplicate node ids' });

  const count = (t: FlowNode['type']) => flow.nodes.filter((n) => n.type === t).length;
  if (count('orchestrator') !== 1) issues.push({ level: 'error', message: 'exactly one Orchestrator node is required' });
  if (count('worker') < 1) issues.push({ level: 'error', message: 'at least one Worker node is required' });
  if (count('gatekeeper') < 1) issues.push({ level: 'error', message: 'at least one Gate Keeper node is required' });

  for (const e of flow.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) {
      issues.push({ level: 'error', edgeId: e.id, message: `edge ${e.id} references a missing node` });
      continue;
    }
    const [st, tt] = ALLOWED[e.kind];
    if (s.type !== st || t.type !== tt) {
      issues.push({ level: 'error', edgeId: e.id, message: `${e.kind} edge must go ${st} → ${tt} (got ${s.type} → ${t.type})` });
    }
    if (e.kind === 'escalate' && e.source === e.target) {
      issues.push({ level: 'error', edgeId: e.id, message: 'a worker cannot escalate to itself' });
    }
  }

  const workers = flow.nodes.filter((n) => n.type === 'worker');
  const dispatched = flow.edges.filter((e) => e.kind === 'dispatch');
  if (workers.length && dispatched.length !== 1) {
    issues.push({ level: 'error', message: 'exactly one dispatch edge (Orchestrator → entry Worker tier) is required' });
  }
  for (const w of workers) {
    if (!flow.edges.some((e) => e.kind === 'submit' && e.source === w.id)) {
      issues.push({ level: 'error', nodeId: w.id, message: `worker "${w.data.label || w.id}" has no submit edge to a Gate Keeper` });
    }
    const outs = flow.edges.filter((e) => e.kind === 'escalate' && e.source === w.id);
    if (outs.length > 1) issues.push({ level: 'error', nodeId: w.id, message: 'a worker may escalate to at most one next tier' });
    if (!flow.edges.some((e) => e.kind === 'reject_retry' && e.target === w.id)) {
      issues.push({ level: 'warn', nodeId: w.id, message: `worker "${w.data.label || w.id}" has no retry loop; rejections escalate immediately` });
    }
  }

  // Escalation must be a simple chain (no cycles) reachable from the dispatch target.
  if (!issues.some((i) => i.level === 'error')) {
    try {
      const plan = compileFlowPlan(flow);
      const unreachable = workers.filter((w) => !plan.tiers.some((t) => t.node.id === w.id));
      for (const w of unreachable) issues.push({ level: 'warn', nodeId: w.id, message: `worker "${w.data.label || w.id}" is not reachable by dispatch/escalate and will be idle` });
    } catch (err) {
      issues.push({ level: 'error', message: (err as Error).message });
    }
  }
  return issues;
}

export function compileFlowPlan(flow: Flow): FlowPlan {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const orchestrator = flow.nodes.find((n) => n.type === 'orchestrator');
  if (!orchestrator) throw new Error('flow has no orchestrator');
  const entry = flow.edges.find((e) => e.kind === 'dispatch');
  if (!entry) throw new Error('flow has no dispatch edge');

  const tiers: WorkerTier[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = entry.target;
  while (cur) {
    if (seen.has(cur)) throw new Error('escalation chain contains a cycle');
    seen.add(cur);
    const node = byId.get(cur);
    if (!node || node.type !== 'worker') throw new Error(`escalation target ${cur} is not a worker`);
    const retryLoop = flow.edges.some((e) => e.kind === 'reject_retry' && e.target === cur);
    tiers.push({ index: tiers.length, node, retryLoop });
    cur = flow.edges.find((e) => e.kind === 'escalate' && e.source === cur)?.target;
  }

  const gatekeepers = flow.nodes.filter((n) => n.type === 'gatekeeper');
  const workerSlots = tiers.reduce((s, t) => s + t.node.data.instances, 0);
  return { orchestrator, tiers, gatekeepers, workerSlots };
}

/** The default preset: 1 Orchestrator, a cheap tier (12) escalating to a strong tier (4), 2 Gate Keepers. */
export function defaultFlow(): Flow {
  const node = (id: string, type: FlowNode['type'], x: number, y: number, data: Partial<FlowNode['data']>): FlowNode => ({
    id,
    type,
    position: { x, y },
    data: {
      label: id,
      instances: 1,
      pool: { strategy: 'pool', accountIds: [], tags: [] },
      maxAttempts: 6,
      stuckAfter: 3,
      gate: { scope: true, leak: true, cheat: true, integrity: true, repoCompare: true, repoPreflight: true, llmReview: false },
      ...data,
    },
  });
  return {
    id: 'default',
    name: 'Cheap → strong ladder',
    nodes: [
      node('orchestrator', 'orchestrator', 0, 160, { label: 'Orchestrator', pool: { strategy: 'pool', accountIds: [], tags: ['orchestrator'] } }),
      node('worker-cheap', 'worker', 320, 40, { label: 'Workers (cheap)', instances: 12, maxAttempts: 6, stuckAfter: 3, pool: { strategy: 'pool', accountIds: [], tags: ['cheap'] } }),
      node('worker-strong', 'worker', 320, 300, { label: 'Workers (strong)', instances: 4, maxAttempts: 10, stuckAfter: 4, pool: { strategy: 'pool', accountIds: [], tags: ['strong'] } }),
      node('gate', 'gatekeeper', 680, 160, { label: 'Gate Keepers', instances: 2 }),
    ],
    edges: [
      { id: 'e-dispatch', source: 'orchestrator', target: 'worker-cheap', kind: 'dispatch' },
      { id: 'e-submit-cheap', source: 'worker-cheap', target: 'gate', kind: 'submit' },
      { id: 'e-submit-strong', source: 'worker-strong', target: 'gate', kind: 'submit' },
      { id: 'e-retry-cheap', source: 'gate', target: 'worker-cheap', kind: 'reject_retry' },
      { id: 'e-retry-strong', source: 'gate', target: 'worker-strong', kind: 'reject_retry' },
      { id: 'e-escalate', source: 'worker-cheap', target: 'worker-strong', kind: 'escalate' },
      { id: 'e-report', source: 'gate', target: 'orchestrator', kind: 'report' },
    ],
  };
}
