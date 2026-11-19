// SPDX-License-Identifier: AGPL-3.0-or-later
// Real adapter for awarebayes/skyrim_decomp. Follows the repo's documented parallel-contributor
// setup (docs/contributor-parallel.md): one git worktree per agent, a shared SR_LOCAL_DIR for
// toolchains/packs/claims, SR_CONTRIB_OFFLINE=1 + `claim --offline-ok` for unpublished local
// claims, `start --no-branch`, and `compare <task-id>` as the authoritative check.
//
// Isolation per slot:
//   * worktree pinned to one base SHA for the whole process; reset --hard + clean -ffdx between
//     attempts and verified clean before reuse;
//   * all repo tooling runs through runBounded: wall-clock timeout with process-tree kill, output
//     cap, cwd = the slot's worktree, allowlisted env (no provider keys ever reach repo tooling);
//   * optional container mode wraps the same command in `docker run --network none --cap-drop ALL
//     --read-only ...` with only the worktree and SR_LOCAL_DIR mounted;
//   * writes go through a realpath check so a symlink in the worktree cannot redirect them.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CompareFunctionResult, Finding, SelectionSpec } from '@decomp/core';
import type { TaskRow } from '../db/store.js';
import { KeyedMutex } from '../util/async.js';
import { runBounded, type RunResult } from '../util/proc.js';
import type { CompareOutcome, DiscoveredFunction, DocSection, PreflightOutcome, PreparedTask, RepoAdapter, StageBatchInput, StageBatchResult } from './types.js';

export interface SrRepoConfig {
  repoPath: string;
  baseRef: string;
  worktreeRoot: string;
  /** Shared private storage (absolute). Must already be set up with `./sr setup`. */
  localDir: string;
  python: string;
  slots: number;
  sandbox: { mode: 'local' } | { mode: 'docker'; image: string; cpus?: number; memory?: string };
  /** Exit codes of contrib.py that mean "infrastructure", not "candidate". */
  infraExitCodes?: number[];
}

const PROTECTED_PATHS = ['tools', 'builds', '.github', 'tests', 'sr', 'sr.cmd', 'reconstruction/recipes', 'data/target-hashes'];
const DOCS: Array<[string, string, number]> = [
  ['contributor-card', 'docs/contributor-card.md', 8_000],
  ['contributor-lessons', 'docs/contributor-lessons.md', 4_000],
  ['matching-cookbook', 'docs/matching-cookbook.md', 12_000],
  ['declaration-kit', 'docs/declaration-kit.md', 6_000],
];

export class InfraError extends Error {}

export class SrRepo implements RepoAdapter {
  readonly name = 'skyrim_decomp';
  readonly slotCount: number;
  private sha = '';
  private srMutex = new KeyedMutex();
  private baseCache = new Map<string, string | null>();

  constructor(private cfg: SrRepoConfig) {
    this.slotCount = cfg.slots;
    if (!isAbsolute(cfg.localDir)) throw new Error('localDir (SR_LOCAL_DIR) must be absolute');
  }

  private wt(slot: number) {
    return resolve(this.cfg.worktreeRoot, `slot-${slot}`);
  }

  private git(cwd: string, args: string[], timeoutMs = 60_000) {
    return runBounded('git', args, { cwd, timeoutMs, maxOutputBytes: 64 * 1024 * 1024 });
  }

  private srEnv() {
    return { SR_LOCAL_DIR: this.cfg.localDir, SR_CONTRIB_OFFLINE: '1', SR_NO_SIBLING_NAMES: '1' };
  }

