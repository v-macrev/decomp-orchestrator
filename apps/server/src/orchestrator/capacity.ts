// SPDX-License-Identifier: AGPL-3.0-or-later
// Capacity planning for the per-worker function cap (RunConfig.maxFunctionsPerWorker, default 60).
//
// Every worker instance may claim at most `cap` distinct functions per run, so a run of B functions
// needs ⌈B / cap⌉ instances in total — and, because routing sends each difficulty to its own tier,
// enough instances per tier. Idle higher tiers can absorb a lower tier's overflow (work stealing);
// nothing flows downwards. Retries that escalate also consume capacity on the tier they climb to,
// so a plan with no headroom is flagged too.
import type { FlowPlan } from '@decomp/core';

export interface CapacityTier {
  tier: number;
  label: string;
  capability: string;
  workers: number;
  capacity: number;
  /** Functions routed to this tier (null before discovery). */
  demand: number | null;
  /** Of the demand, what overflows to higher tiers (stealing) or cannot be placed. */
  overflow: number;
}

export interface CapacityPlan {
  maxPerWorker: number;
  /** Worker instances the run will actually start (flow instances scaled to the repo's worktrees). */
  workers: number;
  /** Worker instances the flow asks for. */
  workersWanted: number;
  repoSlots: number;
  capacity: number;
  batch: number;
  /** Instances needed at this cap for the batch, ignoring routing. */
  workersNeeded: number;
  perTier: CapacityTier[];
  /** Functions no worker can take even with stealing (0 = feasible). */
  unplaced: number;
  headroom: number;
  ok: boolean;
  warnings: string[];
}

export function planCapacity(input: {
  plan: FlowPlan;
  /** Slots per tier as allocateSlots() returns them. */
  usable: Array<{ tier: number; slot: number }>;
  repoSlots: number;
  maxPerWorker: number;
  batch: number;
  /** Functions per tier index (after classification); omit for a batch-size-only check. */
  demandByTier?: number[];
  stealing: boolean;
  /** Capability steps a slot may steal across (1 = only the tier directly below). */
  stealMaxGap?: number;
}): CapacityPlan {
  const { plan, usable, maxPerWorker: cap, batch } = input;
  const workers = usable.length;
  const workersWanted = plan.tiers.reduce((s, t) => s + t.node.data.instances, 0);
  const capacity = workers * cap;
  const workersNeeded = Math.ceil(batch / cap);
  const perTier: CapacityTier[] = plan.tiers.map((t, i) => {
    const w = usable.filter((u) => u.tier === i).length;
    return { tier: i, label: t.node.data.label || t.node.id, capability: t.capability, workers: w, capacity: w * cap, demand: input.demandByTier?.[i] ?? null, overflow: 0 };
  });
  let unplaced = 0;
  if (input.demandByTier) {
    // Overflow travels up at most `gap` tiers; each tier serves its own demand first.
    const gap = input.stealing ? (input.stealMaxGap ?? 1) : 0;
    const pending: Array<{ amount: number; hops: number }> = [];
    for (const t of perTier) {
      let room = t.capacity;
      const own = Math.min(room, t.demand ?? 0);
      room -= own;
      t.overflow = (t.demand ?? 0) - own;
      for (const p of pending) {
        const take = Math.min(room, p.amount);
        p.amount -= take;
        room -= take;
      }
      for (const p of pending) p.hops++;
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.amount <= 0 || pending[i]!.hops >= gap) {
        unplaced += Math.max(0, pending[i]!.amount);
        pending.splice(i, 1);
      }
      if (t.overflow > 0) {
        if (gap > 0) pending.push({ amount: t.overflow, hops: 0 });
        else unplaced += t.overflow;
      }
    }
    unplaced += pending.reduce((s, p) => s + p.amount, 0);
  } else {
    unplaced = Math.max(0, batch - capacity);
  }
  const headroom = capacity - batch;
  const warnings: string[] = [];
  if (capacity < batch) {
    warnings.push(`${batch} functions need at least ${workersNeeded} worker instance(s) at ${cap} functions each; this run has ${workers} (capacity ${capacity}). Up to ${batch - capacity} function(s) will stay unassigned.`);
  }
  if (workers < workersWanted) warnings.push(`the flow asks for ${workersWanted} worker instances but the repository has ${input.repoSlots} worktree slot(s): scaled down to ${workers}.`);
  if (input.demandByTier && unplaced > 0 && capacity >= batch) {
    const short = perTier.filter((t) => t.overflow > 0).map((t) => `${t.capability} tier (${t.demand} fn for ${t.workers} worker(s) = ${t.capacity})`);
    warnings.push(`routing leaves ${unplaced} function(s) without a worker: ${short.join(', ')}${input.stealing ? '' : '; enable work stealing so idle higher tiers can take the overflow'}.`);
  }
  if (capacity >= batch && headroom < Math.ceil(batch * 0.15)) {
    warnings.push(`only ${headroom} function(s) of headroom: retries that escalate to another tier use capacity there too.`);
  }
  return { maxPerWorker: cap, workers, workersWanted, repoSlots: input.repoSlots, capacity, batch, workersNeeded, perTier, unplaced, headroom, ok: unplaced === 0 && capacity >= batch, warnings };
}
