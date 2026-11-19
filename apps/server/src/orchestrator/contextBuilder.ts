// SPDX-License-Identifier: AGPL-3.0-or-later
// TaskContextBundle v2: a deterministic, budgeted context per packet attempt.
//
//   static_system_prefix   contract + distilled repo rules   byte-identical for the run   ~1.1k tok
//   function_spec          JSON: functions, shape counts, difficulty, output mode           ≤300
//   disassembly_slice      target listing only, compact form (exposure consent only)         ≤2.5k
//   minimal_local_context  tree-sitter slice of included headers                             ≤2k
//   unit_files             the packet's own files (accepted bodies elided when large)        ≤5k
//   matched_pr_lessons     lessons/recipes whose tags match this packet's patterns           ≤500
//   shared_run_discoveries verified declarations from earlier packets of this run            ≤400
//   retry_delta            structured verdict + failing function bodies only (retries)       ≤600
//
// Never included: full docs, whole unrelated headers, previous complete files, chat history.
// Each section records `rawTokens` — what the unsliced sources would have cost (≈ the legacy
// bundle) — so savings are measured per attempt, not assumed.
import { createHash } from 'node:crypto';
import {
  patternsOf, sizeOnlyFeatures,
  type ContextBudgets, type ContextConfig, type ContextSection, type ContextSectionKind, type Difficulty, type FunctionFeatures, type TaskContextBundle,
} from '@decomp/core';
import type { Store, TaskRow } from '../db/store.js';
import { extractFunctions, lex } from '../gatekeeper/cpp.js';
import { HeaderSlicer } from '../intel/headerSlicer.js';
import { identifiersOf } from '../intel/knowledge.js';
import { distillRules, type DistilledRules } from '../intel/ruleDistiller.js';
import type { PreparedTask, RepoAdapter } from '../repo/types.js';
import { charsFor, clipToTokens, estimateTokens } from '../util/tokens.js';
import { elideBodies } from './edits.js';
import { FINDING_GUIDANCE } from './lessons.js';
import { WORKER_CONTRACT_V2, buildStaticPrefix, type Feedback } from './prompts.js';

export interface BuildOptionsV2 {
  runId: string;
  exposureConsent: boolean;
  carried: Array<{ path: string; content: string }>;
  attemptNo: number;
  feedback: Feedback | null;
  pitfalls: string[];
  context: ContextConfig;
}

const LEGACY_HEADER_CAP = 8_000; // what the legacy bundle pasted per header (for raw-token accounting)

export class TaskContextBuilder {
  private distilled: DistilledRules | null = null;
  private prefix: { text: string; hash: string } | null = null;
  private slicer: HeaderSlicer | null = null;
  private docsRawTokens = 0;

  constructor(private repo: RepoAdapter, private store: Store) {}

  /** Distil once per process/base revision; the result is the run-wide cached prefix. */
  async staticPrefix(budgets: ContextBudgets): Promise<{ text: string; hash: string; distilled: DistilledRules }> {
    if (!this.prefix || !this.distilled) {
      const docs = await this.repo.docs();
      this.docsRawTokens = docs.reduce((s, d) => s + estimateTokens(d.content), 0);
      const contractTokens = estimateTokens(WORKER_CONTRACT_V2);
      const room = Math.max(200, budgets.static_system_prefix.max - contractTokens - 20);
      this.distilled = distillRules(docs, { maxTokens: room, source: `${this.repo.name}${docs[0]?.source.includes('@') ? `@${docs[0].source.split('@')[1]}` : ''}` });
      this.prefix = buildStaticPrefix(this.distilled.text);
      for (const r of this.distilled.recipes) this.store.upsertLesson({ id: r.id, source: 'repo-cookbook', topic: r.topic, text: r.text, weight: r.weight, tags: r.tags });
    }
    return { ...this.prefix, distilled: this.distilled };
  }

