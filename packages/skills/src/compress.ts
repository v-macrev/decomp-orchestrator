// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic token compression for skill bodies: sanitize → strip filler → merge near-duplicate
// sentences → trim long examples → drop the lowest-signal prose until the target is met. Rules and
// "Fix:" lines outrank narrative; code examples are kept (shortened) as long as possible because a
// before/after snippet is the highest-signal part of a matching recipe.
//
// The optimizer can also ask a model to compress; either way the result is a proposal that must hold
// the shadow-evaluation pass rate before it replaces the current version.
import { sanitizeSkillText } from './sanitize.js';
import { SKILL_TOKEN_CAP, estimateTokens } from './tokens.js';

export interface CompressResult {
  body: string;
  tokens: number;
  before: number;
  removed: string[];
}

interface Item {
  block: number;
  kind: 'code' | 'bullet' | 'sentence' | 'heading';
  text: string;
  prio: number;
}

const FILLER: Array<[RegExp, string]> = [
  [/\b(basically|actually|simply|really|very|quite|obviously|clearly|essentially)\b,?\s+/gi, ''],
  [/\b(note that|it is (important|worth noting|useful) (to note )?that|keep in mind that|remember that)\s+/gi, ''],
  [/\bin order to\b/gi, 'to'],
  [/\bis able to\b/gi, 'can'],
  [/\bmake sure (that )?/gi, 'ensure '],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bfor example\b/gi, 'e.g.'],
  [/\s{2,}/g, ' '],
];
const STRONG = /^(fix|symptom|cause|never|always|do not|don't|use|declare|write|keep|prefer|test|put|read|bind|pass|wrap|drop|add|try|check|define)\b/i;
const IMPERATIVE = /\b(must|never|always|instead|rather than|fix|declare|keep|write|use|prefer)\b/i;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []);
function similar(a: string, b: string, thr: number): boolean {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) > thr;
}

function itemsOf(body: string): Item[] {
  const items: Item[] = [];
  const blocks: string[] = [];
  // keep fenced code blocks intact even when they contain blank lines
  let cur: string[] = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (!inFence && cur.length) {
        blocks.push(cur.join('\n'));
        cur = [];
      }
      cur.push(line);
      inFence = !inFence;
      if (!inFence) {
        blocks.push(cur.join('\n'));
        cur = [];
      }
      continue;
    }
    if (!inFence && !line.trim()) {
      if (cur.length) blocks.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));

  blocks.forEach((b, bi) => {
    if (/^\s*```/.test(b)) {
      const lines = b.split('\n');
      const inner = lines.slice(1, -1).filter((l, i, a) => !(l.trim().startsWith('//') && i > 0 && a[i - 1]!.trim().startsWith('//')));
      const kept = inner.length > 10 ? [...inner.slice(0, 9), '    // …'] : inner;
      items.push({ block: bi, kind: 'code', text: [lines[0], ...kept, '```'].join('\n'), prio: 8 });
      return;
    }
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-*]|\d+[.)])\s+/.test(l) || /^#{1,4}\s/.test(l))) {
      for (const l of lines) items.push({ block: bi, kind: /^#{1,4}\s/.test(l) ? 'heading' : 'bullet', text: l, prio: 0 });
      return;
    }
    const para = lines.join(' ').replace(/\s+/g, ' ').trim();
    for (const s of para.split(/(?<=[.!?])\s+(?=[A-Z`(*])/)) items.push({ block: bi, kind: 'sentence', text: s, prio: 0 });
  });
  for (const it of items) {
    if (it.kind === 'code') continue;
    if (it.kind === 'heading') {
      it.prio = 9;
      continue;
    }
    for (const [re, rep] of FILLER) it.text = it.text.replace(re, rep);
    it.text = it.text.trim();
    const bare = it.text.replace(/^([-*]|\d+[.)])\s+/, '').replace(/^\*\*|\*\*$/g, '');
    it.prio = (STRONG.test(bare) ? 6 : 0) + (IMPERATIVE.test(bare) ? 3 : 0) + (/`[^`]+`/.test(bare) ? 1 : 0) - Math.min(3, bare.length / 160);
  }
  return items;
}

function render(items: Item[]): string {
  const out: string[] = [];
  let block = -1;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(paragraph.join(' '));
    paragraph = [];
  };
  for (const it of items) {
    if (it.block !== block) {
      flush();
      if (out.length) out.push('');
      block = it.block;
    }
    if (it.kind === 'sentence') paragraph.push(it.text);
    else {
      flush();
      out.push(it.text);
    }
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function compressSkillBody(body: string, opts: { cap?: number; target?: number } = {}): CompressResult {
  const cap = opts.cap ?? SKILL_TOKEN_CAP;
  const target = Math.min(cap, opts.target ?? cap);
  const before = estimateTokens(body);
  const removed: string[] = [];
  let items = itemsOf(sanitizeSkillText(body)).filter((it) => it.text.trim() && it.text.trim() !== '```');
  // near-duplicate prose (keep the first, higher-priority occurrence)
  const kept: Item[] = [];
  for (const it of items) {
    if (it.kind !== 'code' && it.kind !== 'heading' && kept.some((k) => k.kind !== 'code' && similar(k.text, it.text, 0.75))) {
      removed.push(it.text);
      continue;
    }
    kept.push(it);
  }
  items = kept;
  // drop lowest-priority prose (latest first among equals) until under target; code goes last
  const tokens = () => estimateTokens(render(items));
  while (tokens() > target) {
    const prose = items.filter((i) => i.kind === 'sentence' || i.kind === 'bullet');
    const pool = prose.length > 2 ? prose : items.filter((i) => i.kind !== 'heading');
    if (pool.length <= 1) break;
    const victim = pool.reduce((v, i) => (i.prio <= v.prio ? i : v));
    removed.push(victim.text);
    items = items.filter((i) => i !== victim);
  }
  let out = render(items);
  if (estimateTokens(out) > cap) out = out.slice(0, Math.floor(cap * 3.3) - 2).replace(/\s+\S*$/, '') + ' …';
  return { body: out, tokens: estimateTokens(out), before, removed };
}
