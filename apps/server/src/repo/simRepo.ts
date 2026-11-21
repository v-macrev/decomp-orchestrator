// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory stand-in for skyrim_decomp used by the simulator and tests. It mimics the parts of the
// real repo the engine depends on: units shared by several functions, a skeleton written by
// `prepare`, a comparator with per-function results and partial byte credit, compile errors,
// flaky infrastructure, and protected inputs whose digest can be tampered with.
import { createHash } from 'node:crypto';
import { ComplexityThresholds, assessPacket, type CompareFunctionResult, type Difficulty, type FunctionFeatures, type FunctionTarget, type SelectionSpec } from '@decomp/core';
import type { TaskRow } from '../db/store.js';
import { simIdent, type SimOracle } from '../providers/mock.js';
import { sleep } from '../util/async.js';
import { clipMiddle } from './srRepo.js';
import { hashUnit as hashUnitSim, simDocs, simFeatures, simPack, simSharedHeader, simTrap, simTrapRecipes, type SimTrapInfo } from './simContent.js';
import type { Backlog, ClaimCollision, ClaimCollisionCheck, CompareOutcome, DiscoveredFunction, InventoryEntry, DocSection, PreflightOutcome, PreparedTask, RepoAdapter, StageBatchInput, StageBatchResult, UpstreamState } from './types.js';

