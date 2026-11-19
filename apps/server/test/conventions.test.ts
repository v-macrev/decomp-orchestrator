// SPDX-License-Identifier: AGPL-3.0-or-later
// Header/convention repairs and format-aware routing, from the failures of the first real run
// (fixtures are the headers workers actually produced; the rejections are the repo lint's).
import { describe, expect, it } from 'vitest';
import { compileFlowPlan, defaultFlow, type Verdict } from '@decomp/core';
import { cheatScan } from '../src/gatekeeper/rules.js';
import { planCapacity } from '../src/orchestrator/capacity.js';
import { applyEdit } from '../src/orchestrator/edits.js';
import { allocateSlots, isFormatOnly } from '../src/orchestrator/engine.js';
import { originStatement, repairAnswer, repairHeader } from '../src/orchestrator/headerRepair.js';

const SPDX = '// SPDX-License-Identifier: MIT (CommonLibSSE-NG declarations, Copyright (c) 2018 Ryan-rsm-McKenzie; full text: licenses/CommonLibSSE-NG.txt)';
const SKELETON = [
  '// Source exposure: mixed (community headers; the pinned image listing).',
  '// Code origin: SKELETON_TODO_CODE_ORIGIN (state the actual origin and any adaptation)',
  '// 0x27edf0 TESObjectARMO::GetSkill',
  '// Adapted bodies: SKELETON_TODO_ORIGIN (write "none" when attempt prints no "origin advice" line;',
  '// otherwise name each adapted body, its upstream file, revision and licence).',
  SPDX,
  '#include "TESObjectARMO.h"',
  '',
].join('\n');
const BODY = '\nstd::int32_t TESObjectARMO::GetSkill() const\n{\n    return skill;\n}\n';
// What Haiku returned in the real run (CONV_HEADER_TOO_LONG: 10 lines; CONV_ORIGIN_PLACEHOLDER).
const WORKER = [
  '// Source exposure: mixed (community headers; the pinned image listing).',
  '// Code origin: SKELETON_TODO_CODE_ORIGIN (state the actual origin and any adaptation)',
  '// 0x27edf0 TESObjectARMO::GetSkill',
  '// Adapted bodies: SKELETON_TODO_ORIGIN (write "none" when attempt prints no "origin advice" line;',
  '// otherwise name each adapted body, its upstream file, revision and licence).',
  '// Code origin: bodies written by the contributor from the compared functions\' behaviour; names and',
  '// declarations come from the header (CharmedBaryon/CommonLibSSE-NG, MIT).',
  '// Source exposure: mixed (names and declarations from community headers; the listing of the pinned',
  '// image).',
  SPDX,
  '// Recipe: reconstruction/recipes/msvc-19.16.27054-o2-root-includes.json',
  '// Adapted bodies: none.',
  '#include "TESObjectARMO.h"',
].join('\n') + BODY;

const conv = (path: string, before: string | null, after: string) => cheatScan({ path, before, after, targets: [{ rva: '0x27edf0', name: 'TESObjectARMO::GetSkill', size: 31 }] }).filter((f) => f.code.startsWith('CONV_'));

