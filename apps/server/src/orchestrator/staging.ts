// SPDX-License-Identifier: AGPL-3.0-or-later
// PR staging: group passed packets into batches that respect the repo's PR size guidance (20–60
// functions, cap 60), whole units at a time (a unit's final file contains every packet of it).
// Staging creates local branches only; submission is an explicit operator action.
import type { Store, TaskRow } from '../db/store.js';
import type { RepoAdapter } from '../repo/types.js';
import type { EventBus } from '../telemetry/events.js';
import { newId } from '../util/async.js';

export async function stageRun(store: Store, repo: RepoAdapter, events: EventBus, runId: string, batchSize: number): Promise<number> {
  const passed = store.listTasks(runId, { state: 'passed', limit: 100_000 });
  if (!passed.length) return 0;
  const byUnit = new Map<string, TaskRow[]>();
  for (const t of passed) byUnit.set(t.unit, [...(byUnit.get(t.unit) ?? []), t]);

  const batches: TaskRow[][] = [];
  let cur: TaskRow[] = [];
  let count = 0;
  for (const tasks of byUnit.values()) {
    const n = tasks.reduce((s, t) => s + t.functions.length, 0);
    if (count + n > batchSize && cur.length) {
      batches.push(cur);
      cur = [];
      count = 0;
    }
    cur.push(...tasks);
    count += n;
  }
  if (cur.length) batches.push(cur);

  let seq = store.maxBatchSeq(runId);
  for (const tasks of batches) {
    seq++;
    const id = newId('batch');
    store.createBatch({ id, runId, seq, taskIds: tasks.map((t) => t.id) });
    const files = latestFiles(store, tasks);
    const fnCount = tasks.reduce((s, t) => s + t.functions.length, 0);
    const message = `Reconstruct ${fnCount} function(s) across ${new Set(tasks.map((t) => t.unit)).size} unit(s)\n\n${tasks.flatMap((t) => t.functions.map((f) => `- ${f.rva} ${f.name ?? ''}`)).join('\n')}`;
    if (repo.stageBatch) {
      const r = await repo.stageBatch({ runId, seq, files, tasks: tasks.map((t) => ({ id: t.id, srTaskId: t.srTaskId, functions: t.functions, task: t })), message });
      store.updateBatch(id, { status: r.verified ? 'branch_ready' : 'failed', branch: r.branch, detail: { problems: r.problems, functions: fnCount } });
      events.emit('batch.staged', `batch ${seq}: ${fnCount} functions → ${r.branch ?? 'no branch'} (${r.verified ? 're-verified' : `problems: ${r.problems.join('; ')}`})`, { runId, level: r.verified ? 'info' : 'warn' });
    } else {
      store.updateBatch(id, { status: 'draft', detail: { functions: fnCount } });
    }
    store.db.prepare(`UPDATE tasks SET state = 'staged', updated_at = ? WHERE id IN (${tasks.map(() => '?').join(',')}) AND state = 'passed'`).run(Date.now(), ...tasks.map((t) => t.id));
  }
  return batches.length;
}

function latestFiles(store: Store, tasks: TaskRow[]) {
  const latest = new Map<string, { content: string; at: number }>();
  for (const t of tasks) {
    const v = t.lastVerdictId ? store.getVerdict(t.lastVerdictId) : null;
    const a = v ? store.getAttempt(v.attemptId) : null;
    for (const f of a?.files ?? []) {
      const prev = latest.get(f.path);
      if (!prev || v!.createdAt > prev.at) latest.set(f.path, { content: f.content, at: v!.createdAt });
    }
  }
  return [...latest].map(([path, { content }]) => ({ path, content }));
}
