// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic synthetic repository content for the simulator, sized like the real skyrim_decomp
// context (docs ≈ 25k chars, a shared header with dozens of classes, listings proportional to the
// function size). It exists so token benchmarks compare legacy vs budgeted bundles on realistic
// volumes; none of it is real game or repository content.
import { createHash } from 'node:crypto';
import type { FunctionFeatures } from '@decomp/core';

export function hashUnit(s: string): number {
  return parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) / 0xffffffff;
}

/** Synthetic complexity features, deterministic per RVA and plausible for the size. */
export function simFeatures(rva: string, size: number): FunctionFeatures {
  const r = (salt: string) => hashUnit(`${rva}:${salt}`);
  const insns = Math.max(1, Math.round(size / (3.2 + r('i') * 1.2)));
  const condBranches = Math.max(0, Math.round((size / 38) * (0.4 + r('b') * 1.2)));
  const backEdges = size > 60 && r('l') < 0.18 ? 1 + Math.floor(r('l2') * 2) : 0;
  const sseOps = r('s') < 0.14 ? 2 + Math.floor(r('s2') * Math.min(18, size / 10)) : 0;
  const indirectCalls = r('v') < 0.28 ? 1 + Math.floor(r('v2') * 3) : 0;
  const indirectJumps = size > 90 && r('j') < 0.06 ? 1 : 0;
  const calls = Math.floor(r('c') * Math.min(8, size / 16));
  const unwindEntries = size > 120 && r('u') < 0.08 ? 2 + Math.floor(r('u2') * 2) : 1;
  return {
    source: 'synthetic', size, instructions: insns, basicBlocks: 1 + condBranches + backEdges, condBranches, backEdges, calls,
    indirectCalls, indirectJumps, sseOps, dataRefs: Math.floor(r('d') * 5), xrefsIn: Math.floor(r('x') * 12), unwindEntries,
    tailCall: r('t') < 0.2, priorFailures: 0, nameConfidence: r('n') < 0.1 ? 'guess' : 'named', cautions: r('k') < 0.1 ? 1 : 0,
  };
}

const RULE_VERBS = ['Keep', 'Never', 'Always', 'Prefer', 'Do not', 'Match', 'Declare', 'Use'];
const RULE_OBJECTS = [
  'the store order exactly as the target emits it', 'compiler intrinsics for rotates and byte swaps', 'a truthful Code origin line in the header',
  'field accesses through the declared struct, not raw offsets', 'callee declarations without bodies so the comparator binds them',
  'previously accepted function bodies byte-for-byte', 'labels on every name that is not a community name', 'static_assert messages on every layout check',
  'tail calls written as return Callee(...)', 'signed and unsigned comparisons the way the branch opcodes show', 'temporaries the compiler would keep in registers',
  'the declaration kit forms for vtables and RTTI', 'the header to six counted lines', 'includes by reconstruction-root path',
];

function sentence(seed: string, i: number): string {
  const v = RULE_VERBS[Math.floor(hashUnit(`${seed}v${i}`) * RULE_VERBS.length)]!;
  const o = RULE_OBJECTS[Math.floor(hashUnit(`${seed}o${i}`) * RULE_OBJECTS.length)]!;
  const tail = ['; the comparator checks this on every compare.', ' unless the cookbook shows a counter-example.', '; reviewers send PRs back for this.', '.'][i % 4]!;
  return `${v} ${o}${tail}`;
}

const COOKBOOK_SECTIONS: Array<[string, string]> = [
  ['Virtual calls and vtables', 'virtual call through the vtable slot; declare the method virtual in the class so the call goes through [rcx+slot]'],
  ['Floating point and SSE', 'float math uses xmm registers; keep float vs double exactly, use the same operand order for comiss and the same conversions'],
  ['Loops', 'loop shape: the compiler rotates while loops; a for loop with the condition at the bottom often matches better'],
  ['Switch tables', 'switch with dense cases compiles to a jump table; keep case order and the default branch position'],
  ['Destructors and exception handling', 'destructor funclets and unwind info come from objects with non-trivial destructors in scope; reproduce scope nesting'],
  ['Tail calls', 'a tail jump is return Callee(args) as the last statement; do not add work after it'],
  ['Globals and constants', 'global and constant references are rip-relative; declare the global extern with the right type'],
  ['Struct layout and offsets', 'struct layout must match offsets; add static_assert(offsetof(...)) with a message for every field you rely on'],
  ['Small accessors', 'accessors are usually one load and ret; do not add checks the target does not have'],
];

