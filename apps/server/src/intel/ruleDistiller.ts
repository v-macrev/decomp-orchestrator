// SPDX-License-Identifier: AGPL-3.0-or-later
// RepoRuleDistiller: compress the repository's contributor docs (~25k chars) into
//   * ~500 tokens of universal rules for the static system prefix (byte-identical for a whole run,
//     so every call after the first reads it from the provider's prompt cache), and
//   * pattern-tagged recipes (one per cookbook section) stored as lessons and injected only into
//     packets whose functions show that pattern (SSE, vtables, loops, EH, ...).
//
// Deterministic by design: no model call, stable ordering, same docs → same bytes → same cache key.
// Trade-off: extraction is keyword/imperative based, so it keeps rules phrased as rules and misses
// rules buried in prose; the full docs remain one `sr` command away for humans, and recipes cover
// the long tail per pattern.
import { createHash } from 'node:crypto';
import type { DocSection } from '../repo/types.js';
import { estimateTokens } from '../util/tokens.js';

export const TAG_RULES: Array<[string, RegExp]> = [
  ['sse', /\b(float|double|sse\d?|xmm|simd|vector|cvt\w*|comis\w*|ucomis\w*)\b/i],
  ['vtable', /\b(virtual|vtable|vtbl|vfunc|override|rtti|polymorph\w*)\b/i],
  ['eh', /\b(exception|unwind|destructors?|funclets?|try|catch|seh|eh)\b/i],
  ['loop', /\b(loops?|iterat\w+|while|for loop)\b/i],
  ['switch', /\b(switch|jump tables?|case labels?)\b/i],
  ['tailcall', /\b(tail[- ]?(call|jump)s?)\b/i],
  ['globals', /\b(globals?|rip-relative|static data|extern)\b/i],
  ['struct', /\b(struct|layout|offsets?|offsetof|sizeof|static_assert|padding|fields?)\b/i],
  ['header', /\b(header|code origin|labels?|exposure|spdx|licen[cs]e)\b/i],
  ['accessor', /\b(accessors?|getters?|setters?)\b/i],
];

export function tagText(text: string): string[] {
  const tags = TAG_RULES.filter(([, re]) => re.test(text)).map(([t]) => t);
  return tags.length ? tags.sort() : ['general'];
}

export interface Recipe {
  id: string;
  topic: string;
  text: string;
  tags: string[];
  weight: number;
}

export interface DistilledRules {
  /** Rendered rules block for the static prefix. */
  text: string;
  tokens: number;
  rules: string[];
  recipes: Recipe[];
  /** sha256 of the source docs (provenance; the static prefix hash covers the rendered text). */
  sourceHash: string;
  rawTokens: number;
}

const DOC_PRIORITY: Record<string, number> = { 'contributor-card': 3, 'contributor-lessons': 3, 'declaration-kit': 2, 'matching-cookbook': 1 };
const STRONG = /\b(never|must|always|do not|don't|only|required?|forbidden|reject(ed)?)\b/i;
const MEDIUM = /\b(keep|use|prefer|declare|match|write|add|fill|label|include)\b/i;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Section {
  doc: string;
  heading: string;
  lines: string[];
}

function sections(d: DocSection): Section[] {
  const out: Section[] = [];
  let cur: Section = { doc: d.id, heading: d.title, lines: [] };
  for (const line of d.content.split('\n')) {
    const h = /^#{1,4}\s+(.+)$/.exec(line);
    if (h) {
      if (cur.lines.length) out.push(cur);
      cur = { doc: d.id, heading: h[1]!.trim(), lines: [] };
    } else if (line.trim()) cur.lines.push(line.trim());
  }
  if (cur.lines.length) out.push(cur);
  return out;
}

/** Imperative candidate statements of a section: bullets, else sentences. */
function statements(s: Section): string[] {
  const bullets = s.lines.filter((l) => /^[-*]\s+|^\d+[.)]\s+/.test(l)).map((l) => l.replace(/^([-*]|\d+[.)])\s+/, ''));
  const src = bullets.length ? bullets : s.lines.join(' ').split(/(?<=[.!?])\s+(?=[A-Z`])/);
  return src
    .map((x) => x.replace(/\s*\((?:see )?docs\/[^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((x) => x.length >= 16 && (STRONG.test(x) || MEDIUM.test(x)))
    .map((x) => (x.length > 220 ? `${x.slice(0, x.search(/[.;](\s|$)/) + 1 || 217)}`.slice(0, 220) : x));
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z_]{3,}/g) ?? []);
function similar(a: string, b: string) {
  const A = words(a);
  const B = words(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.max(1, Math.min(A.size, B.size)) > 0.7;
}

export function distillRules(docs: DocSection[], opts: { maxTokens: number; source: string }): DistilledRules {
  const rawTokens = docs.reduce((s, d) => s + estimateTokens(d.content), 0);
  const secs = docs.flatMap(sections);
  const candidates: Array<{ text: string; score: number; order: number }> = [];
  let order = 0;
  for (const s of secs) {
    const prio = DOC_PRIORITY[s.doc] ?? 1;
    for (const st of statements(s)) {
      const tags = tagText(`${s.heading} ${st}`);
      // Pattern-specific statements belong to recipes, not to the universal prefix.
      const universal = tags.includes('general') || tags.includes('header') || (tags.length === 1 && tags[0] === 'struct');
      if (!universal && s.doc === 'matching-cookbook') continue;
      const score = prio * 2 + (STRONG.test(st) ? 3 : 1) - st.length / 200;
      candidates.push({ text: st, score, order: order++ });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const picked: typeof candidates = [];
  let used = 0;
  for (const c of candidates) {
    if (picked.some((p) => similar(p.text, c.text))) continue;
    const t = estimateTokens(c.text) + 2;
    if (used + t > opts.maxTokens) continue;
    picked.push(c);
    used += t;
  }
  picked.sort((a, b) => a.order - b.order); // document order reads better than score order
  const rules = picked.map((p) => p.text);
  const text = `<repository_rules source="${opts.source}">\n${rules.map((r) => `- ${r}`).join('\n')}\n</repository_rules>`;

  // Recipes: every section with a specific pattern tag, condensed to its top statements.
  const recipes: Recipe[] = [];
  for (const s of secs) {
    const body = statements(s);
    if (!body.length) continue;
    const tags = tagText(`${s.heading} ${body.join(' ')}`).filter((t) => t !== 'general');
    if (!tags.length) continue;
    const top = body.filter((b, i) => body.findIndex((o) => similar(o, b)) === i).slice(0, 3);
    let txt = `${s.heading}: ${top.join(' ')}`;
    if (txt.length > 420) txt = `${txt.slice(0, 417)}…`;
    recipes.push({ id: `recipe:${sha(`${s.doc}/${s.heading}`).slice(0, 16)}`, topic: s.heading, text: txt, tags: tagText(s.heading).filter((t) => t !== 'general').length ? tagText(s.heading) : tags, weight: (DOC_PRIORITY[s.doc] ?? 1) + 4 });
  }
  return { text, tokens: estimateTokens(text), rules, recipes, sourceHash: sha(docs.map((d) => `${d.id}\0${d.content}`).join('\0')), rawTokens };
}
