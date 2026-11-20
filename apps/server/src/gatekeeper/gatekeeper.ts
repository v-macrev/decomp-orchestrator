// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate Keeper pipeline. Cheap deterministic stages run first and short-circuit, so expensive and
// riskier stages (writing files, invoking the compiler) only ever see candidates that passed:
//
//   1 scope       paths ⊆ packet allowlist, size/line caps            (before anything is written)
//   2 leak        repo publication rules on added lines               (before anything is written)
//   3 cheat       shortcut / gaming patterns, matched-body protection (before anything is written)
//   4 write       files written into the slot's isolated worktree
//   5 integrity   changed paths ⊆ written files; repo's own leakgrep on the real diff
//   6 compare     repo comparator (bounded: semaphore, timeout, output cap, scrubbed env)
//   7 integrity   after compare: protected inputs unchanged (digest), no stray changes
//   8 preflight   repo submit --dry-run lint (labels, origin, header rules)
//   9 review      optional LLM review — may block, can never override a deterministic failure
//
// Routing: tamper → quarantine. Strike codes (gaming/leaks/scope escapes) → retry with the exact
// finding, quarantine on the Nth strike. Infra failures → retry without burning the attempt
// budget (engine caps them). Everything else → retry/escalate decided by the engine.
import type { CompareFunctionResult, Finding, FunctionTarget, GateChecks, Verdict } from '@decomp/core';
import type { TaskRow } from '../db/store.js';
import type { PreparedTask, RepoAdapter } from '../repo/types.js';
import { Semaphore, newId } from '../util/async.js';
import { STRIKE_CODES, cheatScan, leakScan } from './rules.js';
import { DEFAULT_SCOPE_LIMITS, checkScope, type ScopeLimits } from './scope.js';

export interface Reviewer {
  review(input: { task: TaskRow; files: Array<{ path: string; content: string }>; compare: CompareFunctionResult[]; signal: AbortSignal }): Promise<Finding[]>;
}

export interface GateInput {
  task: TaskRow;
  attemptId: string;
  slot: number;
  prepared: PreparedTask;
  files: Array<{ path: string; content: string }>;
  checks: GateChecks;
  compareTimeoutMs: number;
  signal: AbortSignal;
  /** Unit files accepted earlier in this run: their functions are protected like base-matched ones. */
  carried?: Map<string, string>;
}

export interface GateResult {
  verdict: Verdict;
  infra: boolean;
  strike: boolean;
  written: Array<{ path: string; content: string }>;
}

export interface GateOptions {
  quarantineAfterStrikes: number;
  scopeLimits: ScopeLimits;
  preflightTimeoutMs: number;
}

export class GateKeeper {
  private opts: GateOptions;
  constructor(
    private repo: RepoAdapter,
    private compareSlots: Semaphore,
    private reviewer: Reviewer | null = null,
    opts: Partial<GateOptions> = {},
  ) {
    this.opts = { quarantineAfterStrikes: 2, scopeLimits: DEFAULT_SCOPE_LIMITS, preflightTimeoutMs: 120_000, ...opts };
  }

