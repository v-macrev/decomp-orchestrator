// SPDX-License-Identifier: AGPL-3.0-or-later
// What a unit's leading comment says about the code already in it: where each body comes from, its
// licence and labels, and which functions it holds. A change to the unit adds to that and never takes
// any of it out: upstream's review refuses the change, and the people credited there are not ours to drop.

const KEYED = /^\/\/\s*([A-Z][A-Za-z -]{1,40}):/;
const COMPARED = /^\/\/\s*0x[0-9a-fA-F]+(?:\s|$)/;
const LABELLED = /(?<![A-Za-z0-9_])(?:COMMUNITY|SIBLING|GUESS|EXE_RTTI|STANDIN|OBSERVED|PUBLIC)\b/;
const SKELETON = /SKELETON_TODO/;
/** Lines the repository's lint asks contributors to drop, and attribution (kept by attribution.ts). */
const NOT_PROVENANCE = /^\/\/\s*(?:Drafted by|Task|Labels?|Recipe|Evidence|Disclaimer|Note to reviewers?)\b|A byte match shows|does not verify the (?:community )?(?:method )?names/i;

/** The statements of a file's leading `//` block, each with the lines it wraps over. */
export function headerStatements(src: string): string[][] {
  const out: string[][] = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('//')) break;
    if (line === '//') continue;
    const last = out.at(-1)?.at(-1);
    const starts = !last || KEYED.test(line) || COMPARED.test(line) || LABELLED.test(line) && /^\/\/\s*[^:]+:/.test(line) || COMPARED.test(last) || /[.)]$/.test(last)
      || last.length < 75 && /^\/\/\s*[A-Z]/.test(line) && !SKELETON.test(last); // a wrapped line is cut when it is long
    if (starts) out.push([line]);
    else out.at(-1)!.push(line);
  }
  return out;
}

const text = (lines: string[]) => lines.map((l) => l.replace(/^\/\/\s?/, '')).join(' ').replace(/\s+/g, ' ').trim();
/** The statement without its wrapping, a skeleton placeholder `sr start` appended, and end punctuation. */
export const statementText = (lines: string[]) => text(lines).split(SKELETON)[0]!.replace(/[\s;,.]+$/, '').trim();
/** A statement that is only a key ("Code origin:") says nothing. */
const says = (s: string) => s !== '' && !/^[A-Za-z -]+:$/.test(s);

/** Header statements of `before` that `after` no longer makes, as their original lines. */
export function lostProvenance(before: string, after: string): string[][] {
  const statements = headerStatements(after).map(text);
  const now = ` ${statements.join(' ')} `;
  return headerStatements(before).filter((s) => {
    const t = statementText(s);
    if (!says(t) || NOT_PROVENANCE.test(s[0]!) || (COMPARED.test(s[0]!) ? [' ', '. ', ', ', '; '].some((end) => now.includes(` ${t}${end}`)) : now.includes(t))) return false;
    // A second line of a key may be folded into the first one ("Source exposure: a; b").
    const keyed = COMPARED.test(s[0]!) ? null : /^([A-Z][A-Za-z -]{1,40}:)\s*(.+)$/.exec(t);
    return !(keyed && statements.some((x) => x.startsWith(keyed[1]!) && `; ${x.slice(keyed[1]!.length).trim()}`.includes(`; ${keyed[2]!}`)));
  });
}

/** The header says some of the unit's code was adapted from other code or generated from a template. */
export const documentsAdaptation = (src: string) =>
  headerStatements(src).some((s) => !/^\/\/\s*Adapted (?:bodies|code):\s*none\b/i.test(s[0]!) && /SIBLING\(|Sibling source:|\badapted\b|generator_family/i.test(text(s)));