  async build(task: TaskRow, prepared: PreparedTask, slot: number, opts: BuildOptionsV2): Promise<TaskContextBundle> {
    const B = opts.context.budgets;
    const sections: ContextSection[] = [];
    const add = (kind: ContextSectionKind, title: string, content: string, rawTokens: number, sources: string[], truncated = false, privacy: 'public' | 'private' = 'public') => {
      if (!content.trim()) return;
      sections.push({ kind, title, content, privacy, tokens: estimateTokens(content), budgetTokens: B[kind].max, rawTokens: Math.max(rawTokens, estimateTokens(content)), truncated, sources });
    };

    // 1. static prefix ---------------------------------------------------------------------------
    const prefix = await this.staticPrefix(B);
    add('static_system_prefix', 'Contract + distilled repository rules', prefix.text, this.docsRawTokens + estimateTokens(WORKER_CONTRACT_V2), ['contract', 'repo-docs']);

    // Unit files first (needed for references, signatures, elision decisions).
    const unitTexts = new Map<string, string | null>();
    for (const p of prepared.allowedPaths) unitTexts.set(p, await this.repo.readFile(slot, p));
    const allUnit = [...unitTexts.values()].filter((t): t is string => t !== null).join('\n');
    const references = new Set<string>([...identifiersOf(allUnit), ...task.functions.flatMap((f) => (f.name ? identifiersOf(f.name) : []))]);
    const primary = primaryClasses(task);
    const feats = task.functions.map(
      (f) => task.assessment?.functions?.[f.rva] ?? (task.assessment && task.functions.length === 1 ? task.assessment.features : null) ?? sizeOnlyFeatures(f.size),
    );

    // 3. disassembly slice (consent only) ----------------------------------------------------------
    let listingRaw = 0;
    if (opts.exposureConsent && prepared.packs.length) {
      const per = Math.floor(charsFor(B.disassembly_slice.max) / prepared.packs.length);
      const parts: string[] = [];
      for (const pack of prepared.packs) {
        if (this.repo.readPackSlice) {
          const s = await this.repo.readPackSlice(pack, per, { withDecompiler: task.difficulty === 'hard' });
          if (s) {
            parts.push(s.text);
            listingRaw += Math.ceil(s.rawChars / 3.3);
          }
        } else {
          const t = await this.repo.readPack(pack);
          if (t) {
            parts.push(clipToTokens(t, Math.floor(B.disassembly_slice.max / prepared.packs.length)).text);
            listingRaw += estimateTokens(t);
          }
        }
      }
      if (parts.length) {
        add('disassembly_slice', 'Target listing', `<listing note="private: read only; never reproduce bytes, mnemonics or pseudo-C names">\n${parts.join('\n')}\n</listing>`, listingRaw, ['private-pack'], false, 'private');
      }
    }

    // 4. minimal local context (tree-sitter slice of included headers) ----------------------------
    this.slicer ??= await HeaderSlicer.create();
    const headers = await this.repo.includedHeaders(slot, prepared.allowedPaths, { maxChars: 400_000, maxHeaders: 12 });
    const headerRaw = headers.reduce((s, h) => s + estimateTokens(h.content.slice(0, LEGACY_HEADER_CAP)), 0);
    const slice = this.slicer.slice({ headers: headers.map((h) => ({ path: h.source, text: h.content })), primary, references, maxTokens: B.minimal_local_context.max });
    if (slice.text.trim()) add('minimal_local_context', `Declarations sliced from ${headers.length} included header(s) (${slice.engine})`, `<local_context>\n${slice.text}\n</local_context>`, headerRaw, headers.map((h) => h.source), slice.truncated);

    // 5. unit files (elide accepted bodies when large) -------------------------------------------
    const isTarget = targetMatcher(task);
    const unitTokens = estimateTokens(allUnit);
    const mustElide = opts.context.outputMode === 'edits' || unitTokens > B.unit_files.max;
    const elided: string[] = [];
    const unitParts: string[] = [];
    for (const [p, text] of unitTexts) {
      if (text === null) {
        unitParts.push(`<unit title="Current ${p}" source="${p}" state="new file"></unit>`);
        continue;
      }
      let shown = text;
      if (mustElide && p.endsWith('.cpp')) {
        const e = elideBodies(text, isTarget);
        shown = e.text;
        elided.push(...e.elided);
      }
      unitParts.push(`<unit title="Current ${p}" source="${p}"${mustElide ? ' accepted_bodies="elided"' : ''}>\n${shown}\n</unit>`);
    }
    const unitClip = clipToTokens(unitParts.join('\n'), Math.max(B.unit_files.max, 400));
    const outputMode: TaskContextBundle['outputMode'] = mustElide ? 'edits' : opts.context.outputMode === 'files' ? 'files' : 'either';
    if (opts.carried.length) unitClip.text += `\n(Functions accepted earlier in this run are already in these files: ${opts.carried.map((c) => c.path).join(', ')}.)`;
    add('unit_files', 'Packet files', unitClip.text, unitTokens, prepared.allowedPaths, unitClip.truncated);

    // 2. function spec (needs elision + signatures) -----------------------------------------------
    const sigSources = [...headers.map((h) => h.content), ...[...unitTexts.values()].filter((t): t is string => !!t)];
    const spec = {
      unit: task.unit,
      allowedPaths: prepared.allowedPaths,
      difficulty: task.difficulty,
      outputMode,
      functions: task.functions.map((f, i) => {
        const ft: FunctionFeatures = feats[i]!;
        const cls = f.name?.includes('::') ? f.name.split('::').slice(0, -1).join('::') : null;
        return {
          rva: f.rva, name: f.name, size: f.size, class: cls,
          signature: f.name ? findSignature(f.name, sigSources) : null,
          callingConvention: cls ? 'x64 MS ABI, this in rcx' : 'x64 MS ABI',
          ...(ft.source !== 'size_only'
            ? { instructions: ft.instructions, basicBlocks: ft.basicBlocks, branches: ft.condBranches, loops: ft.backEdges, virtualCalls: ft.indirectCalls, sseOps: ft.sseOps, ehFunclets: (ft.unwindEntries ?? 0) > 1 }
            : {}),
        };
      }),
      ...(elided.length ? { elidedAccepted: elided.slice(0, 40), elidedMore: Math.max(0, elided.length - 40) } : {}),
    };
    const specText = `<task_spec>\n${JSON.stringify(spec)}\n</task_spec>`;
    sections.splice(1, 0, { kind: 'function_spec', title: 'Packet spec', content: specText, privacy: 'public', tokens: estimateTokens(specText), budgetTokens: B.function_spec.max, rawTokens: estimateTokens(specText), truncated: false, sources: ['orchestrator'] });

    // 6. matched lessons ---------------------------------------------------------------------------
    const patterns = [...new Set([...task.functions.flatMap((f, i) => patternsOf(feats[i]!, f.name)), ...slice.patterns, ...(task.difficulty === 'easy' ? [] : ['struct'])])].sort();
    const lessonsAll = this.store.lessons(400);
    const legacyLessonsRaw = lessonsAll.slice(0, 16).reduce((s, l) => s + estimateTokens(l.text) + 2, 0);
    const scored = lessonsAll
      .filter((l) => !(l.source === 'repo-docs' && l.tags.every((t) => t === 'general'))) // already in the static prefix
      .map((l) => ({ l, s: l.weight + 6 * l.tags.filter((t) => patterns.includes(t)).length, match: l.tags.some((t) => patterns.includes(t)) }))
      .sort((a, b) => Number(b.match) - Number(a.match) || b.s - a.s || a.l.id.localeCompare(b.l.id));
    const picked: string[] = [];
    let lt = 0;
    for (const { l, match } of scored) {
      const t = estimateTokens(l.text) + 2;
      if (lt + t > B.matched_pr_lessons.max) continue;
      if (!match && lt >= B.matched_pr_lessons.min) break;
      picked.push(`- [${l.tags.join(',')}] ${l.text}`);
      lt += t;
    }
    if (picked.length) add('matched_pr_lessons', `Lessons for: ${patterns.join(', ') || 'general'}`, `<lessons patterns="${patterns.join(',')}">\n${picked.join('\n')}\n</lessons>`, legacyLessonsRaw, ['lessons']);

    // 7. shared run discoveries ------------------------------------------------------------------
    const qualified = [...references].filter((r) => r.includes('::'));
    // Types the slicer pulled in (the packet's class, its bases, referenced types) widen the lookup:
    // a signature verified on a base class in another unit is exactly what this packet can reuse.
    const related = slice.included.filter((n) => /^[A-Za-z_]\w*$/.test(n));
    const keys = [...new Set([...task.functions.map((f) => f.name ?? '').filter(Boolean), ...qualified, ...primary, ...related, ...references])];
    const shownContext = `${unitClip.text}\n${slice.text}`;
    const cands = this.store.knowledgeFor(opts.runId, keys, 80, [...new Set([...primary, ...related])])
      .filter((k) => k.sourceUnit !== task.unit || !opts.carried.length)
      .filter((k) => !shownContext.includes(k.content.split('\n')[0]!.trim()))
      .map((k) => ({ k, s: (keys.includes(k.symbol) ? 3 : 0) + (k.symbols.some((s) => primary.includes(s)) ? 2 : k.symbols.some((s) => related.includes(s)) ? 1 : 0) + (k.kind === 'struct_layout' ? 1 : 0) + Math.min(2, k.uses / 5) }))
      .sort((a, b) => b.s - a.s || b.k.verifiedAt - a.k.verifiedAt);
    const disc: string[] = [];
    const used: Array<{ kind: typeof cands[number]['k']['kind']; symbol: string }> = [];
    let dt = 0;
    for (const { k } of cands) {
      const line = `// ${k.kind.replace('_', ' ')} ${k.symbol} (verified in ${k.sourceUnit.split('/').pop()})\n${k.content}`;
      const t = estimateTokens(line) + 1;
      if (dt + t > B.shared_run_discoveries.max) continue;
      disc.push(line);
      used.push({ kind: k.kind, symbol: k.symbol });
      dt += t;
    }
    if (disc.length) {
      add('shared_run_discoveries', `${disc.length} verified declaration(s) from this run`, `<run_discoveries>\n${disc.join('\n')}\n</run_discoveries>`, 0, ['run_knowledge_cache']);
      this.store.bumpKnowledgeUses(opts.runId, used);
    }

    // 8. retry delta + pitfalls (volatile) --------------------------------------------------------
    const relevantPitfalls = opts.pitfalls.slice(0, 4);
    if (opts.feedback) {
      const r = renderRetryDelta(opts.feedback, task, B.retry_delta.max);
      add('retry_delta', `Retry: ${r.category}`, `${relevantPitfalls.length ? `<pitfalls>\n${relevantPitfalls.map((p) => `- ${p}`).join('\n')}\n</pitfalls>\n` : ''}${r.text}`, r.rawTokens, ['verdict']);
    } else if (relevantPitfalls.length) {
      add('retry_delta', 'Common rejections in this run', `<pitfalls>\n${relevantPitfalls.map((p) => `- ${p}`).join('\n')}\n</pitfalls>`, 0, ['run']);
    }

    const order: ContextSectionKind[] = ['static_system_prefix', 'function_spec', 'disassembly_slice', 'minimal_local_context', 'unit_files', 'matched_pr_lessons', 'shared_run_discoveries', 'retry_delta'];
    sections.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const canon = JSON.stringify(sections.map((s) => [s.kind, s.content]));
    const hash = createHash('sha256').update(canon).digest('hex');
    const sent = sections.reduce((s, x) => s + x.tokens, 0);
    const raw = sections.reduce((s, x) => s + x.rawTokens, 0);
    const taskPrefix = sections.filter((s) => ['function_spec', 'disassembly_slice', 'minimal_local_context', 'unit_files', 'matched_pr_lessons'].includes(s.kind)).reduce((s, x) => s + x.tokens, 0);
    const bundle: TaskContextBundle = {
      version: 2, hash, taskId: task.id, difficulty: task.difficulty, allowedPaths: prepared.allowedPaths, staticPrefixHash: prefix.hash,
      sections, tokens: { sent, raw, staticPrefix: sections[0]?.tokens ?? 0, taskPrefix }, containsPrivate: sections.some((s) => s.privacy === 'private'),
      outputMode, elidedFunctions: elided, patterns,
    };
    // Persist for audit, private sections redacted (game-derived text never leaves .local/).
    this.store.putBundle(hash, {
      ...bundle,
      sections: sections.map((s) => (s.privacy === 'private' ? { ...s, content: `[private: ${s.content.length} chars, sha256=${createHash('sha256').update(s.content).digest('hex').slice(0, 16)}]` } : s)),
    });
    return bundle;
  }
}

