// SPDX-License-Identifier: AGPL-3.0-or-later
// Which account·model serves each node of a flow, by the scheduler's own matching (resolveBinding).
// Feeds the Accounts tab's assignment grid, so what the operator ticks there is what the engine does.
import { compileFlowPlan, validateFlow, type Account, type CapabilityTier, type Flow, type PoolBinding, type Role } from '@decomp/core';
import { bindingAdmits, resolveBinding } from './scheduler.js';

export interface NodeAssignment {
  nodeId: string;
  label: string;
  role: Role;
  /** Tier the node asks for (worker nodes): its own, or the one the ladder position implies. */
  capability: CapabilityTier | null;
  instances: number;
  binding: { strategy: PoolBinding['strategy']; tags: string[]; accountIds: string[]; model: string | null };
  /** Whether the node calls a model at all in this flow (a Gate Keeper without LLM review does not). */
  usesModel: boolean;
  serves: Array<{ accountId: string; modelId: string; enabled: boolean }>;
  /** No model declares the node's tier, so any model with the role serves it. */
  fallback: boolean;
  /** Accounts the binding keeps out (strategy / tags), with the reason. */
  excluded: Array<{ accountId: string; reason: string }>;
}

export function flowAssignments(flow: Flow, accounts: Account[]): { flowId: string; nodes: NodeAssignment[] } {
  let tierCap = new Map<string, CapabilityTier>();
  if (!validateFlow(flow).some((i) => i.level === 'error')) {
    tierCap = new Map(compileFlowPlan(flow).tiers.map((t) => [t.node.id, t.capability]));
  }
  const nodes = flow.nodes.map((n): NodeAssignment => {
    const role = n.type;
    const capability = role === 'worker' ? (n.data.pool.capability ?? tierCap.get(n.id) ?? null) : null;
    const binding: PoolBinding = { ...n.data.pool, capability: capability ?? undefined };
    const live = accounts.filter((a) => a.enabled);
    const r = resolveBinding(live, binding, role);
    const excluded = accounts.filter((a) => !bindingAdmits(binding, a)).map((a) => ({
      accountId: a.id,
      reason: binding.strategy === 'bound' ? 'node is bound to other accounts' : `node only takes accounts tagged ${binding.tags.map((t) => `#${t}`).join(' ')}`,
    }));
    return {
      nodeId: n.id,
      label: n.data.label || n.id,
      role,
      capability,
      instances: n.data.instances,
      binding: { strategy: binding.strategy, tags: binding.tags, accountIds: binding.accountIds, model: binding.model ?? null },
      usesModel: role !== 'gatekeeper' || n.data.gate.llmReview,
      serves: r.pairs.map((p) => ({ accountId: p.account.id, modelId: p.model.id, enabled: p.account.enabled })),
      fallback: r.fallback,
      excluded,
    };
  });
  return { flowId: flow.id, nodes };
}