  async evaluate(input: GateInput): Promise<GateResult> {
    const { task, checks, signal } = input;
    const findings: Finding[] = [];
    const stages: Verdict['stages'] = [];
    let compare: CompareFunctionResult[] | null = null;
    let written: Array<{ path: string; content: string }> = [];
    let infra = false;

    const stage = async (name: string, enabled: boolean, fn: () => Promise<Finding[] | void>) => {
      if (!enabled) {
        stages.push({ name, ok: true, ms: 0, skipped: true });
        return true;
      }
      const t = Date.now();
      const out = (await fn()) ?? [];
      findings.push(...out);
      const ok = !out.some((f) => f.severity === 'block');
      stages.push({ name, ok, ms: Date.now() - t, skipped: false });
      return ok;
    };

    const done = (decision: Verdict['decision'], route: Verdict['route']): GateResult => {
      const exactBytes = (compare ?? []).reduce((s, r) => s + (r.result === 'pass' ? (r.targetSize ?? r.totalBytes ?? 0) : (r.exactBytes ?? 0)), 0);
      const strike = findings.some((f) => f.severity === 'block' && STRIKE_CODES.has(f.code));
      return {
        verdict: { id: newId('vd'), taskId: task.id, attemptId: input.attemptId, decision, route, findings, compare, exactBytes, stages, createdAt: Date.now() },
        infra,
        strike,
        written,
      };
    };
    const rejectOrQuarantine = (): GateResult => {
      const strike = findings.some((f) => f.severity === 'block' && STRIKE_CODES.has(f.code));
      const tamper = findings.some((f) => f.code === 'INTEGRITY_HOST_TAMPER');
      if (tamper || (strike && task.cheatStrikes + 1 >= this.opts.quarantineAfterStrikes)) return done('quarantine', 'quarantine');
      return done('reject', 'retry');
    };

    // 1–3: static, nothing written yet --------------------------------------------------------
    let accepted: Array<{ path: string; content: string }> = [];
    if (!(await stage('scope', true, async () => {
      const existing = new Map<string, string | null>();
      for (const p of input.prepared.allowedPaths) existing.set(p, input.carried?.get(p) ?? (await this.repo.baseFile(p)));
      const r = checkScope(input.files, input.prepared.allowedPaths, this.opts.scopeLimits, (p) => existing.get(p));
      accepted = r.accepted;
      return r.findings;
    }))) return rejectOrQuarantine();

    const bases = new Map<string, string | null>();
    for (const f of accepted) bases.set(f.path, await this.repo.baseFile(f.path));
    const current = new Map<string, string | null>();
    for (const f of accepted) current.set(f.path, await this.repo.readFile(input.slot, f.path));

    const leakOk = await stage('leak', checks.leak, async () =>
      accepted.flatMap((f) => leakScan(f.path, current.get(f.path) ?? bases.get(f.path) ?? null, f.content)),
    );
    const cheatOk = await stage('cheat', checks.cheat, async () =>
      accepted.flatMap((f) => cheatScan({ path: f.path, before: input.carried?.get(f.path) ?? bases.get(f.path) ?? null, after: f.content, targets: task.functions as FunctionTarget[] })),
    );
    if (!leakOk || !cheatOk) return rejectOrQuarantine();

    // 4: write ---------------------------------------------------------------------------------
    const digestBefore = checks.integrity ? await this.repo.protectedDigest(input.slot) : '';
    await this.repo.writeFiles(input.slot, accepted);
    written = accepted;

    // 5: integrity + repo-native leak scan on the real diff ---------------------------------------
    const allowed = new Set([...input.prepared.allowedPaths, ...input.prepared.toolingChanges]);
    const strayCheck = async (when: string): Promise<Finding[]> => {
      const changed = await this.repo.changedPaths(input.slot);
      return changed
        .filter((p) => !allowed.has(p))
        .map((p) => ({ stage: 'integrity', code: 'INTEGRITY_UNEXPECTED_CHANGE', severity: 'block' as const, file: p, message: `${p} changed ${when}; only packet files may differ from base` }));
    };
    if (!(await stage('integrity_pre', checks.integrity, async () => {
      const out = await strayCheck('before compare');
      if (this.repo.repoLeakScan && checks.leak) {
        const repoHits = await this.repo.repoLeakScan(input.slot, { signal });
        if (repoHits) out.push(...repoHits);
      }
      return out;
    }))) return rejectOrQuarantine();

    // 6: repository comparator ------------------------------------------------------------------
    const compareOk = await stage('compare', checks.repoCompare, async () => {
      const release = await this.compareSlots.acquire(signal);
      try {
        const r = await this.repo.compare(input.slot, task, input.prepared, { signal, timeoutMs: input.compareTimeoutMs });
        compare = r.functions;
        if (r.infraError) {
          infra = true;
          return [{ stage: 'compare', code: 'INFRA_COMPARE', severity: 'block', message: r.infraError }];
        }
        if (r.compileError) {
          const errs = r.compileErrors ?? [];
          return [{
            stage: 'compare', code: 'COMPARE_COMPILE_ERROR', severity: 'block',
            message: errs.length ? `candidate failed to compile:\n${errs.map((e) => `  ${e}`).join('\n')}` : 'candidate failed to compile (the compiler gave no error lines)',
          }];
        }
        return r.functions
          .filter((fn) => fn.result !== 'pass')
          .map((fn) => ({
            stage: 'compare', code: `COMPARE_${(fn.reason ?? 'MISMATCH').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, severity: 'block' as const,
            message: `${fn.rva} ${fn.name ?? ''}: ${fn.result} ${fn.reason ?? ''}${fn.firstMismatch ? ` first mismatch at ${fn.firstMismatch}` : ''}; ${fn.exactBytes ?? '?'}/${fn.targetSize ?? fn.totalBytes ?? '?'} bytes exact${fn.alignedBytes != null ? `, ${fn.alignedBytes} bytes align${fn.alignedRegions != null ? ` in ${fn.alignedRegions} region(s)` : ''}` : ''}${fn.hint ? `. Hint: ${fn.hint}` : ''}`,
          }));
      } finally {
        release();
      }
    });

    // 7: integrity after running repo tooling ----------------------------------------------------
    const tamperOk = await stage('integrity_post', checks.integrity, async () => {
      const out = await strayCheck('during compare');
      const digestAfter = await this.repo.protectedDigest(input.slot);
      if (digestAfter !== digestBefore) out.push({ stage: 'integrity', code: 'INTEGRITY_HOST_TAMPER', severity: 'block', message: 'protected verifier inputs changed while evaluating this candidate' });
      return out;
    });
    if (!tamperOk) return rejectOrQuarantine();
    if (!compareOk) return done('reject', 'retry'); // engine decides retry vs escalate vs dead-letter

    // 8: repo preflight (lint the submission) ------------------------------------------------------
    if (!(await stage('preflight', checks.repoPreflight, async () => {
      const r = await this.repo.preflight(input.slot, task, input.prepared, { signal, timeoutMs: this.opts.preflightTimeoutMs });
      if (r.infraError) {
        infra = true;
        return [{ stage: 'preflight', code: 'INFRA_PREFLIGHT', severity: 'block', message: r.infraError }];
      }
      // A finding on a file the Worker may not edit and did not change is pre-existing upstream state:
      // blocking on it would trap the packet in an unfixable retry loop, so it is reported, not held.
      const writable = new Set(input.prepared.allowedPaths);
      return r.problems.map((p) => {
        const file = /^([\w./-]+\.(?:h|cpp|hpp|inl)):(\d+):/.exec(p);
        const outOfScope = file && !writable.has(file[1]!) && !accepted.some((a) => a.path === file[1]);
        return outOfScope
          ? { stage: 'preflight', code: 'PREFLIGHT_OUT_OF_SCOPE', severity: 'warn' as const, file: file[1], line: Number(file[2]), message: `pre-existing, outside this packet: ${p}` }
          : { stage: 'preflight', code: 'PREFLIGHT_PROBLEM', severity: 'block' as const, ...(file ? { file: file[1], line: Number(file[2]) } : {}), message: p };
      });
    }))) return done('reject', 'retry');

    // 9: optional LLM review (block-only) ----------------------------------------------------------
    if (!(await stage('review', checks.llmReview && !!this.reviewer, async () =>
      this.reviewer!.review({ task, files: accepted, compare: compare ?? [], signal }),
    ))) return rejectOrQuarantine();

    return done('pass', 'accept');
  }
}
