// SPDX-License-Identifier: AGPL-3.0-or-later
// Server side of the engine protocol (docs/recon/INTEGRATION_CONTRACT.md): versioned JSON Lines over
// stdio. Every object is strict (an unknown field is an error), every string is bounded, and the response
// has no field that can carry bytes, listings or operands: the only free text is C++ inside `edits`,
// the engine's product, which the Gate Keeper judges like any other answer.
import { z } from 'zod';
import { UnitEdit } from '@decomp/core';

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

const Rva = z.string().regex(/^0x[0-9a-f]{1,8}$/);
const Id = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const Model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const BUDGET_KEYS = ['candidates', 'compiles', 'solverUnits', 'irNodes', 'expansions'] as const;
export const Budgets = z.strictObject(Object.fromEntries(BUDGET_KEYS.map((k) => [k, z.number().int().min(0).max(2 ** 40).optional()])) as Record<(typeof BUDGET_KEYS)[number], z.ZodOptional<z.ZodNumber>>);

export const EngineCommand = z.enum(['solve', 'doctor', 'analyze', 'explain']);
export type EngineCommand = z.infer<typeof EngineCommand>;

export const EngineRequest = z.strictObject({
  protocol: z.literal(PROTOCOL_VERSION),
  requestId: Id,
  command: EngineCommand,
  packet: z.strictObject({
    functions: z.array(z.strictObject({ rva: Rva, size: z.number().int().min(1).max(1_000_000), name: z.string().min(1).max(300).optional() })).min(1).max(4),
    unit: z.string().min(1).max(200),
    allowedPaths: z.array(z.string().min(1).max(260)).min(1).max(8),
  }).optional(),
  worktree: z.string().min(1).max(1024).optional(),
  taskDir: z.string().min(1).max(1024).optional(),
  packDirs: z.array(z.string().min(1).max(1024)).max(8).optional(),
  carriedUnitState: z.array(z.strictObject({ path: z.string().min(1).max(260), content: z.string().max(400_000) })).max(8).optional(),
  modelName: Model.optional(),
  budgets: Budgets.optional(),
  options: z.record(Id, z.union([z.boolean(), z.number().int(), z.string().max(1024)])).optional(),
  dataDir: z.string().min(1).max(1024).optional(),
  checkout: z.string().min(1).max(1024).optional(),
}).refine((r) => r.command === 'doctor' || r.packet !== undefined, { message: 'packet is required except for doctor' });
export type EngineRequest = z.infer<typeof EngineRequest>;

export const EngineProgress = z.strictObject({
  type: z.literal('progress'),
  protocol: z.literal(PROTOCOL_VERSION),
  stage: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  counters: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/), z.number().int().min(0).max(2 ** 53)),
});
export type EngineProgress = z.infer<typeof EngineProgress>;

export const FunctionStatus = z.enum(['solved', 'unsolved', 'unsupported', 'blocked']);
export type FunctionStatus = z.infer<typeof FunctionStatus>;

export const EvidenceClass = z.enum(['PROVEN', 'CONSTRAINED', 'INFERRED', 'AMBIGUOUS', 'UNKNOWN']);

export const FunctionResult = z.strictObject({
  rva: Rva,
  status: FunctionStatus,
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  counters: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/), z.number().int().min(0).max(2 ** 53)),
  ruleTrail: z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}@[0-9]{1,6}$/)).max(200),
  originLabels: z.array(z.string().min(1).max(200)).max(64),
  evidenceSummary: z.array(z.strictObject({ kind: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/), evidence: EvidenceClass, count: z.number().int().min(0).max(2 ** 31) })).max(64),
});
export type FunctionResult = z.infer<typeof FunctionResult>;

export const DoctorReport = z.strictObject({
  checks: z.array(z.strictObject({
    id: z.string().max(64),
    status: z.enum(['ok', 'missing', 'mismatch', 'error', 'skipped']),
    detail: z.string().max(200),
    fix: z.string().max(300).optional(),
  })).max(64),
  errors: z.array(z.string().max(64)).max(64),
  missing: z.array(z.string().max(64)).max(64),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export const EngineResult = z.strictObject({
  type: z.literal('result'),
  protocol: z.literal(PROTOCOL_VERSION),
  requestId: Id,
  command: EngineCommand,
  inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  engineVersion: z.string().min(1).max(32),
  ruleStoreVersion: z.string().min(1).max(64),
  functions: z.array(FunctionResult).max(4),
  edits: z.array(UnitEdit).max(4),
  codeOrigin: z.string().min(1).max(300).optional(),
  adaptedBodies: z.string().min(1).max(300).optional(),
  report: z.union([DoctorReport, z.strictObject({ implemented: z.boolean() })]).optional(),
});
export type EngineResult = z.infer<typeof EngineResult>;

/** The engine's attempt model name: what attribution, the attempt row and the claim carry. */
export function engineModelName(engineVersion: string): string {
  return `recon-engine-${engineVersion}`;
}
