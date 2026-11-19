// SPDX-License-Identifier: AGPL-3.0-or-later
// Skill registry types. A skill is a compact, versioned recipe (≤ 600 tokens) plus deterministic
// triggers the context builder evaluates locally before any model call — no tool round-trips.
//
// Lifecycle:  candidate ──shadow eval passes──▶ active ──>25% of a run's functions──▶ promoted_to_core
//                 │                               │
//                 └──shadow eval fails──▶ deprecated ◀──negative pass-rate lift──┘
//
// Versions are immutable rows; a skill points at its current accepted version. Updates are
// proposals (version + 1) that only replace the current version after a shadow evaluation.
import { Difficulty } from '@decomp/core';
import { z } from 'zod';

export const SkillStatus = z.enum(['candidate', 'active', 'promoted_to_core', 'deprecated']);
export type SkillStatus = z.infer<typeof SkillStatus>;

export const SkillOrigin = z.enum(['repo_bootstrap', 'pr_history', 'retry_mining', 'failure_patch', 'compression', 'manual']);
export type SkillOrigin = z.infer<typeof SkillOrigin>;

/** Trigger groups, in descending specificity (and score weight). */
export const TriggerGroup = z.enum(['mnemonics', 'failures', 'symbols', 'features', 'patterns']);
export type TriggerGroup = z.infer<typeof TriggerGroup>;

/** Shape thresholds over the packet's function features (any function in the packet may satisfy them). */
export const FeatureTrigger = z.object({
  minBranches: z.number().int().nonnegative().optional(),
  minLoops: z.number().int().nonnegative().optional(),
  minIndirectCalls: z.number().int().nonnegative().optional(),
  minIndirectJumps: z.number().int().nonnegative().optional(),
  minSseOps: z.number().int().nonnegative().optional(),
  minCalls: z.number().int().nonnegative().optional(),
  minSize: z.number().int().nonnegative().optional(),
  maxSize: z.number().int().positive().optional(),
  eh: z.boolean().optional(),
  tailCall: z.boolean().optional(),
  destructor: z.boolean().optional(),
  difficulties: z.array(Difficulty).optional(),
});
export type FeatureTrigger = z.infer<typeof FeatureTrigger>;

const Regex = z.string().min(2).max(200);

export const SkillTrigger = z.object({
  /** Case-insensitive regexes over the target listing (read locally; never sent without consent). */
  mnemonics: z.array(Regex).max(12).default([]),
  /** Symbol / namespace prefixes over function, class and referenced names: "RE::", "hk", "BST", "GFx". */
  symbols: z.array(z.string().min(1).max(80)).max(16).default([]),
  features: FeatureTrigger.default({}),
  /** Detected code-pattern tags (sse, vtable, loop, eh, switch, tailcall, accessor, globals, ...). */
  patterns: z.array(z.string().min(1).max(32)).max(12).default([]),
  /**
   * The previous verdict's failure categories (BYTE_MISMATCH, COMPILE_ERROR, PREFLIGHT_LINT, ...),
   * raw finding codes (COMPARE_CODE_MISMATCH) or comparator reasons (function-size-mismatch).
   */
  failures: z.array(z.string().min(2).max(64)).max(12).default([]),
  /** Groups that must all match (used to tighten false-positive triggers). */
  require: z.array(TriggerGroup).max(5).default([]),
  /** Vetoes: any hit disqualifies. */
  exclude: z.object({
    symbols: z.array(z.string().min(1).max(80)).max(16).default([]),
    mnemonics: z.array(Regex).max(8).default([]),
    patterns: z.array(z.string().min(1).max(32)).max(12).default([]),
  }).default({ symbols: [], mnemonics: [], patterns: [] }),
  /** Minimum weighted score (see GROUP_WEIGHT) for the skill to be eligible. */
  minScore: z.number().min(0).max(20).default(1),
});
export type SkillTrigger = z.infer<typeof SkillTrigger>;

export const SkillTelemetry = z.object({
  /** Eligible (attempt, skill) pairs, injected or held out. */
  triggerCount: z.number().int(),
  injectCount: z.number().int(),
  passCount: z.number().int(),
  failCount: z.number().int(),
  holdoutCount: z.number().int(),
  holdoutPassCount: z.number().int(),
  avgTokensInjected: z.number(),
  /** Pass rate with the skill minus the control group's (null until enough evidence). */
  lift: z.number().nullable(),
  liftMethod: z.enum(['holdout', 'baseline', 'none']),
});
export type SkillTelemetry = z.infer<typeof SkillTelemetry>;