  /** Run `python tools/contrib.py --json <args>` in a slot (or the main checkout) under the sandbox. */
  private async sr(cwd: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ run: RunResult; json: any }> {
    const base = [join('tools', 'contrib.py'), '--json', ...args];
    let run: RunResult;
    if (this.cfg.sandbox.mode === 'docker') {
      const sb = this.cfg.sandbox;
      const dockerArgs = [
        'run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '512', '--cpus', String(sb.cpus ?? 2), '--memory', sb.memory ?? '4g', '--read-only', '--tmpfs', '/tmp',
        '-v', `${cwd}:/repo`, '-v', `${this.cfg.localDir}:/local`, '-w', '/repo',
        '-e', 'SR_LOCAL_DIR=/local', '-e', 'SR_CONTRIB_OFFLINE=1', '-e', 'SR_NO_SIBLING_NAMES=1',
        sb.image, 'python3', ...base,
      ];
      run = await runBounded('docker', dockerArgs, { cwd, timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes: 8 * 1024 * 1024 });
    } else {
      run = await runBounded(this.cfg.python, base, { cwd, env: this.srEnv(), timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes: 8 * 1024 * 1024 });
    }
    let json: any = null;
    try {
      json = JSON.parse(run.stdout);
    } catch {
      const start = run.stdout.indexOf('{');
      if (start >= 0) {
        try {
          json = JSON.parse(run.stdout.slice(start));
        } catch {
          /* leave null */
        }
      }
    }
    return { run, json };
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    const repo = this.cfg.repoPath;
    if (!existsSync(join(repo, 'tools', 'contrib.py'))) throw new Error(`${repo} is not a skyrim_decomp checkout (tools/contrib.py missing)`);
    if (!existsSync(this.cfg.localDir)) throw new Error(`SR_LOCAL_DIR ${this.cfg.localDir} does not exist; run ./sr setup first`);
    const rev = await this.git(repo, ['rev-parse', '--verify', `${this.cfg.baseRef}^{commit}`]);
    if (rev.code !== 0) throw new Error(`cannot resolve base ref ${this.cfg.baseRef}: ${rev.stderr}`);
    this.sha = rev.stdout.trim();
    mkdirSync(this.cfg.worktreeRoot, { recursive: true });
    await this.git(repo, ['worktree', 'prune']);
    for (let i = 0; i < this.slotCount; i++) {
      const p = this.wt(i);
      if (!existsSync(join(p, '.git'))) {
        const r = await this.git(repo, ['worktree', 'add', '--detach', p, this.sha], 600_000);
        if (r.code !== 0) throw new Error(`worktree add failed for slot ${i}: ${r.stderr}`);
      }
      await this.reset(i);
    }
  }

  get baseSha() {
    return this.sha;
  }

