// SPDX-License-Identifier: AGPL-3.0-or-later
// Real adapter for awarebayes/skyrim_decomp. Follows the repo's documented parallel-contributor
// setup (docs/contributor-parallel.md): one git worktree per agent, a shared SR_LOCAL_DIR for
// toolchains/packs/claims, SR_CONTRIB_OFFLINE=1 + `claim --offline-ok` for unpublished local
// claims, `start --no-branch`, and `compare <task-id>` as the authoritative check.
//
// The checkout can live on this machine (`host: local`) or inside WSL (`host: wsl`), where Wine and
// the pinned MSVC usually are; all commands then run inside the distribution.
//
// Isolation per slot:
//   * worktree pinned to one base SHA for the whole process; reset --hard + clean -ffdx between
//     attempts and verified clean before reuse;
//   * all repo tooling runs bounded: wall-clock timeout with process-tree kill (plus `timeout -k`
//     inside WSL), output cap, cwd = the slot's worktree, explicit env only (provider keys never
//     reach repo tooling);
//   * optional container mode wraps the same command in `docker run --network none --cap-drop ALL
//     --read-only ...` with only the worktree and SR_LOCAL_DIR mounted;
//   * writes are realpath-checked so a symlink in the worktree cannot redirect them.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname as fsDirname } from 'node:path';
import type { CompareFunctionResult, Finding, FunctionFeatures, FunctionTarget, SelectionSpec } from '@decomp/core';
import { featuresFromPack, type PackJson } from '../intel/x64features.js';
import type { TaskRow } from '../db/store.js';
import { KeyedMutex } from '../util/async.js';
import type { RunResult } from '../util/proc.js';
import { LocalHost, WslHost, type Host } from './host.js';
import type { Backlog, CompareOutcome, DiscoveredFunction, DocSection, InventoryEntry, PreflightOutcome, PreparedTask, RepoAdapter, StageBatchInput, StageBatchResult, SubmitBatchInput, SubmitBatchResult } from './types.js';

export interface SrRepoConfig {
  /** Paths are on the repository host: Windows/POSIX paths for `local`, Linux paths for `wsl`. */
  repoPath: string;
  baseRef: string;
  worktreeRoot: string;
  /** Shared private storage (absolute). Must already be set up with `./sr setup`. */
  localDir: string;
  python: string;
  slots: number;
  host?: { kind: 'local' } | { kind: 'wsl'; distro: string };
  sandbox: { mode: 'local' } | { mode: 'docker'; image: string; cpus?: number; memory?: string };
  /** Exit codes of contrib.py that mean "infrastructure", not "candidate". */
  infraExitCodes?: number[];
  /**
   * Optional private function table derived locally from the operator's own pinned image (the same
   * opt-in input as `sr next --function-table`): a directory with table-meta.json + functions.jsonl,
   * or a JSON file with `functions`. Read for counts only (xrefs, blocks); never sent anywhere.
   */
  functionTable?: string;
}

const PROTECTED_PATHS = ['tools', 'builds', '.github', 'tests', 'sr', 'sr.cmd', 'reconstruction/recipes', 'data/target-hashes'];
const DOCS: Array<[string, string, number]> = [
  ['contributor-card', 'docs/contributor-card.md', 8_000],
  ['contributor-lessons', 'docs/contributor-lessons.md', 4_000],
  ['matching-cookbook', 'docs/matching-cookbook.md', 12_000],
  ['declaration-kit', 'docs/declaration-kit.md', 6_000],
];

export class InfraError extends Error {}

/** A git lock younger than this may belong to a command that is just starting: never touch it. */
const STALE_LOCK_MS = 10_000;
/**
 * Prints "<pid> <comm>" for each live git process whose working directory is in the worktree or
 * whose command line names the worktree or its git dir; "NOPROC" when /proc is not available.
 */
const LIVE_GIT_SCRIPT = [
  '[ -d /proc/self ] || { echo NOPROC; exit 0; }',
  'for d in /proc/[0-9]*; do',
  '  n=$(cat "$d/comm" 2>/dev/null) || continue',
  '  case "$n" in git*) ;; *) continue ;; esac',
  '  c=$(readlink "$d/cwd" 2>/dev/null)',
  '  case "$c" in "$1"|"$1"/*) echo "${d#/proc/} $n"; continue ;; esac',
  '  if tr "\\0" " " < "$d/cmdline" 2>/dev/null | grep -qF -e "$1" -e "$2"; then echo "${d#/proc/} $n"; fi',
  'done',
].join('\n');
export class SrRepo implements RepoAdapter {
  readonly name = 'skyrim_decomp';
  readonly slotCount: number;
  readonly host: Host;
  private sha = '';
  private srMutex = new KeyedMutex();
  private baseCache = new Map<string, string | null>();

  constructor(private cfg: SrRepoConfig) {
    this.slotCount = cfg.slots;
    this.host = cfg.host?.kind === 'wsl' ? new WslHost(cfg.host.distro) : new LocalHost();
    if (!this.host.path.isAbsolute(cfg.localDir)) throw new Error('localDir (SR_LOCAL_DIR) must be absolute');
  }

  private get p() {
    return this.host.path;
  }

  wt(slot: number) {
    return this.p.resolve(this.cfg.worktreeRoot, slot >= this.slotCount ? 'staging' : `slot-${slot}`);
  }

  private git(cwd: string, args: string[], timeoutMs = 60_000) {
    return this.host.run('git', args, { cwd, timeoutMs, maxOutputBytes: 64 * 1024 * 1024 });
  }

