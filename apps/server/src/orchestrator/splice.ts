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

/** Lines of `ours` at file scope that are single-line declarations the definitions may need. */
function fileScopeDecls(ours: string): string[] {
  const code = lex(ours).code.split('\n');
  const raw = ours.split('\n');
  const out: string[] = [];
  let depth = 0;
  code.forEach((l, i) => {
    const t = l.trim();
    if (depth === 0 && t && !t.startsWith('#') && /;\s*$/.test(t) && !/[{}]/.test(t) && /^(extern|using|class|struct|enum|typedef|static|constexpr|inline|namespace)\b/.test(t)) out.push(raw[i]!);
    for (const ch of l) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
  });
  return out;
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
  const access = m[1] === 'class' ? 'public: ' : '';
  return onOwnLine
    ? `${header.slice(0, lineStart)}${access ? 'public:\n' : ''}    ${decl}\n${header.slice(lineStart)}`
    : `${header.slice(0, close)} ${access}${decl} ${header.slice(close)}`;
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
  const have = new Set(upCpp.split('\n').map(normalise));
  const decls = fileScopeDecls(oursCpp).filter((l) => !have.has(normalise(l)));
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
    out.push({ path: h, content: header });
  } else if (upH === null && oursH !== null) {
    out.push({ path: h, content: oursH });
  }
  return { files: out, notes };
}
