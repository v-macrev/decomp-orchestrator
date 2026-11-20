// SPDX-License-Identifier: AGPL-3.0-or-later
// Attribution the way the target repo's contributors give it. Its contributor card says "name your
// actual model"; its lint requires a "Drafted by" line in every unit source; the units on its main
// branch read "// Drafted by gpt-6.1-terra." or "// Drafted by <person>, assisted by claude-sonnet-5-5";
// claims record the model (`sr claim --model`) and tasks a `drafter_model`. In an orchestrated run
// the model that finished a function is only known once its attempt is accepted (rotation and
// help-up hand a packet to other models), so the line is written by the orchestrator from the
// accepted attempt, never by the worker, and models accumulate when several packets of a unit pass.

/** The person behind the run, if one is configured ('operator' is the schema's placeholder). */
export function personOf(draftedBy: string | null | undefined): string | null {
  const p = (draftedBy ?? '').replace(/\s+/g, ' ').trim();
  return p && !/^(operator|unknown|none|not stated)$/i.test(p) ? p : null;
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** "a", "a and b", "a, b and c". */
export function listModels(models: string[]): string {
  const m = uniq(models);
  return m.length <= 1 ? (m[0] ?? '') : `${m.slice(0, -1).join(', ')} and ${m.at(-1)}`;
}

function splitModels(text: string): string[] {
  return uniq(text.split(/,\s*|\s+and\s+/));
}

/** `--drafted-by` value: "<person>, assisted by <models>", or the models alone without a person. */
export function draftedByText(person: string | null, models: string[]): string {
  const m = listModels(models);
  return person ? `${person}, assisted by ${m}` : m;
}

const DRAFTED = /^\/\/\s*Drafted by\s+(.*)$/i;
const SKELETON_TAIL = /^\/\/\s*a tools\/skeleton\.py skeleton\.?\s*$/i;
const LATER = '; later functions by ';
const MODEL_TOKEN = /^[A-Za-z][A-Za-z0-9._/-]*\d[A-Za-z0-9._/-]*$/;

/** Parse "<person>, assisted by <models>" or a list of model ids; null for anything else. */
function parseOurs(text: string): { person: string | null; models: string[] } | null {
  const t = text.replace(/\.\s*$/, '').trim();
  const assisted = /^(.+?),\s*assisted by\s+(.+?)(?:,\s*starting from)?$/i.exec(t);
  if (assisted) {
    const models = splitModels(assisted[2]!);
    return models.length && models.every((m) => MODEL_TOKEN.test(m)) ? { person: assisted[1]!.trim(), models } : null;
  }
  const models = splitModels(t);
  return models.length && models.every((m) => MODEL_TOKEN.test(m)) ? { person: null, models } : null;
}

/**
 * Give a unit source exactly one "// Drafted by" header line naming `model` (the model whose
 * attempt is being gated): the skeleton's placeholder is replaced, an earlier line of ours gains the
 * model, and a line from another contributor is kept with "; later functions by ..." appended.
 */
export function setDraftedBy(src: string, person: string | null, model: string): { content: string; change: string | null } {
  if (!model.trim()) return { content: src, change: null };
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  let k = 0;
  while (k < lines.length && lines[k]!.trim().startsWith('//')) k++;
  const header = lines.slice(0, k);
  const at = header.findIndex((l) => DRAFTED.test(l.trim()));
  const fresh = `// Drafted by ${draftedByText(person, [model])}.`;
  if (at < 0) {
    if (!header.length) return { content: src, change: null }; // not a unit source with a header
    lines.splice(k, 0, fresh);
    return { content: lines.join(eol), change: `Drafted by: added "${fresh.slice(3)}"` };
  }
  const span = /starting from\s*$/i.test(header[at]!) && SKELETON_TAIL.test((header[at + 1] ?? '').trim()) ? 2 : 1;
  const text = DRAFTED.exec(header[at]!.trim())![1]!;
  let line: string;
  if (span === 2 || /SKELETON_TODO|the model or person who writes the bodies/i.test(text)) {
    line = fresh; // the skeleton's line (written by `sr start` from the run's --drafted-by)
  } else {
    const cut = text.indexOf(LATER);
    const head = cut >= 0 ? text.slice(0, cut) : text;
    const tail = cut >= 0 ? text.slice(cut + LATER.length) : null;
    const mine = tail !== null ? parseOurs(tail) : null;
    const whole = tail === null ? parseOurs(head) : null;
    if (mine) {
      line = `// Drafted by ${head}${LATER}${draftedByText(mine.person ?? person, [...mine.models, model])}.`;
    } else if (whole && (whole.person ?? null) === person) {
      line = `// Drafted by ${draftedByText(person, [...whole.models, model])}.`;
    } else {
      line = `// Drafted by ${head.replace(/\.\s*$/, '')}${LATER}${draftedByText(person, [model])}.`;
    }
  }
  if (span === 1 && line === header[at]) return { content: src, change: null };
  lines.splice(at, span, line);
  return { content: lines.join(eol), change: `Drafted by: "${line.slice(3)}"` };
}

/**
 * Rename the person on this run's own "Drafted by" header lines (the run's draftedBy was edited
 * after its functions were drafted): "<former>, assisted by <models>" becomes "<person>, assisted
 * by <models>", also after "; later functions by". Lines naming anyone else are left alone.
 */
export function renamePerson(src: string, former: string[], person: string | null): string {
  const names = uniq(former.map((f) => personOf(f) ?? '')).filter((f) => f !== person);
  if (!names.length) return src;
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(Drafted by\\s+|; later functions by\\s+)(?:${alt}),\\s*assisted by\\s+`, 'gi');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  for (let k = 0; k < lines.length && lines[k]!.trim().startsWith('//'); k++) {
    if (DRAFTED.test(lines[k]!.trim())) lines[k] = lines[k]!.replace(re, (_m, lead: string) => `${lead}${person ? `${person}, assisted by ` : ''}`);
  }
  return lines.join(eol);
}

/** Commit trailers in the repo's own form, for models whose maker publishes a co-author address. */
export function coAuthorTrailers(models: string[]): string[] {
  const out: string[] = [];
  for (const m of uniq(models)) {
    const c = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i.exec(m);
    if (!c) continue;
    const family = c[1]![0]!.toUpperCase() + c[1]!.slice(1).toLowerCase();
    out.push(`Co-Authored-By: Claude ${family} ${c[2]}${c[3] ? `.${c[3]}` : ''} <noreply@anthropic.com>`);
  }
  return uniq(out);
}
