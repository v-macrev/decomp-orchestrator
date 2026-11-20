// SPDX-License-Identifier: AGPL-3.0-or-later
// The seam between the engine and a target repository. `SrRepo` drives skyrim_decomp's `./sr`
// tooling in git worktrees; `SimRepo` is an in-memory stand-in for simulation and tests.
import type { CompareFunctionResult, Finding, FunctionFeatures, FunctionTarget, SelectionSpec } from '@decomp/core';
import type { TaskRow } from '../db/store.js';

export interface DiscoveredFunction extends FunctionTarget {
  unit: string; // reconstruction/<area>/<Class>.cpp
  readiness?: number;
  /** Backlog cautions reported by the repo (count only). */
  cautions?: number;
  /** Features known at discovery (simulator); real repos answer through analyze(). */
  features?: FunctionFeatures;
}

export interface InventoryEntry {
  rva: string;
  name: string | null;
  size: number;
  nameOrigin: string | null;
  /** matched | mapped | ... as the repository records it. */
  status: string;
}

export interface Backlog {
  /** Human-readable provenance, e.g. "data/progress.json@1a2b3c + sr next". */
  source: string;
  inventory: InventoryEntry[];
  /** Mapped, startable functions with units, in the repository's readiness order. */
  candidates: DiscoveredFunction[];
  /** RVAs claimed locally (and by others when the claim index was reachable). */
  claimed: string[];
  claimsChecked: boolean;
  /** Optional function table rows by RVA (operator opt-in; xrefs, basic blocks, ...). */
  functionTable: Map<string, Record<string, unknown>> | null;
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
  /** The compiler's own error lines for the candidate (paths made repo-relative): our code, not target data. */
  compileErrors?: string[];
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
  includedHeaders(slot: number, unitFiles: string[], opts?: { maxChars?: number; maxHeaders?: number }): Promise<DocSection[]>;
  readPack(pack: string): Promise<string | null>;
  /**
   * Complexity features from local packs (counts only — nothing game-derived is returned). Functions
   * without a local pack are simply absent from the map. `packs` = directories from prepare().
   */
  analyze?(fns: FunctionTarget[], opts?: { packs?: string[] }): Promise<Map<string, FunctionFeatures>>;
  /** Budgeted listing for one pack: compact listing form, at most `maxChars` (exposure consent only). */
  readPackSlice?(pack: string, maxChars: number, opts?: { withDecompiler?: boolean }): Promise<{ text: string; rawChars: number } | null>;
  /**
   * Everything the FunctionGatherer starts from: the repository's function inventory, the startable
   * candidates with their units (the repo's own mapping and readiness order), claimed RVAs and an
   * optional operator-provided function table (xrefs, blocks). Counts and names only.
   */
  backlog?(opts: { maxSize: number }): Promise<Backlog>;
  /** A repository document in full (docs() caps each doc for prompts; skill bootstrap needs all of it). */
  docFile?(rel: string): Promise<string | null>;
  /** Local pack directory of a function, if one exists (skill matching for shadow-evaluation cases). */
  packFor?(fn: FunctionTarget): Promise<string | null>;
  /** Give back local claims taken by `prepare` for packets that will not be submitted. */
  releaseClaims?(rvas: string[], reason: string): Promise<Array<{ rva: string; ok: boolean; error: string | null }>>;
  /**
   * Assemble a PR batch: write the final unit files on a fresh branch from the base revision,
   * re-verify every packet against the combined result, and commit. Never pushes or opens a PR.
   */
  stageBatch?(input: StageBatchInput): Promise<StageBatchResult>;
  /**
   * Record who finished a packet the way contributors do: the claim's model (`sr claim --model`)
   * and the task's `drafter_model`, set to the model of the accepted attempt.
   */
  recordAttribution?(input: { task: TaskRow; srTaskId: string; model: string; draftedBy: string }): Promise<{ ok: boolean; problems: string[] }>;
}

export interface StageBatchInput {
  runId: string;
  seq: number;
  files: Array<{ path: string; content: string }>;
  tasks: Array<{ id: string; srTaskId: string | null; functions: TaskRow['functions']; task: TaskRow }>;
  message: string;
}

export interface StageBatchResult {
  branch: string | null;
  verified: boolean;
  problems: string[];
}
