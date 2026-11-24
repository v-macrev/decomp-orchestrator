// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic repair of the leading header comment, applied to a worker's files before the Gate
// Keeper. The first real test run lost most of its attempts — and escalated packets to costly tiers —
// on header conventions rather than on matching:
//   * `sr start` writes skeleton placeholders (`Code origin: SKELETON_TODO_CODE_ORIGIN (...)`,
//     `Adapted bodies: SKELETON_TODO_ORIGIN (...)`, wrapped over two lines); workers wrote their own
//     line underneath and left the placeholder → CONV_ORIGIN_PLACEHOLDER + CONV_HEADER_TOO_LONG;
//   * workers added lines the repo's lint bans (Task, Labels, Recipe, Evidence, disclaimers) and
//     second copies of single-valued keys (Source exposure, Code origin, ...);
//   * workers wrote their own "Drafted by" lines; attribution is the orchestrator's job (the
//     accepted attempt's model, see attribution.ts), so a worker's line is dropped and replaced;
//   * a touched `.h` needs its own `Code origin:` line (repo preflight) and workers never add one.
//
// Rules, all conservative:
//   * only lines the worker ADDED are ever dropped (lines already in the file stay, except skeleton
//     placeholders, which are removed only once the worker has supplied that key's real statement);
//   * nothing is invented: a missing `Code origin:` is filled only with the worker's own statement
//     from another file of the same answer (its .cpp), never with orchestrator text;
//   * what upstream's header says about the code already in the unit is put back when a worker left
//     it out, and a new statement is added beside it, never in its place (see gatekeeper/provenance.ts);
//   * every change is reported, so the attempt record shows exactly what was normalised.

import { documentsAdaptation, headerStatements, lostProvenance, statementText } from '../gatekeeper/provenance.js';
import { setDraftedBy } from './attribution.js';
import { repairLabels } from './labelRepair.js';

const SINGLE_KEYS = ['Source exposure', 'Code origin', 'Adapted bodies', 'Adapted code', 'Licence', 'License', 'Recipe'];
/** Lines the repo's header lint asks contributors to drop. */
const NOISE = /^\/\/\s*(?:Task|Labels?|Recipe|Evidence|Disclaimer|Note to reviewers?)\b|A byte match shows|does not verify the (?:community )?(?:method )?names/i;
/** A "Drafted by" line: required by the repo's lint in unit sources, written by the orchestrator. */
const DRAFTED_LINE = /^\/\/\s*Drafted by\b/i;
const KEYED = /^\/\/\s*([A-Z][A-Za-z -]{1,40}):/;
const COMPARED = /^\/\/\s*0x[0-9a-fA-F]+(?:\s|$)/;
const PLACEHOLDER = /SKELETON_TODO\w*/;
/** The repo lint's header budget and what it does not count (labels, sibling sources, compared functions, SPDX). */
const HEADER_BUDGET = 6;
const LABEL_WORD = /(?<![A-Za-z0-9_])(?:COMMUNITY|SIBLING|GUESS|EXE_RTTI|STANDIN|OBSERVED)[A-Za-z0-9_]*/;
function countedLines(es: Array<{ lines: string[] }>): number {
  return es.flatMap((e) => e.lines).filter((l) => l.trim() && l.trim() !== '//' && !LABEL_WORD.test(l) && !l.includes('Sibling source:') && !COMPARED.test(l.trim()) && !l.includes('SPDX-License-Identifier') && !DRAFTED_LINE.test(l.trim())).length;
}

interface Entry {
  lines: string[];
  key: string | null;
  placeholder: boolean;
  added: boolean;
}

const keyOf = (line: string): string | null => {
  if (COMPARED.test(line)) return null;
  const m = KEYED.exec(line);
  if (!m) return null;
  const k = m[1]!.trim();
  if (/^SPDX-License-Identifier$/i.test(k)) return 'SPDX-License-Identifier';
  return SINGLE_KEYS.find((s) => s.toLowerCase() === k.toLowerCase()) ?? k;
};

/** Split a file into its leading `//` header lines and the rest (blank lines end the header). */
function splitHeader(src: string): { header: string[]; rest: string[] } {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let k = 0;
  while (k < lines.length && lines[k]!.trim().startsWith('//')) k++;
  return { header: lines.slice(0, k), rest: lines.slice(k) };
}