  private srEnv() {
    return { SR_LOCAL_DIR: this.cfg.localDir, SR_CONTRIB_OFFLINE: '1', SR_NO_SIBLING_NAMES: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  }

  /** Run `python tools/contrib.py --json <args>` in a slot (or the main checkout) under the sandbox. */
  async sr(cwd: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ run: RunResult; json: any }> {
    const base = ['tools/contrib.py', '--json', ...args];
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
      run = await this.host.run('docker', dockerArgs, { cwd, timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes: 8 * 1024 * 1024 });
    } else {
      run = await this.host.run(this.cfg.python, base, { cwd, env: this.srEnv(), timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes: 8 * 1024 * 1024 });
    }
    return { run, json: parseJsonOutput(run.stdout) };
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    const repo = this.cfg.repoPath;
    if (!this.host.exists(this.p.join(repo, 'tools', 'contrib.py'))) throw new Error(`${repo} is not a skyrim_decomp checkout (tools/contrib.py missing)`);
    if (!this.host.exists(this.cfg.localDir)) throw new Error(`SR_LOCAL_DIR ${this.cfg.localDir} does not exist; run ./sr setup first`);
    const rev = await this.git(repo, ['rev-parse', '--verify', `${this.cfg.baseRef}^{commit}`]);
    if (rev.code !== 0) throw new Error(`cannot resolve base ref ${this.cfg.baseRef}: ${rev.stderr.trim()}`);
    this.sha = rev.stdout.trim();
    const mk = await this.host.run('mkdir', ['-p', this.cfg.worktreeRoot], { cwd: repo, timeoutMs: 30_000 });
    if (this.host.kind === 'local' && mk.code !== 0) mkdirSync(this.cfg.worktreeRoot, { recursive: true });
    await this.git(repo, ['worktree', 'prune']);
    for (let i = 0; i < this.slotCount; i++) await this.ensureWorktree(i);
  }

  private async ensureWorktree(slot: number) {
    const p = this.wt(slot);
    if (!this.host.exists(this.p.join(p, '.git'))) {
      const r = await this.git(this.cfg.repoPath, ['worktree', 'add', '--detach', p, this.sha], 900_000);
      if (r.code !== 0) throw new Error(`worktree add failed for ${p}: ${r.stderr.trim()}`);
    }
    await this.reset(slot);
  }

  get baseSha() {
    return this.sha;
  }

  /** Remove this adapter's worktrees from the checkout (used by tooling/tests; never automatic). */
  async removeWorktrees() {
    for (let i = 0; i <= this.slotCount; i++) {
      const p = this.wt(i);
      if (this.host.exists(p)) await this.git(this.cfg.repoPath, ['worktree', 'remove', '--force', p], 300_000);
    }
    await this.git(this.cfg.repoPath, ['worktree', 'prune']);
  }

  notice: ((kind: string, msg: string) => void) | null = null;

