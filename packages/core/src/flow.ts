// SPDX-License-Identifier: AGPL-3.0-or-later
// Flow validation and compilation. The canvas is free-form, but the engine only needs a small,
// well-defined plan: one orchestrator, an ordered ladder of worker tiers (each with a capability),
// routing rules (difficulty → entry tier), and the gate chain.
import { CAPABILITY_RANK, DIFFICULTIES, DIFFICULTY_RANK, type CapabilityTier, type Difficulty, type Flow, type FlowEdge, type FlowNode } from './schemas.js';

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
  /** Declared on the node, or inferred from the tier's position on the ladder. */
  capability: CapabilityTier;
  capabilityInferred: boolean;
}

export interface FlowPlan {
  orchestrator: FlowNode;
  tiers: WorkerTier[];
  gatekeepers: FlowNode[];
  /** Total concurrent worker slots = sum of tier instances (each slot runs one packet). */
  workerSlots: number;
  /** Entry tier per difficulty (dispatch-edge rules first, else nearest capability, ties → cheaper). */
  route: Record<Difficulty, number>;
  /** Where each difficulty's route came from, for the UI. */
  routeSource: Record<Difficulty, 'edge' | 'capability'>;
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
    if (e.kind !== 'dispatch' && e.difficulties?.length) {
      issues.push({ level: 'warn', edgeId: e.id, message: 'difficulty rules only apply to dispatch edges' });
    }
  }

  const workers = flow.nodes.filter((n) => n.type === 'worker');
  const dispatched = flow.edges.filter((e) => e.kind === 'dispatch');
  if (workers.length && dispatched.length < 1) {
    issues.push({ level: 'error', message: 'a dispatch edge (Orchestrator → Worker) is required' });
  }
  const routed = new Map<string, string>();
  for (const e of dispatched) {
    for (const d of e.difficulties ?? []) {
      if (routed.has(d)) issues.push({ level: 'error', edgeId: e.id, message: `difficulty "${d}" is routed by two dispatch edges` });
      routed.set(d, e.id);
    }
  }
  if (dispatched.length > 1 && !dispatched.some((e) => e.difficulties?.length)) {
    issues.push({ level: 'warn', message: 'several dispatch edges without difficulty rules: routing follows worker capabilities' });
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

  // Escalation must be a simple chain (no cycles) containing every dispatch target.
  if (!issues.some((i) => i.level === 'error')) {
    try {
      const plan = compileFlowPlan(flow);
      const unreachable = workers.filter((w) => !plan.tiers.some((t) => t.node.id === w.id));
      for (const w of unreachable) issues.push({ level: 'warn', nodeId: w.id, message: `worker "${w.data.label || w.id}" is not on the escalation ladder and will be idle` });
      for (let i = 1; i < plan.tiers.length; i++) {
        const a = plan.tiers[i - 1]!;
        const b = plan.tiers[i]!;
        if (CAPABILITY_RANK[b.capability] < CAPABILITY_RANK[a.capability]) {
          issues.push({ level: 'warn', nodeId: b.node.id, message: `"${b.node.data.label || b.node.id}" (${b.capability}) is escalated into from a more capable tier (${a.capability})` });
        }
      }
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
  const dispatches = flow.edges.filter((e) => e.kind === 'dispatch');
  if (!dispatches.length) throw new Error('flow has no dispatch edge');

  // The ladder root: walk back from the first dispatch target along escalate edges.
  let root = dispatches[0]!.target;
  const back = new Set<string>([root]);
  for (;;) {
    const prev = flow.edges.find((e) => e.kind === 'escalate' && e.target === root)?.source;
    if (!prev || back.has(prev)) break;
    back.add(prev);
    root = prev;
  }

  const ladder: FlowNode[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = root;
  while (cur) {
    if (seen.has(cur)) throw new Error('escalation chain contains a cycle');
    seen.add(cur);
    const node = byId.get(cur);
    if (!node || node.type !== 'worker') throw new Error(`escalation target ${cur} is not a worker`);
    ladder.push(node);
    const at: string = cur;
    cur = flow.edges.find((e) => e.kind === 'escalate' && e.source === at)?.target;
  }
  for (const d of dispatches) {
    if (!seen.has(d.target)) throw new Error(`dispatch target ${d.target} is not on the escalation ladder (${ladder.map((n) => n.id).join(' → ')})`);
  }

  const tiers: WorkerTier[] = ladder.map((node, index) => ({
    index,
    node,
    retryLoop: flow.edges.some((e) => e.kind === 'reject_retry' && e.target === node.id),
    capability: node.data.capability ?? inferCapability(index, ladder.length),
    capabilityInferred: !node.data.capability,
  }));

  const route = {} as Record<Difficulty, number>;
  const routeSource = {} as Record<Difficulty, 'edge' | 'capability'>;
  for (const d of DIFFICULTIES) {
    const edge = dispatches.find((e) => e.difficulties?.includes(d));
    if (edge) {
      route[d] = tiers.findIndex((t) => t.node.id === edge.target);
      routeSource[d] = 'edge';
    } else {
      route[d] = nearestTier(tiers, DIFFICULTY_RANK[d]);
      routeSource[d] = 'capability';
    }
  }

  const gatekeepers = flow.nodes.filter((n) => n.type === 'gatekeeper');
  const workerSlots = tiers.reduce((s, t) => s + t.node.data.instances, 0);
  return { orchestrator, tiers, gatekeepers, workerSlots, route, routeSource };
}

/** fast at the bottom of the ladder, frontier at the top, balanced in between (or alone). */
export function inferCapability(index: number, n: number): CapabilityTier {
  if (n <= 1) return 'balanced';
  if (index === 0) return 'fast';
  if (index === n - 1) return 'frontier';
  return 'balanced';
}

/** Tier whose capability rank is nearest to the difficulty rank; ties go to the cheaper tier. */
function nearestTier(tiers: WorkerTier[], rank: number): number {
  let best = 0;
  let bestD = Infinity;
  tiers.forEach((t, i) => {
    const d = Math.abs(CAPABILITY_RANK[t.capability] - rank);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** Tier index that should serve a difficulty — never below the task's current tier. */
export function tierFor(plan: FlowPlan, difficulty: Difficulty, current = 0): number {
  return Math.max(current, plan.route[difficulty]);
}

/** Tiers whose backlog an idle slot of `tier` may steal: strictly lower capability, nearest first. */
export function stealSources(plan: FlowPlan, tier: number): number[] {
  const t = plan.tiers[tier];
  if (!t || t.node.data.stealDown === false) return [];
  const rank = CAPABILITY_RANK[t.capability];
  return plan.tiers
    .filter((o) => o.index !== tier && CAPABILITY_RANK[o.capability] < rank)
    .sort((a, b) => CAPABILITY_RANK[b.capability] - CAPABILITY_RANK[a.capability] || a.index - b.index)
    .map((o) => o.index);
}

/**
 * The default preset: complexity-routed ladder fast (10) → balanced (6) → frontier (3), 2 Gate Keepers.
 * Dispatch edges carry the routing rules; escalate edges carry promotion up the ladder.
 */
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
      stealDown: true,
      ...data,
    },
  });
  const worker = (id: string, y: number, label: string, capability: CapabilityTier, instances: number, maxAttempts: number, stuckAfter: number, costWeight: number) =>
    node(id, 'worker', 340, y, { label, instances, maxAttempts, stuckAfter, capability, costWeight, pool: { strategy: 'pool', accountIds: [], tags: [], capability } });
  return {
    id: 'default',
    name: 'Complexity-routed ladder',
    nodes: [
      node('orchestrator', 'orchestrator', 0, 220, { label: 'Orchestrator', pool: { strategy: 'pool', accountIds: [], tags: ['orchestrator'] } }),
      worker('worker-fast', 20, 'Workers · fast', 'fast', 10, 4, 2, 1),
      worker('worker-balanced', 220, 'Workers · balanced', 'balanced', 6, 6, 3, 4),
      worker('worker-frontier', 420, 'Workers · frontier', 'frontier', 3, 10, 4, 10),
      node('gate', 'gatekeeper', 720, 220, { label: 'Gate Keepers', instances: 2 }),
    ],
    edges: [
      { id: 'e-dispatch-easy', source: 'orchestrator', target: 'worker-fast', kind: 'dispatch', difficulties: ['easy'] },
      { id: 'e-dispatch-medium', source: 'orchestrator', target: 'worker-balanced', kind: 'dispatch', difficulties: ['medium'] },
      { id: 'e-dispatch-hard', source: 'orchestrator', target: 'worker-frontier', kind: 'dispatch', difficulties: ['hard'] },
      { id: 'e-submit-fast', source: 'worker-fast', target: 'gate', kind: 'submit' },
      { id: 'e-submit-balanced', source: 'worker-balanced', target: 'gate', kind: 'submit' },
      { id: 'e-submit-frontier', source: 'worker-frontier', target: 'gate', kind: 'submit' },
      { id: 'e-retry-fast', source: 'gate', target: 'worker-fast', kind: 'reject_retry' },
      { id: 'e-retry-balanced', source: 'gate', target: 'worker-balanced', kind: 'reject_retry' },
      { id: 'e-retry-frontier', source: 'gate', target: 'worker-frontier', kind: 'reject_retry' },
      { id: 'e-escalate-1', source: 'worker-fast', target: 'worker-balanced', kind: 'escalate' },
      { id: 'e-escalate-2', source: 'worker-balanced', target: 'worker-frontier', kind: 'escalate' },
      { id: 'e-report', source: 'gate', target: 'orchestrator', kind: 'report' },
    ],
  };
}