export const Skill = z.object({
  id: z.string(),
  name: z.string().min(3).max(120),
  description: z.string().max(400),
  version: z.number().int().positive(),
  status: SkillStatus,
  origin: SkillOrigin,
  tokenCount: z.number().int(),
  triggers: SkillTrigger,
  body: z.string().min(1),
  provenance: z.record(z.string(), z.unknown()).default({}),
  statusReason: z.string().nullable(),
  telemetry: SkillTelemetry,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Skill = z.infer<typeof Skill>;

export const VersionState = z.enum(['proposed', 'accepted', 'rejected', 'superseded']);
export type VersionState = z.infer<typeof VersionState>;
export const ChangeKind = z.enum(['create', 'patch', 'tighten', 'compress', 'manual']);
export type ChangeKind = z.infer<typeof ChangeKind>;

export const SkillVersion = z.object({
  skillId: z.string(),
  version: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  triggers: SkillTrigger,
  tokenCount: z.number().int(),
  state: VersionState,
  changeKind: ChangeKind,
  rationale: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  parentVersion: z.number().int().nullable(),
  evalRunId: z.string().nullable(),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type SkillVersion = z.infer<typeof SkillVersion>;

export const EvalStatus = z.enum(['running', 'passed', 'failed', 'error']);
export const EvalCase = z.object({
  taskId: z.string(),
  runId: z.string(),
  label: z.string(),
  difficulty: Difficulty,
  /** Why this case is in the benchmark (previous failure, retry win, pattern match). */
  why: z.string(),
  baseline: z.object({ pass: z.boolean(), exactBytes: z.number(), tokens: z.number(), skillInjected: z.boolean(), error: z.string().nullable() }),
  candidate: z.object({ pass: z.boolean(), exactBytes: z.number(), tokens: z.number(), skillInjected: z.boolean(), error: z.string().nullable() }),
});
export type EvalCase = z.infer<typeof EvalCase>;

export const SkillEvalRun = z.object({
  id: z.string(),
  skillId: z.string(),
  version: z.number().int(),
  /** null = baseline is "without this skill" (a new candidate). */
  baselineVersion: z.number().int().nullable(),
  status: EvalStatus,
  cases: z.number().int(),
  baselinePass: z.number().int(),
  candidatePass: z.number().int(),
  baselineTokens: z.number().int(),
  candidateTokens: z.number().int(),
  baselineExact: z.number().int(),
  candidateExact: z.number().int(),
  costUsd: z.number(),
  decision: z.enum(['accept', 'reject']).nullable(),
  reason: z.string().nullable(),
  details: z.array(EvalCase),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type SkillEvalRun = z.infer<typeof SkillEvalRun>;

export const JobKind = z.enum(['bootstrap', 'mine', 'update', 'optimize', 'shadow', 'curate']);
export type JobKind = z.infer<typeof JobKind>;
export const SkillJob = z.object({
  id: z.string(),
  kind: JobKind,
  status: z.enum(['running', 'done', 'failed']),
  summary: z.record(z.string(), z.unknown()),
  costUsd: z.number(),
  error: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type SkillJob = z.infer<typeof SkillJob>;

/** What a curator workflow proposes before the registry stores it. */
export const SkillDraft = z.object({
  name: z.string().min(3).max(120),
  description: z.string().max(400).default(''),
  body: z.string().min(20),
  triggers: SkillTrigger,
  rationale: z.string().max(2_000).default(''),
});
export type SkillDraft = z.infer<typeof SkillDraft>;

/** The frozen per-run view: core text for the static prefix + dynamic skills for matching. */
export interface RunSkillSnapshot {
  createdAt: number;
  core: Array<{ id: string; version: number; name: string; tokens: number }>;
  coreText: string;
  coreHash: string;
  /** Lift is frozen too: it breaks ranking ties, and ranking must not move mid-run. */
  dynamic: Array<{ id: string; version: number; lift?: number | null }>;
}