/** Should the per-packet block carry a cache breakpoint? Only when a retry is likely to read it. */
export function shouldCacheTaskPrefix(mode: ContextConfig['cacheTaskPrefix'], difficulty: Difficulty, attemptNo: number, taskPrefixTokens: number): boolean {
  if (mode === 'never' || taskPrefixTokens < 512) return false;
  if (mode === 'always') return true;
  return difficulty !== 'easy' || attemptNo >= 2;
}

function primaryClasses(task: TaskRow): string[] {
  const out = new Set<string>();
  for (const f of task.functions) if (f.name?.includes('::')) out.add(f.name.split('::').slice(-2, -1)[0]!);
  out.add(task.unit.split('/').pop()!.replace(/\.(cpp|h)$/, ''));
  return [...out];
}

const flat = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function targetMatcher(task: TaskRow): (name: string) => boolean {
  const names = new Set(task.functions.flatMap((f) => (f.name ? [f.name, flat(f.name)] : [`Fn_${f.rva}`])));
  return (n: string) => names.has(n) || names.has(flat(n));
}

const lexMemo = new Map<string, string>();
function lexedCode(src: string): string {
  const key = createHash('sha1').update(src).digest('hex');
  let code = lexMemo.get(key);
  if (code === undefined) {
    code = lex(src).code;
    lexMemo.set(key, code);
    if (lexMemo.size > 256) lexMemo.delete(lexMemo.keys().next().value!);
  }
  return code;
}