export function simDocs(): Array<{ id: string; title: string; source: string; content: string }> {
  const card = ['# Contributor card', '', ...Array.from({ length: 22 }, (_, i) => `- ${sentence('card', i)}`), '', 'Read the cookbook before your first PR. '.repeat(6)].join('\n');
  const lessons = ['# Contributor lessons', '', ...Array.from({ length: 9 }, (_, i) => `- ${sentence('lesson', i)}`)].join('\n');
  const cookbook = ['# Matching cookbook', ''];
  for (const [title, gist] of COOKBOOK_SECTIONS) {
    cookbook.push(`## ${title}`, '', `${gist[0]!.toUpperCase()}${gist.slice(1)}.`, '');
    for (let i = 0; i < 9; i++) cookbook.push(`- ${sentence(title, i)} In ${title.toLowerCase()}, ${gist}.`);
    cookbook.push('', 'Example walkthrough: '.concat('compare the candidate and target listings side by side, then change one statement at a time. '.repeat(5)), '');
  }
  const kit = ['# Declaration kit', '', ...Array.from({ length: 30 }, (_, i) => `- ${sentence('kit', i)} Use the kit form when you declare a class with a vtable.`)].join('\n');
  return [
    { id: 'contributor-card', title: 'docs/contributor-card.md', source: 'sim', content: card },
    { id: 'contributor-lessons', title: 'docs/contributor-lessons.md', source: 'sim', content: lessons },
    { id: 'matching-cookbook', title: 'docs/matching-cookbook.md', source: 'sim', content: cookbook.join('\n') },
    { id: 'declaration-kit', title: 'docs/declaration-kit.md', source: 'sim', content: kit },
  ];
}

/** A shared header declaring `n` classes (bases, fields with offsets, virtual and plain methods). */
export function simSharedHeader(n: number): string {
  const out = ['#pragma once', '// Source exposure: public (community headers).', '#include <cstdint>', '', 'namespace RE', '{'];
  out.push('    class BaseForm', '    {', '    public:', '        virtual ~BaseForm();', '        virtual std::uint32_t GetType() const;', '        std::uint32_t formID; // 08', '        std::uint32_t flags;  // 0C', '    };', '    static_assert(sizeof(BaseForm) == 0x10, "BaseForm size");', '');
  for (let c = 0; c < n; c++) {
    const base = c % 5 === 0 ? 'BaseForm' : `Class${c - (c % 5)}`;
    out.push(`    class Class${c} : public ${c % 5 === 0 ? 'BaseForm' : base}`, '    {', '    public:');
    for (let m = 0; m < 8; m++) out.push(`        ${m < 3 ? 'virtual ' : ''}std::int32_t Method${m}(${m % 2 ? 'std::int32_t a_value' : ''})${m < 3 ? ' override' : ''};`);
    for (let x = 0; x < 6; x++) out.push(`        std::uint32_t Helper${x}() const;`);
    for (let fld = 0; fld < 10; fld++) out.push(`        std::uint${fld % 3 ? 32 : 64}_t field${fld.toString(16).padStart(2, '0')}; // ${(0x10 + fld * 8).toString(16).toUpperCase()}`);
    out.push('    };', `    static_assert(sizeof(Class${c}) == 0x${(0x10 + 80).toString(16)}, "Class${c} size");`, '');
  }
  out.push('    extern std::uint32_t g_frameCounter;', '    enum class SimKind : std::uint8_t { kNone, kForm, kActor };', '}', '');
  return out.join('\n');
}

/** Listing text sized like the repo's byte listing (~68 chars per instruction) plus decompiler output. */
export function simPack(rva: string, size: number): { bytes: string; listing: string; decomp: string } {
  const insns = Math.max(1, Math.round(size / 4));
  const bytes = [`# SimFunction RVA ${rva} ${size} bytes; private, never paste or upload`];
  const listing: string[] = [];
  for (let i = 0; i < insns; i++) {
    const off = (i * 4).toString(16).padStart(3, '0');
    bytes.push(`  +0x${off}  48 8b 41 08 .. .. .. ..${' '.repeat(18)}${i % 7 === 3 ? ` -> 0x14${(i * 977).toString(16)} Callee${i}` : ''}`);
    listing.push(`  +0x${off}  ${['MOV RAX, qword ptr [RCX + 0x8]', 'TEST EAX, EAX', 'JZ 0x40', 'CALL 0x140123456', 'RET'][i % 5]}`);
  }
  const decomp = Array.from({ length: Math.max(3, Math.round(size / 6)) }, (_, i) => `  iVar${i} = *(int *)(param_1 + 0x${(i * 8).toString(16)});`).join('\n');
  return { bytes: bytes.join('\n'), listing: listing.join('\n'), decomp: `int FUN_${rva.slice(2)}(longlong param_1)\n{\n${decomp}\n}` };
}

// ---------------------------------------------------------------------------------------------
// Matching traps (Phase 3 simulator). A trap is a quirk of the original source that makes a
// function much harder to match until the worker is told the fix. Each trap leaves a signature in
// the listing (or the shape counts), which is what deterministic skill triggers key on. Two traps are
// documented in the synthetic cookbook (repo bootstrap finds them); the rest must be mined from
// retry wins. Effect sizes are simulator assumptions, not measurements of real models.
// ---------------------------------------------------------------------------------------------