  /**
   * Restore a slot to the pinned revision. One reset per slot at a time. A git killed mid-command
   * (the host's `timeout -k`, an aborted attempt, a server stop) leaves `index.lock` behind and
   * every later reset fails; such a lock is cleared only when it is provably abandoned (see
   * clearStaleLock), then the reset is tried once more.
   */
  async reset(slot: number) {
    await this.srMutex.run(`reset-${slot}`, async () => {
      const first = await this.tryReset(slot);
      if (first === null) return;
      if (!/index\.lock'?: File exists/i.test(first)) throw new InfraError(`slot ${slot} could not be restored to a clean state: ${first}`);
      const freed = await this.clearStaleLock(slot);
      if (!freed.cleared) throw new InfraError(`slot ${slot} could not be restored to a clean state: ${freed.reason}; ${first}`);
      const again = await this.tryReset(slot);
      if (again !== null) throw new InfraError(`slot ${slot} could not be restored to a clean state after clearing a stale lock: ${again}`);
      this.notice?.('slot.lock_recovered', `slot ${slot}: cleared a stale ${freed.lock} (${freed.reason}) and restored the worktree`);
    });
  }

  /** null when the slot is clean at the pinned revision, else what went wrong. */
  private async tryReset(slot: number): Promise<string | null> {
    const p = this.wt(slot);
    const a = await this.git(p, ['reset', '--hard', '-q', this.sha], 300_000);
    const b = await this.git(p, ['clean', '-ffdxq'], 300_000);
    const s = await this.git(p, ['status', '--porcelain=v1', '--untracked-files=all']);
    return a.code !== 0 || b.code !== 0 || s.stdout.trim() ? (a.stderr + b.stderr + s.stdout).slice(0, 300) : null;
  }

  /**
   * Remove the worktree's index.lock only when it is abandoned: no live git process works in or on
   * the worktree (checked through /proc; a host where that cannot be checked never gets a lock
   * removed) and the lock is older than STALE_LOCK_MS. A live git keeps its lock.
   */
  private async clearStaleLock(slot: number): Promise<{ cleared: boolean; reason: string; lock?: string }> {
    const p = this.wt(slot);
    const dir = await this.git(p, ['rev-parse', '--absolute-git-dir']);
    if (dir.code !== 0) return { cleared: false, reason: `git dir unknown: ${dir.stderr.trim().slice(0, 120)}` };
    const gitDir = dir.stdout.trim();
    const lock = this.p.join(gitDir, 'index.lock');
    const ps = await this.host.run('sh', ['-c', LIVE_GIT_SCRIPT, 'sh', p, gitDir], { cwd: '/', timeoutMs: 30_000 }).catch(() => null);
    if (!ps || ps.code !== 0 || ps.stdout.includes('NOPROC')) return { cleared: false, reason: 'cannot tell whether a git process still holds the lock on this host' };
    const live = ps.stdout.trim().split('\n').filter(Boolean);
    if (live.length) return { cleared: false, reason: `git still running on the worktree (pid ${live.slice(0, 3).join(', ')})` };
    let age: number;
    try {
      age = Date.now() - statSync(this.host.fsPath(lock)).mtimeMs;
    } catch {
      return { cleared: true, reason: 'the lock is already gone', lock: 'index.lock' };
    }
    if (age < STALE_LOCK_MS) return { cleared: false, reason: `the lock is only ${Math.round(age / 1000)}s old` };
    const rm = await this.host.run('rm', ['-f', '--', lock], { cwd: '/', timeoutMs: 30_000 });
    if (rm.code !== 0) return { cleared: false, reason: `rm failed: ${rm.stderr.trim().slice(0, 120)}` };
    return { cleared: true, reason: `no git process alive, lock ${Math.round(age / 1000)}s old`, lock: 'index.lock' };
  }

  // ---------------------------------------------------------------- discovery

  async discover(sel: SelectionSpec): Promise<DiscoveredFunction[]> {
    if (sel.source === 'synthetic') throw new Error('synthetic selection is only for the simulator');
    const count = sel.source === 'sr_next' ? sel.count : 100_000;
    const maxSize = sel.source === 'sr_next' ? sel.maxSize : 1_000_000;
    // Discover from a pristine slot at the base revision, not the operator's own checkout/branch.
    const cwd = this.host.exists(this.p.join(this.wt(0), '.git')) ? this.wt(0) : this.cfg.repoPath;
    const { run, json } = await this.sr(cwd, ['next', '--count', String(count), '--max-size', String(maxSize)], { timeoutMs: 600_000 });
    if (!json?.candidates) throw new InfraError(`sr next failed (exit ${run.code}): ${json?.error ?? (run.stderr || run.stdout).slice(0, 500)}`);
    const want = sel.source === 'rva_list' ? new Set(sel.rvas.map((r) => `0x${parseInt(r, 16).toString(16)}`)) : null;
    return (json.candidates as any[])
      .filter((c) => c.startable && c.unit && (!want || want.has(c.rva)))
      .map((c) => ({
        rva: c.rva, name: c.name ?? null, size: c.size, nameOrigin: c.name_origin ?? null, unit: String(c.unit).replace(/\\/g, '/'),
        readiness: c.readiness_rank, cautions: Array.isArray(c.cautions) ? c.cautions.length : 0,
      }));
  }

  // ---------------------------------------------------------------- per-task

  async prepare(slot: number, task: TaskRow, opts: { draftedBy: string; model: string; signal: AbortSignal }): Promise<PreparedTask> {
    const cwd = this.wt(slot);
    const rvas = task.functions.map((f) => f.rva);
    // claim/start write shared state under SR_LOCAL_DIR: serialise them across slots
    const started = await this.srMutex.run('sr-local', async () => {
      const claim = await this.sr(cwd, ['claim', ...rvas, '--offline-ok', '--model', opts.model, '--drafted-by', opts.draftedBy], { timeoutMs: 120_000, signal: opts.signal });
      if (claim.run.code !== 0) {
        throw new InfraError(`sr claim failed (exit ${claim.run.code}): ${claim.json?.error ?? (claim.run.stderr || claim.run.stdout).slice(0, 300)}`);
      }
      return this.sr(cwd, ['start', ...rvas, '--no-branch', '--drafted-by', opts.draftedBy, '--model', opts.model], { timeoutMs: 600_000, signal: opts.signal });
    });
    const j = started.json;
    if (started.run.code !== 0 || !j?.task) throw new InfraError(`sr start failed (exit ${started.run.code}): ${j?.error ?? (started.run.stderr || started.run.stdout).slice(0, 300)}`);
    const unit = (j.unit as string[]).map((p) => p.replace(/\\/g, '/'));
    const toolingChanges = (await this.changedPaths(slot)).filter((p) => !unit.includes(p));
    return { srTaskId: j.task, allowedPaths: unit, packs: (j.packs as string[]) ?? [], toolingChanges };
  }

  /**
   * Release local claims taken by `prepare`. Runs from the operator's main checkout (a slot may be
   * mid-attempt or dirty); `release` only edits SR_LOCAL_DIR/contrib/claims.json when offline.
   */
  async releaseClaims(rvas: string[], reason: string) {
    const out: Array<{ rva: string; ok: boolean; error: string | null }> = [];
    for (const rva of rvas) {
      const r = await this.srMutex.run('sr-local', () => this.sr(this.cfg.repoPath, ['release', rva, '--reason', reason], { timeoutMs: 120_000 }));
      const ok = r.run.code === 0 && r.json?.ok !== false;
      out.push({ rva, ok, error: ok ? null : (r.json?.error ?? `exit ${r.run.code}: ${(r.run.stderr || r.run.stdout).trim().slice(-300)}`) });
    }
    return out;
  }

  async recordAttribution(input: { task: TaskRow; srTaskId: string; model: string; draftedBy: string }) {
    const problems: string[] = [];
    const rvas = input.task.functions.map((f) => f.rva);
    await this.srMutex.run('sr-local', async () => {
      // Re-claiming one's own local claim only rewrites its record, now with the finishing model.
      const claim = await this.sr(this.cfg.repoPath, ['claim', ...rvas, '--offline-ok', '--model', input.model, '--drafted-by', input.draftedBy], { timeoutMs: 120_000 });
      if (claim.run.code !== 0 || claim.json?.ok === false) problems.push(`claim: ${claim.json?.error ?? (claim.run.stderr || claim.run.stdout).trim().slice(-200)}`);
      if (!/^[A-Za-z0-9._-]+$/.test(input.srTaskId)) {
        problems.push(`task id ${input.srTaskId} is not a plain name`);
        return;
      }
      const file = this.host.fsPath(this.p.join(this.cfg.localDir, 'contrib', 'tasks', input.srTaskId, 'task.json'));
      try {
        const task = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (task.drafter_model !== input.model) writeFileSync(file, `${JSON.stringify({ ...task, drafter_model: input.model }, null, 2)}\n`, 'utf8');
      } catch (e) {
        problems.push(`task.json: ${(e as Error).message.slice(0, 200)}`);
      }
    });
    return { ok: problems.length === 0, problems };
  }

  async baseFile(path: string) {
    if (this.baseCache.has(path)) return this.baseCache.get(path)!;
    const r = await this.git(this.cfg.repoPath, ['show', `${this.sha}:${path}`]);
    const v = r.code === 0 ? r.stdout : null;
    this.baseCache.set(path, v);
    return v;
  }

  private async safePath(slot: number, rel: string): Promise<string> {
    const root = this.wt(slot);
    const abs = this.p.resolve(root, rel);
    const r = this.p.relative(root, abs);
    if (r.startsWith('..') || this.p.isAbsolute(r)) throw new InfraError(`path ${rel} escapes the worktree`);
    const [realRoot, realAbs] = await Promise.all([this.host.realpath(root), this.host.realpath(abs)]);
    const rr = this.p.relative(realRoot, realAbs);
    if (rr.startsWith('..') || this.p.isAbsolute(rr)) throw new InfraError(`path ${rel} resolves outside the worktree (symlink)`);
    return abs;
  }

  async readFile(slot: number, path: string) {
    try {
      const abs = this.p.resolve(this.wt(slot), path);
      return readFileSync(this.host.fsPath(abs), 'utf8');
    } catch {
      return null;
    }
  }

  async writeFiles(slot: number, files: Array<{ path: string; content: string }>) {
    for (const f of files) {
      const abs = this.host.fsPath(await this.safePath(slot, f.path));
      mkdirSync(fsDirname(abs), { recursive: true });
      writeFileSync(abs, f.content, 'utf8');
    }
  }

  async changedPaths(slot: number) {
    const r = await this.git(this.wt(slot), ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
    if (r.code !== 0) throw new InfraError(`git status failed in slot ${slot}: ${r.stderr.slice(0, 200)}`);
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
    const filtered = r.stdout.split('\n').filter((l) => !/(^|\/)__pycache__\/|\.pyc$/.test(l)).join('\n');
    return createHash('sha256').update(this.sha).update(filtered).digest('hex');
  }

  async compare(slot: number, task: TaskRow, prep: PreparedTask, opts: { signal: AbortSignal; timeoutMs: number }): Promise<CompareOutcome> {
    const t = Date.now();
    const { run, json } = await this.sr(this.wt(slot), ['compare', prep.srTaskId ?? ''], opts);
    const infraCodes = new Set(this.cfg.infraExitCodes ?? [2, 5, 7, 8]);
    const base = { durationMs: Date.now() - t };
    const fail = (infraError: string): CompareOutcome => ({ ...base, completed: false, allPass: false, compileError: false, functions: [], infraError });
    if (run.timedOut || run.code === 124) return fail(`compare timed out after ${opts.timeoutMs} ms`);
    if (run.aborted) return fail('compare aborted');
    if (run.truncated) return fail('compare output exceeded the cap');
    if (!json || infraCodes.has(run.code ?? -1)) return fail(`compare infra failure (exit ${run.code}): ${json?.error ?? (run.stderr || run.stdout).slice(0, 300)}`);
    if (run.code === 3 || run.code === 4) return { ...base, completed: true, allPass: false, compileError: true, compileErrors: compileErrorLines(json), functions: [], infraError: null };
    const progress = (json.progress ?? {}) as Record<string, { metric?: string; value?: number; regions?: number } | null>;
    const functions: CompareFunctionResult[] = ((json.functions as any[]) ?? []).map((f) => {
      const p = progress[f.rva];
      const aligned = p?.metric === 'aligned_matching_bytes' && typeof p.value === 'number' ? p : null;
      return {
        rva: f.rva, name: f.name ?? null, result: f.result ?? 'fail', reason: f.reason ?? null, hint: f.hint || null,
        firstMismatch: f.first_mismatch ?? null, candidateSize: f.candidate_size ?? null, targetSize: f.target_size ?? null,
        exactBytes: f.coverage?.code_bytes_exact ?? null, totalBytes: f.coverage?.code_bytes_total ?? null,
        alignedBytes: aligned?.value ?? null, alignedRegions: aligned?.regions ?? null, codeSha256: f.code_section_sha256 ?? null,
      };
    });
    const expected = new Set(task.functions.map((f) => f.rva));
    const allPass = run.code === 0 && functions.length > 0 && functions.every((f) => f.result === 'pass') && [...expected].every((r) => functions.some((f) => f.rva === r));
    return { ...base, completed: true, allPass, compileError: false, functions, infraError: null };
  }

  async preflight(slot: number, _task: TaskRow, prep: PreparedTask, opts: { signal: AbortSignal; timeoutMs: number }): Promise<PreflightOutcome> {
    const { run, json } = await this.sr(this.wt(slot), ['preflight', prep.srTaskId ?? ''], opts);
    if (run.timedOut || run.code === 124 || !json) return { completed: false, ok: false, problems: [], infraError: `preflight failed to run (exit ${run.code}): ${(run.stderr || run.stdout).slice(0, 200)}` };
    if (run.code === 0) return { completed: true, ok: true, problems: [], infraError: null };
    // contrib.py preflight returns {problems|blockers, label_findings, origin_findings, warnings, messages}
    const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []);
    const blockers = list(json.problems).length ? list(json.problems) : list(json.blockers);
    const problems = [
      ...blockers,
      ...list(json.label_findings).map((x) => `label: ${x}`),
      ...list(json.origin_findings).map((x) => `origin: ${x}`),
      ...list(json.errors),
      ...(json.error ? [String(json.error)] : []),
    ].map((s) => s.slice(0, 400));
    if (!problems.length) problems.push(...list(json.messages).filter((m) => /BLOCKED|error|fail/i.test(m)).map((s) => s.slice(0, 400)));
    return { completed: true, ok: false, problems: problems.length ? problems : [`preflight exit ${run.code}`], infraError: null };
  }

  async repoLeakScan(slot: number, opts: { signal: AbortSignal }): Promise<Finding[] | null> {
    const p = this.wt(slot);
    // Untracked new files are not in `git diff`; intent-to-add makes them visible without staging
    // content (the index is discarded by the next reset anyway).
    await this.git(p, ['add', '--intent-to-add', '--all']);
    const diff = await this.git(p, ['diff', '--no-renames', '--no-color', '-U0', '--diff-algorithm=minimal', this.sha, '--']);
    if (diff.code !== 0) return null;
    const r = await this.host.run(this.cfg.python, ['tools/leakgrep.py', '--diff', '-'], { cwd: p, stdin: diff.stdout, timeoutMs: 60_000, signal: opts.signal, env: this.srEnv() });
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
    try {
      await this.ensureWorktree(slot);
    } catch (e) {
      return { branch: null, verified: false, problems: [`staging worktree: ${(e as Error).message.slice(0, 200)}`] };
    }
    await this.writeFiles(slot, input.files);
    const problems: string[] = [];
    const ac = new AbortController();
    for (const t of input.tasks) {
      if (!t.srTaskId) {
        problems.push(`${t.id}: no sr task id`);
        continue;
      }
      const r = await this.compare(slot, t.task, { srTaskId: t.srTaskId, allowedPaths: [], packs: [], toolingChanges: [] }, { signal: ac.signal, timeoutMs: 600_000 });
      if (!r.allPass) problems.push(`${t.id}: ${r.infraError ?? (r.functions.filter((f) => f.result !== 'pass').map((f) => `${f.rva} ${f.reason ?? ''}`).join(', ') || 'compile error')}`);
    }
    // A batch that does not re-verify is never committed: a branch is a claim that its code
    // matches. Put the staging worktree back so nothing unverified lingers there either.
    if (problems.length) {
      await this.reset(slot).catch(() => undefined);
      return { branch: null, verified: false, problems };
    }
    const branch = `decomp/${input.runId}-b${input.seq}`;
    const co = await this.git(p, ['checkout', '-q', '-B', branch]);
    const add = co.code === 0 ? await this.git(p, ['add', '--', ...input.files.map((f) => f.path)]) : co;
    const commit = add.code === 0 ? await this.git(p, ['commit', '-q', '-m', input.message]) : add;
    if (commit.code !== 0) {
      await this.reset(slot).catch(() => undefined);
      return { branch: null, verified: false, problems: [`git: ${(commit.stderr || commit.stdout).slice(0, 300)}`] };
    }
    return { branch, verified: true, problems };
  }

  async submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult> {
    const slot = this.slotCount;
    const p = this.wt(slot);
    const out: SubmitBatchResult = { ok: false, dryRun: input.dryRun, problems: [], blockers: [], warnings: [], plan: [], pullRequest: null, link: null, error: null };
    const last = input.tasks.at(-1);
    if (!last?.srTaskId || !/^[A-Za-z0-9._-]+$/.test(last.srTaskId)) return { ...out, problems: ['the batch has no submittable sr task'] };
    if (!/^[A-Za-z0-9._/-]+$/.test(input.branch)) return { ...out, problems: [`branch name ${input.branch} is not plain`] };
    const tdir = this.p.join(this.cfg.localDir, 'contrib', 'tasks', last.srTaskId);
    let unit: string[];
    try {
      const task = JSON.parse(readFileSync(this.host.fsPath(this.p.join(tdir, 'task.json')), 'utf8')) as { contrib?: { unit?: string[] } };
      unit = (task.contrib?.unit ?? []).map((u) => u.replace(/\\/g, '/'));
      if (!unit.length) throw new Error('task.json lists no unit');
    } catch (e) {
      return { ...out, problems: [`${last.srTaskId}: ${(e as Error).message.slice(0, 200)}`] };
    }
    try {
      await this.ensureWorktree(slot);
    } catch (e) {
      return { ...out, problems: [`staging worktree: ${(e as Error).message.slice(0, 200)}`] };
    }
    try {
      // The same tree the PR will carry, from the base, re-verified packet by packet: this also
      // writes each task's last-compare.json, which `sr submit` checks against the unit's digest.
      await this.writeFiles(slot, input.files);
      const ac = new AbortController();
      for (const t of input.tasks) {
        if (!t.srTaskId) {
          out.problems.push(`${t.id}: no sr task id`);
          continue;
        }
        const r = await this.compare(slot, t.task, { srTaskId: t.srTaskId, allowedPaths: [], packs: [], toolingChanges: [] }, { signal: ac.signal, timeoutMs: 600_000 });
        if (!r.allPass) out.problems.push(`${t.id}: ${r.infraError ?? (r.functions.filter((f) => f.result !== 'pass').map((f) => `${f.rva} ${f.reason ?? ''}`).join(', ') || 'compile error')}`);
      }
      if (out.problems.length) return out;
      const git = async (args: string[]) => {
        const r = await this.git(p, args);
        if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
        return r.stdout;
      };
      await git(['checkout', '-q', '-B', input.branch]);
      const others = input.files.map((f) => f.path).filter((f) => !unit.includes(f));
      if (others.length) {
        await git(['add', '--', ...others]);
        await git(['commit', '-q', '-m', input.message]);
      }
      // `sr submit` needs the network (claims check, push, gh) and the operator's own git/gh
      // credentials: it runs on the host, never in the sandbox, and without SR_CONTRIB_OFFLINE.
      const env = { SR_LOCAL_DIR: this.cfg.localDir, SR_NO_SIBLING_NAMES: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', GIT_TERMINAL_PROMPT: '0' };
      const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400)) : []);
      // `sr submit` checks other people's open claims and PRs only for the task it runs on: ask it
      // (dry run, which changes nothing) about every other task of the batch too.
      const collisions: string[] = [];
      for (const id of new Set(input.tasks.slice(0, -1).map((t) => t.srTaskId).filter((x): x is string => !!x && x !== last.srTaskId && /^[A-Za-z0-9._-]+$/.test(x)))) {
        const probe = await this.host.run(this.cfg.python, ['tools/contrib.py', '--json', 'submit', id, '--drafted-by', input.draftedBy, '--dry-run'], { cwd: p, env, timeoutMs: 300_000, maxOutputBytes: 8 * 1024 * 1024 });
        const pj = parseJsonOutput(probe.stdout) as Record<string, unknown> | null;
        if (!pj) out.warnings.push(`${id}: claims check did not run (exit ${probe.code})`);
        collisions.push(...list(pj?.blockers).filter((b) => /another open claim or pull request/i.test(b)).map((b) => `${id}: ${b}`));
        out.warnings.push(...list(pj?.warnings).filter((w) => /GitHub claims not checked/i.test(w)).map((w) => `${id}: ${w}`));
      }
      if (collisions.length && !input.dryRun) {
        out.blockers = collisions;
        out.error = 'other contributors have open claims or pull requests on functions in this batch; nothing was submitted';
        return out;
      }
      const args = ['tools/contrib.py', '--json', 'submit', last.srTaskId, '--drafted-by', input.draftedBy, ...(input.dryRun ? ['--dry-run'] : [])];
      const run = await this.host.run(this.cfg.python, args, { cwd: p, env, timeoutMs: 900_000, maxOutputBytes: 8 * 1024 * 1024 });
      const j = parseJsonOutput(run.stdout) as Record<string, unknown> | null;
      out.blockers = [...collisions, ...list(j?.blockers)];
      out.warnings = [...out.warnings, ...list(j?.warnings)];
      out.plan = list(j?.plan);
      out.pullRequest = typeof j?.pull_request === 'string' ? j.pull_request : null;
      out.link = typeof j?.link === 'string' ? j.link : null;
      out.ok = run.code === 0 && j?.ok !== false && !out.blockers.length;
      if (!out.ok) out.error = String(j?.error ?? (run.timedOut ? 'sr submit timed out' : `sr submit exit ${run.code}: ${(run.stderr || run.stdout).trim().slice(-300)}`));
      if (out.ok && !input.dryRun) {
        const branch = input.branch;
        // The other packets' tasks are part of this PR too: record it where `sr` keeps task state.
        for (const t of input.tasks.slice(0, -1)) {
          if (!t.srTaskId || !/^[A-Za-z0-9._-]+$/.test(t.srTaskId) || t.srTaskId === last.srTaskId) continue;
          const file = this.host.fsPath(this.p.join(this.cfg.localDir, 'contrib', 'tasks', t.srTaskId, 'task.json'));
          try {
            const task = JSON.parse(readFileSync(file, 'utf8')) as { contrib?: Record<string, unknown> };
            writeFileSync(file, `${JSON.stringify({ ...task, contrib: { ...task.contrib, submitted: branch } }, null, 2)}\n`, 'utf8');
          } catch (e) {
            out.warnings.push(`${t.srTaskId}: could not record the submission: ${(e as Error).message.slice(0, 200)}`);
          }
        }
        // `sr submit` titles and describes the PR from the submitted task; name the whole batch.
        if (out.pullRequest && (input.title || input.extraBody)) {
          const bodyFile = this.p.join(tdir, 'pr-body-batch.md');
          try {
            const body = readFileSync(this.host.fsPath(this.p.join(tdir, 'pr-body.md')), 'utf8');
            writeFileSync(this.host.fsPath(bodyFile), `${body.trimEnd()}\n\n${input.extraBody ?? ''}\n`, 'utf8');
            const edit = await this.host.run('gh', ['pr', 'edit', out.pullRequest, ...(input.title ? ['--title', input.title] : []), '--body-file', bodyFile], { cwd: p, timeoutMs: 120_000 });
            if (edit.code !== 0) out.warnings.push(`gh pr edit: ${(edit.stderr || edit.stdout).trim().slice(0, 300)}; the PR keeps sr submit's title and body`);
          } catch (e) {
            out.warnings.push(`PR body: ${(e as Error).message.slice(0, 200)}`);
          }
        }
      }
      return out;
    } catch (e) {
      return { ...out, ok: false, error: (e as Error).message };
    } finally {
      // The pushed branch stays (it is the PR); the staging worktree goes back to the base.
      await this.reset(slot).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- context

  async docs(): Promise<DocSection[]> {
    const out: DocSection[] = [];
    for (const [id, rel, cap] of DOCS) {
      const text = await this.readHostFile(this.p.join(this.cfg.repoPath, rel));
      if (text === null) continue;
      const shown = (await this.baseFile(rel)) ?? text; // prefer the pinned base revision's copy
      out.push({ id, title: rel, source: `${rel}@${this.sha.slice(0, 12)}`, content: shown.length > cap ? `${shown.slice(0, cap)}\n[truncated: ${shown.length - cap} more chars in ${rel}]` : shown });
    }
    return out;
  }

  /**
   * Gatherer input: data/progress.json at the base revision (the public inventory), `sr next` over
   * the whole backlog (the repo's own unit mapping, readiness order and claim exclusion), local
   * claims, and the optional function table.
   */
  async backlog(opts: { maxSize: number }): Promise<Backlog> {
    const text = (await this.baseFile('data/progress.json')) ?? (await this.readHostFile(this.p.join(this.cfg.repoPath, 'data/progress.json')));
    if (!text) throw new InfraError('data/progress.json not found in the checkout');
    const prog = JSON.parse(text) as { functions: Array<{ rva: number; size: number; name?: string | null; name_origin?: string | null; status: string }> };
    const inventory: InventoryEntry[] = prog.functions.map((f) => ({ rva: `0x${f.rva.toString(16)}`, name: f.name ?? null, size: f.size, nameOrigin: f.name_origin ?? null, status: f.status }));
    const cwd = this.host.exists(this.p.join(this.wt(0), '.git')) ? this.wt(0) : this.cfg.repoPath;
    const { run, json } = await this.sr(cwd, ['next', '--count', '100000', '--max-size', String(opts.maxSize)], { timeoutMs: 600_000 });
    if (!json?.candidates) throw new InfraError(`sr next failed (exit ${run.code}): ${json?.error ?? (run.stderr || run.stdout).slice(0, 500)}`);
    const candidates: DiscoveredFunction[] = (json.candidates as any[])
      .filter((c) => c.startable && c.unit)
      .map((c) => ({
        rva: c.rva, name: c.name ?? null, size: c.size, nameOrigin: c.name_origin ?? null, unit: String(c.unit).replace(/\\/g, '/'),
        readiness: c.readiness_rank, cautions: Array.isArray(c.cautions) ? c.cautions.length : 0,
      }));
    let claimed: string[] = [];
    const claims = await this.readHostFile(this.p.join(this.cfg.localDir, 'contrib', 'claims.json'));
    if (claims) {
      try {
        const obj = JSON.parse(claims) as Record<string, unknown>;
        const keys = Array.isArray(obj) ? (obj as Array<{ rva?: string }>).map((x) => x.rva ?? '') : Object.keys((obj.claims as object | undefined) ?? obj);
        claimed = keys.filter((k) => /^(0x)?[0-9a-f]+$/i.test(k)).map((k) => `0x${parseInt(k, 16).toString(16)}`);
      } catch {
        /* unreadable claims file: sr next has already excluded what it knows */
      }
    }
    return {
      source: `data/progress.json@${this.sha.slice(0, 12)} + sr next${this.cfg.functionTable ? ' + function table' : ''}`,
      inventory, candidates, claimed, claimsChecked: json.claims_checked !== false, functionTable: await this.functionTable(),
    };
  }

  private async functionTable(): Promise<Map<string, Record<string, unknown>> | null> {
    const path = this.cfg.functionTable;
    if (!path) return null;
    const rows: Array<Record<string, unknown>> = [];
    const jsonl = await this.readHostFile(this.p.join(path, 'functions.jsonl'));
    if (jsonl !== null) {
      for (const line of jsonl.split('\n')) if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>);
    } else {
      const file = await this.readHostFile(path);
      if (file) rows.push(...((JSON.parse(file) as { functions?: Array<Record<string, unknown>> }).functions ?? []));
    }
    const out = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const rva = typeof r.rva === 'number' ? r.rva : typeof r.rva === 'string' ? parseInt(r.rva, 16) : NaN;
      if (Number.isFinite(rva)) out.set(`0x${rva.toString(16)}`, r);
    }
    return out;
  }

  async docFile(rel: string): Promise<string | null> {
    if (!/^docs\/[A-Za-z0-9_.-]+\.md$/.test(rel)) return null;
    return (await this.baseFile(rel)) ?? (await this.readHostFile(this.p.join(this.cfg.repoPath, rel)));
  }

  async packFor(fn: FunctionTarget): Promise<string | null> {
    const root = this.p.join(this.cfg.localDir, 'contrib', 'packs');
    const leaf = `0x${parseInt(fn.rva, 16).toString(16)}`;
    let builds: string[] = [];
    try {
      builds = readdirSync(this.host.fsPath(root));
    } catch {
      return null;
    }
    for (const b of builds) {
      const dir = this.p.join(root, b, leaf);
      if (existsSync(this.host.fsPath(this.p.join(dir, 'pack.json')))) return dir;
    }
    return null;
  }

  private async readHostFile(p: string) {
    try {
      return readFileSync(this.host.fsPath(p), 'utf8');
    } catch {
      return null;
    }
  }

  async includedHeaders(slot: number, unitFiles: string[], opts: { maxChars?: number; maxHeaders?: number } = {}): Promise<DocSection[]> {
    const cap = opts.maxChars ?? 8_000;
    const maxHeaders = opts.maxHeaders ?? 8;
    const seen = new Set<string>(unitFiles);
    const out: DocSection[] = [];
    for (const uf of unitFiles) {
      const src = (await this.readFile(slot, uf)) ?? '';
      for (const m of src.matchAll(/^\s*#\s*include\s*"([^"]+\.h)"/gm)) {
        const inc = m[1]!;
        const candidates = [`reconstruction/${inc}`, this.p.join(this.p.dirname(uf), inc)].map((x) => this.p.normalize(x));
        for (const c of candidates) {
          if (seen.has(c) || out.length >= maxHeaders) continue;
          const text = await this.readFile(slot, c);
          if (text === null) continue;
          seen.add(c);
          out.push({ id: `hdr:${c}`, title: c, source: c, content: text.length > cap ? `${text.slice(0, cap)}\n[truncated header]` : text });
          break;
        }
      }
    }
    return out;
  }

  /**
   * Complexity counts from local packs (SR_LOCAL_DIR/contrib/packs/<build>/0x<rva>/pack.json): the
   * ones prepare() just wrote, else any earlier local pack for the same RVA. Counts only.
   */
  async analyze(fns: FunctionTarget[], opts: { packs?: string[] } = {}): Promise<Map<string, FunctionFeatures>> {
    const out = new Map<string, FunctionFeatures>();
    const root = this.p.join(this.cfg.localDir, 'contrib', 'packs');
    let builds: string[] = [];
    try {
      builds = readdirSync(this.host.fsPath(root));
    } catch {
      /* no packs yet */
    }
    for (const f of fns) {
      const leaf = `0x${parseInt(f.rva, 16).toString(16)}`;
      const dirs = [...(opts.packs ?? []).filter((d) => this.p.basename(d) === leaf), ...builds.map((b) => this.p.join(root, b, leaf))];
      for (const d of dirs) {
        const text = await this.readHostFile(this.p.join(d, 'pack.json'));
        if (!text) continue;
        try {
          out.set(f.rva, featuresFromPack(JSON.parse(text) as PackJson));
          break;
        } catch {
          /* malformed pack: try the next location */
        }
      }
    }
    return out;
  }

  /**
   * Budgeted listing for the prompt (exposure consent only): the mnemonic listing when the repo
   * produced one (far denser than the byte listing), else the byte listing; head + tail kept when
   * over budget; decompiler output only if asked and room remains.
   */
  async readPackSlice(pack: string, maxChars: number, opts: { withDecompiler?: boolean } = {}): Promise<{ text: string; rawChars: number } | null> {
    const listing = (await this.readHostFile(this.p.join(pack, 'listing.txt'))) ?? (await this.readHostFile(this.p.join(pack, 'bytes.txt')));
    const decomp = await this.readHostFile(this.p.join(pack, 'decomp.c'));
    if (listing === null && decomp === null) return null;
    const rawChars = (listing?.length ?? 0) + (decomp?.length ?? 0);
    let text = listing ? clipMiddle(listing.replace(/[ \t]+$/gm, ''), maxChars) : '';
    if (opts.withDecompiler && decomp && maxChars - text.length > 400) text += `\n--- decompiler ---\n${clipMiddle(decomp, maxChars - text.length - 24)}`;
    return { text, rawChars };
  }

  async readPack(pack: string): Promise<string | null> {
    const parts: string[] = [];
    for (const f of ['bytes.txt', 'decomp.c']) {
      const t = await this.readHostFile(this.p.join(pack, f));
      if (t !== null) parts.push(`--- ${f} ---\n${t.length > 40_000 ? `${t.slice(0, 40_000)}\n[truncated ${t.length - 40_000} chars]` : t}`);
    }
    return parts.length ? parts.join('\n') : null;
  }
}

