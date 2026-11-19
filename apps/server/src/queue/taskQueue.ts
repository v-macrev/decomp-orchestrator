// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable lease-based task queue on top of the tasks table.
//
// Invariants
//  * A task is owned by at most one dispatcher slot: ownership = (state in leased|gating) AND lease_id.
//  * Every transition is a conditional UPDATE guarded by the expected state and lease id, so a slot
//    that lost its lease (expired, reclaimed after a crash, run cancelled) can never clobber state.
//  * Two packets on the same unit never run concurrently (the unit's source files are shared).
//  * Recovery is idempotent: expired leases go back to pending; their running attempts become
//    'abandoned' and do not count against the task's attempt budget.
import type { TaskState } from '@decomp/core';
import type { Store, TaskRow } from '../db/store.js';
import { newId } from '../util/async.js';

export interface LeaseResult {
  task: TaskRow;
  leaseId: string;
}

export type TaskPatch = Partial<{
  tier: number; attemptsTotal: number; attemptsAtTier: number; noImprovementStreak: number; bestExactBytes: number;
  cheatStrikes: number; infraFailures: number; providerFailures: number; notBefore: number; lastVerdictId: string; srTaskId: string;
}>;

const COLS: Record<keyof TaskPatch, string> = {
  tier: 'tier', attemptsTotal: 'attempts_total', attemptsAtTier: 'attempts_at_tier', noImprovementStreak: 'no_improvement_streak',
  bestExactBytes: 'best_exact_bytes', cheatStrikes: 'cheat_strikes', infraFailures: 'infra_failures',
  providerFailures: 'provider_failures', notBefore: 'not_before', lastVerdictId: 'last_verdict_id', srTaskId: 'sr_task_id',
};

export class TaskQueue {
  constructor(private store: Store, private now: () => number = Date.now) {}

  /** Lease up to `n` ready tasks of a tier. Atomic (BEGIN IMMEDIATE). */
  lease(runId: string, tier: number, n: number, leaseMs: number): LeaseResult[] {
    const db = this.store.db;
    return this.store.tx(() => {
      const now = this.now();
      const rows = db
        .prepare(`SELECT id FROM tasks t
          WHERE t.run_id = @runId AND t.state = 'pending' AND t.tier = @tier AND t.not_before <= @now
            AND NOT EXISTS (SELECT 1 FROM tasks o WHERE o.run_id = t.run_id AND o.unit = t.unit AND o.state IN ('leased','gating'))
          ORDER BY t.priority DESC, t.rowid LIMIT @n`)
        .all({ runId, tier, now, n: n * 4 }) as Array<{ id: string }>;
      const out: LeaseResult[] = [];
      const units = new Set<string>();
      const upd = db.prepare(`UPDATE tasks SET state = 'leased', lease_id = @leaseId, lease_expires_at = @exp, updated_at = @now
        WHERE id = @id AND state = 'pending'`);
      for (const { id } of rows) {
        if (out.length >= n) break;
        const task = this.store.getTask(id)!;
        if (units.has(task.unit)) continue; // same-unit packets within one lease batch
        const leaseId = newId('lease');
        if (upd.run({ id, leaseId, exp: now + leaseMs, now }).changes === 1) {
          units.add(task.unit);
          out.push({ task: { ...task, state: 'leased', leaseId, leaseExpiresAt: now + leaseMs }, leaseId });
        }
      }
      return out;
    });
  }

  /** Extend a lease. Returns false if the lease was lost: the holder must stop work immediately. */
  heartbeat(taskId: string, leaseId: string, leaseMs: number): boolean {
    const now = this.now();
    return (
      this.store.db
        .prepare(`UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_id = ? AND state IN ('leased','gating')`)
        .run(now + leaseMs, now, taskId, leaseId).changes === 1
    );
  }

