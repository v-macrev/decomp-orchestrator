// SPDX-License-Identifier: AGPL-3.0-or-later
// Repo-history bootstrap, deterministic half: skyrim_decomp's matching cookbook is a list of
// numbered recipes distilled from closed PRs ("**16. A flag bit tested as load, shr, test al,1: a
// by-value bit-index helper.** (high)" + Symptom / Cause / Fix + a code example). Each recipe
// becomes a candidate skill whose triggers are derived from the recipe itself:
//   * mnemonics — asm spans the recipe attributes to the *target* listing (never the candidate's);
//   * failures  — comparator reason codes it names (`function-size-mismatch`);
//   * patterns/features — shape words in the title and symptom (virtual slot → indirect calls).
// Recipes with no derivable trigger are skipped: a skill that can never fire deterministically is
// dead weight. Candidates still go through shadow evaluation before they are used.
import { compressSkillBody } from './compress.js';
import { sanitizeSkillText } from './sanitize.js';
import { regexProblem } from './matcher.js';
import { SkillTrigger, type SkillDraft } from './schemas.js';

export interface Recipe {
  number: number;
  section: string;
  title: string;
  confidence: 'high' | 'medium' | 'low' | null;
  text: string;
}

const ASM = new Set(('mov movzx movsx movsxd movaps movups movss movsd movd movq lea push pop call jmp je jne jz jnz ja jae jb jbe jg jge jl jle js jns ' +
  'cmp test xor and or add sub adc sbb imul mul idiv div inc dec shl shr sar sal rol ror neg not bt bts btr btc setne sete setz setnz ' +
  'setg setl seta setb cmove cmovne cmovz cmovnz cmovg cmovl cvtsi2ss cvtss2sd cvttss2si cvtsd2ss comiss ucomiss comisd ucomisd ' +
  'addss subss mulss divss sqrtss andps xorps orps maxss minss shufps unpcklps cdq cqo cwde movabs xchg ret').split(' '));
const COMMON = new Set('mov lea push pop call jmp je jne jz jnz xor and or add sub cmp inc dec ret'.split(' '));
const RARE = /^(bt[src]?|set[a-z]+|cmov[a-z]+|cvt\w+|u?comis[sd]|sqrt\w+|shufps|unpck\w+|cdq|cqo)$/;
const REG = /^(?:[re]?[abcd]x|[abcd][lh]|[re]?[sd]il?|[re]?[sb]pl?|r\d{1,2}[dwb]?|xmm\d{1,2}|e?ip)$/i;

const SHAPE: Array<[string, RegExp]> = [
  ['vtable', /\b(virtual|vtable|vftable|vfunc)\b|\bslot (?:0x)?[0-9]/i],
  ['switch', /\bswitch\b|jump tables?/i],
  ['loop', /\bloops?\b/i],
  ['eh', /\b(try|catch|unwind|funclets?|exception)\b/i],
  ['destructor', /\b(destructor|~\w+|\?\?_G|\?\?1)\b/i],
  ['sse', /\b(float|double|xmm\d*|sse|scalar single)\b/i],
  ['tailcall', /\btail[- ]?(call|jump)s?\b/i],
  ['accessor', /\b(accessor|getter|setter)\b/i],
];
const FAILURE_CODE = /^[a-z]+(?:-[a-z0-9]+){1,4}$/;

/** Parse numbered "**N. Title.** (confidence)" recipes, section by section. */
export function parseCookbook(markdown: string): Recipe[] {
  const out: Recipe[] = [];
  let section = '';
  const lines = markdown.replace(/\r/g, '').split('\n');
  let cur: Recipe | null = null;
  const push = () => {
    if (cur) out.push({ ...cur, text: cur.text.trim() });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^#{1,3}\s+(.+)$/.exec(line);
    if (h) {
      push();
      section = h[1]!.trim();
      continue;
    }
    const start = /^\*\*(\d+)\.\s+(.*)$/.exec(line);
    if (start) {
      push();
      // the bold title may wrap onto the next line(s)
      let head = start[2]!;
      while (!head.includes('**') && i + 1 < lines.length && lines[i + 1]!.trim()) head += ` ${lines[++i]!.trim()}`;
      const close = head.indexOf('**');
      const title = (close >= 0 ? head.slice(0, close) : head).replace(/\.\s*$/, '').trim();
      let rest = close >= 0 ? head.slice(close + 2) : '';
      if (!/\((high|medium|low)\)/i.test(rest) && /^\s*\((high|medium|low)\)/i.test(lines[i + 1] ?? '')) rest += ` ${lines[++i]!.trim()}`;
      const conf = /\((high|medium|low)\)/i.exec(rest)?.[1]?.toLowerCase() as Recipe['confidence'] | undefined;
      cur = { number: Number(start[1]), section, title, confidence: conf ?? null, text: rest.replace(/\((high|medium|low)\)/i, '').trim() };
      continue;
    }
    if (cur) (cur as Recipe).text += `\n${line}`;
  }
  push();
  return out;
}

/** Split prose into clauses at sentence ends and semicolons that sit outside backticks. */
function clauses(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let tick = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '`') tick = !tick;
    buf += c;
    if (!tick && (c === ';' || ((c === '.' || c === '!' || c === '?') && /\s/.test(text[i + 1] ?? ' ')))) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** An objdump-style regex for one asm piece ("test al,1" → /\btest\s+al\s*,\s*(?:0x)?[0-9a-f]+h?\b/). */
