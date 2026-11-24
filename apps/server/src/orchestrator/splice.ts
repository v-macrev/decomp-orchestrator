// SPDX-License-Identifier: AGPL-3.0-or-later
// Rebuild a unit on upstream: a unit set aside because upstream matched (or stopped publishing) some
// of its functions still holds functions nobody else has. A pull request sends whole files, so those
// can only go upstream inside upstream's current file. This splices the packet's accepted
// definitions (and what they need: includes, header lines, declarations, labels) into that file.
// Deterministic and free; the Gate Keeper then compiles and compares the result like any candidate,
// and a packet the splice does not get through goes on to the AI workers from the spliced file.
import type { FunctionTarget } from '@decomp/core';
import { extractFunctions, lex, normalise } from '../gatekeeper/cpp.js';

const bare = (name: string) => name.split('::').pop()!;
const owner = (name: string) => name.split('::').slice(-2, -1)[0] ?? null;
const rvaRe = (rva: string) => new RegExp(`\\b0x0*${parseInt(rva, 16).toString(16)}\\b`, 'i');
const LABEL = /^\s*\/\/\s*([^:]+):\s*((?:COMMUNITY|GUESS|PUBLIC|ORIGINAL|DOC)\b.*)$/;

function defsOf(src: string) {
  return extractFunctions(lex(src).code);
}

function findDef(src: string, fn: FunctionTarget) {
  const name = fn.name ?? '';
  const o = owner(name);
  return defsOf(src).find((d) => d.name === name || (bare(d.name) === bare(name) && (!owner(d.name) || !o || owner(d.name) === o)));
}

/** Insert `lines` after the last line matching `after` (or before the first matching `before`, or at the top). */
function insertLines(src: string, lines: string[], after: RegExp, before?: RegExp): string {
  if (!lines.length) return src;
  const rows = src.split('\n');
  let at = -1;
  rows.forEach((r, i) => {
    if (after.test(r)) at = i;
  });
  if (at < 0 && before) {
    const b = rows.findIndex((r) => before.test(r));
    if (b >= 0) at = b - 1;
  }
  rows.splice(at + 1, 0, ...lines);
  return rows.join('\n');
}

export interface Chunk {
  start: number;
  end: number;
  text: string;
  /** What it declares; empty for a member definition (`A::B(...) {...}`). */
  names: string[];
  /** One line, no body: a declaration. */
  single: boolean;
}

const KEYWORDS = /^(?:const|constexpr|static|extern|inline|volatile|unsigned|signed|class|struct|union|enum|typename|return|if|else|for|while|using|typedef|namespace|template|public|private|protected|virtual|this|void|bool|char|short|int|long|float|double|auto)$/;
const idents = (code: string) => (code.match(/[A-Za-z_]\w*/g) ?? []).filter((w) => !KEYWORDS.test(w));

