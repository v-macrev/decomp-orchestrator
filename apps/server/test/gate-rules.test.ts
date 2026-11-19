// SPDX-License-Identifier: AGPL-3.0-or-later
// Labelled corpus for the Gate Keeper's static rules. Every "legit" case must produce zero blocking
// findings (false positives); every "cheat" case must produce its expected code (false negatives).
import { describe, expect, it } from 'vitest';
import type { FunctionTarget } from '@decomp/core';
import { cheatScan, leakScan } from '../src/gatekeeper/rules.js';
import { checkScope } from '../src/gatekeeper/scope.js';

const PATH = 'reconstruction/skyrim/forms/TESForm.cpp';
const HEADER = [
  '// Source exposure: mixed (community headers; the pinned image listing).',
  '// SPDX-License-Identifier: MIT (CommonLibSSE-NG declarations, Copyright (c) 2018 Ryan-rsm-McKenzie; full text: licenses/CommonLibSSE-NG.txt)',
  '// Code origin: original; the listing and community declarations only',
  '// 0x1de5e0 TESForm::GetFormID',
  '// TESForm, formID: COMMUNITY(CharmedBaryon/CommonLibSSE-NG@0d9f1c2, MIT)',
  '// Adapted bodies: none',
  '#include "TESForm.h"',
  '',
].join('\n');

const T = (name: string, size: number, rva = '0x1de5e0'): FunctionTarget => ({ rva, name, size });

function blocks(src: string, opts: { before?: string | null; targets?: FunctionTarget[] } = {}) {
  const all = [...leakScan(PATH, opts.before ?? null, src), ...cheatScan({ path: PATH, before: opts.before ?? null, after: src, targets: opts.targets ?? [] })];
  return all.filter((f) => f.severity === 'block').map((f) => f.code);
}

const LEGIT: Array<[string, string, { before?: string; targets?: FunctionTarget[] }?]> = [
  ['simple accessor', `${HEADER}std::uint32_t TESForm::GetFormID() const\n{\n    return formID;\n}\n`, { targets: [T('TESForm::GetFormID', 5)] }],
  ['prose comments mentioning forbidden words', `${HEADER}// We avoid a #pragma here; the old byte array approach (and ## pasting) was dropped.\n/* move the value into place */\nint TESForm::Get() const { return value; }\n`],
  ['float lookup table', `${HEADER}static const float kSteps[8] = {0.0f, 0.5f, 1.0f, 1.5f, 2.0f, 2.5f, 3.0f, 3.5f};\nfloat Step(int i) { return kSteps[i]; }\n`],
  ['int table (not byte-typed, decimal)', `${HEADER}static const int kPrimes[9] = {2, 3, 5, 7, 11, 13, 17, 19, 23};\n`],
  ['static_assert with message and template comma', `${HEADER}static_assert(sizeof(TESForm) == 0x20, "TESForm size");\nstatic_assert(std::is_same_v<int, int>, "same");\n`],
  ['pointer arithmetic on this', `${HEADER}void* TESForm::Extra() { return reinterpret_cast<char*>(this) + 0x1A0; }\nstd::uintptr_t A() { return reinterpret_cast<std::uintptr_t>(this) + 0x10; }\n`],
  ['tiny target legitimately trivial', `${HEADER}bool TESForm::IsDeleted() const\n{\n    return false;\n}\n`, { targets: [T('TESForm::IsDeleted', 3)] }],
  ['include guard + pragma once', `#pragma once\n#ifndef TESFORM_H\n#define TESFORM_H\nstruct TESForm { int formID; };\n#endif\n`],
  ['adds new function, keeps matched one', `${HEADER}int TESForm::A() const { return a; }\nint TESForm::B() const { return b; }\n`, { before: `${HEADER}int TESForm::A() const { return a; }\n` }],
  ['whitespace-only reformat of matched body', `${HEADER}int TESForm::A() const\n{\n    return a;\n}\n`, { before: `${HEADER}int TESForm::A() const { return a; }\n` }],
  ['hex constants and masks', `${HEADER}std::uint32_t Mask(std::uint32_t f) { return (f & 0x00FF00FF) | 0x80000000; }\n`],
  ['digit separators', `${HEADER}constexpr std::uint32_t kBig = 0xFFFF'FFFF;\nconstexpr int kMil = 1'000'000;\n`],
  ['pinned 40-hex revision in a label comment', `${HEADER}// Foo: COMMUNITY(owner/repo@0123456789abcdef0123456789abcdef01234567, MIT)\nint F() { return 1; }\n`],
  ['virtual call through vtable member', `${HEADER}void Actor::Kill() { this->Unk_A0(nullptr, 0); }\n`],
  ['string literal containing tooling-like words', `${HEADER}const char* TESForm::Name() const { return "compare"; }\n`],
  // Real skyrim_decomp header shape: SPDX, labels and compared lines do not count against the budget.
  ['compact header with SPDX, labels and several compared lines', [
    '// Source exposure: mixed (community headers; the pinned image listing).',
    '// SPDX-License-Identifier: MIT (CommonLibSSE-NG declarations, Copyright (c) 2018 Ryan-rsm-McKenzie; full text: licenses/CommonLibSSE-NG.txt)',
    '// Code origin: original; the listing and community declarations only',
    '// 0x3cc6d0 TESActorBase::GetHasPLSpecTex', '// 0x3b03a0 TESActorBase::GetIsPlayerOwner', '// 0x3b03c0 TESActorBase::GetIsGhost',
    '// TESActorBase: COMMUNITY(CharmedBaryon/CommonLibSSE-NG@0d9f1c2, MIT)', '// GetIsGhost: GUESS(low)',
    '// Adapted bodies: none', '#include "TESActorBase.h"', 'bool TESActorBase::GetIsGhost() const { return flags & 1; }', ''].join('\n')],
];

