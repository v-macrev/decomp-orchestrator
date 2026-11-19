// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal C++ lexing for static checks: blank out comments and string/char literals while keeping
// line structure, so code rules never fire on prose in comments (a main false-positive source),
// and extract top-level function definitions with their bodies for body-level comparisons.

export interface Lexed {
  /** Source with comments and literal contents replaced by spaces (newlines preserved). */
  code: string;
  comments: Array<{ line: number; text: string }>;
  strings: Array<{ line: number; raw: string }>;
}

export function lex(src: string): Lexed {
  const out: string[] = [];
  const comments: Lexed['comments'] = [];
  const strings: Lexed['strings'] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      comments.push({ line, text: src.slice(i + 2, j) });
      out.push(blank(src.slice(i, j)));
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      const chunk = src.slice(i, j);
      comments.push({ line, text: chunk.slice(2, -2) });
      out.push(blank(chunk));
      line += (chunk.match(/\n/g) ?? []).length;
      i = j;
      continue;
    }
    // raw string literal R"delim( ... )delim"
    if (c === 'R' && d === '"' && !/[A-Za-z0-9_]/.test(src[i - 1] ?? '')) {
      const open = src.indexOf('(', i + 2);
      if (open > 0) {
        const delim = src.slice(i + 2, open);
        const close = src.indexOf(`)${delim}"`, open);
        const j = close < 0 ? n : close + delim.length + 2;
        const chunk = src.slice(i, j);
        strings.push({ line, raw: chunk });
        out.push('R"' + blank(chunk.slice(2, -1)) + '"');
        line += (chunk.match(/\n/g) ?? []).length;
        i = j;
        continue;
      }
    }
    if (c === '"' || (c === "'" && !/[0-9A-Fa-f]/.test(src[i - 1] ?? ''))) {
      // ' after a hex digit is a C++14 digit separator (0xFF'FF), not a char literal
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(n, j + 1);
      const chunk = src.slice(i, j);
      strings.push({ line, raw: chunk });
      out.push(c + blank(chunk.slice(1, -1)) + c);
      i = j;
      continue;
    }
    if (c === '\n') line++;
    out.push(c);
    i++;
  }
  return { code: out.join(''), comments, strings };
}

export interface FunctionDef {
  /** Qualified name as written, e.g. "TESForm::GetFormID" or "Foo". */
  name: string;
  line: number;
  /** Body without the outer braces, whitespace-normalised. */
  body: string;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'alignof', 'decltype', 'static_assert', 'noexcept', 'requires']);

/**
 * Extract function definitions at namespace scope (also class-inline definitions one level deep).
 * Works on lexed code (comments/strings blanked), tolerant of templates and qualifiers.
 */
export function extractFunctions(code: string): FunctionDef[] {
  const defs: FunctionDef[] = [];
  const re = /([A-Za-z_~][\w:<>,~ ]*?)\s*\(([^;{}()]*(?:\([^;{}()]*\)[^;{}()]*)*)\)\s*((?:const|noexcept|override|final|volatile|&|&&|\s|->\s*[\w:<>*& ]+)*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const rawName = m[1]!.trim().split(/\s+/).pop() ?? '';
    const name = rawName.replace(/^[*&]+/, '');
    const base = name.split('::').pop() ?? name;
    if (!name || KEYWORDS.has(base) || /^\d/.test(base)) continue;
    // ignore lambdas / initialiser lists: require the char before the name chunk to be a boundary
    const open = m.index + m[0].length - 1;
    let depth = 1;
    let k = open + 1;
    while (k < code.length && depth > 0) {
      const ch = code[k]!;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      k++;
    }
    const body = code.slice(open + 1, k - 1);
    const line = code.slice(0, m.index).split('\n').length;
    defs.push({ name, line, body: normalise(body) });
    re.lastIndex = k; // skip nested content
  }
  return defs;
}

export const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Index of each line start, for offset → line conversion. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Split a call's argument list at top-level commas. `s` starts right after the opening paren. */
export function topLevelArgs(s: string): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    // '<'/'>' are deliberately not tracked: they are usually comparisons, not template brackets
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') {
        args.push(cur.trim());
        return args;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  return null;
}
