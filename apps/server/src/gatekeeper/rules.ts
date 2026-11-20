// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic Gate Keeper rules. Two families:
//
//  LEAK_*   — a TypeScript reimplementation of the target repository's own publication guard
//             (tools/leakgrep.py in awarebayes/skyrim_decomp: asm mnemonics, decompiler identifiers,
//             hex runs, asm directives, private paths, includes outside the allowed roots). Run on
//             added lines exactly like the repo's CI so we reject before the PR ever sees it. The
//             repo's own script is additionally executed on the real diff when Python is available.
//  CHEAT_*  — shortcut / test-gaming patterns: byte steering, binding by absolute address,
//             preprocessor tricks, stubs, edits to previously matched bodies, verifier tampering.
//  CONV_*   — repository conventions that would fail review (header length, licence text, ...).
//
// Code rules run on lexed source (comments and string contents blanked) to avoid false positives
// on prose. Each finding carries file + line so a Worker retry gets an exact, actionable trace.
import type { Finding, FunctionTarget } from '@decomp/core';
import { extractFunctions, lex, lineOf, normalise, topLevelArgs } from './cpp.js';

// ---------------------------------------------------------------- LEAK (mirror of leakgrep.py)

const STANDARD_HEADERS = new Set([
  'cstddef', 'cstdint', 'cstring', 'climits', 'cfloat', 'cmath', 'type_traits', 'utility', 'new', 'limits', 'memory',
  'typeinfo', 'atomic', 'algorithm', 'stddef.h', 'stdint.h', 'intrin.h',
]);
const MNEMONICS = ('mov movzx movsx movaps movups movss movsd lea push pop call jmp je jne jz jnz ja jae jb jbe jg jge ' +
  'jl jle cmp test xor and or add sub adc sbb imul mul idiv div inc dec shl shr sar sal rol ror neg not ' +
  'fld fstp fild fistp fadd fmul fsub fdiv fxch xchg cmov\\w+ set\\w+ rep\\s+movs\\w ret retn').split(' ');
const OPERAND = String.raw`(?:(?:byte|word|dword|qword)\s+ptr\b|\[|[re]?[abcd]x\b|e?[sd]i\b|e?[sb]p\b|[abcd][lh]\b|r\d{1,2}[dwb]?\b|xmm\d+|st\(\d\)|0x[0-9a-f]+\s*(?:,|$)|[0-9][0-9a-f]*h\b)`;

const LEAK_RULES: Array<[string, RegExp, string]> = [
  ['LEAK_ASM_MNEMONIC', new RegExp(String.raw`^\s*(?://|;|\*|#)?\s*(?:(?:0x)?[0-9a-f]{6,16}:?\s+)?(?:${MNEMONICS.join('|')})\s+${OPERAND}`, 'i'),
    'line looks like disassembly; listings must never be published'],
  ['LEAK_DECOMPILER_IDENT', new RegExp(String.raw`\b(?:FUN|DAT|LAB|PTR|SUB|SUB_|thunk_FUN)_[0-9a-fA-F]{4,}\b|\bundefined[1-8]\b|\bundefined\s*\*|\b(?:param|local|Stack)_[0-9a-fA-F]+\b|\b[iupcbl]Var\d+\b|\bin_[A-Z]{2,3}\b|\b(?:unaff|extraout)_\w+`),
    'decompiler-generated identifier; write original source with real names instead of copying pseudo-C'],
  ['LEAK_HEX_RUN', new RegExp(String.raw`(?<![0-9A-Za-z@])[0-9a-fA-F]{32,}(?![0-9A-Za-z])|(?<![0-9A-Za-z])(?:[0-9a-fA-F]{2}[ ,:-]){15}[0-9a-fA-F]{2}(?![0-9A-Za-z])|(?:0x[0-9a-fA-F]{1,2}\s*,\s*){7}0x[0-9a-fA-F]{1,2}\b|(?:\\x[0-9a-fA-F]{2}){8,}`),
    'long hex/byte run; binary bytes must never be published'],
  ['LEAK_ASM_DIRECTIVE', new RegExp(String.raw`\b(?:__emit|__asm__|__asm|_asm)\b|\basm\s*[({]|#\s*pragma\s+(?:code_seg|section|comment\s*\(\s*linker)|__declspec\s*\(\s*(?:naked|allocate)`),
    'inline assembly / section directive'],
  ['LEAK_PRIVATE_PATH', /\/Users\/|\/home\/\w|[A-Za-z]:[\\/]+Users[\\/]|\/private\/var\/|\/Volumes\//i, 'host path in source'],
];
const PINNED_REVISION = /(?<![0-9A-Za-z])[0-9a-f]{40}(?:[0-9a-f]{24})?(?![0-9A-Za-z])/g;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
const INCLUDE = /^\s*#\s*include\s*([<"])([^>"]*)[>"]/;

function includeProblem(line: string, path: string): boolean {
  const m = INCLUDE.exec(line);
  if (!m) return false;
  const [, kind, target] = m as unknown as [string, string, string];
  const parts = target.split('/');
  if (target.includes('\\') || target.includes(':') || target.startsWith('/') || !/^[A-Za-z0-9_./-]+$/.test(target)) return true;
  if (parts.includes('..') && kind === '"') {
    const dir = path.split('/').slice(0, -1);
    for (const p of parts) {
      if (p === '..') dir.pop();
      else if (p !== '.') dir.push(p);
    }
    const resolved = dir.join('/');
    return !resolved.startsWith('reconstruction/');
  }
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) return true;
  if (kind === '<') return !STANDARD_HEADERS.has(target) && !target.endsWith('.h');
  return !target.endsWith('.h');
}