function findSignature(qualified: string, sources: string[]): string | null {
  const method = qualified.split('::').pop()!.replace(/[^~\w]/g, '');
  if (!method) return null;
  const re = new RegExp(`^\\s*([^;{}\\n]*\\b${method.replace('~', '~?')}\\s*\\([^;{}]*\\)[^;{}\\n]*);`, 'm');
  for (const src of sources) {
    if (!src.includes(method)) continue;
    const m = re.exec(lexedCode(src));
    if (m) {
      const at = m.index + m[0].indexOf(m[1]!);
      return src.slice(at, at + m[1]!.length).replace(/\s+/g, ' ').trim().slice(0, 180);
    }
  }
  return null;
}

const CATEGORY: Array<[RegExp, string]> = [
  [/^COMPARE_COMPILE_ERROR$/, 'COMPILE_ERROR'],
  [/^(CHEAT|LEAK|SCOPE|INTEGRITY)_/, 'ANTI_CHEAT_VIOLATION'],
  [/^COMPARE_/, 'BYTE_MISMATCH'],
  [/^(PREFLIGHT|CONV)_/, 'PREFLIGHT_LINT'],
  [/^(OUTPUT|PROVIDER)_/, 'OUTPUT_CONTRACT'],
  [/^REVIEW_/, 'REVIEW_BLOCK'],
];

