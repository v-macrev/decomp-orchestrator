// SPDX-License-Identifier: AGPL-3.0-or-later
// Materialise function-level edits into complete files. Workers on large units return only the
// functions they add or change (a fraction of the output tokens of a whole file); the orchestrator
// splices them into the current unit and the Gate Keeper evaluates the complete result exactly as
// before — scope, cheat (incl. matched-body protection), leak, compare, preflight.
import type { UnitEdit, WorkerOutput } from '@decomp/core';
import { extractFunctions, lex, normalise } from '../gatekeeper/cpp.js';

/** Placeholder the context builder puts in elided bodies; never valid inside an edit. */
export const ELIDED_MARKER = 'accepted — kept verbatim by the orchestrator';

export interface Materialised {
  files: Array<{ path: string; content: string }>;
  problems: string[];
  /** How the worker answered: files, edits, or both. */
  mode: 'files' | 'edits' | 'mixed';
}

export async function materialise(out: WorkerOutput, current: (path: string) => Promise<string | null>): Promise<Materialised> {
  const files = new Map<string, string>();
  const problems: string[] = [];
  for (const f of out.files ?? []) files.set(f.path, expandPlaceholderSlots(f.content));
  for (const e of out.edits ?? []) {
    const base = files.get(e.path) ?? (await current(e.path)) ?? '';
    const r = applyEdit(base, e);
    problems.push(...r.problems.map((p) => `${e.path}: ${p}`));
    files.set(e.path, r.content);
  }
  const mode = out.files?.length && out.edits?.length ? 'mixed' : out.edits?.length ? 'edits' : 'files';
  return { files: [...files].map(([path, content]) => ({ path, content })), problems, mode };
}

export function applyEdit(src: string, e: UnitEdit): { content: string; problems: string[] } {
  const problems: string[] = [];
  let out = src.replace(/\r\n/g, '\n');

  let extraDecl = '';
  if (e.header !== undefined) {
    // Comment lines form the header; anything else a worker put there (an #include, a forward
    // declaration) belongs after the includes — move it instead of failing the whole attempt.
    const raw = e.header.replace(/\r\n/g, '\n').trim().split('\n');
    const hdr = raw.filter((l) => l.trim().startsWith('//'));
    extraDecl = raw.filter((l) => l.trim() && !l.trim().startsWith('//')).join('\n');
    const lines = out.split('\n');
    let k = 0;
    while (k < lines.length && lines[k]!.trim().startsWith('//')) k++;
    out = [...hdr, ...lines.slice(k)].join('\n');
  }

  const declText = [extraDecl, e.declarations ?? ''].filter((s) => s.trim()).join('\n');
  if (declText.trim()) {
    const decl = declText.replace(/\r\n/g, '\n').trim();
    if (!normalise(out).includes(normalise(decl))) {
      const lines = out.split('\n');
      let at = -1;
      lines.forEach((l, i) => {
        if (/^\s*#\s*include\b/.test(l)) at = i;
      });
      if (at < 0) {
        at = 0;
        while (at < lines.length && lines[at]!.trim().startsWith('//')) at++;
        at--;
      }
      lines.splice(at + 1, 0, '', decl);
      out = lines.join('\n');
    }
  }

  for (const fe of e.functions) {
    const code = fe.code.replace(/\r\n/g, '\n').trim();
    if (code.includes(ELIDED_MARKER)) {
      problems.push(`function ${fe.name}: returned an elided placeholder body; accepted functions are kept automatically — do not return them`);
      continue;
    }
    const defs = extractFunctions(lex(code).code);
    if (!defs.length) {
      problems.push(`function ${fe.name}: code contains no function definition`);
      continue;
    }
    const target = defs[0]!;
    const existing = extractFunctions(lex(out).code).filter((d) => d.name === target.name);
    const hit = existing.find((d) => d.signature === target.signature) ?? existing[0];
    if (hit) out = `${out.slice(0, hit.start)}${code}${out.slice(hit.close + 1)}`;
    else out = `${out.replace(/\s*$/, '')}\n\n${code}\n`;
  }
  if (!out.endsWith('\n')) out += '\n';
  return { content: out, problems };
}

// Stand-in classes keep compared virtual slots at the right vtable offsets with runs of
// `virtual void Unk_3B();` placeholders — often 100+ lines that crowd the class's real members out
// of the unit budget. Prompts show each run as one marker line; a complete file returned with the
// marker gets the run back verbatim, so nothing the worker did not see can be lost.
const SLOT_LINE = /^([ \t]*)virtual void Unk_([0-9A-Fa-f]+)\(\);[ \t]*$/;
const SLOT_MARKER = /^([ \t]*)\/\/ \[placeholder slots Unk_([0-9A-Fa-f]+)\.\.Unk_([0-9A-Fa-f]+) \(\d+ lines "virtual void Unk_NN\(\);"\) elided; returned files get them back\][ \t]*$/;
const MIN_SLOT_RUN = 6;

export function collapsePlaceholderSlots(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const m = SLOT_LINE.exec(lines[i]!);
    if (!m) {
      out.push(lines[i++]!);
      continue;
    }
    let j = i + 1;
    let prev = parseInt(m[2]!, 16);
    while (j < lines.length) {
      const n = SLOT_LINE.exec(lines[j]!);
      if (!n || n[1] !== m[1] || n[2]!.length !== m[2]!.length || parseInt(n[2]!, 16) !== prev + 1) break;
      prev++;
      j++;
    }
    if (j - i >= MIN_SLOT_RUN) {
      const last = SLOT_LINE.exec(lines[j - 1]!)![2]!;
      out.push(`${m[1]}// [placeholder slots Unk_${m[2]}..Unk_${last} (${j - i} lines "virtual void Unk_NN();") elided; returned files get them back]`);
    } else out.push(...lines.slice(i, j));
    i = j;
  }
  return out.join('\n');
}

export function expandPlaceholderSlots(src: string): string {
  if (!src.includes('// [placeholder slots Unk_')) return src;
  return src.split('\n').flatMap((line) => {
    const m = SLOT_MARKER.exec(line.replace(/\r$/, ''));
    if (!m) return [line];
    const [, indent, a, b] = m as unknown as [string, string, string, string];
    const from = parseInt(a, 16);
    const to = parseInt(b, 16);
    if (!(to >= from) || to - from > 4_096) return [line];
    const upper = a === a.toUpperCase();
    const out: string[] = [];
    for (let k = from; k <= to; k++) {
      const hex = k.toString(16).padStart(a.length, '0');
      out.push(`${indent}virtual void Unk_${upper ? hex.toUpperCase() : hex}();`);
    }
    return out;
  }).join('\n');
}

/** Replace the bodies of every function not in `keep` with the elision marker (for prompts). */
export function elideBodies(src: string, keep: (name: string) => boolean): { text: string; elided: string[] } {
  const code = lex(src).code;
  const defs = extractFunctions(code).filter((d) => !keep(d.name));
  let text = src;
  for (const d of [...defs].sort((a, b) => b.open - a.open)) {
    text = `${text.slice(0, d.open)}{ /* ${ELIDED_MARKER}; do not return or modify */ }${text.slice(d.close + 1)}`;
  }
  return { text, elided: defs.map((d) => d.name) };
}
