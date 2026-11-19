// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory stand-in for skyrim_decomp used by the simulator and tests. It mimics the parts of the
// real repo the engine depends on: units shared by several functions, a skeleton written by
// `prepare`, a comparator with per-function results and partial byte credit, compile errors,
// flaky infrastructure, and protected inputs whose digest can be tampered with.
import { createHash } from 'node:crypto';
import type { CompareFunctionResult, SelectionSpec } from '@decomp/core';
import type { TaskRow } from '../db/store.js';
import { simIdent, type SimOracle } from '../providers/mock.js';
import { sleep } from '../util/async.js';
import type { CompareOutcome, DiscoveredFunction, DocSection, PreflightOutcome, PreparedTask, RepoAdapter } from './types.js';

export interface SimRepoOptions {
  slots: number;
  compareLatencyMs?: [number, number];
  /** Probability a compare run fails for infrastructure reasons. */
  infraRate?: number;
  /** Test hook: runs inside compare (e.g. to simulate tooling that tampers with protected files). */
  onCompare?: (slot: number, repo: SimRepo) => void;
  rand?: () => number;
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
  compares = 0;

  constructor(private opts: SimRepoOptions) {
    this.slotCount = opts.slots;
    this.overlays = Array.from({ length: opts.slots }, () => new Map());
    this.protectedFiles = Array.from({ length: opts.slots }, () => new Map([['tools/compare.py', 'def compare(): ...'], ['builds/target.json', '{"build_id":"sim"}']]));
    this.rand = opts.rand ?? Math.random;
  }

  async init() {}

  solution(rva: string): string {
    const h = createHash('sha256').update(rva).digest('hex').slice(0, 6);
    return `return 0x${h};`;
  }

  async discover(sel: SelectionSpec): Promise<DiscoveredFunction[]> {
    if (sel.source !== 'synthetic') throw new Error('SimRepo supports only synthetic selection');
    const rnd = mulberry32(sel.seed);
    const out: DiscoveredFunction[] = [];
    let cls = 0;
    let rva = 0x100000;
    while (out.length < sel.count) {
      const methods = 1 + Math.floor(rnd() * 6);
      const unit = `reconstruction/sim/Class${cls}.cpp`;
      for (let j = 0; j < methods && out.length < sel.count; j++) {
        rva += 0x10 + Math.floor(rnd() * 0x400);
        const f: DiscoveredFunction = { rva: `0x${rva.toString(16)}`, name: `Class${cls}::Method${j}`, size: 8 + Math.floor(rnd() * 200), unit, readiness: Math.floor(rnd() * 4) };
        out.push(f);
        this.functions.set(f.rva, f);
      }
      // Some units already contain an accepted function: it must survive every candidate unchanged.
      if (rnd() < 0.3) this.base.set(unit, `${HEADER}int Class${cls}_Accepted()\n{\n    return 7;\n}\n`);
      cls++;
    }
    return out;
  }

  async prepare(slot: number, task: TaskRow): Promise<PreparedTask> {
    const cpp = task.unit;
    const h = cpp.replace(/\.cpp$/, '.h');
    const ov = this.overlays[slot]!;
    if (!ov.has(cpp)) ov.set(cpp, this.base.get(cpp) ?? `${HEADER}`);
    return { srTaskId: `sim-${task.id}`, allowedPaths: [h, cpp], packs: [`sim-pack/${task.id}`], toolingChanges: await this.changedPaths(slot) };
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
    const src = this.overlays[slot]!.get(task.unit) ?? '';
    if ((src.match(/\{/g) ?? []).length !== (src.match(/\}/g) ?? []).length || src.includes('#error')) {
      return { completed: true, allPass: false, compileError: true, functions: [], infraError: null, durationMs: Date.now() - t };
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
    return { completed: true, allPass: functions.every((f) => f.result === 'pass'), compileError: false, functions, infraError: null, durationMs: Date.now() - t };
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
    return [{ id: 'rules', title: 'Simulated contributor rules', source: 'sim', content: 'Write plausible C++. Never use asm, byte arrays or #pragma.' }];
  }
  async includedHeaders(): Promise<DocSection[]> {
    return [];
  }
  async readPack(pack: string) {
    return `SIMULATED PRIVATE LISTING for ${pack}`;
  }
}

const HEADER = ['// Source exposure: public (community headers).', '// Code origin: original; simulated base', '#include "Sim.h"', ''].join('\n');