  async reset(slot: number) {
    const p = this.wt(slot);
    const a = await this.git(p, ['reset', '--hard', '-q', this.sha], 300_000);
    const b = await this.git(p, ['clean', '-ffdxq'], 300_000);
    const s = await this.git(p, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (a.code !== 0 || b.code !== 0 || s.stdout.trim()) throw new InfraError(`slot ${slot} could not be restored to a clean state`);
  }

  // ---------------------------------------------------------------- discovery

  async discover(sel: SelectionSpec): Promise<DiscoveredFunction[]> {
    if (sel.source === 'synthetic') throw new Error('synthetic selection is only for the simulator');
    const count = sel.source === 'sr_next' ? sel.count : 100_000;
    const maxSize = sel.source === 'sr_next' ? sel.maxSize : 1_000_000;
    const { run, json } = await this.sr(this.cfg.repoPath, ['next', '--count', String(count), '--max-size', String(maxSize)], { timeoutMs: 300_000 });
    if (!json?.candidates) throw new InfraError(`sr next failed (exit ${run.code}): ${json?.error ?? run.stderr.slice(0, 500)}`);
    const want = sel.source === 'rva_list' ? new Set(sel.rvas.map((r) => `0x${parseInt(r, 16).toString(16)}`)) : null;
    return (json.candidates as any[])
      .filter((c) => c.startable && c.unit && (!want || want.has(c.rva)))
      .map((c) => ({ rva: c.rva, name: c.name ?? null, size: c.size, nameOrigin: c.name_origin ?? null, unit: String(c.unit).replace(/\\/g, '/'), readiness: c.readiness_rank }));
  }

  // ---------------------------------------------------------------- per-task

  async prepare(slot: number, task: TaskRow, opts: { draftedBy: string; model: string; signal: AbortSignal }): Promise<PreparedTask> {
    const cwd = this.wt(slot);
    const rvas = task.functions.map((f) => f.rva);
    // claim/start write shared state under SR_LOCAL_DIR: serialise them across slots
    const started = await this.srMutex.run('sr-local', async () => {
      const claim = await this.sr(cwd, ['claim', ...rvas, '--offline-ok', '--model', opts.model, '--drafted-by', opts.draftedBy], { timeoutMs: 120_000, signal: opts.signal });
      if (claim.run.code !== 0 && !String(claim.json?.error ?? '').includes('already')) {
        throw new InfraError(`sr claim failed (exit ${claim.run.code}): ${claim.json?.error ?? claim.run.stderr.slice(0, 300)}`);
      }
      return this.sr(cwd, ['start', ...rvas, '--no-branch', '--drafted-by', opts.draftedBy, '--model', opts.model], { timeoutMs: 600_000, signal: opts.signal });
    });
    const j = started.json;
    if (started.run.code !== 0 || !j?.task) throw new InfraError(`sr start failed (exit ${started.run.code}): ${j?.error ?? started.run.stderr.slice(0, 300)}`);
    const unit = (j.unit as string[]).map((p) => p.replace(/\\/g, '/'));
    const toolingChanges = (await this.changedPaths(slot)).filter((p) => !unit.includes(p));
    return { srTaskId: j.task, allowedPaths: unit, packs: (j.packs as string[]) ?? [], toolingChanges };
  }

  async baseFile(path: string) {
    if (this.baseCache.has(path)) return this.baseCache.get(path)!;
    const r = await this.git(this.cfg.repoPath, ['show', `${this.sha}:${path}`]);
    const v = r.code === 0 ? r.stdout : null;
    this.baseCache.set(path, v);
    return v;
  }

  private safePath(slot: number, rel: string): string {
    const root = realpathSync(this.wt(slot));
    const abs = resolve(root, rel);
    const r = relative(root, abs);
    if (r.startsWith('..') || isAbsolute(r)) throw new InfraError(`path ${rel} escapes the worktree`);
    if (existsSync(abs)) {
      const real = realpathSync(abs);
      const rr = relative(root, real);
      if (rr.startsWith('..') || isAbsolute(rr)) throw new InfraError(`path ${rel} resolves outside the worktree (symlink)`);
    }
    return abs;
  }

  async readFile(slot: number, path: string) {
    try {
      return readFileSync(this.safePath(slot, path), 'utf8');
    } catch {
      return null;
    }
  }

  async writeFiles(slot: number, files: Array<{ path: string; content: string }>) {
    for (const f of files) {
      const abs = this.safePath(slot, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content, 'utf8');
    }
  }

  async changedPaths(slot: number) {
    const r = await this.git(this.wt(slot), ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
    if (r.code !== 0) throw new InfraError(`git status failed in slot ${slot}`);
    const out: string[] = [];
    const parts = r.stdout.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]!;
      const status = e.slice(0, 2);
      out.push(e.slice(3).replace(/\\/g, '/'));
      if (status.startsWith('R') || status.startsWith('C')) i++; // skip rename source
    }
    return out.filter((p) => !/(^|\/)__pycache__\/|\.pyc$/.test(p));
  }

