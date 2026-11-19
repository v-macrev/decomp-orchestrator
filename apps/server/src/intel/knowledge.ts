// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared cross-worker knowledge for one bulk run.
//
// When a packet passes the Gate Keeper, its accepted files are mined for facts the comparator just
// vouched for: callee declarations that bound to real symbols (verified helper signatures), the
// signatures of the matched functions, struct/class layouts (with their static_asserts), externs
// and enums. Entries are keyed by symbol and stored in run_knowledge_cache; the context builder
// offers them to later packets that reference those symbols.
//
// Only content that differs from the base revision is extracted (new knowledge), and only from
// accepted files — never from rejected candidates — so a bad guess cannot propagate.
import type { KnowledgeEntry, KnowledgeKind } from '@decomp/core';
import { extractFunctions, lex } from '../gatekeeper/cpp.js';

const CPP_KEYWORDS = new Set(
  'alignas alignof auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public return short signed sizeof static static_assert struct switch template this throw true try typedef typename union unsigned using virtual void volatile while override final std uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t size_t'.split(' '),
);

export function identifiersOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_~][A-Za-z0-9_]*)*/g)) {
    const id = m[0];
    if (id.length < 3 || CPP_KEYWORDS.has(id)) continue;
    out.add(id);
    if (id.includes('::')) for (const part of id.split('::')) if (part.length >= 3 && !CPP_KEYWORDS.has(part)) out.add(part);
  }
  return [...out];
}

interface Fact {
  kind: KnowledgeKind;
  symbol: string;
  content: string;
}

/** Facts in a source file, found lexically (comments/strings blanked first). */
export function factsOf(src: string): Fact[] {
  const code = lex(src).code;
  const defs = extractFunctions(code);
  const inBody = (off: number) => defs.some((d) => off > d.open && off < d.close);
  const facts: Fact[] = [];

  // Matched / defined functions: their signatures.
  for (const d of defs) facts.push({ kind: 'function_signature', symbol: d.name, content: `${d.signature};` });

  // Class / struct / enum definitions (outside function bodies).
  const typeRe = /\b(class|struct|union|enum(?:\s+class)?)\s+(\w+)\s*(?::\s*[^{;]+)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(code))) {
    if (inBody(m.index)) continue;
    let depth = 1;
    let k = m.index + m[0].length;
    while (k < code.length && depth > 0) {
      if (code[k] === '{') depth++;
      else if (code[k] === '}') depth--;
      k++;
    }
    const end = code.indexOf(';', k - 1);
    let text = src.slice(code.lastIndexOf('\n', m.index) + 1, end < 0 ? k : end + 1).trim();
    const name = m[2]!;
    const asserts = [...src.matchAll(new RegExp(`static_assert\\s*\\([^;]*\\b${name}\\b[^;]*\\);`, 'g'))].map((a) => a[0]);
    if (asserts.length) text += `\n${asserts.join('\n')}`;
    if (text.length > 1_600) text = `${text.slice(0, 1_560)}\n    // … (layout continues)`;
    facts.push({ kind: m[1]!.startsWith('enum') ? 'type_decl' : 'struct_layout', symbol: name, content: text });
    typeRe.lastIndex = k;
  }

  // Declarations at namespace/class scope: callees (bound by the comparator), externs.
  const lines = src.split('\n');
  let off = 0;
  for (const line of lines) {
    const lexedLine = code.slice(off, off + line.length);
    if (!inBody(off)) {
      const ext = /^\s*extern\s+(?!"C")[^;(]*?\b(\w+)\s*(\[[^\]]*\])?\s*;/.exec(lexedLine);
      if (ext) facts.push({ kind: 'global', symbol: ext[1]!, content: line.trim() });
      const decl = /^\s*(?:virtual\s+|static\s+|inline\s+)*[\w:<>,*&\s]+?\b([A-Za-z_~][\w]*(?:::[A-Za-z_~][\w]*)*)\s*\([^;{}]*\)\s*(?:const)?\s*(?:noexcept)?\s*(?:override)?\s*;\s*$/.exec(lexedLine);
      if (decl && !/^\s*(return|using|typedef|friend)\b/.test(lexedLine)) facts.push({ kind: 'function_signature', symbol: decl[1]!, content: line.trim() });
    }
    off += line.length + 1;
  }
  return facts;
}

/** New, verified facts from a passing packet's accepted files (relative to the base revision). */
export function extractKnowledge(input: {
  runId: string;
  taskId: string;
  unit: string;
  files: Array<{ path: string; content: string }>;
  base: Map<string, string | null>;
}): KnowledgeEntry[] {
  const out = new Map<string, KnowledgeEntry>();
  const now = Date.now();
  for (const f of input.files) {
    const before = new Set(factsOf(input.base.get(f.path) ?? '').map((x) => `${x.kind}\0${x.symbol}\0${x.content}`));
    for (const fact of factsOf(f.content)) {
      if (before.has(`${fact.kind}\0${fact.symbol}\0${fact.content}`)) continue;
      out.set(`${fact.kind}\0${fact.symbol}`, {
        runId: input.runId, kind: fact.kind, symbol: fact.symbol, content: fact.content, symbols: identifiersOf(fact.content).slice(0, 40),
        sourceTaskId: input.taskId, sourceUnit: input.unit, verifiedAt: now, uses: 0,
      });
    }
  }
  return [...out.values()];
}
