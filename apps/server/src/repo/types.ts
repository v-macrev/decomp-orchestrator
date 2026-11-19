// SPDX-License-Identifier: AGPL-3.0-or-later
// The seam between the engine and a target repository. `SrRepo` drives skyrim_decomp's `./sr`
// tooling in git worktrees; `SimRepo` is an in-memory stand-in for simulation and tests.
import type { CompareFunctionResult, Finding, FunctionTarget, SelectionSpec } from '@decomp/core';
import type { TaskRow } from '../db/store.js';

export interface DiscoveredFunction extends FunctionTarget {
  unit: string; // reconstruction/<area>/<Class>.cpp
  readiness?: number;
}

export interface PreparedTask {
  srTaskId: string | null;
  /** The only paths a Worker may write: the packet's unit header and source. */
  allowedPaths: string[];
  /** Private pack directories (listing / pseudo-C). Read only with exposure consent. */
  packs: string[];
  /** Paths the repo's own tooling changed during prepare (skeletons, shared headers). Not writable by
   *  the Worker, but not integrity violations either. */
  toolingChanges: string[];
}

export interface CompareOutcome {
  /** Repo tooling ran to completion and produced per-function results. */
  completed: boolean;
  allPass: boolean;
  compileError: boolean;
  functions: CompareFunctionResult[];
  /** Tooling/infra failure (timeout, missing toolchain, crash): not the candidate's fault. */
  infraError: string | null;
  durationMs: number;
}

export interface PreflightOutcome {
  completed: boolean;
  ok: boolean;
  problems: string[];
  infraError: string | null;
}

export interface DocSection {
  id: string;
  title: string;
  source: string;
  content: string;
}

export interface RepoAdapter {
  readonly name: string;
  /** Worktree slots available (one per concurrent worker slot). */
  readonly slotCount: number;
  init(): Promise<void>;
  discover(sel: SelectionSpec): Promise<DiscoveredFunction[]>;
  prepare(slot: number, task: TaskRow, opts: { draftedBy: string; model: string; signal: AbortSignal }): Promise<PreparedTask>;
  /** Content at the base revision (previously accepted source), or null if the file is new. */
  baseFile(path: string): Promise<string | null>;
  /** Current content in the slot's worktree (after prepare: includes the skeleton). */
  readFile(slot: number, path: string): Promise<string | null>;
  writeFiles(slot: number, files: Array<{ path: string; content: string }>): Promise<void>;
  /** Every path that differs from the base revision, including untracked and ignored files. */
  changedPaths(slot: number): Promise<string[]>;
  /** Content hashes of protected inputs (tooling, target pin, recipes) for tamper detection. */
  protectedDigest(slot: number): Promise<string>;
  compare(slot: number, task: TaskRow, prep: PreparedTask, opts: { signal: AbortSignal; timeoutMs: number }): Promise<CompareOutcome>;
  preflight(slot: number, task: TaskRow, prep: PreparedTask, opts: { signal: AbortSignal; timeoutMs: number }): Promise<PreflightOutcome>;
  /** Run the repository's own publication scan over the slot's diff (optional). */
  repoLeakScan?(slot: number, opts: { signal: AbortSignal }): Promise<Finding[] | null>;
  reset(slot: number): Promise<void>;
  docs(): Promise<DocSection[]>;
  /** Headers included by the unit (one level), for the context bundle. */
  includedHeaders(slot: number, unitFiles: string[]): Promise<DocSection[]>;
  readPack(pack: string): Promise<string | null>;
}