const CHEATS: Array<[string, string, string, { before?: string; targets?: FunctionTarget[] }?]> = [
  ['inline asm', `${HEADER}int F() { __asm { nop } return 0; }\n`, 'CHEAT_INLINE_ASM'],
  ['naked function', `${HEADER}__declspec(naked) void F() {}\n`, 'CHEAT_INLINE_ASM'],
  ['__emit bytes', `${HEADER}void F() { __emit 0x90; }\n`, 'CHEAT_INLINE_ASM'],
  ['byte-typed decimal array', `${HEADER}static unsigned char k[] = {72, 139, 1, 255, 96, 8, 204, 204, 144};\n`, 'CHEAT_BYTE_ARRAY'],
  ['hex byte array untyped', `${HEADER}auto k = {0x48, 0x8b, 0x01, 0xff, 0x60, 0x08, 0xcc, 0xcc};\n`, 'CHEAT_BYTE_ARRAY'],
  ['std::uint8_t machine code', `${HEADER}const std::uint8_t code[10] = {0x48,0x89,0x5c,0x24,0x08,0x57,0x48,0x83,0xec,0x20};\n`, 'CHEAT_BYTE_ARRAY'],
  ['\\x string', `${HEADER}const char* k = "\\x48\\x8b";\n`, 'CHEAT_HEX_ESCAPE'],
  ['absolute address reinterpret_cast', `${HEADER}int F() { return reinterpret_cast<int(*)()>(0x1401de5e0)(); }\n`, 'CHEAT_ABS_ADDRESS'],
  ['absolute address C-style fnptr', `${HEADER}void F(void* p) { ((void(__fastcall*)(void*))0x1402AB000)(p); }\n`, 'CHEAT_ABS_ADDRESS'],
  ['absolute data address', `${HEADER}int G() { return *(int*)0x142F0E2B8; }\n`, 'CHEAT_ABS_ADDRESS'],
  ['pragma optimize', `${HEADER}#pragma optimize("", off)\nint F() { return 0; }\n`, 'CHEAT_PRAGMA'],
  ['pragma code_seg', `${HEADER}#pragma code_seg(".text$x")\n`, 'CHEAT_PRAGMA'],
  ['keyword macro', `${HEADER}#define private public\n`, 'CHEAT_MACRO_REDEFINE'],
  ['undef', `${HEADER}#undef assert\n`, 'CHEAT_MACRO_REDEFINE'],
  ['line directive', `${HEADER}#line 1 "fake.cpp"\n`, 'CHEAT_LINE_DIRECTIVE'],
  ['token paste', `${HEADER}#define CAT(a, b) a##b\n`, 'CHEAT_TOKEN_PASTE'],
  ['empty stub for large target', `${HEADER}void Actor::Update(float dt)\n{\n}\n`, 'CHEAT_STUB', { targets: [T('Actor::Update', 412)] }],
  ['return-0 stub for large target', `${HEADER}int Actor::GetLevel() const { return 0; }\n`, 'CHEAT_STUB', { targets: [T('Actor::GetLevel', 120)] }],
  ['matched body modified', `${HEADER}int TESForm::A() const { return a + 1; }\n`, 'CHEAT_MATCHED_BODY_MODIFIED', { before: `${HEADER}int TESForm::A() const { return a; }\n` }],
  ['matched body removed', `${HEADER}int TESForm::B() const { return b; }\n`, 'CHEAT_MATCHED_BODY_REMOVED', { before: `${HEADER}int TESForm::A() const { return a; }\n` }],
  ['verifier reference', `${HEADER}static const char* p = "tools/compare.py";\n`, 'CHEAT_VERIFIER_REFERENCE'],
  ['target hash reference', `${HEADER}extern const char* target_hashes;\n`, 'CHEAT_VERIFIER_REFERENCE'],
  ['decompiler identifiers', `${HEADER}undefined8 F(longlong param_1) { int iVar1 = 0; return iVar1; }\n`, 'LEAK_DECOMPILER_IDENT'],
  ['FUN_ name', `${HEADER}void FUN_1401de5e0();\n`, 'LEAK_DECOMPILER_IDENT'],
  ['disassembly in comment', `${HEADER}// 1401de5e0: mov eax, dword ptr [rcx+8]\n`, 'LEAK_ASM_MNEMONIC'],
  ['hex run', `${HEADER}// 48 8b 01 ff 60 08 cc cc 48 8b 01 ff 60 08 cc cc\n`, 'LEAK_HEX_RUN'],
  ['host path include', `${HEADER}#include "C:/Users/me/secret.h"\n`, 'LEAK_INCLUDE_OUTSIDE_ROOTS'],
  ['parent-escaping include', `${HEADER}#include "../../../tools/x.h"\n`, 'LEAK_INCLUDE_OUTSIDE_ROOTS'],
  ['non-allowlisted std include', `${HEADER}#include <fstream>\n`, 'LEAK_INCLUDE_OUTSIDE_ROOTS'],
  ['static_assert without message', `${HEADER}static_assert(sizeof(TESForm) == 0x20);\n`, 'CONV_STATIC_ASSERT_NO_MESSAGE'],
  ['licence text in header', `// Permission is hereby granted, free of charge, to any person\n// Code origin: original\n${HEADER}`, 'CONV_HEADER_LICENCE_TEXT'],
  ['origin placeholder', HEADER.replace('original; the listing and community declarations only', '<fill me>'), 'CONV_ORIGIN_PLACEHOLDER'],
  ['header too long', `${'// note\n'.repeat(8)}${HEADER}`, 'CONV_HEADER_TOO_LONG'],
  ['unfilled skeleton placeholder', HEADER.replace('// Adapted bodies: none', '// Adapted bodies: SKELETON_TODO_ORIGIN'), 'CONV_ORIGIN_PLACEHOLDER'],
];

