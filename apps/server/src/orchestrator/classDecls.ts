// SPDX-License-Identifier: AGPL-3.0-or-later
// Class declarations of a packet's own member functions. The compiler refuses `R Cls::Fn(...) {}`
// (C2039) unless class `Cls` declares `Fn`, and a worker that returns edits of a large unit often
// writes only the definition. The declaration follows from the definition, so the orchestrator adds
// it: a non-virtual member function changes neither the class layout nor its vtable. The comparator
// decides the result like any other candidate.
import { extractFunctions, lex, normalise } from '../gatekeeper/cpp.js';

const esc = (s: string) => s.replace(/[^\w]/g, '\\$&');

export interface ClassSpan {
  kind: 'class' | 'struct';
  /** Offset of the `class`/`struct` word, of the body's `{` and of its `}`. */
  start: number;
  open: number;
  close: number;
}

/** The definition of class `cls` in lexed code (a forward declaration does not count). */
export function classSpan(code: string, cls: string): ClassSpan | null {
  const re = new RegExp(`\\b(class|struct)\\s+(?:alignas\\s*\\([^()]*\\)\\s*|__declspec\\s*\\([^()]*(?:\\([^()]*\\))?[^()]*\\)\\s*)*${esc(cls)}\\b(?!\\s*::)[^;{}()]*\\{`, 'g');
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (/\benum\s+$/.test(code.slice(0, m.index))) continue;
    const open = m.index + m[0].length - 1;
    let depth = 1;
    let k = open + 1;
    for (; k < code.length && depth > 0; k++) {
      if (code[k] === '{') depth++;
      else if (code[k] === '}') depth--;
    }
    if (depth) return null;
    return { kind: m[1] as ClassSpan['kind'], start: m.index, open, close: k - 1 };
  }
  return null;
}

/** Add lines at the end of class `cls`, publicly; null when the class is not defined here. */
export function addMembers(src: string, cls: string, text: string): string | null {
  const code = lex(src).code;
  const at = classSpan(code, cls);
  if (!at) return null;
  const last = [...code.slice(at.open + 1, at.close).matchAll(/\b(public|protected|private)\s*:(?!:)/g)].at(-1)?.[1];
  const isPublic = (last ?? (at.kind === 'class' ? 'private' : 'public')) === 'public';
  const rows = text.trim().split('\n').map((l) => (l.trim() ? `    ${l.replace(/^ {4}/, '').trimEnd()}` : ''));
  const added = `${isPublic ? '' : 'public:\n'}${rows.join('\n')}\n`;
  const lineStart = src.lastIndexOf('\n', at.close) + 1;
  return src.slice(lineStart, at.close).trim() === ''
    ? `${src.slice(0, lineStart)}${added}${src.slice(lineStart)}`
    : `${src.slice(0, at.close).trimEnd()}\n${added}${src.slice(at.close)}`;
}

export interface MemberDef {
  cls: string;
  name: string;
  /** The declaration the class needs ("bool Fn(int a) const;"). */
  decl: string;
}

/** Out-of-line member definitions (`R A::B(...) {`), constructors with an initialiser list included. */
export function memberDefs(src: string): MemberDef[] {
  const code = lex(src).code.replace(/^[ \t]*#.*$/gm, (l) => ' '.repeat(l.length));
  const out: MemberDef[] = [];
  const add = (sig: string) => {
    const m = /^((?:[\w:<>,*&\s])*?)((?:[A-Za-z_]\w*\s*::\s*)+)(~?[A-Za-z_]\w*)\s*(\(.*)$/.exec(normalise(sig));
    if (!m) return;
    const cls = m[2]!.split('::').map((x) => x.trim()).filter(Boolean).pop()!;
    const name = m[3]!;
    const ret = m[1]!.replace(/\b(?:inline|static|virtual|extern)\b/g, '').replace(/\s+/g, ' ').trim();
    // Only a constructor or destructor has no return type; otherwise this is a shape not read here.
    if (!ret && name !== cls && name !== `~${cls}`) return;
    out.push({ cls, name, decl: `${ret ? `${ret} ` : ''}${name}${m[4]!.trim()};` });
  };
  for (const d of extractFunctions(code)) {
    if (!d.name.includes('::')) continue;
    let sig = d.signature;
    // The return type on the line above.
    if (/^(?:[A-Za-z_]\w*\s*::\s*)+[A-Za-z_]\w*\s*\(/.test(sig)) {
      const prev = code.slice(code.lastIndexOf('\n', d.start - 2) + 1, d.start).trim();
      if (prev && /^[\w:<>,*&\s]+$/.test(prev)) sig = `${prev} ${sig}`;
    }
    add(sig);
  }
  const ctor = /(?:^|\n)[ \t]*((?:[A-Za-z_]\w*\s*::\s*)*([A-Za-z_]\w*)\s*::\s*\2\s*\([^;{}()]*(?:\([^;{}()]*\)[^;{}()]*)*\))\s*(?:noexcept\s*)?:(?!:)/g;
  for (const m of code.matchAll(ctor)) add(m[1]!);
  return out;
}

const declares = (body: string, name: string) => new RegExp(`(?<![\\w~])${esc(name)}\\s*\\(`).test(body);

/**
 * Declare what the answer's sources define and their classes do not declare. Looks for each class in
 * the source itself, then in the packet's other files; a class of another header is left alone.
 * `isOwn` limits it to definitions the packet adds.
 */
export async function declareMembers(
  files: Array<{ path: string; content: string }>,
  allowed: string[],
  current: (path: string) => Promise<string | null>,
  isOwn: (path: string, def: MemberDef) => boolean | Promise<boolean> = () => true,
): Promise<{ files: Array<{ path: string; content: string }>; changes: string[] }> {
  const out = new Map(files.map((f) => [f.path, f.content]));
  const changes: string[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.cpp')) continue;
    const places = [...new Set([f.path, f.path.replace(/\.cpp$/, '.h'), ...allowed])].filter((p) => p === f.path || allowed.includes(p) || out.has(p));
    for (const def of memberDefs(f.content)) {
      if (!(await isOwn(f.path, def))) continue;
      for (const p of places) {
        const src = out.get(p) ?? (await current(p));
        if (src === null) continue;
        const code = lex(src).code;
        const span = classSpan(code, def.cls);
        if (!span) continue;
        const next = declares(code.slice(span.open + 1, span.close), def.name) ? null : addMembers(src, def.cls, def.decl);
        if (next) {
          out.set(p, next);
          changes.push(`${p}: declared ${def.cls}::${def.name} (the .cpp defines it)`);
        }
        break;
      }
    }
  }
  return { files: [...out].map(([path, content]) => ({ path, content })), changes };
}