/** Say which include was refused and what is allowed, so the retry does not try the same header again. */
function includeMessage(line: string): string {
  const m = INCLUDE.exec(line);
  const shown = m ? `${m[1] === '<' ? '<' : '"'}${m[2]}${m[1] === '<' ? '>' : '"'}` : line.trim();
  if (m?.[1] === '<') {
    return `#include ${shown} is not an allowed standard header (allowed: ${[...STANDARD_HEADERS].map((h) => `<${h}>`).join(' ')}); remove it and declare the function or type you need yourself (e.g. extern "C" int sprintf_s(char*, std::size_t, const char*, ...);)`;
  }
  return `#include ${shown} must be the unit's own header ("X.h"), a reconstruction-root path ("area/Y.h") or a relative path that stays inside reconstruction/`;
}

/** Lines present in `after` but not in `before` (multiset difference), with 1-based line numbers. */
export function addedLines(before: string | null, after: string): Array<{ line: number; text: string }> {
  const pool = new Map<string, number>();
  for (const l of (before ?? '').split('\n')) pool.set(l, (pool.get(l) ?? 0) + 1);
  const out: Array<{ line: number; text: string }> = [];
  after.split('\n').forEach((text, i) => {
    const c = pool.get(text) ?? 0;
    if (c > 0) pool.set(text, c - 1);
    else out.push({ line: i + 1, text });
  });
  return out;
}