/** What one file-scope statement declares. */
function declared(code: string): string[] {
  const t = code.replace(/^\s*(?:template\s*<[^{};]*?>\s*)?/, '').trim();
  const ns = /^(?:inline\s+)?namespace\b[^{]*\{([\s\S]*)\}\s*$/.exec(t);
  if (ns) return chunksOf(ns[1]!).flatMap((c) => c.names);
  const type = /^(?:typedef\s+)?(?:class|struct|union|enum(?:\s+class|\s+struct)?)\s+(?:alignas\s*\([^)]*\)\s*|__declspec\s*\([^)]*\)\s*)*([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^;{]*)?[{;]/.exec(t);
  if (type) return [type[1]!];
  const using = /^using\s+([A-Za-z_]\w*)\s*=/.exec(t);
  if (using) return [using[1]!];
  if (/^(?:using|friend|static_assert)\b/.test(t)) return [];
  const head = t.split(/[{;=]/)[0]!;
  const call = /([A-Za-z_~][\w:~]*)\s*\(/.exec(head.replace(/__declspec\s*\([^)]*\)/g, ''));
  if (call) return call[1]!.includes('::') ? [] : [call[1]!];
  const v = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*$/.exec(head.trim());
  return v && !KEYWORDS.test(v[1]!) && !new RegExp(`::\\s*${v[1]}\\s*(?:\\[|$)`).test(head.trim()) ? [v[1]!] : [];
}

/** The file-scope statements of a source: types, declarations, variables, definitions. Preprocessor lines are not statements. */
export function chunksOf(src: string): Chunk[] {
  const code = lex(src).code.replace(/^[ \t]*#.*$/gm, (l) => ' '.repeat(l.length));
  const out: Chunk[] = [];
  let depth = 0;
  let start = -1;
  const close = (end: number) => {
    const text = src.slice(start, end);
    const body = code.slice(start, end);
    out.push({ start, end, text, names: declared(body), single: !text.includes('\n') && !/[{}]/.test(body) });
    start = -1;
  };
  for (let k = 0; k < code.length; k++) {
    const ch = code[k]!;
    if (start < 0) {
      if (/\s/.test(ch) || ch === ';') continue;
      start = k;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth > 0) continue;
      depth = 0;
      // A body ends its statement; a type or an initialiser runs on to its `;`.
      const head = code.slice(start, code.indexOf('{', start));
      if (/^\s*(?:template\s*<[^{}]*>\s*)?(?:typedef\s+)?(?:class|struct|union|enum)\b[^()]*$/.test(head) || /=\s*$/.test(head)) continue;
      close(k + 1);
    } else if (ch === ';' && depth === 0) close(k + 1);
  }
  return out;
}

/** Class `cls` of a header: its base list and its data members (null: a shape this does not read). */
function classOf(header: string, cls: string): { bases: string; members: Array<{ text: string; names: string[] }> | null } | null {
  const code = lex(header).code;
  const m = new RegExp(`\\b(?:class|struct)\\s+${cls}\\b([^;{]*)\\{`).exec(code);
  if (!m) return null;
  let k = m.index + m[0].length;
  let depth = 1;
  let start = k;
  let simple = true;
  const members: Array<{ text: string; names: string[] }> = [];
  for (; k < code.length && depth > 0; k++) {
    const ch = code[k];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      // An inline method ends here; a nested type or an initialiser runs on to its `;`.
      if (depth === 1 && code.slice(start, k).split('{')[0]!.includes('(')) start = k + 1;
    } else if (ch === ';' && depth === 1) {
      const stmt = code.slice(start, k).replace(/\b(?:public|protected|private)\s*:(?!:)/g, (x) => ' '.repeat(x.length));
      const from = start + (stmt.length - stmt.trimStart().length);
      const t = stmt.trim();
      start = k + 1;
      if (!t || /^(?:using|typedef|friend|static|static_assert|enum)\b/.test(t) || /^(?:class|struct|union)\s+\w+\s*(?:\{[\s\S]*\})?$/.test(t)) continue;
      if (/[{}]/.test(t)) {
        simple = false;
        continue;
      }
      if (t.includes('(')) {
        if (/\(\s*(?:\w+::)*\*/.test(t)) simple = false; // a function pointer member, or a method taking one
        continue;
      }
      const names = t.split('=')[0]!.split(',').map((x) => /([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?::\s*\d+\s*)?$/.exec(x.trim())?.[1]).filter((x): x is string => !!x);
      members.push({ text: `${header.slice(from, k).replace(/\s+/g, ' ').trim()};`, names });
    }
  }
  return { bases: m[1]!.replace(/\s+/g, ' ').trim(), members: simple ? members : null };
}

/** The declaration of `name` in `header` as one statement ("int Foo();"), or null. */
function declarationOf(header: string, name: string): string | null {
  const code = lex(header).code;
  const m = new RegExp(`\\b${name.replace(/[^\w~]/g, '\\$&')}\\s*\\(`).exec(code);
  if (!m) return null;
  // The statement runs from after the previous ; { } or access specifier to the next ;
  let s = m.index;
  while (s > 0 && !/[;{}]/.test(code[s - 1]!)) s--;
  let e = code.indexOf(';', m.index);
  if (e < 0) return null;
  const stmt = header.slice(s, e + 1).replace(/^\s*(?:public|protected|private)\s*:\s*/, '').replace(/\s+/g, ' ').trim();
  return stmt.includes('{') ? null : stmt;
}

/** Add `decl` at the end of class `cls` in `header` (public), or return null when the class is not there. */
function addToClass(header: string, cls: string, decl: string): string | null {
  const code = lex(header).code;
  const m = new RegExp(`\\b(class|struct)\\s+${cls}\\b[^;{]*\\{`).exec(code);
  if (!m) return null;
  let depth = 1;
  let k = m.index + m[0].length;
  while (k < code.length && depth > 0) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}') depth--;
    k++;
  }
  const close = k - 1;
  const lineStart = header.lastIndexOf('\n', close) + 1;
  const onOwnLine = header.slice(lineStart, close).trim() === '';
  const last = [...code.slice(m.index + m[0].length, close).matchAll(/\b(public|protected|private)\s*:(?!:)/g)].at(-1)?.[1];
  const access = (last ?? (m[1] === 'class' ? 'private' : 'public')) === 'public' ? '' : 'public: ';
  return onOwnLine
    ? `${header.slice(0, lineStart)}${access ? 'public:\n' : ''}    ${decl}\n${header.slice(lineStart)}`
    : `${header.slice(0, close)} ${access}${decl} ${header.slice(close)}`;
}

const flat = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** A definition `extractFunctions` does not see: one with a constructor initialiser list, or a flattened name. */
function looseDef(src: string, fn: FunctionTarget): { start: number; close: number } | null {
  const name = fn.name;
  if (!name) return null;
  const code = lex(src).code;
  const same = defsOf(src).find((d) => flat(d.name) === flat(name));
  if (same) return same;
  const o = owner(name);
  if (!o) return null;
  const esc = (s: string) => s.replace(/[^\w]/g, '\\$&');
  const m = new RegExp(`\\b${esc(o)}\\s*::\\s*${esc(bare(name))}\\s*\\([^;{}]*\\{`).exec(code);
  if (!m) return null;
  let depth = 1;
  let k = m.index + m[0].length;
  while (k < code.length && depth > 0) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}') depth--;
    k++;
  }
  return { start: code.lastIndexOf('\n', m.index) + 1, close: k - 1 };
}