describe('gate rules: false positives (legit code passes)', () => {
  for (const [name, src, opts] of LEGIT) {
    it(name, () => expect(blocks(src, opts)).toEqual([]));
  }
});

describe('gate rules: false negatives (cheats are caught)', () => {
  for (const [name, src, code, opts] of CHEATS) {
    it(`${name} → ${code}`, () => expect(blocks(src, opts)).toContain(code));
  }
  it('corpus summary', () => {
    const fp = LEGIT.filter(([, src, opts]) => blocks(src, opts).length > 0).length;
    const fn = CHEATS.filter(([, src, code, opts]) => !blocks(src, opts).includes(code)).length;
    expect({ falsePositives: fp, falseNegatives: fn, legit: LEGIT.length, cheats: CHEATS.length }).toEqual({ falsePositives: 0, falseNegatives: 0, legit: LEGIT.length, cheats: CHEATS.length });
  });
});

describe('scope', () => {
  const allowed = ['reconstruction/skyrim/forms/TESForm.h', 'reconstruction/skyrim/forms/TESForm.cpp'];
  it.each([
    ['tools/compare.py', 'SCOPE_PROTECTED_PATH'],
    ['builds/target.json', 'SCOPE_PROTECTED_PATH'],
    ['.github/workflows/check.yml', 'SCOPE_PROTECTED_PATH'],
    ['reconstruction/skyrim/Actor.cpp', 'SCOPE_OTHER_UNIT'],
    ['reconstruction/skyrim/forms/../../../tools/x.py', 'SCOPE_PATH_OUTSIDE_ALLOWLIST'],
    ['C:/Windows/system32/x', 'SCOPE_PATH_OUTSIDE_ALLOWLIST'],
    ['reconstruction\\skyrim\\forms\\TESForm.cpp', 'SCOPE_PATH_OUTSIDE_ALLOWLIST'],
    ['/etc/passwd', 'SCOPE_PATH_OUTSIDE_ALLOWLIST'],
  ])('%s → %s', (path, code) => {
    expect(checkScope([{ path, content: 'x' }], allowed).findings.map((f) => f.code)).toContain(code);
  });
  it('accepts allowlisted files and normalises CRLF', () => {
    const r = checkScope([{ path: allowed[1]!, content: 'int a;\r\nint b;\r\n' }], allowed);
    expect(r.findings).toEqual([]);
    expect(r.accepted[0]!.content).toBe('int a;\nint b;\n');
  });
  it('blocks oversize lines (byte dumps)', () => {
    expect(checkScope([{ path: allowed[1]!, content: 'x'.repeat(700) }], allowed).findings.map((f) => f.code)).toContain('SCOPE_LINE_TOO_LONG');
  });
});
