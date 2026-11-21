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
import type { Backlog, ClaimCollision, ClaimCollisionCheck, CompareOutcome, DiscoveredFunction, DocSection, InventoryEntry, PreflightOutcome, PreparedTask, RepoAdapter, StageBatchInput, StageBatchResult, SubmitBatchInput, SubmitBatchResult, UpstreamState } from './types.js';
import { batchPrText, type CompareSummary } from './batchPr.js';

interface ProgressInventory {
  target_build_id?: string;
  functions: Array<{ rva: number; size: number; name?: string | null; name_origin?: string | null; status: string; build_id?: string }>;
}

interface SrCandidate {
  rva: string;
  size: number;
  name?: string | null;
  name_origin?: string | null;
  startable: boolean;
  unit: string;
  build_id?: string;
  readiness_rank?: number;
  cautions?: unknown[];
}

const rvaHex = (rva: number) => `0x${rva.toString(16)}`;

/** The project's repository since it moved to the organisation (tools/repo_slug.py upstream). */
export const DEFAULT_UPSTREAM = 'Mudcrab-Team/skyrim_decomp';

export interface SrRepoConfig {
  /** Paths are on the repository host: Windows/POSIX paths for `local`, Linux paths for `wsl`. */
  repoPath: string;
  baseRef: string;
  /** GitHub `owner/name` of the project (SR_UPSTREAM): claims, open PRs, and where PRs open. */
  upstream?: string;
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
    return { SR_LOCAL_DIR: this.cfg.localDir, SR_CONTRIB_OFFLINE: '1', SR_NO_SIBLING_NAMES: '1', SR_UPSTREAM: this.upstream, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  }