/** Whether `src` still defines any of these functions (then they cannot be taken out of it cleanly). */
export function stillDefines(src: string, fns: FunctionTarget[]): boolean {
  return fns.some((fn) => findDef(src, fn) ?? looseDef(src, fn));
}

/** A unit file without these functions: their definitions, the comment lines right above them, and their `// 0x<rva>` lines. */
export function removeFunctions(src: string, drop: FunctionTarget[]): string {
  for (const fn of drop) {
    const d = findDef(src, fn) ?? looseDef(src, fn);
    if (d) {
      let start = d.start;
      while (start > 0) {
        const prev = src.lastIndexOf('\n', start - 2) + 1;
        if (!/^\s*\/\//.test(src.slice(prev, start))) break;
        start = prev;
      }
      // A block that reaches the top is the file's header, not the function's comment.
      if (start === 0) start = d.start;
      src = `${src.slice(0, start)}${src.slice(d.close + 1).replace(/^\r?\n/, '')}`;
    }
    const line = new RegExp(`^\\s*//\\s*${rvaRe(fn.rva).source}`, 'i');
    src = src.split('\n').filter((l) => !line.test(l)).join('\n');
  }
  return src;
}

export interface SpliceResult {
  files: Array<{ path: string; content: string }>;
  /** What was carried over, per function, for the event log. */
  notes: string[];
}

/**
 * Splice `keep` (the packet's functions nobody else has) from our accepted unit files into
 * upstream's. `drop` (matched upstream or no longer published) is never carried over.
 */
export function spliceUnit(input: {
  cpp: string;
  ours: Map<string, string>;
  upstream: Map<string, string | null>;
  keep: FunctionTarget[];
  drop: FunctionTarget[];
}): SpliceResult {
  const { cpp, ours, upstream, keep, drop } = input;
  const h = cpp.replace(/\.cpp$/, '.h');
  const notes: string[] = [];
  const out: Array<{ path: string; content: string }> = [];
  const oursCpp = ours.get(cpp) ?? '';
  const oursH = ours.get(h) ?? null;
  let upCpp = upstream.get(cpp) ?? null;
  const upH = upstream.get(h) ?? null;

  if (upCpp === null) {
    // Upstream has no such unit: ours is the unit, minus what is dropped.
    let src = oursCpp;
    for (const fn of drop) {
      const d = findDef(src, fn);
      if (d) src = `${src.slice(0, d.start)}${src.slice(d.close + 1).replace(/^\r?\n/, '')}`;
      src = src.split('\n').filter((l) => !(l.trim().startsWith('//') && rvaRe(fn.rva).test(l))).join('\n');
    }
    out.push({ path: cpp, content: src });
    if (oursH !== null) out.push({ path: h, content: oursH });
    notes.push(`${cpp}: upstream has no such unit; kept ours without ${drop.length} dropped function(s)`);
    return { files: out, notes };
  }

  // .cpp: includes, header lines, file-scope declarations, then the definitions.
  const upIncludes = new Set(upCpp.split('\n').filter((l) => /^\s*#\s*include/.test(l)).map((l) => normalise(l)));
  const includes = oursCpp.split('\n').filter((l) => /^\s*#\s*include/.test(l) && !upIncludes.has(normalise(l)));
  upCpp = insertLines(upCpp, includes, /^\s*#\s*include/);
  const rvaLines: string[] = [];
  for (const fn of keep) {
    if (rvaRe(fn.rva).test(upCpp.split('\n').filter((l) => l.trim().startsWith('//')).join('\n'))) continue;
    rvaLines.push(oursCpp.split('\n').find((l) => l.trim().startsWith('//') && rvaRe(fn.rva).test(l)) ?? `// ${fn.rva} ${fn.name ?? ''}`.trimEnd());
  }
  upCpp = insertLines(upCpp, rvaLines, /^\s*\/\/\s*0x[0-9a-f]+\s/i, /^\s*#\s*include/);
  const bodies: string[] = [];
  for (const fn of keep) {
    if (findDef(upCpp, fn)) {
      notes.push(`${fn.rva} ${fn.name}: upstream already defines it; kept upstream's`);
      continue;
    }
    const d = findDef(oursCpp, fn);
    if (!d) {
      notes.push(`${fn.rva} ${fn.name}: not in our accepted file`);
      continue;
    }
    bodies.push(oursCpp.slice(d.start, d.close + 1));
    notes.push(`${fn.rva} ${fn.name}: definition carried over`);
  }
  // What those definitions use: helper types, declarations and variables of our files that upstream's
  // do not declare, and our data members where upstream's class has none yet (two layouts are never
  // merged: such a packet does not compile, and goes on to the workers).
  const need = new Set(bodies.flatMap((b) => idents(lex(b).code)));
  const carriedMembers = new Map<string, string[]>();
  const carriedNames = new Set<string>();
  const owners = new Set(keep.map((fn) => owner(fn.name ?? '')).filter((x): x is string => !!x));
  if (upH !== null && oursH !== null && bodies.length) {
    for (const cls of owners) {
      const mine = classOf(oursH, cls);
      const theirs = classOf(upH, cls);
      if (!mine?.members?.length || !theirs?.members || theirs.members.length || mine.bases !== theirs.bases) continue;
      if (!mine.members.some((m) => m.names.some((n) => need.has(n)))) continue;
      carriedMembers.set(cls, mine.members.map((m) => m.text));
      for (const m of mine.members) {
        m.names.forEach((n) => carriedNames.add(n));
        idents(m.text).forEach((w) => need.add(w));
      }
      notes.push(`${cls}: ${mine.members.length} data member(s) carried over`);
    }
  }
  const theirNames = new Set([...chunksOf(upCpp), ...(upH === null ? [] : chunksOf(upH))].flatMap((c) => c.names));
  const have = new Set(upCpp.split('\n').map(normalise));
  const pool = (src: string | null) => (src === null ? [] : chunksOf(src).filter((c) => c.names.length && !c.names.some((n) => theirNames.has(n) || owners.has(n))));
  const cppPool = pool(oursCpp);
  const hPool = pool(upH === null ? null : oursH);
  const taken = new Set<Chunk>(cppPool.filter((c) => c.single && /^(extern|using|class|struct|enum|typedef|static|constexpr|inline)\b/.test(c.text) && !have.has(normalise(c.text))));
  for (const c of taken) idents(lex(c.text).code).forEach((w) => need.add(w));
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of [...hPool, ...cppPool]) {
      if (taken.has(c) || !c.names.some((n) => need.has(n))) continue;
      taken.add(c);
      idents(lex(c.text).code).forEach((w) => need.add(w));
      grew = true;
    }
  }
  const decls = cppPool.filter((c) => taken.has(c)).map((c) => c.text);
  const headerDecls = hPool.filter((c) => taken.has(c));
  headerDecls.forEach((c) => c.names.forEach((n) => carriedNames.add(n)));
  if (decls.length || headerDecls.length) notes.push(`carried over with them: ${[...hPool, ...cppPool].filter((c) => taken.has(c)).flatMap((c) => c.names).join(', ')}`);
  const tail = [...(decls.length ? ['', ...decls] : []), ...bodies.flatMap((b) => ['', b])];
  out.push({ path: cpp, content: `${upCpp.replace(/\s*$/, '')}\n${tail.join('\n')}\n` });

  // .h: a declaration and a label for each carried function the header does not name yet.
  if (upH !== null && oursH !== null) {
    let header: string = upH;
    const oursHeader: string = oursH;
    for (const fn of keep) {
      if (!fn.name) continue;
      const b = bare(fn.name);
      if (new RegExp(`\\b${b.replace(/[^\w~]/g, '\\$&')}\\s*\\(`).test(lex(header).code)) continue;
      const decl = declarationOf(oursHeader, b);
      const cls = owner(fn.name);
      const next = decl && cls ? addToClass(header, cls, decl) : null;
      if (!next) {
        notes.push(`${fn.rva} ${fn.name}: could not place its declaration in ${h}`);
        continue;
      }
      header = next;
      const label = oursHeader.split('\n').map((l) => LABEL.exec(l)).find((m) => m && m[1]!.split(',').map((s) => s.trim()).includes(b));
      if (label && !header.split('\n').some((l) => LABEL.exec(l)?.[1]!.split(',').map((s) => s.trim()).includes(b))) {
        header = insertLines(header, [`// ${b}: ${label[2]!.trim()}`], LABEL, new RegExp(`\\b(class|struct)\\s+${cls}\\b`));
      }
    }
    for (const [cls, members] of carriedMembers) {
      for (const m of members) header = addToClass(header, cls, m) ?? header;
    }
    if (headerDecls.length) {
      const before = new RegExp(`^\\s*(?:class|struct)\\s+(?:${[...owners].join('|')})\\b[^;]*$`);
      header = insertLines(header, [...headerDecls.map((c) => c.text), ''], /(?!)/, before);
    }
    // Their labels, for the names carried (a statement about other names stays out).
    const labelled = new Set(header.split('\n').flatMap((l) => LABEL.exec(l)?.[1]!.split(',').map((x) => x.trim()) ?? []));
    for (const l of oursHeader.split('\n')) {
      const m = LABEL.exec(l);
      const names = m ? m[1]!.split(',').map((x) => x.trim()).filter((n) => carriedNames.has(n) && !labelled.has(n)) : [];
      if (!names.length) continue;
      names.forEach((n) => labelled.add(n));
      header = insertLines(header, [`// ${names.join(', ')}: ${m![2]!.trim()}`], /^\s*#pragma once/, /^\s*(?:class|struct)\b/);
    }
    out.push({ path: h, content: header });
  } else if (upH === null && oursH !== null) {
    out.push({ path: h, content: oursH });
  }
  return { files: out, notes };
}
