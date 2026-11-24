// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { cheatScan } from '../src/gatekeeper/rules.js';
import { lostProvenance } from '../src/gatekeeper/provenance.js';
import { repairAnswer, repairHeader } from '../src/orchestrator/headerRepair.js';

// Headers as upstream had them when a pull request replaced them (skyrim_decomp #985).
const COMBAT = `// Source exposure: mixed (authorized target analysis and anonymous permitted sibling source).
// Origin: adapted from the cited game-code body under anonymous author permission.
// Licence: fo4-private reused with author permission conditional on anonymity.
// BSFixedString: STANDIN GUESS(low)
// data: GUESS(low)
// Sibling source: fo4-private@1b765c70 src/Game/AI/Combat/CombatTargetSelector.cpp:134
// CombatTargetSelectorFixed, GetClassType: SIBLING(fo4-private@1b765c70, author-permission)
// 0x8632b0 CombatTargetSelectorFixed::GetClassType
#include "CombatTargetSelectorFixed.h"
unsigned int CombatTargetSelectorFixed::GetClassType() { return 1; }
`;
const COMBAT_WORKER = `// Source exposure: mixed (community headers; the pinned image listing).
// Code origin: written for this reconstruction from the listing; names from the header.
// Adapted bodies: none
// 0x862b50 CombatTargetSelectorFixed::Function862b50
// Sibling source: fo4-private@1b765c70 src/Game/AI/Combat/CombatTargetSelector.cpp:134
// CombatTargetSelectorFixed, GetClassType: SIBLING(fo4-private@1b765c70, author-permission)
// 0x8632b0 CombatTargetSelectorFixed::GetClassType
#include "CombatTargetSelectorFixed.h"
unsigned int CombatTargetSelectorFixed::GetClassType() { return 1; }
unsigned int* CombatTargetSelectorFixed::Function862b50(unsigned int* a_out) { *a_out = m_unk18; return a_out; }
`;
const SHADER = `// Source exposure: mixed (local binary analysis and public names).
// Origin: {"generator_family":"const-return","generator_version":"2"}
// Adapted bodies: none. Body synthesized from the bounded leaf template.
// ShaderReferenceEffect: EXE_RTTI
// 0x5dfed0 ShaderReferenceEffect::GetStackable
#include "S.h"
`;
const IMAGESPACE = `// Source exposure: mixed (names and declarations from community headers; the listing of the pinned
// image).
// Code origin: brown-room reconstruction from disassembly
// Declarations derived from powerof3/CommonLibSSE are GPL-3.0 (its licence).
// Adapted bodies: none
// 0x1541630 ISShaderInitA::Initialize
#include "B.h"
`;
const fix = async (base: string, worker: string, own: string[]) =>
  (await repairAnswer([{ path: 'reconstruction/x.cpp', content: worker }], async () => base, {}, { base: async () => base, own })).files[0]!.content;

describe('upstream header statements', () => {
  it('are put back when a worker replaced them, and the new ones speak only for the new function', async () => {
    const out = await fix(COMBAT, COMBAT_WORKER, ['Function862b50']);
    expect(lostProvenance(COMBAT, out)).toEqual([]);
    expect(out).toContain('// Adapted bodies: none in Function862b50');
    expect(out).toContain('// Licence: fo4-private reused with author permission conditional on anonymity.');
    expect(out).toContain('// 0x862b50 CombatTargetSelectorFixed::Function862b50');
    expect(out.match(/Source exposure:/g)).toHaveLength(1);
    expect(out).toContain('anonymous permitted sibling source); mixed (community headers; the pinned image listing)');
    expect(cheatScan({ path: 'reconstruction/x.cpp', before: COMBAT, after: out, targets: [] }).filter((f) => f.code.startsWith('CONV_'))).toEqual([]);
  });

  it('keep a template origin and its own adapted-bodies statement', async () => {
    const out = await fix(SHADER, SHADER.replace(/\/\/ Source[\s\S]*?EXE_RTTI\n/, '// Source exposure: mixed (community headers).\n// Code origin: written for this reconstruction; bit test.\n// Adapted bodies: none.\n// 0x5e2320 ShaderReferenceEffect::Function5e2320\n'), ['Function5e2320']);
    expect(lostProvenance(SHADER, out)).toEqual([]);
    expect(out).toContain('Body synthesized from the bounded leaf template');
  });

  it('fold a replaced Code origin into the one upstream had', async () => {
    const out = await fix(IMAGESPACE, IMAGESPACE.replace('brown-room reconstruction from disassembly', 'written for this reconstruction from the listing'), ['GetShaderMacros']);
    expect(out).toContain('// Code origin: brown-room reconstruction from disassembly; GetShaderMacros: written for this reconstruction from the listing');
    expect(out).toContain('GPL-3.0 (its licence)');
  });

  it('leave an untouched header alone', async () => {
    const worker = `${COMBAT}int added();\n`;
    expect(await fix(COMBAT, worker, ['added'])).toBe(worker);
  });

  it('block a candidate that still drops one, whatever path it came by', () => {
    const f = cheatScan({ path: 'reconstruction/x.cpp', before: COMBAT, after: COMBAT_WORKER, targets: [] });
    expect(f.find((x) => x.code === 'CONV_PROVENANCE_REMOVED')?.message).toContain('Origin: adapted');
    expect(cheatScan({ path: 'reconstruction/x.cpp', before: COMBAT, after: COMBAT, targets: [] }).some((x) => x.code === 'CONV_PROVENANCE_REMOVED')).toBe(false);
  });

  it('a removed function line counts, and a longer address does not stand in for it', () => {
    expect(lostProvenance('// 0x5bcda0\n', '// 0x5bcda01 X\n')).toHaveLength(1);
    expect(lostProvenance('// 0x5bcda0\n', '// 0x5bcda0 X::Y\n')).toEqual([]);
  });

  it('keeps two upstream lines of one key apart from the worker\'s, and label lines under a short statement', () => {
    const base = '// Source exposure: mixed.\n// Code origin: original body A.\n// Code origin: adapted body B.\n// Unk_0F: COMMUNITY(x/y@1, MIT)\nint a();\n';
    const mine = '// Source exposure: mixed.\n// Code origin: written from the listing.\n// Adapted bodies: none.\n// member, padding: GUESS(low); unk08\n// Unk_0F: COMMUNITY(x/y@1, MIT)\nint a();\nint b();\n';
    const out = repairHeader('r/A.cpp', mine, base, { base, own: ['b'] }).content;
    expect(out).toContain('// Code origin: original body A; adapted body B; b: written from the listing');
    expect(out).toContain('// member, padding: GUESS(low); unk08');
    expect(lostProvenance(base, out)).toEqual([]);
  });
});