export type SimTrapId = 'vslot-gap' | 'bit-test' | 'null-reload' | 'shared-constant' | 'switch-width';

export interface SimTrapInfo {
  id: SimTrapId;
  title: string;
  /** Lines the trap adds to the listing. */
  listing: string[];
  /** Regex (as a skill trigger would write it) that finds the trap's listing signature. */
  signature: string | null;
  /** The phrase guidance must contain for the trap to be fixed. */
  fix: RegExp;
  /** A rule that fixes it (what a good mined skill says). */
  fixText: string;
  documented: boolean;
}

export const SIM_TRAPS: Record<SimTrapId, SimTrapInfo> = {
  'vslot-gap': {
    id: 'vslot-gap', title: 'Missing virtual slots shift every virtual call', listing: ['CALL qword ptr [RAX + 0x210]'], signature: null,
    fix: /placeholder virtuals?|earlier virtuals/i, fixText: 'A call through slot N needs N - 1 earlier virtuals in the stand-in class, including inherited ones; add placeholder virtuals labelled GUESS until the slot offset matches.', documented: true,
  },
  'bit-test': {
    id: 'bit-test', title: 'A flag bit tested as shr + test al,1 is a by-value bit-index helper', listing: ['SHR EAX, 0x3', 'TEST AL, 0x1'], signature: String.raw`\bshr\s+eax\s*,\s*(?:0x)?[0-9a-f]+h?`,
    fix: /TestBit/, fixText: 'Read the flag word into a local and call an inline TestBit(flags, bit) helper that takes the word by value: ((flags >> bit) & 1) != 0. Masks and bit-fields fold into a memory test instead.', documented: true,
  },
  'null-reload': {
    id: 'null-reload', title: 'A null test after a dereference: re-read the member', listing: ['MOV RCX, qword ptr [RBX + 0x28]', 'TEST RCX, RCX', 'MOV RCX, qword ptr [RBX + 0x28]'], signature: String.raw`mov\s+rcx\s*,\s*qword ptr \[rbx \+ 0x28\]`,
    fix: /re-?read the member|reload the member/i, fixText: 'When the target tests a pointer it already dereferenced, re-read the member where the target tests it instead of keeping a local: a reload counts as a new value to MSVC.', documented: false,
  },
  'shared-constant': {
    id: 'shared-constant', title: 'One materialised -1 reused for compare and result: a value helper', listing: ['OR EAX, 0xffffffff'], signature: String.raw`\bor\s+eax\s*,\s*0xffffffff`,
    fix: /own helper|value-producing branch/i, fixText: 'Put the value-producing branch in its own helper (int32 mask = -1; if (...) mask = table[i]; return mask;) so MSVC materialises -1 once.', documented: false,
  },
  'switch-width': {
    id: 'switch-width', title: 'Switch register differences: change the width of the switch operand', listing: ['MOVZX EAX, byte ptr [RCX + 0x1a]', 'JMP qword ptr [RDX + RAX*0x8]'], signature: String.raw`jmp\s+qword ptr \[rdx \+ rax\*0x8\]`,
    fix: /width of the switch|switch operand width/i, fixText: 'Try switch (static_cast<std::uint32_t>(byteField)) and switching on the byte enum: the width of the switch operand changes register allocation and zero-extension.', documented: false,
  },
};

export function simTrap(rva: string, size: number): SimTrapInfo | null {
  const f = simFeatures(rva, size);
  const r = hashUnit(`${rva}:trap`);
  if ((f.indirectCalls ?? 0) > 0 && r < 0.8) return SIM_TRAPS['vslot-gap'];
  if ((f.indirectJumps ?? 0) > 0) return SIM_TRAPS['switch-width'];
  if (size > 20 && r > 0.92) return SIM_TRAPS['bit-test'];
  if (size > 12 && r > 0.84 && r <= 0.92) return SIM_TRAPS['null-reload'];
  if (size > 30 && r > 0.8 && r <= 0.84) return SIM_TRAPS['shared-constant'];
  return null;
}

/** Cookbook recipes for the documented traps, in the real cookbook's "**N. Title.** (high)" format. */
export function simTrapRecipes(): string {
  return [
    '## Data and calls',
    '',
    `**1. ${SIM_TRAPS['vslot-gap'].title}.** (high)`,
    `Symptom: the target calls through a virtual slot the candidate's stand-in class does not reach, so every virtual call lands on the wrong offset. Fix: ${SIM_TRAPS['vslot-gap'].fixText} Closed SimForm::Update 0x1a2b30.`,
    '',
    `**2. ${SIM_TRAPS['bit-test'].title}.** (high)`,
    `Symptom: the target reads a flag word, shifts it right by the bit number and tests the low byte (\`mov eax,[rcx+0x10]; shr eax,3; test al,1\`); the candidate has \`test byte ptr [mem],imm\`. Fix: ${SIM_TRAPS['bit-test'].fixText}`,
    '',
  ].join('\n');
}