export interface SimRepoOptions {
  slots: number;
  compareLatencyMs?: [number, number];
  /** Probability a compare run fails for infrastructure reasons. */
  infraRate?: number;
  /** Test hook: runs inside compare (e.g. to simulate tooling that tampers with protected files). */
  onCompare?: (slot: number, repo: SimRepo) => void;
  rand?: () => number;
  /** Realistic context volumes (docs, shared header, big units, listings). Default true. */
  realisticContext?: boolean;
  /** Matching traps (Phase 3): listing signatures + documented/undocumented fixes. Default false. */
  traps?: boolean;
  /** Mapped functions in the simulated inventory (FunctionGatherer). Default 1500. */
  backlogSize?: number;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimRepo implements RepoAdapter, SimOracle {
  readonly name = 'sim';
  readonly slotCount: number;
  private base = new Map<string, string>();
  private overlays: Array<Map<string, string>>;
  private protectedFiles: Array<Map<string, string>>;
  private functions = new Map<string, DiscoveredFunction>();
  private rand: () => number;
  private realistic: boolean;
  private sharedHeader: string | null = null;
  compares = 0;
  /** Open claims by other contributors, by RVA (tests set it; the simulator has none). */
  claimedByOthers = new Map<string, ClaimCollision[]>();
  /** Test hooks: what upstream already matched (rva → owner), and files it changed since a batch was built. */
  upstreamMatched = new Map<string, string | null>();
  upstreamChanged = new Set<string>();

  constructor(private opts: SimRepoOptions) {
    this.realistic = opts.realisticContext ?? true;
    this.slotCount = opts.slots;
    this.overlays = Array.from({ length: opts.slots }, () => new Map());
    this.protectedFiles = Array.from({ length: opts.slots }, () => new Map([['tools/compare.py', 'def compare(): ...'], ['builds/target.json', '{"build_id":"sim"}']]));
    this.rand = opts.rand ?? Math.random;
  }

  async init() {}

  /** Ground-truth matching trap of a function (null when traps are off or it has none). */
  trapInfo(rva: string, size: number): SimTrapInfo | null {
    return this.opts.traps ? simTrap(rva, size) : null;
  }

  difficulty(rva: string, size: number): Difficulty {
    return assessPacket([simFeatures(rva, size)], THRESHOLDS).difficulty;
  }

  solution(rva: string): string {
    const h = createHash('sha256').update(rva).digest('hex').slice(0, 6);
    return `return 0x${h};`;
  }

  private backlogCache: Backlog | null = null;

  /**
   * Simulated repository inventory for the FunctionGatherer: `backlogSize` mapped functions (the
   * synthetic backlog) plus twice as many already matched, ~3% claimed locally, a few template
   * instantiations, and a function table with xrefs/blocks for every mapped function.
   */
  async backlog(opts: { maxSize: number }): Promise<Backlog> {
    if (!this.backlogCache) {
      const mapped = await this.discover({ source: 'synthetic', count: this.opts.backlogSize ?? 1_500, seed: 4_242 });
      const rnd = mulberry32(99);
      const matched: InventoryEntry[] = Array.from({ length: mapped.length * 2 }, (_, i) => ({ rva: `0x${(0x4000000 + i * 0x40).toString(16)}`, name: `Done${i}::Run`, size: 8 + Math.floor(rnd() * 90), nameOrigin: 'GUESS', status: 'matched' }));
      const table = new Map<string, Record<string, unknown>>();
      for (const f of mapped) {
        const ft = f.features ?? simFeatures(f.rva, f.size);
        table.set(f.rva, { rva: f.rva, xrefs_in: ft.xrefsIn, callees: ft.calls, basic_blocks: ft.basicBlocks, instructions: ft.instructions });
        if (hashUnitSim(`${f.rva}:tpl`) < 0.04) f.name = `${f.name!.split('::')[0]}::Visit<Form${f.name!.split('::')[1]!.replace('Method', '')}>`;
        f.nameOrigin = hashUnitSim(`${f.rva}:origin`) < 0.25 ? 'GUESS' : 'COMMUNITY';
      }
      this.backlogCache = {
        source: 'simulated inventory + function table',
        inventory: [...mapped.map((f) => ({ rva: f.rva, name: f.name, size: f.size, nameOrigin: f.nameOrigin ?? null, status: 'mapped' })), ...matched],
        candidates: mapped,
        claimed: mapped.filter((f) => hashUnitSim(`${f.rva}:claim`) < 0.03).map((f) => f.rva),
        claimsChecked: true,
        functionTable: table,
      };
    }
    return { ...this.backlogCache, candidates: this.backlogCache.candidates.filter((c) => c.size <= opts.maxSize) };
  }

  async discover(sel: SelectionSpec): Promise<DiscoveredFunction[]> {
    // Explicit RVAs resolve against functions this simulator has already discovered (carry-over runs).
    if (sel.source === 'rva_list') return sel.rvas.map((r) => this.functions.get(r.toLowerCase())).filter((f): f is DiscoveredFunction => !!f);
    if (sel.source !== 'synthetic') throw new Error('SimRepo supports only synthetic and rva_list selection');
    const rnd = mulberry32(sel.seed);
    const out: DiscoveredFunction[] = [];
    let cls = 0;
    let rva = 0x100000;
    while (out.length < sel.count) {
      const methods = 1 + Math.floor(rnd() * 6);
      const unit = `reconstruction/sim/Class${cls}.cpp`;
      for (let j = 0; j < methods && out.length < sel.count; j++) {
        rva += 0x10 + Math.floor(rnd() * 0x400);
        const hex = `0x${rva.toString(16)}`;
        // Real backlogs skew small (most ready functions are accessors and short helpers): median ≈ 50 B.
        const size = 6 + Math.floor(200 * rnd() ** 2.2);
        const f: DiscoveredFunction = { rva: hex, name: `Class${cls}::Method${j}`, size, unit, readiness: Math.floor(rnd() * 4), features: simFeatures(hex, size) };
        out.push(f);
        this.functions.set(f.rva, f);
      }
      // Some units already contain accepted functions: they must survive every candidate unchanged.
      // About a third of those are big units, whose bodies the budgeted builder elides (edits mode).
      if (rnd() < 0.3) {
        const many = this.realistic && rnd() < 0.35 ? 12 + Math.floor(rnd() * 20) : 0;
        const extra = Array.from({ length: many }, (_, k) => `int Class${cls}_Done${k}()\n{\n    int total = ${k};\n    for (int i = 0; i < ${k + 3}; ++i)\n        total += i * ${k + 1};\n    return total;\n}\n`);
        this.base.set(unit, `${HEADER}int Class${cls}_Accepted()\n{\n    return 7;\n}\n${extra.length ? `\n${extra.join('\n')}` : ''}`);
      }
      cls++;
    }
    return out;
  }

  async prepare(slot: number, task: TaskRow): Promise<PreparedTask> {
    const cpp = task.unit;
    const h = cpp.replace(/\.cpp$/, '.h');
    const ov = this.overlays[slot]!;
    if (!ov.has(cpp)) ov.set(cpp, this.base.get(cpp) ?? `${HEADER}`);
    return { srTaskId: `sim-${task.id}`, allowedPaths: [h, cpp], packs: task.functions.map((f) => `sim-pack/${f.size}/${f.rva}`), toolingChanges: await this.changedPaths(slot) };
  }

  async baseFile(path: string) {
    return this.base.get(path) ?? null;
  }
  async readFile(slot: number, path: string) {
    return this.overlays[slot]!.get(path) ?? this.base.get(path) ?? null;
  }
  async writeFiles(slot: number, files: Array<{ path: string; content: string }>) {
    for (const f of files) this.overlays[slot]!.set(f.path, f.content);
  }
  async changedPaths(slot: number) {
    return [...this.overlays[slot]!.entries()].filter(([p, c]) => this.base.get(p) !== c).map(([p]) => p);
  }
  async protectedDigest(slot: number) {
    const h = createHash('sha256');
    for (const [p, c] of [...this.protectedFiles[slot]!.entries()].sort()) h.update(`${p}\0${c}\0`);
    return h.digest('hex');
  }
  /** Test helper: mutate a protected file in a slot. */
  tamper(slot: number, path = 'tools/compare.py') {
    this.protectedFiles[slot]!.set(path, 'def compare(): return "pass"');
  }
  /** Test helper: create a stray file in a slot. */
  stray(slot: number, path: string) {
    this.overlays[slot]!.set(path, 'stray');
  }

  async compare(slot: number, task: TaskRow, _prep: PreparedTask, opts: { signal: AbortSignal }): Promise<CompareOutcome> {
    const t = Date.now();
    this.compares++;
    const [lo, hi] = this.opts.compareLatencyMs ?? [5, 15];
    await sleep(lo + this.rand() * (hi - lo), opts.signal);
    this.opts.onCompare?.(slot, this);
    if (this.rand() < (this.opts.infraRate ?? 0)) {
      return { completed: false, allPass: false, compileError: false, functions: [], infraError: 'simulated toolchain crash', durationMs: Date.now() - t };
    }
    return { ...this.evaluate(this.overlays[slot]!.get(task.unit) ?? '', task), durationMs: Date.now() - t };
  }

  private evaluate(src: string, task: TaskRow): Omit<CompareOutcome, 'durationMs'> {
    if ((src.match(/\{/g) ?? []).length !== (src.match(/\}/g) ?? []).length || src.includes('#error')) {
      return { completed: true, allPass: false, compileError: true, functions: [], infraError: null };
    }
    const functions: CompareFunctionResult[] = task.functions.map((f) => {
      const ident = simIdent(f);
      const m = new RegExp(`int\\s+${ident}\\s*\\(\\)\\s*\\{([\\s\\S]*?)\\}`).exec(src);
      const body = m?.[1]?.trim() ?? null;
      const sol = this.solution(f.rva);
      const pass = body === sol;
      const near = !pass && body !== null && body.startsWith('return 0x');
      const exact = pass ? f.size : near ? Math.floor(f.size * 0.7) : 0;
      return {
        rva: f.rva, name: f.name, result: pass ? 'pass' : 'fail', reason: pass ? null : body === null ? 'symbol-missing' : 'code-mismatch',
        hint: pass ? null : 'compare the constant loaded into eax', firstMismatch: pass ? null : '+0x1', candidateSize: body ? f.size : null,
        targetSize: f.size, exactBytes: exact, totalBytes: f.size,
      };
    });
    return { completed: true, allPass: functions.every((f) => f.result === 'pass'), compileError: false, functions, infraError: null };
  }

  async claimCollisions(rvas: string[]): Promise<ClaimCollisionCheck> {
    const collisions: Record<string, ClaimCollision[]> = {};
    for (const rva of new Set(rvas)) {
      const hit = this.claimedByOthers.get(rva);
      if (hit?.length) collisions[rva] = hit;
    }
    return { checked: true, error: null, collisions };
  }

  async upstreamState(input: { rvas: string[]; files: string[]; branch: string | null }): Promise<UpstreamState> {
    const matched = Object.fromEntries(input.rvas.filter((r) => this.upstreamMatched.has(r)).map((r) => [r, this.upstreamMatched.get(r)!]));
    return { checked: true, matched, untracked: [], changed: input.files.filter((p) => this.upstreamChanged.has(p)), builtOn: null };
  }

  /** Re-verify every packet against the combined final unit files (what a PR would contain). */
  async stageBatch(input: StageBatchInput): Promise<StageBatchResult> {
    const files = new Map(input.files.map((f) => [f.path, f.content]));
    const problems: string[] = [];
    for (const t of input.tasks) {
      const r = this.evaluate(files.get(t.task.unit) ?? '', t.task);
      if (!r.allPass) problems.push(`${t.id}: ${r.functions.filter((f) => f.result !== 'pass').map((f) => f.rva).join(',') || 'compile error'}`);
    }
    return { branch: problems.length ? null : `sim/${input.runId}-b${input.seq}`, verified: problems.length === 0, problems };
  }

  async preflight(slot: number, task: TaskRow): Promise<PreflightOutcome> {
    const src = this.overlays[slot]!.get(task.unit) ?? '';
    const problems = /\/\/ Code origin: \S/.test(src) ? [] : ['missing Code origin header line'];
    return { completed: true, ok: problems.length === 0, problems, infraError: null };
  }

  async reset(slot: number) {
    this.overlays[slot] = new Map();
  }

  async docs(): Promise<DocSection[]> {
    if (this.realistic) {
      const docs = simDocs();
      if (!this.opts.traps) return docs;
      return docs.map((d) => (d.id === 'matching-cookbook' ? { ...d, content: `${d.content}\n\n${simTrapRecipes()}` } : d));
    }
    return [{ id: 'rules', title: 'Simulated contributor rules', source: 'sim', content: 'Write plausible C++. Never use asm, byte arrays or #pragma.' }];
  }
  async includedHeaders(_slot: number, _unitFiles: string[], opts: { maxChars?: number } = {}): Promise<DocSection[]> {
    if (!this.realistic) return [];
    this.sharedHeader ??= simSharedHeader(200); // covers every class a 500-function backlog uses
    const cap = opts.maxChars ?? 8_000;
    const text = this.sharedHeader.length > cap ? `${this.sharedHeader.slice(0, cap)}\n[truncated header]` : this.sharedHeader;
    return [{ id: 'hdr:reconstruction/sim/Sim.h', title: 'reconstruction/sim/Sim.h', source: 'reconstruction/sim/Sim.h', content: text }];
  }
  private pack(path: string) {
    const [, size, rva] = path.split('/');
    return simPack(rva ?? '0x0', Number(size) || 16);
  }
  async readPack(pack: string) {
    if (!this.realistic) return `SIMULATED PRIVATE LISTING for ${pack}`;
    const p = this.pack(pack);
    return `--- bytes.txt ---\n${p.bytes}\n--- decomp.c ---\n${p.decomp}`;
  }
  async readPackSlice(pack: string, maxChars: number, opts: { withDecompiler?: boolean } = {}) {
    const p = this.pack(pack);
    const [, size, rva] = pack.split('/');
    const trap = this.trapInfo(rva ?? '0x0', Number(size) || 16);
    const listing = trap ? spliceTrap(p.listing, trap.listing) : p.listing;
    let text = clipMiddle(listing, maxChars);
    if (opts.withDecompiler && maxChars - text.length > 400) text += `\n--- decompiler ---\n${clipMiddle(p.decomp, maxChars - text.length - 24)}`;
    return { text, rawChars: p.bytes.length + p.decomp.length };
  }
  async docFile(rel: string): Promise<string | null> {
    if (rel !== 'docs/matching-cookbook.md') return null;
    return (await this.docs()).find((d) => d.id === 'matching-cookbook')?.content ?? null;
  }
  async packFor(fn: FunctionTarget): Promise<string | null> {
    return this.realistic ? `sim-pack/${fn.size}/${fn.rva}` : null;
  }
  async analyze(fns: FunctionTarget[]): Promise<Map<string, FunctionFeatures>> {
    return new Map(fns.map((f) => [f.rva, simFeatures(f.rva, f.size)]));
  }
}

const THRESHOLDS = ComplexityThresholds.parse({});

/** Put a trap's lines in the middle of a listing (offsets continue the listing's own format). */
function spliceTrap(listing: string, lines: string[]): string {
  const rows = listing.split('\n');
  const at = Math.max(1, Math.floor(rows.length / 2));
  return [...rows.slice(0, at), ...lines.map((l, i) => `  +0x${(at * 4 + i).toString(16).padStart(3, '0')}  ${l}`), ...rows.slice(at)].join('\n');
}
const HEADER = ['// Source exposure: public (community headers).', '// Code origin: original; simulated base', '#include "Sim.h"', ''].join('\n');
