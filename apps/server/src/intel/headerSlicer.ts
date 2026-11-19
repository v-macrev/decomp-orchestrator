// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal local context: instead of pasting whole included headers into every prompt, parse them
// with tree-sitter (C++ grammar, WASM — no native build) and keep only the declarations a packet
// actually needs, in priority order, within a token budget:
//
//   1. the packet's own class(es) and their bases (transitively) — with data members (offsets),
//      virtual methods (vtable order), and only the non-virtual methods the packet references;
//   2. static_asserts on those classes (size/offset constraints);
//   3. types, enums, aliases, globals and free functions the unit files reference;
//   4. one level of types referenced from the fields of what was already included.
//
// Everything else is dropped with a one-line note. If the grammar cannot load, a lexical fallback
// keeps the referenced class bodies by brace matching (same priorities, coarser compaction).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lex } from '../gatekeeper/cpp.js';
import { estimateTokens } from '../util/tokens.js';

type TSNode = {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
  descendantsOfType(types: string | string[]): TSNode[];
};
type TSParser = { parse(src: string): { rootNode: TSNode; delete?: () => void } };

export interface HeaderSource {
  path: string;
  text: string;
}

export interface SliceRequest {
  headers: HeaderSource[];
  /** Class names the packet's functions belong to (highest priority). */
  primary: string[];
  /** Identifiers referenced by the unit files / function names / knowledge. */
  references: Set<string>;
  maxTokens: number;
}

export interface SliceResult {
  text: string;
  tokens: number;
  rawTokens: number;
  included: string[];
  truncated: boolean;
  /** Patterns visible in the sliced types (e.g. "vtable" when an included class has virtual methods). */
  patterns: string[];
  engine: 'tree-sitter' | 'lexical';
}

interface Decl {
  name: string | null;
  kind: 'class' | 'enum' | 'alias' | 'assert' | 'global' | 'function' | 'other';
  ns: string;
  text: string;
  refs: Set<string>;
  bases: string[];
  hasVirtual: boolean;
  path: string;
}

let parserPromise: Promise<TSParser | null> | null = null;

async function loadParser(): Promise<TSParser | null> {
  try {
    const require = createRequire(import.meta.url);
    const ts = (await import('web-tree-sitter')) as unknown as {
      Parser: { init(): Promise<void>; new (): TSParser & { setLanguage(l: unknown): void } };
      Language: { load(p: string): Promise<unknown> };
    };
    await ts.Parser.init();
    const lang = await ts.Language.load(require.resolve('tree-sitter-cpp/tree-sitter-cpp.wasm'));
    const p = new ts.Parser();
    p.setLanguage(lang);
    return p;
  } catch {
    return null;
  }
}

const DECL_CACHE_MAX = 128;

export class HeaderSlicer {
  /** Parsed declarations per header content: headers repeat across packets, parsing is the cost. */
  private declCache = new Map<string, Decl[]>();

  private constructor(private parser: TSParser | null) {}

  private decls(h: HeaderSource): Decl[] {
    const key = `${h.path}\0${createHash('sha1').update(h.text).digest('hex')}`;
    const hit = this.declCache.get(key);
    if (hit) {
      this.declCache.delete(key); // LRU refresh
      this.declCache.set(key, hit);
      return hit;
    }
    const d = this.parser ? this.declsTreeSitter(h) : declsLexical(h);
    this.declCache.set(key, d);
    if (this.declCache.size > DECL_CACHE_MAX) this.declCache.delete(this.declCache.keys().next().value!);
    return d;
  }

  static async create(): Promise<HeaderSlicer> {
    parserPromise ??= loadParser();
    return new HeaderSlicer(await parserPromise);
  }

  get engine(): 'tree-sitter' | 'lexical' {
    return this.parser ? 'tree-sitter' : 'lexical';
  }

  slice(req: SliceRequest): SliceResult {
    const rawTokens = req.headers.reduce((s, h) => s + estimateTokens(h.text), 0);
    const decls = req.headers.flatMap((h) => this.decls(h));
    const byName = new Map<string, Decl[]>();
    for (const d of decls) if (d.name) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);

