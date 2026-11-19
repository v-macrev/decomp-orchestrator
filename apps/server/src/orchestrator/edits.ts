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
  for (const f of out.files ?? []) files.set(f.path, f.content);
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