  async protectedDigest(slot: number) {
    const r = await this.git(this.wt(slot), ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--', ...PROTECTED_PATHS]);
    const h = createHash('sha256').update(this.sha).update(r.stdout);
    return h.digest('hex');
  }

  async compare(slot: number, task: TaskRow, prep: PreparedTask, opts: { signal: AbortSignal; timeoutMs: number }): Promise<CompareOutcome> {
    const t = Date.now();
    const { run, json } = await this.sr(this.wt(slot), ['compare', prep.srTaskId ?? ''], opts);
    const infraCodes = new Set(this.cfg.infraExitCodes ?? [2, 5, 7, 8]);
    const base = { durationMs: Date.now() - t };
    if (run.timedOut) return { ...base, completed: false, allPass: false, compileError: false, functions: [], infraError: `compare timed out after ${opts.timeoutMs} ms` };
    if (run.aborted) return { ...base, completed: false, allPass: false, compileError: false, functions: [], infraError: 'compare aborted' };
    if (run.truncated) return { ...base, completed: false, allPass: false, compileError: false, functions: [], infraError: 'compare output exceeded the cap' };
    if (!json || infraCodes.has(run.code ?? -1)) {
      return { ...base, completed: false, allPass: false, compileError: false, functions: [], infraError: `compare infra failure (exit ${run.code}): ${json?.error ?? run.stderr.slice(0, 300)}` };
    }
    if (run.code === 3 || run.code === 4) return { ...base, completed: true, allPass: false, compileError: true, functions: [], infraError: null };
    const functions: CompareFunctionResult[] = ((json.functions as any[]) ?? []).map((f) => ({
      rva: f.rva, name: f.name ?? null, result: f.result ?? 'fail', reason: f.reason ?? null, hint: f.hint || null,
      firstMismatch: f.first_mismatch ?? null, candidateSize: f.candidate_size ?? null, targetSize: f.target_size ?? null,
      exactBytes: f.coverage?.code_bytes_exact ?? null, totalBytes: f.coverage?.code_bytes_total ?? null,
    }));
    const expected = new Set(task.functions.map((f) => f.rva));
    const allPass = run.code === 0 && functions.length > 0 && functions.every((f) => f.result === 'pass') && [...expected].every((r) => functions.some((f) => f.rva === r));
    return { ...base, completed: true, allPass, compileError: false, functions, infraError: null };
  }

  async preflight(slot: number, _task: TaskRow, prep: PreparedTask, opts: { signal: AbortSignal; timeoutMs: number }): Promise<PreflightOutcome> {
    const { run, json } = await this.sr(this.wt(slot), ['preflight', prep.srTaskId ?? ''], opts);
    if (run.timedOut || !json) return { completed: false, ok: false, problems: [], infraError: `preflight failed to run (exit ${run.code})` };
    if (run.code === 0) return { completed: true, ok: true, problems: [], infraError: null };
    const problems = [...((json.errors as string[]) ?? []), ...(json.error ? [String(json.error)] : [])].map((s) => s.slice(0, 400));
    return { completed: true, ok: false, problems: problems.length ? problems : [`preflight exit ${run.code}`], infraError: null };
  }

  async repoLeakScan(slot: number, opts: { signal: AbortSignal }): Promise<Finding[] | null> {
    const p = this.wt(slot);
    // Untracked new files are not in `git diff`; intent-to-add makes them visible without staging
    // content (the index is discarded by the next reset anyway).
    await this.git(p, ['add', '--intent-to-add', '--all']);
    const diff = await this.git(p, ['diff', '--no-renames', '--no-color', '-U0', '--diff-algorithm=minimal', this.sha, '--']);
    if (diff.code !== 0) return null;
    const r =await runBounded(this.cfg.python, [join('tools', 'leakgrep.py'), '--diff', '-'], { cwd: p, stdin: diff.stdout, timeoutMs: 60_000, signal: opts.signal, env: this.srEnv() });
    if (r.code !== 0 && r.code !== 1) return null; // script unavailable: the TS port already ran
    return r.stdout
      .split('\n')
      .map((l) => /^(.+):(\d+) (\S+)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ stage: 'leak', code: `LEAK_REPO_${m[3]!.toUpperCase().replace(/-/g, '_')}`, severity: 'block' as const, file: m[1]!, line: Number(m[2]), message: `repository leakgrep rule ${m[3]}` }));
  }

  // ---------------------------------------------------------------- staging

  async stageBatch(input: StageBatchInput): Promise<StageBatchResult> {
    const slot = this.slotCount; // dedicated staging worktree after the worker slots
    const p = this.wt(slot);
    if (!existsSync(join(p, '.git'))) {
      const r = await this.git(this.cfg.repoPath, ['worktree', 'add', '--detach', p, this.sha], 600_000);
      if (r.code !== 0) return { branch: null, verified: false, problems: [`staging worktree: ${r.stderr.slice(0, 200)}`] };
    }
    await this.reset(slot);
    await this.writeFiles(slot, input.files);
    const problems: string[] = [];
    const ac = new AbortController();
    for (const t of input.tasks) {
      if (!t.srTaskId) {
        problems.push(`${t.id}: no sr task id`);
        continue;
      }
      const r = await this.compare(slot, t.task, { srTaskId: t.srTaskId, allowedPaths: [], packs: [], toolingChanges: [] }, { signal: ac.signal, timeoutMs: 600_000 });
      if (!r.allPass) problems.push(`${t.id}: ${r.infraError ?? r.functions.filter((f) => f.result !== 'pass').map((f) => `${f.rva} ${f.reason ?? ''}`).join(', ') ?? 'compile error'}`);
    }
    const branch = `decomp/${input.runId}-b${input.seq}`;
    const co = await this.git(p, ['checkout', '-q', '-B', branch]);
    const add = await this.git(p, ['add', '--', ...input.files.map((f) => f.path)]);
    const commit = await this.git(p, ['commit', '-q', '-m', input.message]);
    if (co.code !== 0 || add.code !== 0 || commit.code !== 0) problems.push(`git: ${(co.stderr + add.stderr + commit.stderr).slice(0, 300)}`);
    return { branch: commit.code === 0 ? branch : null, verified: problems.length === 0, problems };
  }

  // ---------------------------------------------------------------- context

  async docs(): Promise<DocSection[]> {
    const out: DocSection[] = [];
    for (const [id, rel, cap] of DOCS) {
      const p = join(this.cfg.repoPath, rel);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, 'utf8');
      out.push({ id, title: rel, source: `${rel}@${this.sha.slice(0, 12)}`, content: text.length > cap ? `${text.slice(0, cap)}\n[truncated: ${text.length - cap} more chars in ${rel}]` : text });
    }
    return out;
  }

  async includedHeaders(slot: number, unitFiles: string[]): Promise<DocSection[]> {
    const seen = new Set<string>(unitFiles);
    const out: DocSection[] = [];
    for (const uf of unitFiles) {
      const src = (await this.readFile(slot, uf)) ?? '';
      for (const m of src.matchAll(/^\s*#\s*include\s*"([^"]+\.h)"/gm)) {
        const inc = m[1]!;
        const candidates = [join('reconstruction', inc), join(dirname(uf), inc)].map((p) => p.replace(/\\/g, '/'));
        for (const c of candidates) {
          if (seen.has(c) || out.length >= 8) continue;
          const text = await this.readFile(slot, c);
          if (text === null) continue;
          seen.add(c);
          out.push({ id: `hdr:${c}`, title: c, source: c, content: text.length > 8_000 ? `${text.slice(0, 8_000)}\n[truncated header]` : text });
          break;
        }
      }
    }
    return out;
  }

  async readPack(pack: string): Promise<string | null> {
    const parts: string[] = [];
    for (const f of ['bytes.txt', 'decomp.c']) {
      const p = join(pack, f);
      if (existsSync(p)) {
        const t = readFileSync(p, 'utf8');
        parts.push(`--- ${f} ---\n${t.length > 40_000 ? `${t.slice(0, 40_000)}\n[truncated ${t.length - 40_000} chars]` : t}`);
      }
    }
    return parts.length ? parts.join('\n') : null;
  }
}