    // priority: primary classes + bases (100..90), referenced names (50), field-type deps (20)
    const score = new Map<Decl, number>();
    const bump = (d: Decl, s: number) => score.set(d, Math.max(score.get(d) ?? 0, s));
    const queue: Array<[string, number]> = req.primary.map((p) => [p, 100]);
    const seenName = new Set<string>();
    while (queue.length) {
      const [name, s] = queue.shift()!;
      if (seenName.has(name)) continue;
      seenName.add(name);
      for (const d of byName.get(name) ?? []) {
        bump(d, s);
        for (const b of d.bases) queue.push([b, s - 2]);
      }
    }
    for (const r of req.references) for (const d of byName.get(r) ?? []) bump(d, 50);
    for (const d of decls) {
      if (d.kind === 'assert' && [...d.refs].some((r) => [...score.keys()].some((k) => k.name === r && k.kind === 'class'))) bump(d, 60);
    }
    for (const [d, s] of [...score]) {
      if (d.kind !== 'class' || s < 50) continue;
      for (const r of d.refs) for (const dep of byName.get(r) ?? []) if (!score.has(dep)) bump(dep, 20);
    }

    const ranked = [...score].sort((a, b) => b[1] - a[1] || a[0].text.length - b[0].text.length).map(([d]) => d);
    const out: Decl[] = [];
    let used = 0;
    let truncated = false;
    for (const d of ranked) {
      const body = d.kind === 'class' ? compactClass(d, req.references) : d.text;
      const t = estimateTokens(body) + 2;
      if (used + t > req.maxTokens) {
        truncated = true;
        if (score.get(d)! >= 90 && used < req.maxTokens * 0.8) {
          const room = Math.floor((req.maxTokens - used) * 3.3) - 40;
          out.push({ ...d, text: `${body.slice(0, Math.max(0, room))}\n    // … truncated to fit the context budget` });
          used = req.maxTokens;
        }
        continue;
      }
      out.push({ ...d, text: body });
      used += t;
    }
    const dropped = decls.filter((d) => d.name && !out.some((o) => o.name === d.name)).length;
    const text = render(out, dropped);
    const patterns = out.some((d) => d.hasVirtual) ? ['vtable'] : [];
    return { text, tokens: estimateTokens(text), rawTokens, included: out.map((d) => d.name ?? d.kind), truncated, patterns, engine: this.engine };
  }

  private declsTreeSitter(h: HeaderSource): Decl[] {
    const tree = this.parser!.parse(h.text);
    const out: Decl[] = [];
    const visit = (n: TSNode, ns: string) => {
      for (const c of n.namedChildren) {
        if (c.type === 'namespace_definition') {
          const name = c.childForFieldName('name')?.text ?? '';
          const body = c.childForFieldName('body');
          if (body) visit(body, ns ? `${ns}::${name}` : name);
          continue;
        }
        if (c.type === 'linkage_specification') {
          const body = c.childForFieldName('body');
          if (body) visit(body, ns);
          continue;
        }
        const d = toDecl(c, ns, h.path);
        if (d) out.push(d);
      }
    };
    visit(tree.rootNode, '');
    tree.delete?.();
    return out;
  }
}

function idents(n: TSNode): Set<string> {
  return new Set(n.descendantsOfType(['type_identifier', 'identifier', 'namespace_identifier', 'field_identifier']).map((x) => x.text));
}

function toDecl(c: TSNode, ns: string, path: string): Decl | null {
  const base = { ns, text: c.text, refs: idents(c), bases: [] as string[], hasVirtual: false, path };
  const inner = c.type === 'template_declaration' ? c.namedChildren.find((k) => /class_specifier|struct_specifier|union_specifier/.test(k.type)) : c;
  if (inner && /^(class|struct|union)_specifier$/.test(inner.type) && inner.childForFieldName('body')) {
    const bc = inner.namedChildren.find((k) => k.type === 'base_class_clause');
    return {
      ...base, name: inner.childForFieldName('name')?.text ?? null, kind: 'class',
      bases: (bc?.namedChildren ?? []).filter((k) => k.type !== 'access_specifier').map((k) => k.text.replace(/^.*::/, '').replace(/<.*$/, '')),
      hasVirtual: /\bvirtual\b/.test(inner.childForFieldName('body')!.text),
    };
  }
  switch (c.type) {
    case 'enum_specifier':
      return { ...base, name: c.childForFieldName('name')?.text ?? null, kind: 'enum' };
    case 'alias_declaration':
      return { ...base, name: c.childForFieldName('name')?.text ?? null, kind: 'alias' };
    case 'type_definition': {
      const ids = c.namedChildren.filter((k) => k.type === 'type_identifier');
      return { ...base, name: ids[ids.length - 1]?.text ?? null, kind: 'alias' };
    }
    case 'static_assert_declaration':
      return { ...base, name: null, kind: 'assert' };
    case 'declaration': {
      const fn = c.descendantsOfType('function_declarator')[0];
      if (fn) {
        const id = fn.childForFieldName('declarator')?.text ?? null;
        return { ...base, name: id ? id.replace(/^.*::/, '') : null, kind: 'function' };
      }
      const ids = c.namedChildren.filter((k) => k.type === 'identifier' || k.type === 'init_declarator');
      const id = ids[0]?.type === 'init_declarator' ? ids[0].childForFieldName('declarator')?.text : ids[0]?.text;
      return { ...base, name: id ?? null, kind: 'global' };
    }
    case 'comment':
    case 'preproc_call':
    case 'preproc_include':
      return null;
    default:
      return null;
  }
}