  /** The project's GitHub repository (claims are its open issues; PRs open there). */
  get upstream() {
    return this.cfg.upstream ?? DEFAULT_UPSTREAM;
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
        '-e', 'SR_LOCAL_DIR=/local', '-e', 'SR_CONTRIB_OFFLINE=1', '-e', 'SR_NO_SIBLING_NAMES=1', '-e', `SR_UPSTREAM=${this.upstream}`,
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
    // A staging slot can be on a batch branch. Detach without moving its ref.
    const a = await this.git(p, ['checkout', '--detach', '-f', '-q', this.sha], 300_000);
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

  private get claimWorktree() {
    return this.wt(0);
  }

  /** Fetch the configured upstream branch into an app-owned ref, leaving the compiler base pinned. */
  private async syncedInventory() {
    const { repoPath, baseRef } = this.cfg;
    const tracking = baseRef.replace(/^refs\/remotes\//, '');
    const remotes = await this.git(repoPath, ['remote']);
    if (remotes.code !== 0) throw new InfraError('could not read the repository remotes');
    const remote = remotes.stdout.trim().split(/\r?\n/).filter(Boolean)
      .sort((a, b) => b.length - a.length).find((name) => tracking.startsWith(`${name}/`));
    let revision = this.sha;
    if (remote) {
      const branch = tracking.slice(remote.length + 1);
      const ref = `refs/decomp/claim-base/${tracking}`;
      const fetched = await this.git(repoPath, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', '--', remote, `+refs/heads/${branch}:${ref}`], 120_000);
      if (fetched.code !== 0) throw new InfraError(`could not sync ${tracking}: ${fetched.stderr.trim().slice(0, 300)}`);
      const head = await this.git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
      if (head.code !== 0) throw new InfraError(`could not resolve synced ${tracking}`);
      revision = head.stdout.trim();
    }
    const result = await this.git(repoPath, ['show', `${revision}:data/progress.json`]);
    if (result.code !== 0) throw new InfraError('could not read the synced progress inventory');
    const progress = parseJsonOutput(result.stdout) as ProgressInventory | null;
    if (!Array.isArray(progress?.functions)) throw new InfraError('the synced progress inventory is invalid');
    return { revision, progress };
  }

  private async syncedBacklog(maxSize: number) {
    return this.srMutex.run('claim-sync', async () => {
      const { revision, progress } = await this.syncedInventory();
      const pinned = revision === this.sha ? progress : parseJsonOutput((await this.baseFile('data/progress.json')) ?? '') as ProgressInventory | null;
      if (!pinned || pinned.target_build_id !== progress.target_build_id || !Array.isArray(pinned.functions)) {
        throw new InfraError('upstream target build differs from the pinned checkout or its inventory is unreadable');
      }
      // sr next reads local reservations and GitHub issues/PRs, but does not publish a claim.
      const { SR_CONTRIB_OFFLINE: _, ...env } = this.srEnv();
      const run = await this.host.run(this.cfg.python, ['tools/contrib.py', '--json', 'next', '--count', '100000', '--max-size', String(maxSize)], {
        cwd: this.claimWorktree, env, timeoutMs: 600_000, maxOutputBytes: 32 * 1024 * 1024,
      });
      const result = parseJsonOutput(run.stdout);
      if (run.code !== 0 || !Array.isArray(result?.candidates)) {
        throw new InfraError(`sr next failed (exit ${run.code}): ${result?.error ?? run.stderr.trim().slice(0, 300)}`);
      }
      if (result.claims_checked !== true) throw new InfraError('GitHub claims could not be checked. Restore GitHub access and try again.');
      const entries = new Map(progress.functions.map((entry) => [rvaHex(entry.rva), entry]));
      // Candidates must be startable in the pinned build and not matched upstream since the pin.
      // A function of the published target-hash list has no inventory entry until the bot records
      // its match (`next`/`claim`/`start` offer it), so no upstream entry means still unmatched.
      const candidates: DiscoveredFunction[] = result.candidates
        .filter((c: SrCandidate) => {
          if (!c.startable || !c.unit) return false;
          const upstream = entries.get(c.rva);
          if (!upstream) return true;
          return upstream.status === 'mapped' && upstream.size === c.size && (!upstream.build_id || !c.build_id || upstream.build_id === c.build_id);
        })
        .map((c: SrCandidate) => ({
          rva: c.rva, name: c.name ?? null, size: c.size, nameOrigin: c.name_origin ?? null, unit: c.unit.replace(/\\/g, '/'),
          readiness: c.readiness_rank, cautions: c.cautions?.length ?? 0,
        }));
      return { candidates, revision, progress };
    });
  }

  async discover(sel: SelectionSpec, opts?: { exclude?: ReadonlySet<string> }): Promise<DiscoveredFunction[]> {
    if (sel.source === 'synthetic') throw new Error('synthetic selection is only for the simulator');
    const { candidates } = await this.syncedBacklog(sel.source === 'sr_next' ? sel.maxSize : 1_000_000);
    const want = sel.source === 'rva_list' ? new Set(sel.rvas.map((r) => rvaHex(parseInt(r, 16)))) : null;
    return candidates.filter((c) => !opts?.exclude?.has(c.rva) && (!want || want.has(c.rva)))
      .slice(0, sel.source === 'sr_next' ? sel.count : undefined);
  }

  // ---------------------------------------------------------------- per-task

  private localClaims(): Record<string, { status?: string; url?: string | null; model?: string }> {
    const path = this.host.fsPath(this.p.join(this.cfg.localDir, 'contrib', 'claims.json'));
    try {
      const claims = parseJsonOutput(readFileSync(path, 'utf8'));
      if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new InfraError('the local claims file is invalid');
      return claims;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async prepare(slot: number, task: TaskRow, opts: { draftedBy: string; model: string; signal: AbortSignal }): Promise<PreparedTask> {
    const cwd = this.wt(slot);
    const rvas = task.functions.map((f) => f.rva);
    // claim/start write shared state under SR_LOCAL_DIR: serialise them across slots
    const j = await this.srMutex.run('sr-local', async () => {
      const existing = this.localClaims();
      const missing = rvas.filter((rva) => !Object.hasOwn(existing, rva));
      try {
        opts.signal.throwIfAborted();
        if (missing.length) {
          const claim = await this.sr(cwd, ['claim', ...missing, '--offline-ok', '--model', opts.model, '--drafted-by', opts.draftedBy], { timeoutMs: 120_000, signal: opts.signal });
          const recorded = this.localClaims();
          if (claim.run.code !== 0 || claim.json?.claim !== 'unpublished' || missing.some((rva) => recorded[rva]?.status !== 'unpublished')) {
            throw new InfraError(`sr local claim failed (exit ${claim.run.code}): ${claim.json?.error ?? (claim.run.stderr || claim.run.stdout).slice(0, 300)}`);
          }
        }
        opts.signal.throwIfAborted();
        const started = await this.sr(cwd, ['start', ...rvas, '--no-branch', '--drafted-by', opts.draftedBy, '--model', opts.model], { timeoutMs: 600_000, signal: opts.signal });
        if (started.run.code !== 0 || !started.json?.task) {
          throw new InfraError(`sr start failed (exit ${started.run.code}): ${started.json?.error ?? (started.run.stderr || started.run.stdout).slice(0, 300)}`);
        }
        return started.json;
      } catch (error) {
        const current = this.localClaims();
        for (const rva of missing.filter((id) => current[id]?.status === 'unpublished')) {
          const result = await this.sr(cwd, ['release', rva, '--reason', 'decomp-orchestrator: preparation failed'], { timeoutMs: 120_000 }).catch(() => null);
          if (result?.run.code !== 0 || result.json?.rva !== rva) this.notice?.('claims.release_failed', `could not roll back local claim ${rva} after preparation failed`);
        }
        throw error;
      }
    });
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
      try {
        const r = await this.srMutex.run('sr-local', () => this.sr(this.cfg.repoPath, ['release', rva, '--reason', reason], { timeoutMs: 120_000 }));
        const ok = r.run.code === 0 && r.json?.ok !== false && r.json?.rva === rva;
        const error = r.json?.error ?? (r.run.code === 0 ? 'sr release did not confirm this RVA' : `exit ${r.run.code}: ${(r.run.stderr || r.run.stdout).trim().slice(-300)}`);
        out.push({ rva, ok, error: ok ? null : error });
      } catch (error) {
        out.push({ rva, ok: false, error: String(error) });
      }
    }
    return out;
  }

  async recordAttribution(input: { task: TaskRow; srTaskId: string; model: string; draftedBy: string; slot?: number }) {
    const problems: string[] = [];
    const rvas = input.task.functions.map((f) => f.rva);
    await this.srMutex.run('sr-local', async () => {
      // Re-claiming one's own local claim only rewrites its record, now with the finishing model.
      const existing = this.localClaims();
      // A claim that already records this model needs no new `sr claim` (it stores only the model).
      const local = rvas.filter((rva) => existing[rva]?.status !== 'published' && !existing[rva]?.url && existing[rva]?.model !== input.model);
      if (local.length) {
        const claim = await this.sr(this.wt(input.slot ?? 0), ['claim', ...local, '--offline-ok', '--model', input.model, '--drafted-by', input.draftedBy], { timeoutMs: 120_000 });
        if (claim.run.code !== 0 || claim.json?.claim !== 'unpublished') problems.push(`claim: ${claim.json?.error ?? (claim.run.stderr || claim.run.stdout).trim().slice(-200)}`);
      }
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

  async deleteBatchBranch(branch: string): Promise<boolean> {
    if (!/^decomp\/run_[a-z0-9]+-b[1-9]\d*(?:-pr)?$/.test(branch)) throw new Error('invalid local batch branch');
    const ref = `refs/heads/${branch}`;
    const found = await this.git(this.cfg.repoPath, ['show-ref', '--verify', '--quiet', ref]);
    if (found.code === 1) return false;
    if (found.code !== 0) throw new Error('could not look up the local batch branch');
    const staging = this.wt(this.slotCount);
    if (this.host.exists(this.p.join(staging, '.git'))) {
      const head = await this.git(staging, ['symbolic-ref', '--quiet', 'HEAD']);
      if (head.code === 0 && head.stdout.trim() === ref) {
        const detached = await this.git(staging, ['checkout', '--detach', '-q', 'HEAD']);
        if (detached.code !== 0) throw new Error(`could not detach the staging worktree: ${detached.stderr.trim().slice(0, 300)}`);
      }
    }
    const deleted = await this.git(this.cfg.repoPath, ['branch', '-D', '--', branch]);
    if (deleted.code !== 0) throw new Error(`could not delete ${branch}: ${deleted.stderr.trim().slice(0, 300)}`);
    return true;
  }

  /**
   * Fresh open claims and pull requests by others that name these functions, decided by the
   * repository's own code (`open_items` + `claim_state`, as `sr submit` does): lapsed claims and the
   * operator's own (by GitHub login or local claim URL) do not count. Reads GitHub; publishes nothing.
   */
  async claimCollisions(rvas: string[], opts: { signal?: AbortSignal } = {}): Promise<ClaimCollisionCheck> {
    const wanted = [...new Set(rvas)].filter((r) => /^0x[0-9a-f]+$/.test(r));
    if (!wanted.length) return { checked: true, error: null, collisions: {} };
    const env = { SR_LOCAL_DIR: this.cfg.localDir, SR_NO_SIBLING_NAMES: '1', SR_UPSTREAM: this.upstream, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', GIT_TERMINAL_PROMPT: '0' };
    const run = await this.host.run(this.cfg.python, ['-c', CLAIM_COLLISIONS_PY, JSON.stringify(wanted)], {
      cwd: this.cfg.repoPath, env, signal: opts.signal, timeoutMs: 300_000, maxOutputBytes: 8 * 1024 * 1024,
    });
    return claimCollisionResult(run, wanted);
  }

  async upstreamState(input: { rvas: string[]; files: string[]; branch: string | null }): Promise<UpstreamState> {
    const out: UpstreamState = { checked: false, matched: {}, untracked: [], changed: [], builtOn: null };
    const text = await this.baseFile('data/progress.json');
    if (!text) return out;
    let fns: Array<{ rva?: unknown; status?: unknown; owner?: unknown }>;
    try {
      const j = JSON.parse(text) as { functions?: unknown };
      fns = Array.isArray(j.functions) ? j.functions : [];
    } catch {
      return out;
    }
    const byRva = new Map(fns.map((f) => [typeof f.rva === 'number' ? f.rva : Number.parseInt(String(f.rva), 16), f]));
    for (const rva of new Set(input.rvas)) {
      const e = byRva.get(Number.parseInt(rva, 16));
      if (!e) out.untracked.push(rva);
      else if (e.status === 'matched') out.matched[rva] = typeof e.owner === 'string' ? e.owner : null;
    }
    if (input.branch && /^[A-Za-z0-9._/-]+$/.test(input.branch)) {
      const r = await this.git(this.cfg.repoPath, ['log', '-1', '--format=%P', input.branch, '--']);
      const parent = r.code === 0 ? r.stdout.trim().split(/\s+/)[0] : '';
      if (/^[0-9a-f]{40}$/.test(parent ?? '')) out.builtOn = parent!;
    }
    const files = [...new Set(input.files)].filter((f) => /^[\w./-]+$/.test(f));
    if (out.builtOn && out.builtOn !== this.sha && files.length) {
      const d = await this.git(this.cfg.repoPath, ['diff', '--name-only', out.builtOn, this.sha, '--', ...files]);
      if (d.code !== 0) return out;
      out.changed = d.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    out.checked = true;
    return out;
  }

  async stageBatch(input: StageBatchInput): Promise<StageBatchResult> {
    const slot = this.slotCount; // dedicated staging worktree after the worker slots
    const p = this.wt(slot);
    try {
      await this.ensureWorktree(slot);
    } catch (e) {
      return { branch: null, verified: false, problems: [`staging worktree: ${(e as Error).message.slice(0, 200)}`] };
    }
    await this.writeFiles(slot, input.files);
    const ac = new AbortController();
    const v = await this.verifyTree(slot, input.tasks, { signal: ac.signal, stagedAt: null, files: input.files, progress: (detail, done, total) => input.progress?.('re-verify', detail, done, total) });
    const { problems, failedTaskIds, compared, reused } = v;
    // A batch that does not re-verify is never committed: a branch is a claim that its code
    // matches. Put the staging worktree back so nothing unverified lingers there either.
    if (problems.length) {
      await this.reset(slot).catch(() => undefined);
      return { branch: null, verified: false, problems, failedTaskIds, compared, reused };
    }
    const branch = `decomp/${input.runId}-b${input.seq}`;
    input.progress?.('commit', `all packets match: committing ${branch}`, input.tasks.length, input.tasks.length);
    const co = await this.git(p, ['checkout', '-q', '-B', branch]);
    const add = co.code === 0 ? await this.git(p, ['add', '--', ...input.files.map((f) => f.path)]) : co;
    const commit = add.code === 0 ? await this.git(p, ['commit', '-q', '-m', input.message]) : add;
    if (commit.code !== 0) {
      await this.reset(slot).catch(() => undefined);
      return { branch: null, verified: false, problems: [`git: ${(commit.stderr || commit.stdout).slice(0, 300)}`] };
    }
    return { branch, verified: true, problems, compared, reused };
  }

  /**
   * Re-verify the batch tree written into `slot`: one `sr compare` per sr task (a unit's packets
   * share one), skipped where the task's last compare still proves this exact tree — the same proof
   * `sr submit` itself accepts (all pass, pinned compiler, the unit's source closure and recipe
   * digests unchanged), compared at this base.
   */
  private async verifyTree(slot: number, tasks: SubmitBatchInput['tasks'], opts: { signal: AbortSignal; stagedAt: number | null; files?: Array<{ path: string; content: string }>; progress?: (detail: string, done: number, total: number) => void }) {
    const problems: string[] = [];
    const failedTaskIds: string[] = [];
    const groups = new Map<string, SubmitBatchInput['tasks']>();
    for (const t of tasks) {
      if (!t.srTaskId || !/^[A-Za-z0-9._-]+$/.test(t.srTaskId)) {
        problems.push(`${t.id}: no plain sr task id`);
        failedTaskIds.push(t.id);
        continue;
      }
      groups.set(t.srTaskId, [...(groups.get(t.srTaskId) ?? []), t]);
    }
    if (problems.length) return { problems, failedTaskIds, compared: 0, reused: 0 };
    const focus = await this.focusTasks(groups);
    if (focus.problems.length) return { problems: focus.problems, failedTaskIds: focus.failedTaskIds, compared: 0, reused: 0 };
    opts.progress?.(`checking which packets' last compare still proves this tree (${groups.size} sr task(s))`, 0, groups.size);
    const fresh = await this.freshCompares(slot, groups, opts.stagedAt, opts.signal);
    for (const id of fresh) this.markVerified(id);
    let done = fresh.size;
    let compared = 0;
    const queue = [...groups].filter(([id]) => !fresh.has(id));
    // With every slot idle (see useIdleSlots), spare worker slots get the same tree and take sr
    // tasks from one queue, so the compares run side by side; each compare reads only its own unit.
    const spare = this.idleSlots && opts.files?.length ? Array.from({ length: Math.min(this.slotCount, queue.length - 1) }, (_, i) => i) : [];
    const lanes = [slot, ...spare];
    const prepared = new Set<number>([slot]);
    const running = new Map<number, string>();
    const say = () => {
      const now = [...running.values()];
      opts.progress?.(`${lanes.length > 1 ? `${now.length} compare(s) side by side: ` : 'sr compare '}${now.join(' · ')}${fresh.size ? ` (${fresh.size} unchanged, not recompiled)` : ''}`, done, groups.size);
    };
    const lane = async (s: number) => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        opts.signal.throwIfAborted();
        const [id, ts] = job;
        if (!prepared.has(s)) {
          try {
            await this.ensureWorktree(s);
            await this.writeFiles(s, opts.files!);
            prepared.add(s);
          } catch {
            queue.unshift(job); // this slot cannot help: leave the work to the others
            return;
          }
        }
        const fns = ts.flatMap((t) => t.functions);
        running.set(s, `${id} (${fns.map((f) => f.name ?? f.rva).join(', ')})`);
        say();
        const r = await this.compare(s, { ...ts[0]!.task, functions: fns }, { srTaskId: id, allowedPaths: [], packs: [], toolingChanges: [] }, { signal: opts.signal, timeoutMs: 600_000 });
        running.delete(s);
        compared++;
        done++;
        say();
        if (r.allPass) {
          this.markVerified(id);
          continue;
        }
        problems.push(`${ts.map((t) => t.id).join(',')}: ${r.infraError ?? (r.functions.filter((f) => f.result !== 'pass').map((f) => `${f.rva} ${f.reason ?? ''}`).join(', ') || 'compile error')}`);
        failedTaskIds.push(...ts.map((t) => t.id));
      }
    };
    try {
      await Promise.all(lanes.map((s) => lane(s)));
      // A lane that gave up hands its work back; the staging slot finishes whatever is left.
      if (queue.length) await lane(slot);
    } finally {
      for (const s of prepared) if (s !== slot) await this.reset(s).catch(() => undefined);
    }
    return { problems, failedTaskIds, compared, reused: fresh.size };
  }

  private idleSlots = false;
  useIdleSlots(on: boolean) {
    this.idleSlots = on;
  }

  /**
   * An sr task lists every function ever started in its unit, dead packets' too, and `sr compare`
   * checks all of them: narrow each to exactly the batch's packets, so it checks what the batch carries.
   */
  private async focusTasks(groups: Map<string, SubmitBatchInput['tasks']>) {
    const problems: string[] = [];
    const failedTaskIds: string[] = [];
    const num = (rva: unknown) => Number.parseInt(String(rva), 16);
    await this.srMutex.run('sr-local', async () => {
      for (const [id, ts] of groups) {
        const file = this.host.fsPath(this.p.join(this.cfg.localDir, 'contrib', 'tasks', id, 'task.json'));
        try {
          const task = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & { functions?: Array<{ rva?: string }> };
          const want = new Set(ts.flatMap((t) => t.functions.map((f) => num(f.rva))));
          const all = Array.isArray(task.functions) ? task.functions : [];
          const kept = all.filter((f) => want.has(num(f.rva)));
          const missing = [...want].filter((r) => !kept.some((f) => num(f.rva) === r));
          if (missing.length) throw new Error(`sr task ${id} does not list ${missing.map((r) => `0x${r.toString(16)}`).join(', ')}`);
          if (kept.length !== all.length) writeFileSync(file, `${JSON.stringify({ ...task, functions: kept }, null, 2)}\n`, 'utf8');
        } catch (e) {
          problems.push(`${ts.map((t) => t.id).join(',')}: task.json: ${(e as Error).message.slice(0, 200)}`);
          failedTaskIds.push(...ts.map((t) => t.id));
        }
      }
    });
    return { problems, failedTaskIds };
  }

  /** The sr tasks whose last compare still proves the tree in `slot` (see FRESH_COMPARES_PY). */
  private async freshCompares(slot: number, groups: Map<string, SubmitBatchInput['tasks']>, stagedAt: number | null, signal: AbortSignal): Promise<Set<string>> {
    const arg = {
      tasksDir: this.p.join(this.cfg.localDir, 'contrib', 'tasks'), base: this.sha, stagedAt,
      tasks: Object.fromEntries([...groups].map(([id, ts]) => [id, ts.flatMap((t) => t.functions.map((f) => f.rva))])),
    };
    const env = { SR_LOCAL_DIR: this.cfg.localDir, SR_CONTRIB_OFFLINE: '1', SR_NO_SIBLING_NAMES: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    const run = await this.host.run(this.cfg.python, ['-c', FRESH_COMPARES_PY, JSON.stringify(arg)], { cwd: this.wt(slot), env, signal, timeoutMs: 300_000, maxOutputBytes: 4 * 1024 * 1024 });
    const j = parseJsonOutput(run.stdout) as Record<string, { fresh?: unknown }> | null;
    if (run.code !== 0 || !j || typeof j !== 'object') return new Set();
    return new Set(Object.entries(j).filter(([id, v]) => groups.has(id) && v?.fresh === true).map(([id]) => id));
  }

  /** Record that this task's last compare passed at this base (what freshCompares trusts next time). */
  private markVerified(srTaskId: string) {
    const dir = this.p.join(this.cfg.localDir, 'contrib', 'tasks', srTaskId);
    try {
      const raw = readFileSync(this.host.fsPath(this.p.join(dir, 'last-compare.json')));
      const mark = { base: this.sha, summary_sha256: createHash('sha256').update(raw).digest('hex'), at: new Date().toISOString() };
      writeFileSync(this.host.fsPath(this.p.join(dir, 'orch-verified.json')), `${JSON.stringify(mark)}\n`, 'utf8');
    } catch {
      // Without the mark the next re-verification simply compares again.
    }
  }

  /**
   * The latest time the batch's staged branch or its dry-run branch (`-pr`) was committed on this
   * base: every compare written before it ran at this base (both are committed after their compares).
   */
  private async stagedAtThisBase(branch: string | null | undefined): Promise<number | null> {
    if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) return null;
    let at: number | null = null;
    for (const b of [branch, `${branch}-pr`]) {
      const r = await this.git(this.cfg.repoPath, ['log', '-1', '--format=%ct %P', b, '--']);
      const [ct, parent] = r.stdout.trim().split(/\s+/);
      if (r.code === 0 && parent === this.sha && Number(ct) > 0) at = Math.max(at ?? 0, Number(ct));
    }
    return at;
  }

  async submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult> {
    const slot = this.slotCount;
    const p = this.wt(slot);
    const out: SubmitBatchResult = { ok: false, dryRun: input.dryRun, submissionStarted: false, problems: [], blockers: [], warnings: [], plan: [], pullRequest: null, link: null, error: null };
    const signal = input.signal ?? new AbortController().signal;
    if (signal.aborted) return out;
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
    let restoreUnit: (() => Promise<void>) | null = null;
    try {
      // The same tree the PR will carry, from the base, re-verified packet by packet: this also
      // writes each task's last-compare.json, which `sr submit` checks against the unit's digest.
      signal.throwIfAborted();
      await this.writeFiles(slot, input.files);
      const stagedAt = await this.stagedAtThisBase(input.stagedBranch);
      const v = await this.verifyTree(slot, input.tasks, {
        signal, stagedAt, files: input.files,
        progress: (detail, done, total) => input.progress?.('Rebuilding the batch from the base; re-comparing only packets whose last compare no longer proves it', detail, done, total),
      });
      out.compared = v.compared;
      out.reused = v.reused;
      out.problems.push(...v.problems);
      if (out.problems.length) return out;
      const git = async (args: string[]) => {
        signal.throwIfAborted();
        const r = await this.git(p, args);
        if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
        return r.stdout;
      };
      await git(['checkout', '-q', '-B', input.branch]);
      // `sr submit` commits exactly its task's unit files: while it runs, that unit names every file
      // of the batch, so the whole batch is one commit and sr's staged checks cover all of it.
      const others = [...new Set(input.files.map((f) => f.path))].filter((f) => !unit.includes(f));
      if (others.length) restoreUnit = await this.widenUnit(tdir, [...unit, ...others], unit);
      // `sr submit` needs the network (claims check, push, gh) and the operator's own git/gh
      // credentials: it runs on the host, never in the sandbox, and without SR_CONTRIB_OFFLINE.
      const env = { SR_LOCAL_DIR: this.cfg.localDir, SR_NO_SIBLING_NAMES: '1', SR_UPSTREAM: this.upstream, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', GIT_TERMINAL_PROMPT: '0' };
      const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400)) : []);
      // Before the mutating command: `sr submit --dry-run` on the task submitted through (its gates,
      // claims and the plan), and for every other packet the same claims rule (`open_items` +
      // `claim_state`) in one GitHub read, run side by side.
      const args = ['tools/contrib.py', '--json', 'submit'];
      const attribution = ['--drafted-by', input.draftedBy];
      const unchecked: string[] = [];
      const otherTasks = input.tasks.filter((t) => t.srTaskId !== last.srTaskId);
      const otherRvas = otherTasks.flatMap((t) => t.functions.map((f) => f.rva));
      signal.throwIfAborted();
      input.progress?.('Checking claims and gates', `sr submit --dry-run ${last.srTaskId}${otherRvas.length ? `, and one GitHub claims check for the other ${otherRvas.length} function(s)` : ''}`, null, null);
      const [probe, claims] = await Promise.all([
        this.host.run(this.cfg.python, [...args, last.srTaskId, ...attribution, '--dry-run'], { cwd: p, env, signal, timeoutMs: 300_000, maxOutputBytes: 8 * 1024 * 1024 }),
        otherRvas.length ? this.claimCollisions(otherRvas, { signal }) : Promise.resolve<ClaimCollisionCheck>({ checked: true, error: null, collisions: {} }),
      ]);
      const check = submitClaimsCheck(probe);
      unchecked.push(...check.unchecked.map((issue) => `${last.srTaskId}: ${issue}`));
      out.blockers.push(...check.blockers);
      out.warnings.push(...check.warnings);
      out.plan = check.plan;
      if (!claims.checked) unchecked.push(...[...new Set(otherTasks.map((t) => t.srTaskId))].map((id) => `${id}: ${claims.error ?? 'claims not checked'}`));
      for (const t of otherTasks) {
        for (const f of t.functions) {
          const hit = claims.collisions[f.rva];
          if (hit?.length) out.blockers.push(`${t.srTaskId}: another open claim or pull request names ${f.rva}: ${hit.map((h) => h.url).join(', ')} (talk to them, or pass --ack-collision)`);
        }
      }
      out.uncheckedClaims = unchecked;
      if (out.blockers.length || (unchecked.length && (input.dryRun || !input.allowUncheckedClaims))) {
        out.error = out.blockers.length ? 'Submission preflight found blockers' : 'Claims checks could not be completed for the entire batch';
        return out;
      }
      if (input.dryRun) return { ...out, ok: true };
      if (unchecked.length) out.warnings.push(...unchecked.map((issue) => `Unchecked claims accepted by operator: ${issue}`));
      signal.throwIfAborted();
      out.submissionStarted = true;
      input.progress?.('Submitting: sr submit pushes the branch and opens the pull request', `sr submit ${last.srTaskId}`, null, null);
      const run = await this.host.run(this.cfg.python, [...args, last.srTaskId, ...attribution], { cwd: p, env, signal, timeoutMs: 900_000, maxOutputBytes: 8 * 1024 * 1024 });
      const j = parseJsonOutput(run.stdout) as Record<string, unknown> | null;
      out.blockers = list(j?.blockers);
      out.warnings = [...out.warnings, ...list(j?.warnings)];
      out.plan = list(j?.plan);
      out.pullRequest = typeof j?.pull_request === 'string' ? j.pull_request : null;
      out.link = typeof j?.link === 'string' ? j.link : null;
      out.ok = run.code === 0 && !!j && j.ok !== false && !out.blockers.length;
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
        // `sr submit` titles the commit and the PR from the submitted task alone: name the whole batch.
        if (new Set(input.tasks.map((t) => t.srTaskId)).size > 1) {
          input.progress?.('Naming the whole batch: one commit, and the PR title and description list every function', input.branch, null, null);
          const tidy = await this.tidyCheckedOut(slot, { branch: input.branch, tasks: input.tasks, draftedBy: input.draftedBy, pullRequest: out.pullRequest, bodyDir: tdir });
          out.warnings.push(...tidy.warnings);
          if (tidy.title) out.title = tidy.title;
        }
      }
      return out;
    } catch (e) {
      return { ...out, ok: false, error: (e as Error).message };
    } finally {
      await restoreUnit?.().catch((e: Error) => out.warnings.push(`could not restore the sr task's unit list: ${e.message.slice(0, 200)}`));
      // The pushed branch stays (it is the PR); the staging worktree goes back to the base.
      await this.reset(slot).catch(() => undefined);
    }
  }

  /** Name `files` as the sr task's unit; the returned function puts `original` back (keeping anything sr recorded meanwhile). */
  private async widenUnit(tdir: string, files: string[], original: string[]) {
    const file = this.host.fsPath(this.p.join(tdir, 'task.json'));
    const setUnit = (unit: string[]) => this.srMutex.run('sr-local', async () => {
      const task = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & { contrib?: Record<string, unknown> };
      writeFileSync(file, `${JSON.stringify({ ...task, contrib: { ...task.contrib, unit } }, null, 2)}\n`, 'utf8');
    });
    await setUnit(files);
    return () => setUnit(original);
  }

  /**
   * Make an open batch PR read as one piece of work: one commit on the base with every function in
   * its message, and a title and description that list every function (per-unit comparator reports
   * included). Works on the branch's local copy and refuses when the fork's branch moved since.
   */
  async tidyPullRequest(input: { branch: string; tasks: SubmitBatchInput['tasks']; draftedBy: string; pullRequest: string | null }): Promise<{ ok: boolean; title: string | null; warnings: string[]; error: string | null }> {
    const slot = this.slotCount;
    const p = this.wt(slot);
    if (!/^decomp\/run_[a-z0-9]+-b[1-9]\d*-pr$/.test(input.branch)) return { ok: false, title: null, warnings: [], error: 'not a batch PR branch' };
    const last = input.tasks.at(-1);
    if (!last?.srTaskId || !/^[A-Za-z0-9._-]+$/.test(last.srTaskId)) return { ok: false, title: null, warnings: [], error: 'the batch has no sr task' };
    try {
      await this.ensureWorktree(slot);
      const co = await this.git(p, ['checkout', '-q', input.branch]);
      if (co.code !== 0) return { ok: false, title: null, warnings: [], error: `git checkout: ${co.stderr.trim().slice(0, 300)}` };
      const r = await this.tidyCheckedOut(slot, { ...input, bodyDir: this.p.join(this.cfg.localDir, 'contrib', 'tasks', last.srTaskId) });
      return { ok: r.ok, title: r.title, warnings: r.warnings, error: r.ok ? null : r.warnings.at(-1) ?? 'not tidied' };
    } catch (e) {
      return { ok: false, title: null, warnings: [], error: (e as Error).message.slice(0, 300) };
    } finally {
      await this.reset(slot).catch(() => undefined);
    }
  }

  /** See tidyPullRequest: `branch` is checked out in `slot`. */
  private async tidyCheckedOut(slot: number, input: { branch: string; tasks: SubmitBatchInput['tasks']; draftedBy: string; pullRequest: string | null; bodyDir: string }): Promise<{ ok: boolean; title: string | null; warnings: string[] }> {
    const p = this.wt(slot);
    const warnings: string[] = [];
    const fail = (why: string) => ({ ok: false, title: null, warnings: [...warnings, why] });
    const git = async (args: string[]) => {
      const r = await this.git(p, args);
      if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      return r.stdout.trim();
    };
    try {
      // Every sr task's last compare, in batch order: the evidence the description reports.
      const groups: Array<{ id: string; summary: CompareSummary }> = [];
      for (const t of input.tasks) {
        if (!t.srTaskId || groups.some((g) => g.id === t.srTaskId)) continue;
        const raw = readFileSync(this.host.fsPath(this.p.join(this.cfg.localDir, 'contrib', 'tasks', t.srTaskId, 'last-compare.json')), 'utf8');
        groups.push({ id: t.srTaskId, summary: JSON.parse(raw) as CompareSummary });
      }
      const pr = batchPrText(groups.map((g) => g.summary), input.draftedBy);
      // Only an open PR is rewritten: a merged or closed one stays exactly as the project took it.
      const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(input.pullRequest ?? '');
      if (m) {
        const state = await this.host.run('gh', ['api', `repos/${m[1]}/${m[2]}/pulls/${m[3]}`, '--jq', '.state + " " + (.merged | tostring)'], { cwd: p, timeoutMs: 120_000 });
        const [st, merged] = state.stdout.trim().split(/\s+/);
        if (state.code !== 0) return fail(`could not read the pull request's state (${(state.stderr || state.stdout).trim().slice(0, 200)}): nothing was rewritten`);
        if (st !== 'open') return fail(`the pull request is ${merged === 'true' ? 'already merged' : st}: nothing was rewritten`);
      }
      const base = await git(['merge-base', 'HEAD', this.sha]);
      const head = await git(['rev-parse', 'HEAD']);
      const tree = await git(['rev-parse', 'HEAD^{tree}']);
      const remote = (await this.git(p, ['config', '--get', `branch.${input.branch}.remote`])).stdout.trim();
      if (!/^[\w.-]+$/.test(remote)) return fail(`no push remote recorded for ${input.branch}: the PR keeps its commits, title and description`);
      const env = { GIT_TERMINAL_PROMPT: '0' };
      const remoteTip = await this.host.run('git', ['ls-remote', remote, `refs/heads/${input.branch}`], { cwd: p, env, timeoutMs: 120_000 });
      const tip = remoteTip.stdout.trim().split(/\s+/)[0] ?? '';
      if (remoteTip.code !== 0 || tip !== head) return fail(`the fork's ${input.branch} is ${tip ? `at ${tip.slice(0, 10)}` : 'unreadable'}, not the local ${head.slice(0, 10)}: someone else pushed, so nothing was rewritten`);
      const count = Number(await git(['rev-list', '--count', `${base}..HEAD`]));
      const message = await git(['log', '-1', '--format=%B', 'HEAD']);
      if (count !== 1 || message.trim() !== pr.message.trim()) {
        await git(['reset', '-q', '--soft', base]);
        await git(['commit', '-q', '-m', pr.message]);
        if ((await git(['rev-parse', 'HEAD^{tree}'])) !== tree) {
          await git(['reset', '-q', '--soft', head]);
          return fail('the squashed commit would not carry the same files: nothing was pushed');
        }
        const push = await this.host.run('git', ['push', `--force-with-lease=refs/heads/${input.branch}:${head}`, remote, `HEAD:refs/heads/${input.branch}`], { cwd: p, env, timeoutMs: 300_000 });
        if (push.code !== 0) {
          await git(['reset', '-q', '--soft', head]);
          return fail(`git push: ${(push.stderr || push.stdout).trim().slice(0, 300)}; the PR keeps its ${count} commit(s)`);
        }
      }
      // sr's own description of the submitted task carries the label and origin checks of every
      // file (sr ran them over the whole branch): keep it, with every function's rows and reports.
      let srBody = '';
      try {
        srBody = readFileSync(this.host.fsPath(this.p.join(input.bodyDir, 'pr-body.md')), 'utf8');
      } catch {
        warnings.push('sr submit\'s pr-body.md is gone: the description is rebuilt from the template without the label and origin checks');
      }
      const template = srBody || ((await this.baseFile('.github/PULL_REQUEST_TEMPLATE/function.md')) ?? '');
      const body = pr.body(template, this.sha.slice(0, 12));
      const bodyFile = this.p.join(input.bodyDir, 'pr-body-batch.md');
      writeFileSync(this.host.fsPath(bodyFile), body, 'utf8');
      if (!m) return { ok: true, title: pr.title, warnings: [...warnings, `no pull request URL: title it "${pr.title}" and paste ${bodyFile} as its description`] };
      // REST, not `gh pr edit`: that one reads the retired Projects (classic) API and fails.
      const edit = await this.host.run('gh', ['api', '-X', 'PATCH', `repos/${m[1]}/${m[2]}/pulls/${m[3]}`, '-f', `title=${pr.title}`, '-F', `body=@${bodyFile}`], { cwd: p, timeoutMs: 120_000 });
      if (edit.code !== 0) return fail(`gh api: ${(edit.stderr || edit.stdout).trim().slice(0, 300)}; the commit is tidied, the PR keeps its title and description`);
      return { ok: true, title: pr.title, warnings };
    } catch (e) {
      return fail(`tidying the PR: ${(e as Error).message.slice(0, 300)}`);
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
    const { candidates, revision, progress } = await this.syncedBacklog(opts.maxSize);
    const inventory: InventoryEntry[] = progress.functions.map((f) => ({ rva: rvaHex(f.rva), name: f.name ?? null, size: f.size, nameOrigin: f.name_origin ?? null, status: f.status }));
    const claimed = Object.keys(this.localClaims());
    return {
      source: `upstream progress@${revision.slice(0, 12)} + pinned sr next@${this.sha.slice(0, 12)}${this.cfg.functionTable ? ' + function table' : ''}`,
      inventory, candidates, claimed, claimsChecked: true, functionTable: await this.functionTable(),
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

/** Run from the checkout root: sr's own collision rule for a JSON list of RVAs (argv[1]). */
export const CLAIM_COLLISIONS_PY = [
  'import json, sys',
  "sys.path.insert(0, 'tools')",
  'import contrib',
  'rvas = json.loads(sys.argv[1])',
  'ctx = contrib.Ctx(as_json=True)',
  'gh = ctx.github()',
  'try:',
  '    items = gh.open_items(refresh=True)',
  '    me = gh.user()',
  'except contrib.Offline as exc:',
  "    print(json.dumps({'checked': False, 'error': str(exc)}))",
  '    sys.exit(0)',
  "own = {c.get('url') for c in contrib.local_claims(ctx).values() if isinstance(c, dict)}",
  'out = {}',
  'for rva in rvas:',
  "    found = [i for i in items.get(contrib.parse_rva(rva), []) if i.get('url') not in own]",
  '    _mine, fresh, _stale = contrib.claim_state(found, me)',
  '    if fresh:',
  "        out[rva] = [{'url': i.get('url'), 'author': i.get('author'), 'updated_at': str(i.get('updated_at'))} for i in fresh]",
  "print(json.dumps({'checked': True, 'me': me, 'collisions': out}))",
].join('\n');

/**
 * For each sr task, whether its last `sr compare` still proves the tree in the cwd: every function
 * passed with the pinned compiler, exactly the wanted functions, and the unit's source closure and
 * recipe hash as they are on disk now (what `sr submit` checks), compared at this base — by our
 * mark written after a passing compare at this base, or no later than a branch verified at this
 * base was committed. argv: JSON {tasksDir, base, stagedAt, tasks: {srTaskId: [rva]}}.
 */
export const FRESH_COMPARES_PY = [
  'import hashlib, json, os, sys',
  'from pathlib import Path',
  "sys.path.insert(0, 'tools')",
  'import contrib',
  'from source_digest import include_closure',
  'try:',
  '    from digest_v2 import tu_digest',
  'except ImportError:',
  '    from source_digest import tu_digest',
  // `sr submit`'s own per-task check where the tools have it, so the digest method always agrees.
  "check = getattr(contrib, 'submit_task_blockers', None)",
  'ctx = contrib.Ctx(as_json=True)',
  'a = json.loads(sys.argv[1])',
  'out = {}',
  "for tid, rvas in a['tasks'].items():",
  "    d = os.path.join(a['tasksDir'], tid)",
  '    why = None',
  '    try:',
  "        task = json.load(open(os.path.join(d, 'task.json')))",
  "        last = os.path.join(d, 'last-compare.json')",
  "        raw = open(last, 'rb').read()",
  '        s = json.loads(raw)',
  "        fns = s.get('functions') or []",
  '        blockers = check(ctx, Path(d), task)[0] if check else []',
  '        if blockers: why = str(blockers[0])[:200]',
  "        elif s.get('compiler') != 'pinned': why = 'stand-in compiler'",
  "        elif not fns or not all(f.get('result') == 'pass' for f in fns): why = 'not every function passed'",
  "        elif sorted(int(str(f['rva']), 16) for f in fns) != sorted(int(r, 16) for r in rvas): why = 'it compared other functions'",
  "        elif tu_digest(ctx.repo, include_closure(ctx.repo, task['compiled'])) != s.get('source_revision'): why = 'the unit changed since'",
  "        elif hashlib.sha256(open(task['recipe'], 'rb').read()).hexdigest() != s.get('recipe_sha256'): why = 'the recipe changed since'",
  '        else:',
  "            mark = os.path.join(d, 'orch-verified.json')",
  '            m = json.load(open(mark)) if os.path.exists(mark) else None',
  "            ok = isinstance(m, dict) and m.get('base') == a['base'] and m.get('summary_sha256') == hashlib.sha256(raw).hexdigest()",
  "            if not ok and a.get('stagedAt'): ok = os.path.getmtime(last) <= a['stagedAt'] + 2",
  "            if not ok: why = 'not compared at this base'",
  '    except Exception as exc:',
  "        why = (type(exc).__name__ + ': ' + str(exc))[:200]",
  "    out[tid] = {'fresh': why is None, 'why': why}",
  'print(json.dumps(out))',
].join('\n');

/** Parse the collision probe; anything short of a complete report counts as "not checked". */
export function claimCollisionResult(run: RunResult, rvas: string[]): ClaimCollisionCheck {
  const result = parseJsonOutput(run.stdout);
  const fail = (error: string): ClaimCollisionCheck => ({ checked: false, error, collisions: {} });
  if (run.timedOut) return fail('the claims check timed out');
  if (run.aborted) return fail('the claims check was cancelled');
  if (run.truncated || run.code !== 0 || !result || typeof result !== 'object') {
    return fail(`the claims check did not complete (exit ${run.code}): ${(run.stderr || run.stdout).trim().slice(-300)}`);
  }
  if (result.checked !== true) return fail(String(result.error ?? 'GitHub claims could not be checked').slice(0, 300));
  const wanted = new Set(rvas);
  const collisions: Record<string, ClaimCollision[]> = {};
  for (const [rva, items] of Object.entries((result.collisions ?? {}) as Record<string, unknown>)) {
    if (!wanted.has(rva) || !Array.isArray(items)) continue;
    const list = items
      .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && typeof (i as Record<string, unknown>).url === 'string')
      .map((i) => ({ url: String(i.url), author: typeof i.author === 'string' ? i.author : null, updatedAt: typeof i.updated_at === 'string' ? i.updated_at : null }));
    if (list.length) collisions[rva] = list;
  }
  return { checked: true, error: null, collisions };
}

/** A collision is evidence even when the probe did not complete cleanly. */
export function submitClaimsCheck(run: RunResult) {
  const result = parseJsonOutput(run.stdout);
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.slice(0, 400))
    : [];
  const blockers = strings(result?.blockers);
  const warnings = strings(result?.warnings);
  const unchecked = warnings.filter((warning) => /GitHub claims not checked/i.test(warning));
  // Exit 1 is expected when a valid dry-run report contains blockers.
  const valid = result?.dry_run === true && Array.isArray(result.blockers) && Array.isArray(result.warnings)
    && blockers.length === result.blockers.length && warnings.length === result.warnings.length
    && (result.ok !== false || blockers.length > 0)
    && (run.code === 0 || (run.code === 1 && blockers.length > 0));
  if (!valid || run.timedOut || run.aborted || run.truncated || result?.claims_checked === false) {
    unchecked.push(run.timedOut ? 'claims check timed out' : `claims check did not complete (exit ${run.code})`);
  }
  return { blockers, warnings, unchecked, plan: strings(result?.plan) };
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