/** Group header lines into entries: a keyed or compared line starts one; other lines wrap into it. */
function entries(header: string[], before: Set<string>): Entry[] {
  const out: Entry[] = [];
  for (const line of header) {
    const starts = keyOf(line) !== null || COMPARED.test(line) || !out.length || LABEL_WORD.test(line) && /^\s*\/\/\s*[^:(]+:\s/.test(line) || (/(?:\.|\))\s*$/.test(out.at(-1)!.lines.at(-1)!) || out.at(-1)!.lines.at(-1)!.length < 75 && !out.at(-1)!.placeholder) && /^\/\/\s*[A-Z]/.test(line);
    if (starts) out.push({ lines: [line], key: keyOf(line), placeholder: PLACEHOLDER.test(line), added: !before.has(line.trim()) });
    else {
      const e = out.at(-1)!;
      e.lines.push(line);
      if (PLACEHOLDER.test(line)) e.placeholder = true;
      if (!before.has(line.trim()) && e.lines.length === 1) e.added = true;
    }
  }
  return out;
}

export interface HeaderRepairResult {
  content: string;
  changes: string[];
}

/** The worker's own `Code origin:` statement in a file's header (null for placeholders). */
export function originStatement(src: string): string | null {
  for (const l of splitHeader(src).header) {
    const m = /^\/\/\s*Code origin:\s*(.+)$/.exec(l.trim());
    if (m && !PLACEHOLDER.test(m[1]!) && !/<[^>]*>|TODO|\?\?\?/.test(m[1]!)) return m[1]!.trim();
  }
  return null;
}