  /** Conditional transition for the lease holder. Lease fields are cleared when leaving leased/gating. */
  transition(taskId: string, leaseId: string, from: TaskState[], to: TaskState, patch: TaskPatch = {}): boolean {
    const releases = to !== 'leased' && to !== 'gating';
    const sets = ['state = @to', 'updated_at = @now'];
    if (releases) sets.push('lease_id = NULL', 'lease_expires_at = NULL');
    const params: Record<string, unknown> = { id: taskId, leaseId, to, now: this.now() };
    for (const [k, v] of Object.entries(patch) as Array<[keyof TaskPatch, unknown]>) {
      if (v === undefined) continue;
      sets.push(`${COLS[k]} = @${k}`);
      params[k] = v;
    }
    from.forEach((s, i) => (params[`f${i}`] = s));
    const sql = `UPDATE tasks SET ${sets.join(', ')} WHERE id = @id AND lease_id = @leaseId AND state IN (${from.map((_, i) => `@f${i}`).join(',')})`;
    return this.store.db.prepare(sql).run(params).changes === 1;
  }

  /** Reclaim expired leases (crash recovery + periodic reaper). Returns number of tasks requeued. */
  recoverExpired(runId?: string): number {
    const db = this.store.db;
    return this.store.tx(() => {
      const now = this.now();
      const scope = runId ? 'AND run_id = @runId' : '';
      const expired = db
        .prepare(`SELECT id FROM tasks WHERE state IN ('leased','gating') AND lease_expires_at < @now ${scope}`)
        .all({ now, runId }) as Array<{ id: string }>;
      const abandon = db.prepare(`UPDATE attempts SET status = 'abandoned', finished_at = ?, error = 'lease expired (crash or stall)' WHERE task_id = ? AND status = 'running'`);
      const reset = db.prepare(`UPDATE tasks SET state = 'pending', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state IN ('leased','gating')`);
      for (const { id } of expired) {
        abandon.run(now, id);
        reset.run(now, id);
      }
      return expired.length;
    });
  }

  /** On process start every lease is stale by definition (single-process deployment). */
  recoverAllOnBoot(): number {
    const db = this.store.db;
    return this.store.tx(() => {
      const now = this.now();
      db.prepare(`UPDATE attempts SET status = 'abandoned', finished_at = ?, error = 'process restarted' WHERE status = 'running'`).run(now);
      return db.prepare(`UPDATE tasks SET state = 'pending', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE state IN ('leased','gating')`).run(now).changes;
    });
  }

  /** Cancel everything not yet finished in a run (in-flight slots are aborted by the engine first). */
  cancelOpen(runId: string): number {
    return this.store.db
      .prepare(`UPDATE tasks SET state = 'cancelled', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE run_id = ? AND state IN ('leased','gating','pending')`)
      .run(this.now(), runId).changes;
  }

  /** Operator action: put dead/quarantined/cancelled tasks back into the queue at a chosen tier. */
  requeue(taskId: string, tier = 0): boolean {
    return (
      this.store.db
        .prepare(`UPDATE tasks SET state = 'pending', tier = ?, attempts_at_tier = 0, no_improvement_streak = 0, not_before = 0, updated_at = ?
          WHERE id = ? AND state IN ('dead','quarantined','cancelled')`)
        .run(tier, this.now(), taskId).changes === 1
    );
  }

  /** Earliest not_before among pending tasks of a tier, or null. Lets idle slots sleep precisely. */
  nextReadyAt(runId: string, tier: number): number | null {
    const r = this.store.db.prepare(`SELECT MIN(not_before) t FROM tasks WHERE run_id = ? AND tier = ? AND state = 'pending'`).get(runId, tier) as { t: number | null };
    return r.t;
  }

  hasOpenWork(runId: string): boolean {
    const r = this.store.db.prepare(`SELECT COUNT(*) n FROM tasks WHERE run_id = ? AND state IN ('pending','leased','gating')`).get(runId) as { n: number };
    return r.n > 0;
  }
}