describe('header repair', () => {
  it('turns the real rejected header into one the lint accepts, without inventing anything', () => {
    expect(conv('a.cpp', SKELETON, WORKER).map((f) => f.code).sort()).toEqual(['CONV_HEADER_TOO_LONG', 'CONV_ORIGIN_PLACEHOLDER']);
    const r = repairHeader('reconstruction/skyrim_shared/forms/TESObjectARMO.cpp', WORKER, SKELETON);
    expect(r.content).not.toMatch(/SKELETON_TODO/);
    expect(r.content.match(/Code origin:/g)).toHaveLength(1);
    expect(r.content).toContain("Code origin: bodies written by the contributor from the compared functions' behaviour; names and");
    expect(r.content).toContain('// declarations come from the header'); // wrapped continuation kept with its line
    expect(r.content.match(/Source exposure:/g)).toHaveLength(1);
    expect(r.content).toContain('// Source exposure: mixed (community headers; the pinned image listing).'); // the file's own line wins
    expect(r.content.match(/Adapted bodies:/g)).toHaveLength(1);
    expect(r.content).toContain('// Adapted bodies: none.');
    expect(r.content).not.toContain('Recipe:');
    expect(r.content).toContain('// 0x27edf0 TESObjectARMO::GetSkill');
    expect(r.content).toContain(SPDX);
    expect(r.content).toContain(BODY.trim());
    expect(conv('a.cpp', SKELETON, r.content)).toEqual([]);
    expect(r.changes.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves a placeholder alone when the worker gave no origin statement anywhere', () => {
    const lazy = SKELETON + BODY;
    const r = repairHeader('x.cpp', lazy, SKELETON);
    expect(r.content).toBe(lazy);
    expect(r.changes).toEqual([]);
  });

  it('keeps every line the file already had (only added lines are ever dropped)', () => {
    const base = ['// Source exposure: mixed.', '// Code origin: written for this reconstruction.', '// Recipe: kept because it was already here.', "// IsEqual's body is adapted from NG (MIT).", '#include "X.h"', ''].join('\n');
    const after = base.replace('#include', '// Drafted by claude from listings. A byte match shows that this source works.\n#include') + 'int f();\n';
    const r = repairHeader('x.cpp', after, base);
    expect(r.content).toContain('// Recipe: kept because it was already here.');
    expect(r.content).toContain("// IsEqual's body is adapted from NG (MIT).");
    expect(r.content).not.toContain('Drafted by');
  });

  it('gives a changed .h the worker\'s own origin statement from its .cpp', async () => {
    const h0 = '// Source exposure: mixed (binary-analysis of the pinned image, community-headers).\n// TESModelTextureSwap: EXE_RTTI; class name and base from the image RTTI\n#pragma once\n\nclass TESModelTextureSwap {};\n';
    const h1 = h0.replace('class TESModelTextureSwap {};', 'class TESModelTextureSwap { public: TESModelTextureSwap* GetAsModelTextureSwap(); };');
    const cpp = '// Source exposure: mixed.\n// Code origin: written for this reconstruction from the listing; names from the header.\n// 0x146650 TESModelTextureSwap::GetAsModelTextureSwap\n#include "TESModelTextureSwap.h"\n';
    const current = async (p: string) => (p.endsWith('.h') ? h0 : null);
    const r = await repairAnswer([{ path: 'u/TESModelTextureSwap.h', content: h1 }, { path: 'u/TESModelTextureSwap.cpp', content: cpp }], current);
    const h = r.files.find((f) => f.path.endsWith('.h'))!.content;
    expect(originStatement(h)).toBe('written for this reconstruction from the listing; names from the header.');
    expect(h.split('\n')[1]).toMatch(/^\/\/ Code origin:/); // right after Source exposure
    expect(h).toContain('// TESModelTextureSwap: EXE_RTTI');
    // an unchanged .h is never touched
    const same = await repairAnswer([{ path: 'u/T.h', content: h0 }, { path: 'u/T.cpp', content: cpp }], async () => h0);
    expect(same.files[0]!.content).toBe(h0);
  });

  it('an edits-mode answer that never touches the header gets the stated codeOrigin/adaptedBodies in the placeholders', async () => {
    // The pattern behind the rest of the real run's CONV_ORIGIN_PLACEHOLDER rejections.
    const lazy = SKELETON + BODY;
    const r = await repairAnswer([{ path: 'r/TESObjectARMO.cpp', content: lazy }], async () => SKELETON, {
      codeOrigin: 'written for this reconstruction from the listing; names from TESObjectARMO.h', adaptedBodies: 'none',
    });
    const out = r.files[0]!.content;
    expect(out).not.toMatch(/SKELETON_TODO|otherwise name each adapted body/);
    expect(out).toContain('// Code origin: written for this reconstruction from the listing; names from TESObjectARMO.h');
    expect(out).toContain('// Adapted bodies: none');
    expect(conv('a.cpp', SKELETON, out)).toEqual([]);
  });

  it('header edits with code lines move them to the declarations instead of failing', () => {
    const r = applyEdit(SKELETON, { path: 'x.cpp', header: '// Source exposure: mixed.\n// Code origin: written here.\n#include <cstdint>', functions: [] });
    expect(r.problems).toEqual([]);
    expect(r.content.startsWith('// Source exposure: mixed.\n// Code origin: written here.\n')).toBe(true);
    expect(r.content).toContain('#include <cstdint>');
  });
});

describe('format-aware routing', () => {
  const v = (codes: string[], compareFail = false): Verdict => ({
    id: 'v', taskId: 't', attemptId: 'a', decision: 'reject', route: 'retry', exactBytes: 0, stages: [], createdAt: 0,
    findings: codes.map((code) => ({ stage: 'x', code, severity: 'block' as const, message: '' })),
    compare: compareFail ? [{ rva: '0x1', name: null, result: 'fail', reason: 'code-mismatch', hint: null, firstMismatch: null, candidateSize: 1, targetSize: 1, exactBytes: 0, totalBytes: 1 }] : null,
  });
  it('treats header/lint/output-only rejections as format, never byte or compile failures', () => {
    expect(isFormatOnly(v(['CONV_HEADER_TOO_LONG', 'CONV_ORIGIN_PLACEHOLDER']))).toBe(true);
    expect(isFormatOnly(v(['PREFLIGHT_PROBLEM']))).toBe(true);
    expect(isFormatOnly(v(['SCOPE_LINE_TOO_LONG', 'LEAK_INCLUDE_OUTSIDE_ROOTS']))).toBe(true);
    expect(isFormatOnly(v(['COMPARE_FUNCTION_SIZE_MISMATCH']))).toBe(false);
    expect(isFormatOnly(v(['COMPARE_COMPILE_ERROR', 'CONV_HEADER_TOO_LONG']))).toBe(false);
    expect(isFormatOnly(v(['CONV_HEADER_TOO_LONG'], true))).toBe(false);
    expect(isFormatOnly(v(['CHEAT_STUB']))).toBe(false);
  });

  it('overflow travels up at most stealMaxGap tiers', () => {
    const plan = compileFlowPlan(defaultFlow());
    const usable = allocateSlots(plan, 64); // 10/6/4 workers → 600/360/240
    const base = { plan, usable, repoSlots: 64, maxPerWorker: 60, batch: 1400, demandByTier: [1100, 300, 0], stealing: true };
    expect(planCapacity({ ...base, stealMaxGap: 1 }).unplaced).toBe(440); // balanced takes 60; frontier never takes fast work
    expect(planCapacity({ ...base, stealMaxGap: 2 }).unplaced).toBe(200);
  });
});