/** Structured verdict + only the failing functions' previous bodies — never the whole previous file. */
export function renderRetryDelta({ verdict, attempt }: Feedback, task: TaskRow, maxTokens: number): { text: string; category: string; rawTokens: number } {
  const blocks = verdict.findings.filter((f) => f.severity === 'block');
  const cats = [...new Set(blocks.map((f) => CATEGORY.find(([re]) => re.test(f.code))?.[1] ?? 'OTHER'))];
  const category = cats[0] ?? (verdict.decision === 'pass' ? 'PASS' : 'OTHER');
  const fails = (verdict.compare ?? []).filter((c) => c.result !== 'pass');
  const passes = (verdict.compare ?? []).filter((c) => c.result === 'pass');
  const summary: string[] = [`Attempt ${attempt.n} was rejected (${cats.join(', ') || verdict.decision}).`];
  if (verdict.compare?.length) {
    summary.push(`${passes.length} of ${verdict.compare.length} function(s) matched${passes.length ? ` (${passes.map((p) => p.name ?? p.rva).join(', ')}: keep them exactly)` : ''}.`);
    if (fails.length) summary.push(`Still wrong: ${fails.slice(0, 3).map((f) => `${f.name ?? f.rva} ${f.exactBytes ?? 0}/${f.targetSize ?? f.totalBytes ?? '?'} bytes exact${f.firstMismatch ? `, first mismatch ${f.firstMismatch}` : ''}`).join('; ')}.`);
  } else if (cats.includes('ANTI_CHEAT_VIOLATION')) summary.push('The candidate was blocked before compiling; another violation is quarantined.');
  else if (cats.includes('COMPILE_ERROR')) summary.push('It did not compile, so there is no byte evidence yet: declare every type and callee you use.');
  const lines = [`<retry category="${category}">`, `Summary: ${summary.join(' ')}`, 'Gate Keeper findings:'];
  for (const f of blocks.slice(0, 8)) {
    const guide = FINDING_GUIDANCE[f.code];
    lines.push(`- [${f.code}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}${f.message.slice(0, 300)}${guide ? ` → ${guide}` : ''}`);
  }
  if (blocks.length > 8) lines.push(`- … ${blocks.length - 8} more finding(s)`);
  // Previous bodies of failing (or all, when nothing compiled) target functions only.
  const wanted = new Set((fails.length ? fails.map((f) => f.name) : task.functions.map((f) => f.name)).filter(Boolean).flatMap((n) => [n!, flat(n!)]));
  const prevBodies: string[] = [];
  for (const file of attempt.files ?? []) {
    if (!file.path.endsWith('.cpp')) continue;
    for (const d of extractFunctions(lex(file.content).code)) {
      if (!wanted.has(d.name) && !wanted.has(flat(d.name))) continue;
      prevBodies.push(clipToTokens(file.content.slice(d.start, d.close + 1), 160).text);
    }
  }
  const head = lines.join('\n');
  const room = maxTokens - estimateTokens(head) - 20;
  if (prevBodies.length && room > 60) lines.push('Your previous version of the failing function(s):', clipToTokens(prevBodies.join('\n\n'), room).text);
  lines.push('</retry>');
  const rawTokens = estimateTokens(head) + (attempt.files ?? []).reduce((s, f) => s + estimateTokens(f.content.slice(0, 20_000)), 0);
  return { text: clipToTokens(lines.join('\n'), maxTokens).text, category, rawTokens };
}
