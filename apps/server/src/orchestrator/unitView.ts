// SPDX-License-Identifier: AGPL-3.0-or-later
// What a worker sees of a unit file that does not fit the context budget. Cutting the end off dropped
// what mattered most (the packet's own class is often the last in its header); this keeps the leading
// comment, the includes, the classes the packet's functions belong to and what those use, and puts one
// marker line in place of each run of unrelated declarations. A complete file returned with its
// markers gets them back verbatim, like the placeholder slots (see edits.ts).
import { lex, normalise } from '../gatekeeper/cpp.js';
import { estimateTokens } from '../util/tokens.js';
import { chunksOf } from './splice.js';

export interface Elision {
  path: string;
  marker: string;
  text: string;
  /** What the hidden text declares. */
  names: string[];
}

const words = (s: string) => new Set(lex(s).code.match(/[A-Za-z_]\w*/g) ?? []);
const MIN_HIDDEN = 200;

/**
 * `text` (a unit file) within about `budget` tokens. `owners`: the packet's classes, always shown.
 * `wanted`: other identifiers the packet uses, shown while they fit.
 */
export function focusFile(path: string, text: string, budget: number, owners: Set<string>, wanted: Set<string>): { text: string; elisions: Elision[] } {
  if (estimateTokens(text) <= budget) return { text, elisions: [] };
  const chunks = chunksOf(text);
  if (chunks.length < 2) return { text, elisions: [] };
  const cost = (k: number) => estimateTokens(chunks[k]!.text);
  const shown = new Set<number>();
  let used = estimateTokens(text) - chunks.reduce((n, _c, k) => n + cost(k), 0);
  const show = (k: number) => {
    if (shown.has(k)) return;
    shown.add(k);
    used += cost(k);
  };
  // The packet's classes and functions, and one-line declarations (they cost little and name things).
  chunks.forEach((c, k) => {
    if (c.names.some((n) => owners.has(n)) || (!c.names.length && [...owners].some((o) => new RegExp(`\\b${o}\\s*::`).test(c.text)))) show(k);
  });
  // Then what those classes name (bases, member types), nearest first, then what the packet names.
  const near = new Set<string>();
  for (const k of shown) for (const w of words(chunks[k]!.text)) near.add(w);
  for (const set of [near, wanted]) {
    chunks.forEach((c, k) => {
      if (!shown.has(k) && c.names.some((n) => set.has(n)) && used + cost(k) <= budget) show(k);
    });
  }
  chunks.forEach((c, k) => {
    if (!shown.has(k) && c.single && used + cost(k) <= budget) show(k);
  });
  // Runs of hidden chunks (with the comments between them) become one marker each.
  const elisions: Elision[] = [];
  let out = '';
  let pos = 0;
  for (let k = 0; k < chunks.length;) {
    if (shown.has(k)) {
      k++;
      continue;
    }
    let j = k;
    // A preprocessor line between two chunks stays visible: it ends the run.
    while (j + 1 < chunks.length && !shown.has(j + 1) && !/^[ \t]*#/m.test(text.slice(chunks[j]!.end, chunks[j + 1]!.start))) j++;
    const from = text.lastIndexOf('\n', chunks[k]!.start) + 1;
    const eol = text.indexOf('\n', chunks[j]!.end);
    const to = eol < 0 ? text.length : eol;
    const hidden = text.slice(from, to);
    if (from >= pos && hidden.length >= MIN_HIDDEN && text.slice(from, chunks[k]!.start).trim() === '') {
      const names = chunks.slice(k, j + 1).flatMap((c) => c.names);
      const marker = `// [elided #${elisions.length + 1}: ${hidden.split('\n').length} lines${names.length ? ` declaring ${names.slice(0, 12).join(', ')}${names.length > 12 ? `, … ${names.length - 12} more` : ''}` : ''}; kept verbatim, keep this line]`;
      out += text.slice(pos, from) + marker;
      pos = to;
      elisions.push({ path, marker, text: hidden, names });
    }
    k = j + 1;
  }
  return elisions.length ? { text: out + text.slice(pos), elisions } : { text, elisions: [] };
}

/** Put hidden declarations back into a complete file a worker returned; `missing`: dropped markers. */
export function expandElisions(path: string, content: string, elisions: Elision[]): { content: string; missing: string[] } {
  const missing: string[] = [];
  let out = content;
  for (const e of elisions) {
    if (e.path !== path) continue;
    const id = /^\/\/ \[elided #\d+:/.exec(e.marker)![0];
    const at = out.split('\n').findIndex((l) => l.trim().startsWith(id));
    if (at >= 0) {
      const rows = out.split('\n');
      rows[at] = e.text;
      out = rows.join('\n');
    } else if (!normalise(out).includes(normalise(e.text))) missing.push(...(e.names.length ? e.names : [e.marker]));
  }
  return { content: out, missing };
}
