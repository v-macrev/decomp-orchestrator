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
  readonly baseSha?: string;
  /** Worktree slots available (one per concurrent worker slot). */
  readonly slotCount: number;
  init(): Promise<void>;
  discover(sel: SelectionSpec, opts?: { exclude?: ReadonlySet<string> }): Promise<DiscoveredFunction[]>;
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
  /** Operator notices from the adapter (e.g. a stale git lock it cleared); set by the engine. */
  notice?: ((kind: string, msg: string) => void) | null;
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
  recordAttribution?(input: { task: TaskRow; srTaskId: string; model: string; draftedBy: string; slot?: number }): Promise<{ ok: boolean; problems: string[] }>;
  /**
   * Open one pull request for a staged batch with the repository's own `sr submit`: rebuild the
   * batch on a fresh branch from the base, re-verify every packet, then submit through the last
   * unit's task with every file of the batch as its unit: one commit, pushed, one PR. A batch of
   * several units then gets a commit message, title and description naming every function.
   * `dryRun` runs `sr submit --dry-run`: nothing is committed or pushed.
   */
  submitBatch?(input: SubmitBatchInput): Promise<SubmitBatchResult>;
  /** Rewrite an open batch PR as one commit, titled and described with every function of the batch. */
  tidyPullRequest?(input: { branch: string; tasks: SubmitBatchInput['tasks']; draftedBy: string; pullRequest: string | null; claimUrls?: string[] }): Promise<{ ok: boolean; title: string | null; warnings: string[]; error: string | null; claims?: string[] }>;
  /** Delete an orchestrator-owned local batch ref. */
  deleteBatchBranch?(branch: string): Promise<boolean>;
  /**
   * Which of these functions another contributor's open claim or pull request names, by the same
   * rule `sr submit` blocks on (fresh claims only: lapsed ones and the operator's own do not count).
   */
  claimCollisions?(rvas: string[], opts?: { signal?: AbortSignal }): Promise<ClaimCollisionCheck>;
  /** Read only: what the base already has of these functions and files (`branch` = the batch's staged branch, for its base). */
  upstreamState?(input: { rvas: string[]; files: string[]; branch: string | null }): Promise<UpstreamState>;
  /**
   * While on, staging and dry runs may also use the worker slots to re-compare packets side by side.
   * The engine turns it on only while it holds every slot (no run active) and off afterwards.
   */
  useIdleSlots?(on: boolean): void;
  /** A pull request's state on GitHub and every comment, review and inline review comment on it. Read only. */
  pullRequestStatus?(url: string): Promise<PrStatus>;
  /**
   * Push fixed files to an open batch PR as one more commit on its branch: the branch's local copy
   * (refused when the fork moved), the files written, every packet of the PR re-verified, committed,
   * pushed as a fast-forward. Never force-pushes and never opens a new PR.
   */
  updatePullRequest?(input: { branch: string; pullRequest: string; files: Array<{ path: string; content: string }>; tasks: SubmitBatchInput['tasks']; message: string; progress?: ProgressFn }): Promise<{ ok: boolean; commit: string | null; problems: string[]; error: string | null }>;
}

/** One comment on a pull request, from any of GitHub's three places for them. */
export interface PrComment {
  id: string;
  /** 'comment': the conversation; 'review': a review's summary; 'inline': a review comment on a line. */
  kind: 'comment' | 'review' | 'inline';
  author: string | null;
  bot: boolean;
  /** Written by the operator's own GitHub account. */
  mine: boolean;
  body: string;
  path: string | null;
  line: number | null;
  url: string;
  at: string | null;
  /** For a review: APPROVED, CHANGES_REQUESTED, COMMENTED… */
  reviewState: string | null;
}

export interface PrStatus {
  checked: boolean;
  error: string | null;
  state: 'open' | 'closed' | 'merged' | null;
  title: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  headSha: string | null;
  comments: PrComment[];
}

export interface ClaimCollision {
  url: string;
  author: string | null;
  updatedAt: string | null;
}

export interface ClaimCollisionCheck {
  /** Every function was checked against GitHub. */
  checked: boolean;
  error: string | null;
  /** Colliding functions only: rva → the open claims or PRs naming it. */
  collisions: Record<string, ClaimCollision[]>;
}

/** Live progress for the operator: what is happening now, and how far along it is. */
export type ProgressFn = (step: string, detail?: string | null, done?: number | null, total?: number | null) => void;

export interface SubmitBatchInput {
  runId: string;
  seq: number;
  branch: string;
  files: Array<{ path: string; content: string }>;
  /** The last one is submitted through; the others are committed first. */
  tasks: Array<{ id: string; srTaskId: string | null; functions: TaskRow['functions']; task: TaskRow }>;
  /** Commit message for the units committed before the submitted one. */
  message: string;
  /** `sr submit --drafted-by`. */
  draftedBy: string;
  /** After a real submit of a multi-packet batch: the PR's title and a section for the other functions. */
  title: string | null;
  extraBody: string | null;
  /** The batch's verified branch: packets compared when it was staged at this base need no new compare. */
  stagedBranch?: string | null;
  dryRun: boolean;
  allowUncheckedClaims?: boolean;
  signal?: AbortSignal;
  progress?: ProgressFn;
}

export interface SubmitBatchResult {
  ok: boolean;
  dryRun: boolean;
  cancelled?: boolean;
  /** Distinct sr tasks re-compared, and those whose last compare still proved this exact tree. */
  compared?: number;
  reused?: number;
  /** Whether the mutating sr submit command was started. */
  submissionStarted?: boolean;
  /** Re-verification or git problems found before `sr submit` ran. */
  problems: string[];
  /** `sr submit`'s own blockers and warnings. */
  blockers: string[];
  uncheckedClaims?: string[];
  warnings: string[];
  plan: string[];
  pullRequest: string | null;
  /** The title the batch PR was given (every function of the batch), when it was renamed. */
  title?: string | null;
  /** The claim issue(s) opened for the PR's functions after a real submit (each links the PR; the PR links them). */
  claims?: string[];
  /** When gh could not open the PR: the compare link to open it by hand. */
  link: string | null;
  error: string | null;
}

/** What upstream (the pinned base) already has of a batch: matched functions, untracked ones, files it changed since the batch was built. */
export interface UpstreamState {
  checked: boolean;
  /** rva → the owner upstream records for it. */
  matched: Record<string, string | null>;
  /** Functions data/progress.json does not list. */
  untracked: string[];
  /** Files the batch writes that upstream changed between the batch's base and this one. */
  changed: string[];
  builtOn: string | null;
}

export interface StageBatchInput {
  runId: string;
  seq: number;
  files: Array<{ path: string; content: string }>;
  tasks: Array<{ id: string; srTaskId: string | null; functions: TaskRow['functions']; task: TaskRow }>;
  message: string;
  progress?: ProgressFn;
}

export interface StageBatchResult {
  branch: string | null;
  verified: boolean;
  problems: string[];
  /** Packets whose re-verification failed (their sr task's compare did not pass). */
  failedTaskIds?: string[];
  compared?: number;
  reused?: number;
}
