// SPDX-License-Identifier: AGPL-3.0-or-later
// A git killed mid-command leaves index.lock behind and every later reset of that worktree fails.
// The adapter clears such a lock only when it is provably abandoned (no live git, old enough).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalHost, type Host } from '../src/repo/host.js';
import { SrRepo } from '../src/repo/srRepo.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  }
});

function world(live: string) {
  const root = mkdtempSync(join(tmpdir(), 'decomp-lock-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  const wtRoot = join(root, 'wt');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const sha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-q', '--detach', join(wtRoot, 'slot-0'), sha);
  const local = new LocalHost();
  const calls: string[] = [];
  const host: Host = {
    kind: 'local', path: local.path, fsPath: (p) => local.fsPath(p), exists: (p) => local.exists(p), realpath: (p) => local.realpath(p),
    run: async (cmd, args, o) => {
      calls.push(cmd);
      if (cmd === 'sh') return { code: 0, stdout: live, stderr: '', timedOut: false, truncated: false, signal: null } as never;
      if (cmd === 'rm') {
        rmSync(args.at(-1)!, { force: true });
        return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false, signal: null } as never;
      }
      return local.run(cmd, args, o);
    },
  };
  const sr = new SrRepo({ slots: 1, localDir: root, worktreeRoot: wtRoot, repoPath: repo } as never);
  Object.assign(sr, { host, sha });
  const notices: string[] = [];
  sr.notice = (_k, m) => notices.push(m);
  const gitDir = git(join(wtRoot, 'slot-0'), 'rev-parse', '--absolute-git-dir');
  const lock = join(gitDir, 'index.lock');
  const stale = (ageMs: number) => {
    writeFileSync(lock, '');
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(lock, t, t);
  };
  return { sr, lock, stale, notices, calls };
}

describe('stale git lock recovery', () => {
  it('clears an abandoned lock and restores the worktree', async () => {
    const w = world('');
    w.stale(60_000);
    await w.sr.reset(0);
    expect(existsSync(w.lock)).toBe(false);
    expect(w.notices.join(' ')).toMatch(/cleared a stale index\.lock/);
  }, 30_000);

  it('never removes a lock while a git process is alive on the worktree', async () => {
    const w = world('4242 git\n');
    w.stale(60_000);
    await expect(w.sr.reset(0)).rejects.toThrow(/git still running on the worktree \(pid 4242 git\)/);
    expect(existsSync(w.lock)).toBe(true);
    expect(w.calls).not.toContain('rm');
  }, 30_000);

  it('never removes a fresh lock, or one on a host where processes cannot be checked', async () => {
    const young = world('');
    young.stale(1_000);
    await expect(young.sr.reset(0)).rejects.toThrow(/only \d+s old/);
    expect(existsSync(young.lock)).toBe(true);
    const blind = world('NOPROC\n');
    blind.stale(60_000);
    await expect(blind.sr.reset(0)).rejects.toThrow(/cannot tell whether a git process/);
    expect(existsSync(blind.lock)).toBe(true);
  }, 30_000);
});