export function repairHeader(path: string, after: string, before: string | null, opts: { originHint?: string | null; adaptedHint?: string | null; base?: string | null; own?: string[] } = {}): HeaderRepairResult {
  const changes: string[] = [];
  if (!/\.(cpp|h|hpp|inl)$/.test(path)) return { content: after, changes };
  const { header, rest } = splitHeader(after);
  if (!header.length) return { content: after, changes };
  const prev = new Set((before ? splitHeader(before).header : []).map((l) => l.trim()));
  let es = entries(header, prev);

  // 1. banned lines the worker added, and attribution lines the worker wrote itself
  const noise = es.filter((e) => e.added && (NOISE.test(e.lines.join(' ')) || DRAFTED_LINE.test(e.lines[0]!.trim())));
  if (noise.length) {
    es = es.filter((e) => !noise.includes(e));
    changes.push(`dropped ${noise.length} banned header line(s) (${noise.map((e) => e.key ?? e.lines[0]!.slice(3, 30)).join(', ')})`);
  }
  // 2. single-valued keys: one entry each; placeholders yield to a real statement
  for (const key of [...SINGLE_KEYS, 'SPDX-License-Identifier']) {
    const all = es.filter((e) => e.key === key);
    if (all.length <= 1) continue;
    const real = all.filter((e) => !e.placeholder);
    if (!real.length) continue;
    // keep the file's existing real line if there is one, else the worker's first
    const keep = real.find((e) => !e.added) ?? real[0]!;
    const drop = all.filter((e) => e !== keep && (e.placeholder || e.added));
    if (!drop.length) continue;
    es = es.filter((e) => !drop.includes(e));
    const ph = drop.filter((e) => e.placeholder).length;
    changes.push(`${key}: ${ph ? `replaced the skeleton placeholder with the worker's statement` : ''}${ph && drop.length > ph ? ' and ' : ''}${drop.length > ph ? `removed ${drop.length - ph} duplicate line(s) the worker added` : ''}`);
  }
  // 3. a placeholder origin with no real statement in this file: use the worker's own from its .cpp
  // `sr start` appends its placeholder to a statement the file already makes ("none.; SKELETON_TODO_ORIGIN
  // (state it for the added functions)"): that statement covers the functions already there, so it stays
  // and the new one follows it.
  const merged = (e: Entry, key: string, hint: string, isNone: boolean) => {
    const value = e.lines.join(' ').replace(/^\/\/\s*[^:]+:\s*/, '').split(PLACEHOLDER)[0]!.replace(/\s*\/\/\s*/g, ' ').replace(/[\s;,]+$/, '').trim();
    if (!value) return `// ${key}: ${hint}`;
    return isNone || value.toLowerCase().includes(hint.toLowerCase()) ? `// ${key}: ${value}` : `// ${key}: ${value}; ${hint}`;
  };
  const originPh = es.find((e) => e.key === 'Code origin' && e.placeholder);
  if (originPh && opts.originHint && !es.some((e) => e.key === 'Code origin' && !e.placeholder)) {
    originPh.lines = [merged(originPh, 'Code origin', opts.originHint, false)];
    originPh.placeholder = false;
    changes.push(`Code origin: filled the skeleton placeholder with the worker's own statement from its source file`);
  }
  // 3b. the same for the adapted-bodies placeholder, from the worker's own "adaptedBodies" statement
  const adaptedPh = es.find((e) => (e.key === 'Adapted bodies' || e.key === 'Adapted code') && e.placeholder);
  if (adaptedPh && opts.adaptedHint && !es.some((e) => (e.key === 'Adapted bodies' || e.key === 'Adapted code') && !e.placeholder)) {
    adaptedPh.lines = [merged(adaptedPh, adaptedPh.key!, opts.adaptedHint, /^none\b/i.test(opts.adaptedHint))];
    adaptedPh.placeholder = false;
    changes.push(`Adapted bodies: filled the skeleton placeholder with the worker's statement`);
  }
  // 4. a changed file with no origin line at all (typically the .h): add the worker's statement
  if (!es.some((e) => e.key === 'Code origin') && opts.originHint && before !== null && after !== before) {
    const at = es.findIndex((e) => e.key === 'Source exposure');
    es.splice(at >= 0 ? at + 1 : 0, 0, { lines: [`// Code origin: ${opts.originHint}`], key: 'Code origin', placeholder: false, added: true });
    changes.push(`Code origin: added the worker's own statement (required in every changed file's header)`);
  }
  // 4b. Upstream's own statements the worker left out or replaced go back; the worker's follow them, named
  // for the functions they are about, so they do not speak for the code that was there before.
  if (opts.base) {
    const own = opts.own?.length ? (opts.own.length > 3 ? 'the added functions' : opts.own.join(', ')) : 'the added functions';
    const value = (lines: string[]) => lines.map((l) => l.replace(/^\s*\/\/\s?/, '')).join(' ').replace(/^[^:]+:\s*/, '').replace(/\s+/g, ' ').replace(/[\s;,.]+$/, '').trim();
    const lost = lostProvenance(opts.base, es.flatMap((e) => e.lines).join('\n'));
    const order = entries(splitHeader(opts.base).header, new Set()).map((e) => e.lines[0]!.trim());
    const theirs = headerStatements(opts.base).map(statementText);
    const joined = new Map<Entry, { theirs: string[]; mine: string | null }>();
    let back = 0;
    for (const lines of lost) {
      const was = statementText(lines);
      const key = keyOf(lines[0]!);
      const same = key && key !== 'SPDX-License-Identifier' && SINGLE_KEYS.includes(key) ? es.find((e) => e.key === key && !e.placeholder) : undefined;
      if (same) {
        // A line of upstream's that stayed is upstream's too; what the worker wrote speaks for its own functions.
        const kept = theirs.includes(statementText(same.lines));
        const j = joined.get(same) ?? { theirs: kept ? [value(same.lines)] : [], mine: kept ? null : value(same.lines) };
        joined.set(same, j);
        j.theirs.push(was.replace(/^[^:]+:\s*/, ''));
        const all = j.theirs.join('; ');
        const mine = j.mine && !/^none\b/i.test(j.mine) && !all.toLowerCase().includes(j.mine.toLowerCase()) ? `; ${key === 'Code origin' ? `${own}: ` : ''}${j.mine}` : '';
        same.lines = [`// ${was.slice(0, was.indexOf(':'))}: ${all}${mine}`];
        same.added = false;
      } else {
        const i = order.indexOf(lines[0]!.trim());
        const prev = order.slice(0, Math.max(i, 0)).reverse().map((l) => es.findIndex((e) => e.lines[0]!.trim().startsWith(l.slice(0, 24)))).find((k) => k >= 0);
        es.splice(prev === undefined ? 0 : prev + 1, 0, { lines: lines.map((l) => l.trim()), key, placeholder: false, added: false });
      }
      back++;
    }
    if (back) changes.push(`put back ${back} statement(s) of upstream's header`);
    const none = es.find((e) => (e.key === 'Adapted bodies' || e.key === 'Adapted code') && /:\s*none\W*$/i.test(e.lines.join(' ')));
    if (none && documentsAdaptation(opts.base) && !/^\/\/\s*Adapted (?:bodies|code):/im.test(opts.base)) {
      none.lines = [`// ${none.key}: none in ${own}`];
      changes.push(`${none.key}: "none" now speaks only for what this change adds (the unit documents adapted code)`);
    }
  }
  // 5. Still over the repo's 6-line budget? `sr start` stacks its skeleton on top of the unit's
  // existing header, so the file itself may carry a second "Source exposure" or a "Recipe:" /
  // "Drafted by" line from an older draft. Untouched, the lint tolerates that; once the header
  // changes it must fit. Only then fold later duplicates of single-valued keys
  // into the first and, if that is not enough, drop pre-existing banned lines (what the header says about
  // origin, adaptation and licence is never dropped).
  if (countedLines(es) > HEADER_BUDGET) {
    // A wrapped statement counts once per line: put it on one line first, which loses nothing.
    let joined = 0;
    for (const e of es) {
      if (e.lines.length === 1) continue;
      e.lines = [`// ${e.lines.map((l) => l.trim().replace(/^\/\/\s?/, '')).join(' ').replace(/\s+/g, ' ').trim()}`];
      joined++;
    }
    if (joined) changes.push(`put ${joined} wrapped header statement(s) on one line to fit the ${HEADER_BUDGET}-line budget`);
    // Then a later duplicate of a single-valued key is folded into the first one, not dropped.
    let folded = 0;
    for (const key of ['Source exposure', 'Code origin']) {
      const all = es.filter((e) => e.key === key && !e.placeholder);
      for (const extra of all.slice(1)) {
        const add = statementText(extra.lines).replace(/^[^:]+:\s*/, '');
        if (add && !statementText(all[0]!.lines).includes(add)) all[0]!.lines = [`// ${statementText(all[0]!.lines)}; ${add}`];
        es = es.filter((e) => e !== extra);
        folded++;
      }
    }
    if (folded) changes.push(`folded ${folded} duplicate header line(s) into the first to fit the ${HEADER_BUDGET}-line budget`);
  }
  if (countedLines(es) > HEADER_BUDGET) {
    const before0 = es.length;
    es = es.filter((e) => e.added || !NOISE.test(e.lines.join(' ')) || e.key === 'Licence' || e.key === 'License');
    if (es.length < before0) changes.push(`dropped ${before0 - es.length} pre-existing banned header line(s) to fit the ${HEADER_BUDGET}-line budget`);
  }
  if (!changes.length) return { content: after, changes };
  return { content: [...es.flatMap((e) => e.lines), ...rest].join('\n'), changes };
}

/**
 * Repair every file of an answer: sources first (they carry the worker's origin statement), then
 * headers, which may borrow it.
 */
export async function repairAnswer(
  files: Array<{ path: string; content: string }>,
  current: (path: string) => Promise<string | null>,
  stated: { codeOrigin?: string; adaptedBodies?: string } = {},
  opts: {
    untouched?: Array<{ path: string; current: string | null; base: string | null }>;
    /** Name the model of this attempt in each returned unit source's "Drafted by" line. */
    attribution?: { person: string | null; model: string };
    /** A file as upstream has it: what its header says about the code there is kept. */
    base?: (path: string) => Promise<string | null>;
    /** Names of the functions this answer adds. */
    own?: string[];
  } = {},
): Promise<{ files: Array<{ path: string; content: string }>; changes: string[] }> {
  const order = [...files].sort((a, b) => Number(a.path.endsWith('.h')) - Number(b.path.endsWith('.h')));
  const out = new Map(files.map((f) => [f.path, f.content]));
  const changes: string[] = [];
  const clean = (s?: string) => (s ? s.replace(/\s+/g, ' ').replace(/^\/\/\s*(Code origin|Adapted bodies):\s*/i, '').trim().slice(0, 200) : null);
  let hint: string | null = clean(stated.codeOrigin);
  const adapted = clean(stated.adaptedBodies);
  for (const f of order) {
    const before = await current(f.path);
    const r = repairHeader(f.path, out.get(f.path)!, before, { originHint: hint ?? originStatement(f.content), adaptedHint: adapted, base: opts.base ? await opts.base(f.path) : null, own: opts.own });
    const l = repairLabels(f.path, r.content, opts.base ? await opts.base(f.path) : before);
    out.set(f.path, l.content);
    changes.push(...[...r.changes, ...l.changes].map((c) => `${f.path}: ${c}`));
    hint ??= originStatement(r.content);
    if (opts.attribution && f.path.endsWith('.cpp')) {
      const d = setDraftedBy(out.get(f.path)!, opts.attribution.person, opts.attribution.model);
      out.set(f.path, d.content);
      if (d.change) changes.push(`${f.path}: ${d.change}`);
    }
  }
  // Files the worker did not return but `prepare` changed (skeleton headers/declarations): the
  // repo's preflight checks them too. Compare against the base revision; add them only if repaired.
  const extra: Array<{ path: string; content: string }> = [];
  for (const x of opts.untouched ?? []) {
    if (out.has(x.path) || x.current === null || x.current === x.base) continue;
    const r = repairHeader(x.path, x.current, x.base, { originHint: hint, adaptedHint: adapted, base: opts.base ? x.base : null, own: opts.own });
    if (!r.changes.length) continue;
    extra.push({ path: x.path, content: r.content });
    changes.push(...r.changes.map((c) => `${x.path} (changed by prepare): ${c}`));
  }
  if (extra.length) return { files: [...files.map((f) => ({ path: f.path, content: out.get(f.path)! })), ...extra], changes };
  return { files: files.map((f) => ({ path: f.path, content: out.get(f.path)! })), changes };
}
