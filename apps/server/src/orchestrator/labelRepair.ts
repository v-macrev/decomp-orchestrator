// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic repair of origin labels. The repository's lint takes a label only as a line of its own
// (`// <names>: <LABEL> ...[; note]`) and refuses a label word anywhere else; workers get the bytes
// right and lose the packet on this. Only lines the packet added are touched, and no origin is made up:
// a label with no names gets the name of the declaration right below it, text behind a label becomes
// its note, and a label word inside prose is put in lower case (the lint's words are capitals).
import { lex } from '../gatekeeper/cpp.js';

const LABEL = String.raw`(?:COMMUNITY\([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{7,40}, [A-Za-z0-9.+-]+\)|SIBLING\((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|fo4-private)@[0-9a-f]{7,40}, [A-Za-z0-9.+-]+\)|CRASHLOGGER_PDB\(59818@[0-9A-Za-z][0-9A-Za-z.+-]*\)|SYMBOLS\((?:tesv-2013-map|fo4-pdb|fnv-x360-pdb)\)|GUESS(?:\((?:low|medium|high)\))?|EXE_RTTI|STANDIN|OBSERVED)`;
const LABEL_LINE = new RegExp(String.raw`^\s*\/\/\s*(?<names>\S(?:.*?\S)?)\s*:\s*(?<labels>${LABEL}(?:\s+${LABEL})*)\s*(?:;\s*(?<note>.*))?$`);
const BARE = new RegExp(String.raw`^(${LABEL}(?:\s+${LABEL})*)(?![A-Za-z0-9_(])\s*[:;,.]?\s*(.*)$`);
const NAMED = new RegExp(String.raw`^(\S(?:.*?\S)?)\s*:\s*(${LABEL}(?:\s+${LABEL})*)(?![A-Za-z0-9_(])\s*[;,.:–—-]*\s*(.*)$`);
const NEXT_LABEL = new RegExp(String.raw`^(${LABEL})(?![A-Za-z0-9_(])\s*[;,.]?\s*`);
const WORD = /(?<![A-Za-z0-9_])(?:COMMUNITY|SIBLING|CRASHLOGGER_PDB|SYMBOLS(?=\()|GUESS|EXE_RTTI|STANDIN|OBSERVED)[A-Za-z0-9_]*|(?<![A-Za-z0-9_])(?:EXE[- ]RTTI|STAND[- _]IN)(?![A-Za-z0-9_])/;
const WORDS = new RegExp(WORD.source, 'g');
const HEADER_KEY = /^(?:Source exposure|Code origin|Adapted (?:bodies|code)|SPDX-License-Identifier|Licen[cs]e|Sibling source)$/i;

/** A stand-in with made-up placeholder names (Slot06..Slot17, Unk_12, pad08): their origin is a guess. */
const STANDIN_ONLY = /^(\s*\/\/\s*(?:(?:[A-Za-z_]\w*::)*(?:Slot|Unk_?|unk|unknown|pad|padding|field|Function|g_?[Uu]nk)_?[0-9A-Fa-f]+(?:\s*(?:,|\.\.|through|to|and)\s*)?)+\s*:\s*)(STANDIN)(\s*(?:;.*)?)$/;

const plain = (s: string) => s.replace(WORDS, (w) => w.toLowerCase());
const note = (s: string) => {
  const t = plain(s).replace(/^[-–—\s]+/, '').replace(/[\s.]+$/, '').replace(/^\(([^()]*)\)$/, '$1');
  return t ? `; ${t}` : '';
};

export function labelLineOk(line: string): boolean {
  if (!WORD.test(line)) return true;
  const m = LABEL_LINE.exec(line);
  return !!m && !WORD.test(`${m.groups!.names} ${m.groups!.note ?? ''}`);
}

/** What the declaration at or below row `i` declares (null: the next code is something else). */
function declaredBelow(code: string[], i: number): string | null {
  for (let k = i; k < Math.min(code.length, i + 4); k++) {
    const t = code[k]!.trim();
    if (!t) continue;
    if (/^[#{}]/.test(t) || /^(?:return|if|for|while|switch|else|do|public|private|protected)\b/.test(t)) return null;
    const type = /^(?:typedef\s+)?(?:class|struct|union|enum(?:\s+class)?)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?:[:;{]|$)/.exec(t);
    if (type) return type[1]!;
    const using = /^using\s+([A-Za-z_]\w*)\s*=/.exec(t);
    if (using) return using[1]!;
    const head = t.split(/[{;=]/)[0]!.trim();
    const call = /[\w>*&\]]\s+[*&]*([A-Za-z_~][\w:~]*)\s*\(/.exec(head);
    if (call) return call[1]!.split('::').pop() || null;
    if (head.includes('(')) return null;
    return /[\w>*&\]]\s+[*&]*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?::\s*\d+\s*)?$/.exec(head)?.[1] ?? null;
  }
  return null;
}

function fixLine(line: string, code: string[], i: number, header: boolean): string {
  const at = /^(\s*)\/\/\s*(.*)$/.exec(line);
  if (!at) {
    // Behind code: prose there, and in a header the label goes on a line of its own for that declaration.
    const c = code[i]!.trimEnd().length;
    const label = new RegExp(`(?<![A-Za-z0-9_])${LABEL}(?![A-Za-z0-9_(])`).exec(line.slice(c))?.[0];
    const name = header && label && label !== 'STANDIN' && /;\s*$/.test(code[i]!) ? declaredBelow([code[i]!], 0) : null;
    const own = line.slice(0, c) + plain(line.slice(c));
    return name ? `${/^\s*/.exec(line)![0]}// ${name}: ${label}\n${own}` : own;
  }
  const [, indent, body] = at as unknown as [string, string, string];
  // "A: GUESS(low); B: GUESS(low)": one line each.
  const parts = body.split(/[;,]\s+(?=[A-Za-z_~][\w:~, ]*:\s*(?:COMMUNITY|SIBLING|CRASHLOGGER_PDB|SYMBOLS|GUESS|EXE_RTTI|STANDIN|OBSERVED)\b)/);
  if (parts.length > 1) return parts.map((p) => fixLine(`${indent}// ${p}`, code, i, header)).join('\n');
  const bare = BARE.exec(body);
  if (bare) {
    // Inside a body, or with no declaration below, there is no name to attach it to: a remark.
    const name = declaredBelow(code, i + 1);
    if (!name) return plain(line);
    return `${indent}// ${name}: ${bare[1] === 'STANDIN' ? 'STANDIN GUESS(low)' : bare[1]}${note(bare[2]!)}`;
  }
  const named = NAMED.exec(body);
  if (named && !WORD.test(named[1]!) && /^[A-Za-z_~]/.test(named[1]!) && !HEADER_KEY.test(named[1]!)) {
    const labels = [named[2]!];
    let rest = named[3]!;
    // "GUESS(low), OBSERVED": the labels of a list go together.
    for (let m = NEXT_LABEL.exec(rest); m; m = NEXT_LABEL.exec(rest)) {
      labels.push(m[1]!);
      rest = rest.slice(m[0].length);
    }
    return `${indent}// ${named[1]}: ${labels.join(' ')}${note(rest)}`;
  }
  return plain(line);
}

const MIT = /^\s*\/\/\s*SPDX-License-Identifier:\s*MIT \(CommonLibSSE-NG (?:declarations, )?(?:\.\.\.|…)\)?\s*$/;
const MIT_FULL = '// SPDX-License-Identifier: MIT (CommonLibSSE-NG declarations, Copyright (c) 2018 Ryan-rsm-McKenzie; full text: licenses/CommonLibSSE-NG.txt)';

/** Repair the label lines of `content` that are not in `base` (the file as upstream has it). */
export function repairLabels(path: string, content: string, base: string | null): { content: string; changes: string[] } {
  if (!/\.(cpp|h|hpp|inl)$/.test(path)) return { content, changes: [] };
  const had = new Set((base ?? '').split(/\r?\n/).map((l) => l.trim()));
  const rows = content.replace(/\r\n/g, '\n').split('\n');
  const code = lex(rows.join('\n')).code.split('\n');
  let n = 0;
  const out = rows.map((line, i) => {
    if (had.has(line.trim())) return line;
    let next = line;
    if (MIT.test(line)) next = MIT_FULL;
    else if (STANDIN_ONLY.test(line) && labelLineOk(line)) next = line.replace(STANDIN_ONLY, '$1STANDIN GUESS(low)$3');
    else if (!labelLineOk(line)) {
      next = fixLine(line, code, i, path.endsWith('.h'));
      if (!next.split('\n').every(labelLineOk)) next = plain(line);
    }
    if (next !== line) n++;
    return next;
  });
  return n ? { content: out.join('\n'), changes: [`put ${n} label or notice line(s) in the repository's form`] } : { content, changes: [] };
}
