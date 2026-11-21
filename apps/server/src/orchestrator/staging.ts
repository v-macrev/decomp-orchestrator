// SPDX-License-Identifier: AGPL-3.0-or-later
// PR staging: group passed packets into batches that respect the repo's PR size guidance (20–60
// functions, cap 60), whole units at a time (a unit's final file contains every packet of it).
// Staging creates local branches only; submission is an explicit operator action.
// A batch that fails re-verification creates no branch and leaves its packets 'passed' (the batch
// row keeps the problems), so they can be staged again; only a verified branch makes them 'staged'.
import type { Store, TaskRow } from '../db/store.js';
import type { ProgressFn, RepoAdapter } from '../repo/types.js';
import type { EventBus } from '../telemetry/events.js';
import { newId } from '../util/async.js';
import { coAuthorTrailers, draftedByText, personOf, renamePerson } from './attribution.js';

export interface StageSummary {
  /** Batches with a verified branch (or drafts, for adapters that do not stage). */
  staged: number;
  /** Batches that failed re-verification or git: no branch, packets still 'passed'. */
  failed: number;
  /** Sequence numbers of the batches this call created. */
  seqs: number[];
}

/**
 * Stage the run's 'passed' packets, or only `only` of them (those still 'passed'), into batches.
 */
export async function stageRun(store: Store, repo: RepoAdapter, events: EventBus, runId: string, batchSize: number, opts: { only?: readonly string[]; progress?: ProgressFn } = {}): Promise<StageSummary> {
  const summary: StageSummary = { staged: 0, failed: 0, seqs: [] };
  const pick = opts.only ? new Set(opts.only) : null;
  const passed = store.listTasks(runId, { state: 'passed', limit: 100_000 }).filter((t) => !pick || pick.has(t.id));
  if (!passed.length) return summary;
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
  for (const [i, tasks] of batches.entries()) {
    seq++;
    const of = batches.length > 1 ? ` (${i + 1} of ${batches.length})` : '';
    const fns = tasks.reduce((n, t) => n + t.functions.length, 0);
    opts.progress?.(`Re-verifying batch ${seq}${of}: ${fns} functions in ${tasks.length} packet(s)`, 'writing the final unit files into the staging worktree', 0, tasks.length);
    const id = newId('batch');
    store.createBatch({ id, runId, seq, taskIds: tasks.map((t) => t.id) });
    summary.seqs.push(seq);
    const { files, fnCount, draftedBy, models, message } = batchContent(store, runId, tasks);
    if (repo.stageBatch) {
      const step = `Re-verifying batch ${seq}${of}: ${fns} functions in ${tasks.length} packet(s)`;
      const r = await repo.stageBatch({
        runId, seq, files, tasks: tasks.map((t) => ({ id: t.id, srTaskId: t.srTaskId, functions: t.functions, task: t })), message,
        progress: (_s, detail, done, total) => opts.progress?.(step, detail, done, total),
      });
      const ok = r.verified && !!r.branch;
      store.updateBatch(id, { status: ok ? 'branch_ready' : 'failed', branch: ok ? r.branch : null, detail: { problems: r.problems, functions: fnCount, draftedBy, models } });
      if (!ok) {
        summary.failed++;
        events.emit('batch.failed', `batch ${seq}: ${fnCount} functions NOT staged, no branch created; packets stay passed and can be staged again: ${r.problems.join('; ') || 'no branch'}`, { runId, level: 'warn', data: { seq, problems: r.problems } });
        continue;
      }
      events.emit('batch.staged', `batch ${seq}: ${fnCount} functions → ${r.branch} (re-verified)${draftedBy ? `; submit with --drafted-by "${draftedBy}"` : ''}`, { runId, data: { draftedBy, models } });
    } else {
      store.updateBatch(id, { status: 'draft', detail: { functions: fnCount, draftedBy, models } });
    }
    summary.staged++;
    store.db.prepare(`UPDATE tasks SET state = 'staged', updated_at = ? WHERE id IN (${tasks.map(() => '?').join(',')}) AND state = 'passed'`).run(Date.now(), ...tasks.map((t) => t.id));
  }
  return summary;
}

/**
 * What a batch commits, with attribution as contributors give it: the model that finished each
 * packet (its accepted attempt), a "Drafted by" line for `sr submit --drafted-by`, and co-author
 * trailers. The person is the run's current draftedBy; lines written under an earlier name of the
 * run (it was edited) are renamed.
 */
export function batchContent(store: Store, runId: string, tasks: TaskRow[]) {
  const cfg = store.getRun(runId)?.config;
  const person = personOf(cfg?.draftedBy);
  const former = cfg?.formerDraftedBy ?? [];
  const files = latestFiles(store, tasks).map((f) => (f.path.endsWith('.cpp') && former.length ? { ...f, content: renamePerson(f.content, former, person) } : f));
  const fnCount = tasks.reduce((s, t) => s + t.functions.length, 0);
  const finisher = new Map(tasks.map((t) => [t.id, finishingModel(store, t)]));
  const models = [...new Set([...finisher.values()].filter((m): m is string => !!m))];
  const draftedBy = models.length ? draftedByText(person, models) : null;
  const lines = tasks.flatMap((t) => t.functions.map((f) => `- ${f.rva} ${f.name ?? ''}${finisher.get(t.id) ? ` (drafted by ${finisher.get(t.id)})` : ''}`));
  const trailers = coAuthorTrailers(models);
  const message = [
    `Reconstruct ${fnCount} function(s) across ${new Set(tasks.map((t) => t.unit)).size} unit(s)`,
    '',
    lines.join('\n'),
    ...(draftedBy ? ['', `Drafted by ${draftedBy}.`] : []),
    ...(trailers.length ? ['', ...trailers] : []),
  ].join('\n');
  return { files, fnCount, finisher, models, draftedBy, person, message };
}

/** The model of the packet's accepted attempt. */
export function finishingModel(store: Store, t: TaskRow): string | null {
  const v = t.lastVerdictId ? store.getVerdict(t.lastVerdictId) : null;
  return (v ? store.getAttempt(v.attemptId)?.model : null) ?? null;
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
