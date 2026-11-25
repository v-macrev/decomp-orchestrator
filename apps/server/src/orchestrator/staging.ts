// SPDX-License-Identifier: AGPL-3.0-or-later
// PR staging: group passed packets into batches that respect the repo's PR size guidance (20–60
// functions, cap 60), whole units at a time (a unit's final file contains every packet of it).
// Staging creates local branches only; submission is an explicit operator action.
// A batch that fails re-verification creates no branch and leaves its packets 'passed' (the batch
// row keeps the problems), so they can be staged again; only a verified branch makes them 'staged'.
// When re-verification names the packets at fault, only their units stay in the failed batch: the
// other units are staged without them, as a batch of their own.
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
/** The most functions one PR may hold (the repository's PR size guidance; RunConfig.prBatchSize's cap). */
export const PR_BATCH_MAX = 60;

/**
 * Whole units into as few batches as fit `batchSize` functions each, biggest units first, each into
 * the first batch with room (a unit bigger than `batchSize` is a batch of its own).
 */
export function packUnits<T>(units: Array<{ unit: string; functions: number; items: T[] }>, batchSize: number): T[][] {
  const bins: Array<{ n: number; items: T[] }> = [];
  for (const u of [...units].sort((a, b) => b.functions - a.functions || a.unit.localeCompare(b.unit))) {
    const bin = bins.find((b) => b.n + u.functions <= batchSize);
    if (bin) {
      bin.n += u.functions;
      bin.items.push(...u.items);
    } else bins.push({ n: u.functions, items: [...u.items] });
  }
  return bins.map((b) => b.items);
}

export async function stageRun(store: Store, repo: RepoAdapter, events: EventBus, runId: string, batchSize: number, opts: { only?: readonly string[]; progress?: ProgressFn; pack?: 'dense' } = {}): Promise<StageSummary> {
  const summary: StageSummary = { staged: 0, failed: 0, seqs: [] };
  const pick = opts.only ? new Set(opts.only) : null;
  const passed = store.listTasks(runId, { state: 'passed', limit: 100_000 }).filter((t) => !pick || pick.has(t.id));
  if (!passed.length) return summary;
  const byUnit = new Map<string, TaskRow[]>();
  for (const t of passed) byUnit.set(t.unit, [...(byUnit.get(t.unit) ?? []), t]);

  let batches: TaskRow[][] = [];
  // Fixes from an open PR's review go back to that PR: each PR's fixed packets are a batch of their own.
  const forPr = new Map<string, TaskRow[]>();
  for (const [unit, tasks] of [...byUnit]) {
    const own = tasks.filter((t) => t.fix?.check === 'review' && t.fix.prOpen);
    for (const t of own) forPr.set(t.fix!.batchId, [...(forPr.get(t.fix!.batchId) ?? []), t]);
    const rest = tasks.filter((t) => !own.includes(t));
    if (rest.length) byUnit.set(unit, rest);
    else byUnit.delete(unit);
  }
  batches.push(...forPr.values());
  if (opts.pack === 'dense') {
    batches.push(...packUnits([...byUnit].map(([unit, items]) => ({ unit, functions: items.reduce((s, t) => s + t.functions.length, 0), items })), batchSize));
  } else {
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
  }

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
      const isPrFix = tasks[0]!.fix?.check === 'review' && tasks[0]!.fix.prOpen;
      const atFault = new Set(tasks.filter((t) => r.failedTaskIds?.includes(t.id)).map((t) => t.unit));
      const rest = ok || isPrFix || !atFault.size ? [] : tasks.filter((t) => !atFault.has(t.unit));
      const bad = rest.length ? tasks.filter((t) => atFault.has(t.unit)) : tasks;
      const badFns = bad.reduce((n, t) => n + t.functions.length, 0);
      const prFix = tasks[0]!.fix?.check === 'review' && tasks[0]!.fix.prOpen ? tasks[0]!.fix : null;
      const updatesPr = prFix ? { updatesPr: { batchId: prFix.batchId, seq: prFix.seq, pr: prFix.pr ?? null } } : {};
      store.updateBatch(id, { status: ok ? 'branch_ready' : 'failed', branch: ok ? r.branch : null, detail: { problems: r.problems, ...(r.failedTaskIds?.length ? { failedTaskIds: r.failedTaskIds } : {}), ...updatesPr, functions: ok ? fnCount : badFns, draftedBy, models } });
      if (!ok) {
        summary.failed++;
        if (rest.length) {
          store.setBatchTasks(id, bad.map((t) => t.id));
          batches.splice(i + 1, 0, rest);
        }
        events.emit('batch.failed', `batch ${seq}: ${badFns} functions NOT staged, no branch created; packets stay passed and can be staged again: ${r.problems.join('; ') || 'no branch'}${rest.length ? `. The other ${fnCount - badFns} functions go on without them in batch ${seq + 1}` : ''}`, { runId, level: 'warn', data: { seq, problems: r.problems } });
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

/** What an attempt that made no model call records: whose code it submitted. */
export const freeAttemptModel = (kind: 'stored candidate' | 'splice', writer: string | null | undefined) => `${kind}${writer ? ` of ${writer}` : ''} (no model call)`;

/** The model that finished the packet: the one that wrote what its accepted attempt submitted. */
export function finishingModel(store: Store, t: TaskRow): string | null {
  return writerOf(store, t, t.lastVerdictId);
}

/**
 * The model that wrote what a verdict's attempt submitted. An attempt without a model call submitted
 * an earlier attempt's code: the model it names, or (rows before it was named) the model of the
 * attempt the packet's fix came from, else of the packet's newest accepted attempt by a model.
 */
export function writerOf(store: Store, t: TaskRow, verdictId: string | null | undefined): string | null {
  const modelAt = (id: string | null | undefined) => {
    const v = id ? store.getVerdict(id) : null;
    return (v ? store.getAttempt(v.attemptId)?.model : null) ?? null;
  };
  const named = (m: string | null) => (m?.endsWith('(no model call)') ? (/^(?:stored candidate|splice) of (.+) \(no model call\)$/.exec(m)?.[1] ?? null) : m);
  const model = modelAt(verdictId);
  if (!model) return null;
  const accepted = () => store.attemptsForTask(t.id).filter((a) => named(a.model) && store.db.prepare("SELECT 1 FROM verdicts WHERE attempt_id = ? AND decision = 'pass'").get(a.id)).at(-1)?.model ?? null;
  return named(model) ?? named(modelAt(t.fix?.verdictId)) ?? named(accepted());
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