export function leakScan(path: string, before: string | null, after: string): Finding[] {
  const findings: Finding[] = [];
  for (const { line, text } of addedLines(before, after)) {
    const scanned = COMMENT_LINE.test(text) ? text.replace(PINNED_REVISION, '') : text;
    for (const [code, rx, message] of LEAK_RULES) {
      if (rx.test(scanned)) findings.push({ stage: 'leak', code, severity: 'block', file: path, line, message });
    }
    if (includeProblem(text, path)) {
      findings.push({ stage: 'leak', code: 'LEAK_INCLUDE_OUTSIDE_ROOTS', severity: 'block', file: path, line, message: includeMessage(text) });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- CHEAT + CONV

const MACRO_KEYWORDS = new Set([
  'private', 'public', 'protected', 'class', 'struct', 'return', 'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'const',
  'volatile', 'static', 'inline', 'virtual', 'this', 'true', 'false', 'nullptr', 'void', 'int', 'char', 'bool', 'float',
  'double', 'unsigned', 'signed', 'long', 'short', 'auto', 'sizeof', 'new', 'delete', 'operator', 'template', 'typename',
  'goto', 'break', 'continue', 'static_assert', 'noexcept', 'override', 'final', 'explicit', 'friend', 'using', 'namespace',
  '__forceinline', '__declspec', 'assert',
]);
const VERIFIER_REFS = /\b(?:contrib\.py|compare(?:_internal|_runtime)?\.py|leakgrep|target[_-]?hash(?:es)?|ci_hash_check|builds\/target\.json|recipe_sha256|verify_function|\.local[\\/])/i;
// Header budget: a faithful port of lint_reconstruction.header_budget_problems in the target repo.
const HEADER_LIMIT = 6;
const FULL_LICENCE = /Permission is hereby granted|THE SOFTWARE IS PROVIDED|^\/\/[ \t]*MIT License[ \t]*$|GNU GENERAL PUBLIC LICENSE|Apache License/m;
const LABEL_WORD = /(?<![A-Za-z0-9_])(?:COMMUNITY|SIBLING|GUESS|EXE_RTTI|STANDIN|OBSERVED)[A-Za-z0-9_]*/;
const COMPARED_LINE = /^\/\/[ \t]*0x[0-9a-fA-F]+(?:[ \t]|$)/;
export const TRIVIAL_BODIES = new Set(['', 'return;', 'return 0;', 'return false;', 'return true;', 'return nullptr;', 'return {};', 'return NULL;', 'return 0u;', 'return 0.0f;', 'return 0.0;']);
/** x64 MSVC: `xor eax,eax; ret` is 3 bytes; anything this large cannot be a trivial return. */
const STUB_MIN_TARGET_BYTES = 24;

export interface CheatContext {
  path: string;
  before: string | null; // content at the base revision (previously accepted source)
  after: string;
  targets: FunctionTarget[];
}

function push(f: Finding[], code: string, severity: Finding['severity'], file: string, line: number | undefined, message: string) {
  f.push({ stage: 'cheat', code, severity, file, ...(line ? { line } : {}), message });
}

export function cheatScan(ctx: CheatContext): Finding[] {
  const f: Finding[] = [];
  const { path, after } = ctx;
  const lx = lex(after);
  const code = lx.code;
  const codeLines = code.split('\n');

  // --- preprocessor tricks (on lexed code, so commented-out directives are ignored)
  codeLines.forEach((l, i) => {
    const line = i + 1;
    const pp = /^\s*#\s*(\w+)\s*(.*)$/.exec(l);
    if (!pp) {
      if (/##/.test(l)) push(f, 'CHEAT_TOKEN_PASTE', 'block', path, line, 'token pasting (##) is not allowed in reconstructions');
      return;
    }
    const [, dir, rest] = pp as unknown as [string, string, string];
    if (dir === 'pragma' && !/^once\s*$/.test(rest.trim())) push(f, 'CHEAT_PRAGMA', 'block', path, line, `#pragma ${rest.trim().split(/\s|\(/)[0]} is not allowed (only #pragma once); it steers codegen instead of expressing source`);
    if (dir === 'line') push(f, 'CHEAT_LINE_DIRECTIVE', 'block', path, line, '#line directives are not allowed');
    if (dir === 'undef') push(f, 'CHEAT_MACRO_REDEFINE', 'block', path, line, '#undef is not allowed');
    if (dir === 'define') {
      const name = /^([A-Za-z_]\w*)/.exec(rest)?.[1] ?? '';
      if (MACRO_KEYWORDS.has(name)) push(f, 'CHEAT_MACRO_REDEFINE', 'block', path, line, `macro redefines the keyword/identifier "${name}"`);
      else push(f, 'CHEAT_DEFINE', 'warn', path, line, `macro "${name}" — prefer constexpr/inline functions; macros are unusual in reconstructions`);
      if (rest.includes('##')) push(f, 'CHEAT_TOKEN_PASTE', 'block', path, line, 'token pasting (##) is not allowed');
    }
    if ((dir === 'if' || dir === 'ifdef' || dir === 'ifndef') && !/_H_?$|_INCLUDED$/.test(rest.trim())) {
      push(f, 'CHEAT_CONDITIONAL_COMPILATION', 'warn', path, line, 'conditional compilation can hide code from review');
    }
  });

  // --- inline asm / naked functions / intrinsic byte emission
  const asm = /\b(?:__asm__|__asm|_asm|__emit)\b|\basm\s*[({]|__declspec\s*\(\s*naked\s*\)/g;
  for (let m; (m = asm.exec(code)); ) push(f, 'CHEAT_INLINE_ASM', 'block', path, lineOf(code, m.index), 'inline assembly / naked function: write C++ the compiler turns into the target bytes');

  // --- byte arrays (initialiser lists of >= 8 byte-sized integer literals)
  const init = /\{([^{}]*)\}/g;
  for (let m; (m = init.exec(code)); ) {
    const elems = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    if (elems.length < 8) continue;
    const ints = elems.filter((e) => /^(?:0x[0-9a-fA-F]{1,2}|\d{1,3})[uU]?$/.test(e));
    const hex = elems.filter((e) => /^0x[0-9a-fA-F]{1,2}$/.test(e));
    const before = code.slice(Math.max(0, m.index - 120), m.index);
    const byteTyped = /\b(?:unsigned\s+char|signed\s+char|char|std::uint8_t|uint8_t|std::byte|BYTE|std::int8_t|int8_t)\b[^;{}]*$/.test(before);
    if ((byteTyped && ints.length >= 8) || hex.length >= 8) {
      push(f, 'CHEAT_BYTE_ARRAY', 'block', path, lineOf(code, m.index), `byte array with ${ints.length} byte literals; machine code or data bytes must not be embedded`);
    }
  }

  // --- \x escapes in string literals (bytes smuggled through strings)
  for (const s of lx.strings) {
    if (/\\x[0-9a-fA-F]{2}/.test(s.raw)) push(f, 'CHEAT_HEX_ESCAPE', 'block', path, s.line, '\\x escape in a string literal; strings must not carry raw bytes');
  }

  // --- binding by absolute address instead of declaring the callee
  const absCast = [
    /reinterpret_cast\s*<[^>]*\*[^>]*>\s*\(\s*(0x[0-9a-fA-F]{6,}|\d{7,})\s*[uUlL]*\s*\)/g,
    /\(\s*[A-Za-z_][\w:<>\s]*(?:\(\s*(?:__\w+\s*)?\*\s*\)\s*\([^()]*\)|\*+)\s*\)\s*\(?\s*(0x[0-9a-fA-F]{6,})/g,
  ];
  for (const rx of absCast) {
    for (let m; (m = rx.exec(code)); ) {
      push(f, 'CHEAT_ABS_ADDRESS', 'block', path, lineOf(code, m.index), `casts the absolute address ${m[1]} to a pointer; declare the callee/data and let compare bind it`);
    }
  }

  // --- verifier tampering / referencing comparator inputs (code and string literals)
  const verifierHay = [code, ...lx.strings.map((s) => s.raw)].join('\n');
  const vm = VERIFIER_REFS.exec(verifierHay);
  if (vm) push(f, 'CHEAT_VERIFIER_REFERENCE', 'block', path, undefined, `references verifier inputs/tooling ("${vm[0]}") from source`);
  for (const [rx, what] of [[/\b__(?:DATE|TIME|TIMESTAMP|COUNTER)__\b/, 'non-deterministic macro'], [/\b__debugbreak\s*\(|\b__assume\s*\(\s*0\s*\)/, 'trap/assume intrinsic']] as const) {
    const m = rx.exec(code);
    if (m) push(f, 'CHEAT_SUSPICIOUS_INTRINSIC', 'warn', path, lineOf(code, m.index), `${what} "${m[0]}"`);
  }

  // --- static_assert without message (repository rule)
  const sa = /\bstatic_assert\s*\(/g;
  for (let m; (m = sa.exec(code)); ) {
    const args = topLevelArgs(code.slice(m.index + m[0].length));
    if (args && args.length < 2) push(f, 'CONV_STATIC_ASSERT_NO_MESSAGE', 'block', path, lineOf(code, m.index), 'static_assert needs a message');
  }

  // --- function bodies: stubs vs. target sizes; previously matched bodies must not change
  const defs = extractFunctions(code);
  const byBase = new Map<string, FunctionTarget>();
  for (const t of ctx.targets) if (t.name) byBase.set(t.name, t);
  for (const d of defs) {
    const target = byBase.get(d.name) ?? [...byBase.entries()].find(([n]) => n.endsWith(`::${d.name}`) || d.name.endsWith(`::${n}`))?.[1];
    if (target && target.size >= STUB_MIN_TARGET_BYTES && TRIVIAL_BODIES.has(d.body)) {
      push(f, 'CHEAT_STUB', 'block', path, d.line, `${d.name} has a trivial body ("${d.body || 'empty'}") but the target is ${target.size} bytes; reconstruct the logic`);
    }
  }
  if (ctx.before) {
    const prev = extractFunctions(lex(ctx.before).code);
    const now = new Map(defs.map((d) => [d.name, d]));
    for (const p of prev) {
      if (!p.body) continue;
      const cur = now.get(p.name);
      if (!cur) push(f, 'CHEAT_MATCHED_BODY_REMOVED', 'block', path, p.line, `previously accepted function ${p.name} was removed; add new functions alongside matched ones`);
      else if (normalise(cur.body) !== normalise(p.body)) push(f, 'CHEAT_MATCHED_BODY_MODIFIED', 'block', path, cur.line, `previously accepted function ${p.name} was modified; never change matched bodies`);
    }
  }

  // --- header block conventions (new or changed headers only, as the repo's header_check does)
  const header = leadingComment(after);
  const prevHeader = ctx.before ? leadingComment(ctx.before) : null;
  if (header.trim() && prevHeader !== header) {
    if (FULL_LICENCE.test(header)) push(f, 'CONV_HEADER_LICENCE_TEXT', 'block', path, 1, 'remove the licence text from the header; use the one-line SPDX notice');
    const counted = countedHeaderLines(header);
    const shrinks = prevHeader !== null && counted.every((l) => countedHeaderLines(prevHeader).includes(l));
    if (counted.length > HEADER_LIMIT && !shrinks) {
      push(f, 'CONV_HEADER_TOO_LONG', 'block', path, 1, `header has ${counted.length} lines besides labels, sources, compared functions and SPDX; keep at most ${HEADER_LIMIT} (drop Task, Labels, Recipe, Evidence, Drafted by, disclaimers, wrapped skeleton guidance)`);
    }
    const origin = header.split('\n').find((l) => /^\/\/\s*Code origin:/.test(l));
    if (origin && (/<[^>]*>|TODO|\?\?\?/.test(origin) || /Code origin:\s*$/.test(origin))) {
      push(f, 'CONV_ORIGIN_PLACEHOLDER', 'block', path, 1, 'fill the "Code origin:" header line truthfully');
    }
  }
  const placeholder = /\bSKELETON_TODO\w*/.exec(after);
  if (placeholder && !f.some((x) => x.code === 'CONV_ORIGIN_PLACEHOLDER')) {
    push(f, 'CONV_ORIGIN_PLACEHOLDER', 'block', path, lineOf(after, placeholder.index), `replace the skeleton placeholder ${placeholder[0]}`);
  }
  return f;
}

/** The comment block at the top of the file (repo: lint_reconstruction.leading_comment). */
function leadingComment(src: string): string {
  const lines: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('//') || s.startsWith('/*') || s.startsWith('*') || !s) lines.push(s);
    else break;
  }
  return lines.join('\n');
}

/** Lines counting against the budget (repo: lint_reconstruction.counted_header_lines). */
function countedHeaderLines(header: string): string[] {
  return header.split('\n').filter((ln) => ln.trim() && ln.trim() !== '//' && !LABEL_WORD.test(ln) && !ln.includes('Sibling source:') && !COMPARED_LINE.test(ln.trim()) && !ln.includes('SPDX-License-Identifier'));
}

// ---------------------------------------------------------------- classification

/** Codes that indicate an attempt to game verification (count toward quarantine). */
export const STRIKE_CODES = new Set([
  'SCOPE_PATH_OUTSIDE_ALLOWLIST', 'SCOPE_PROTECTED_PATH', 'SCOPE_OTHER_UNIT',
  'LEAK_ASM_MNEMONIC', 'LEAK_DECOMPILER_IDENT', 'LEAK_HEX_RUN', 'LEAK_ASM_DIRECTIVE',
  'CHEAT_INLINE_ASM', 'CHEAT_BYTE_ARRAY', 'CHEAT_HEX_ESCAPE', 'CHEAT_ABS_ADDRESS', 'CHEAT_PRAGMA', 'CHEAT_TOKEN_PASTE',
  'CHEAT_MACRO_REDEFINE', 'CHEAT_LINE_DIRECTIVE', 'CHEAT_MATCHED_BODY_MODIFIED', 'CHEAT_MATCHED_BODY_REMOVED', 'CHEAT_STUB',
  'CHEAT_VERIFIER_REFERENCE', 'INTEGRITY_HOST_TAMPER', 'INTEGRITY_UNEXPECTED_CHANGE',
]);