export function asmPieceRegex(piece: string): string | null {
  const m = /^\s*([a-z][a-z0-9]{1,9})\b\s*(.*)$/i.exec(piece.trim());
  if (!m) return null;
  const mn = m[1]!.toLowerCase();
  if (!ASM.has(mn)) return null;
  const ops = m[2]!.split(',').map((o) => o.trim()).filter(Boolean);
  const literal = ops.some((o) => /^(?:0x)?[0-9a-f]+h?$/i.test(o));
  if (COMMON.has(mn) && !literal) return null; // "mov rax,..." alone says nothing
  if (COMMON.has(mn) && mn !== 'cmp' && mn !== 'and' && mn !== 'xor') return null;
  const opRe = ops.map((o) => {
    if (REG.test(o)) return o.toLowerCase();
    if (/^(?:0x)?[0-9a-f]+h?$/i.test(o)) return '(?:0x)?[0-9a-f]+h?';
    if (/^(?:byte|word|dword|qword)\s+ptr/i.test(o)) return '(?:byte|word|dword|qword) ptr ?\\[[^\\]]*\\]';
    if (/^\[.*\]$/.test(o)) return '\\[[^\\]]*\\]';
    return null;
  });
  if (opRe.some((o) => o === null)) return RARE.test(mn) ? `\\b${mn}\\b` : null; // "test [mem],imm": too generic
  if (!opRe.length && !RARE.test(mn)) return null; // a bare common mnemonic matches every listing
  const src = opRe.length ? `\\b${mn}\\s+${opRe.join('\\s*,\\s*')}` : `\\b${mn}\\b`;
  return regexProblem(src) ? null : src;
}

export function recipeTriggers(r: Recipe): SkillTrigger {
  const all = `${r.title}. ${r.text}`;
  const mnemonics = new Set<string>();
  const failures = new Set<string>();
  for (const cl of clauses(all)) {
    const spans = [...cl.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    for (const s of spans) if (FAILURE_CODE.test(s) && /(mismatch|missing|error|size|undefined)/.test(s)) failures.add(s);
    // only asm the recipe attributes to the target listing (the candidate's code is what we must fix)
    const aboutTarget = /\btarget\b|\bthe original\b|\blisting\b/i.test(cl) && !/\bcandidate\b/i.test(cl);
    const inTitle = cl.includes(r.title.slice(0, 20));
    if (!aboutTarget && !inTitle) continue;
    for (const s of spans) for (const piece of s.split(/;|\n/)) {
      const re = asmPieceRegex(piece);
      if (re) mnemonics.add(re);
    }
  }
  // asm named in the title itself ("load, shr, test al,1") without backticks
  for (const piece of r.title.split(/[,:]/)) {
    const re = asmPieceRegex(piece);
    if (re && /\s/.test(piece.trim())) mnemonics.add(re);
  }
  const symptom = /Symptom:([^]*?)(?:Cause:|Fix:|$)/i.exec(r.text)?.[1] ?? r.text.split(/\n/)[0] ?? '';
  const shapeText = `${r.title} ${symptom}`;
  const patterns = SHAPE.filter(([, re]) => re.test(shapeText)).map(([t]) => t).filter((t) => t !== 'destructor');
  const destructor = SHAPE.find(([t]) => t === 'destructor')![1].test(shapeText);
  const features: SkillTrigger['features'] = {};
  if (patterns.includes('vtable')) features.minIndirectCalls = 1;
  if (patterns.includes('loop')) features.minLoops = 1;
  if (patterns.includes('switch')) features.minIndirectJumps = 1;
  if (patterns.includes('sse')) features.minSseOps = 1;
  if (destructor) features.destructor = true;
  const mn = [...mnemonics].slice(0, 6);
  // With a listing signature, require it (or two independent shape signals): pattern words alone
  // over-trigger. Without one, shape + pattern together must agree.
  const minScore = mn.length ? 3 : 2.5;
  return SkillTrigger.parse({ mnemonics: mn, failures: [...failures].slice(0, 6), patterns, features, minScore });
}

export function recipeToDraft(r: Recipe): SkillDraft | null {
  const triggers = recipeTriggers(r);
  const hasTrigger = triggers.mnemonics.length || triggers.failures.length || (triggers.patterns.length && Object.keys(triggers.features).length);
  if (!hasTrigger) return null;
  const body = compressSkillBody(`**${r.title}.**${r.confidence ? ` (${r.confidence} confidence)` : ''}\n${sanitizeSkillText(r.text)}`, { target: 420 }).body;
  const symptom = /Symptom:\s*([^.]*\.)/i.exec(r.text)?.[1] ?? r.title;
  return {
    name: r.title.length > 120 ? `${r.title.slice(0, 117)}…` : r.title,
    description: sanitizeSkillText(symptom).slice(0, 400),
    body,
    triggers,
    rationale: `matching cookbook §${r.section} recipe ${r.number}${r.confidence ? ` (${r.confidence})` : ''}`,
  };
}

export function draftsFromCookbook(markdown: string, opts: { skipSections?: RegExp } = {}): Array<SkillDraft & { recipe: number; section: string }> {
  const skip = opts.skipSections ?? /unsolved|permuter|method/i;
  return parseCookbook(markdown)
    .filter((r) => !skip.test(r.section))
    .flatMap((r) => {
      const d = recipeToDraft(r);
      return d ? [{ ...d, recipe: r.number, section: r.section }] : [];
    });
}