/**
 * Keep what defines layout and dispatch (data members, virtual methods, access specifiers, the
 * methods the packet references); collapse the rest into a count.
 */
function compactClass(d: Decl, refs: Set<string>): string {
  const lines = d.text.split('\n');
  if (lines.length <= 14) return d.text;
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    const s = line.trim();
    const isMethod = /\)\s*(const)?\s*(override|final|noexcept)?\s*(=\s*0)?\s*;/.test(s) && !/^(using|typedef|friend)\b/.test(s);
    const name = /([~\w]+)\s*\(/.exec(s)?.[1];
    if (isMethod && !/\bvirtual\b|\boverride\b/.test(s) && !(name && refs.has(name))) {
      dropped++;
      continue;
    }
    kept.push(line);
  }
  if (dropped) {
    const close = kept.findLastIndex((l) => /^\s*\}/.test(l));
    const indent = /^\s*/.exec(kept[1] ?? '    ')?.[0] ?? '    ';
    kept.splice(close < 0 ? kept.length : close, 0, `${indent}// … ${dropped} non-virtual member function(s) not used by this packet elided`);
  }
  return kept.join('\n');
}

function render(decls: Decl[], dropped: number): string {
  const out: string[] = [];
  let curNs = '';
  const open = (ns: string) => {
    if (ns === curNs) return;
    if (curNs) out.push(`} // namespace ${curNs}`);
    if (ns) out.push(`namespace ${ns}\n{`);
    curNs = ns;
  };
  const byPath = new Map<string, Decl[]>();
  for (const d of decls) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d]);
  for (const [path, list] of byPath) {
    open('');
    out.push(`// from ${path}`);
    for (const d of list) {
      open(d.ns);
      out.push(d.text);
    }
  }
  open('');
  if (dropped) out.push(`// ${dropped} other declaration(s) in the included headers are not referenced by this packet and were omitted`);
  return out.join('\n');
}

/** Fallback without tree-sitter: top-level class/struct bodies by brace matching on lexed code. */
function declsLexical(h: HeaderSource): Decl[] {
  const code = lex(h.text).code;
  const out: Decl[] = [];
  const re = /\b(class|struct|union|enum(?:\s+class)?)\s+(\w+)\s*(?::\s*([^{;]+))?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 1;
    let k = m.index + m[0].length;
    while (k < code.length && depth > 0) {
      if (code[k] === '{') depth++;
      else if (code[k] === '}') depth--;
      k++;
    }
    const end = code.indexOf(';', k);
    const text = h.text.slice(m.index, end < 0 ? k : end + 1);
    const isEnum = m[1]!.startsWith('enum');
    out.push({
      name: m[2]!, kind: isEnum ? 'enum' : 'class', ns: '', text, refs: new Set(text.match(/[A-Za-z_]\w*/g) ?? []),
      bases: isEnum ? [] : (m[3] ?? '').split(',').map((b) => b.replace(/\b(public|private|protected|virtual)\b/g, '').trim().replace(/^.*::/, '')).filter(Boolean),
      hasVirtual: /\bvirtual\b/.test(text), path: h.path,
    });
    re.lastIndex = k;
  }
  for (const a of h.text.matchAll(/static_assert\s*\([^;]*\);/g)) out.push({ name: null, kind: 'assert', ns: '', text: a[0], refs: new Set(a[0].match(/[A-Za-z_]\w*/g) ?? []), bases: [], hasVirtual: false, path: h.path });
  return out;
}