/** Keep the head and tail of an over-long listing, marking how many lines were elided. */
export function clipMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const head: string[] = [];
  const tail: string[] = [];
  let used = 40;
  let i = 0;
  let j = lines.length - 1;
  while (i <= j) {
    const h = lines[i]!;
    if (used + h.length + 1 > maxChars * 0.65) break;
    head.push(h);
    used += h.length + 1;
    i++;
  }
  while (j >= i) {
    const t = lines[j]!;
    if (used + t.length + 1 > maxChars) break;
    tail.unshift(t);
    used += t.length + 1;
    j--;
  }
  return [...head, `[… ${j - i + 1} line(s) elided to fit the context budget …]`, ...tail].join('\n');
}

function parseJsonOutput(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('{');
    if (start >= 0) {
      try {
        return JSON.parse(stdout.slice(start));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * The compiler's error lines from a failed `sr compare --json` (exit 3 COMPILE / 4 UNIT), with
 * worktree paths made repo-relative. These describe the candidate's own source, so the Worker may
 * see them; without them a retry only learns "it did not compile" and repeats the same mistake.
 */
export function compileErrorLines(json: any): string[] {
  const raw: string[] = Array.isArray(json?.errors) ? json.errors.map(String) : [];
  if (!raw.length && typeof json?.error === 'string' && json.error !== 'compile failed') raw.push(json.error);
  return raw.slice(0, 8).map((l) => relativiseWorktreePaths(l).slice(0, 400));
}

/** `z:\home\me\worktrees\slot-2\reconstruction\a\B.h(13): ...` → `reconstruction/a/B.h(13): ...` */
export function relativiseWorktreePaths(line: string): string {
  return line.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'"<>|]*?[\\/])?slot-\d+[\\/]([^\s'"<>|(]+)/g, (_m, rest: string) => rest.replace(/\\/g, '/'));
}
