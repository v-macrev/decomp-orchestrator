// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '../src/db/store.js';
import { SrRepo, claimCollisionResult, submitClaimsCheck } from '../src/repo/srRepo.js';
import type { RunResult } from '../src/util/proc.js';

const run = (stdout: string, extra: Partial<RunResult> = {}): RunResult => ({
  code: 0, stdout, stderr: '', timedOut: false, aborted: false, truncated: false, durationMs: 1, ...extra,
});
const report = (blockers: string[] = [], warnings: string[] = []) =>
  JSON.stringify({ dry_run: true, blockers, warnings });

describe('submission claims probes', () => {
  it('requires an actual successful check report', () => {
    expect(submitClaimsCheck(run(report())).unchecked).toEqual([]);
    expect(submitClaimsCheck(run('not json')).unchecked).not.toEqual([]);
    expect(submitClaimsCheck(run('{}')).unchecked).not.toEqual([]);
    expect(submitClaimsCheck(run(report(), { timedOut: true })).unchecked).not.toEqual([]);
    expect(submitClaimsCheck(run(report([], ['GitHub claims not checked: offline']))).unchecked).not.toEqual([]);
  });

  it('preserves known collisions even if the check is incomplete', () => {
    const blocker = 'another open claim or pull request names 0x1234';
    const complete = submitClaimsCheck(run(report([blocker]), { code: 1 }));
    expect(complete).toMatchObject({ blockers: [blocker], unchecked: [] });
    const incomplete = submitClaimsCheck(run(report([blocker]), { truncated: true }));
    expect(incomplete.blockers).toEqual([blocker]);
    expect(incomplete.unchecked).not.toEqual([]);
  });

  it('calls real submit only when an unchecked task is explicitly accepted, and never over a known collision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decomp-submit-'));
    try {
      const taskDir = join(root, 'contrib', 'tasks', 'last');
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, 'task.json'), JSON.stringify({ contrib: { unit: ['last.cpp'] } }));
      const repo = new SrRepo({
        repoPath: root, baseRef: 'main', worktreeRoot: root, localDir: root,
        python: 'python', slots: 1, sandbox: { mode: 'local' },
      });
      vi.spyOn(repo.host, 'exists').mockReturnValue(true);
      vi.spyOn(repo, 'reset').mockResolvedValue();
      vi.spyOn(repo, 'writeFiles').mockResolvedValue();
      vi.spyOn(repo, 'compare').mockResolvedValue({
        completed: true, allPass: true, compileError: false, functions: [], infraError: null, durationMs: 1,
      });
      let collision = false;
      let actualSubmits = 0;
      vi.spyOn(repo.host, 'run').mockImplementation(async (cmd, args) => {
        if (cmd === 'git') return run('');
        if (!args.includes('--dry-run')) {
          actualSubmits++;
          return run(JSON.stringify({ ok: true }));
        }
        if (!args.includes('first')) return run(report());
        return collision ? run(report(['another open claim or pull request names 0x1234']), { code: 1 }) : run('not json');
      });
      const input = {
        runId: 'run_test', seq: 1, branch: 'decomp/run_test-b1-pr', files: [],
        tasks: ['first', 'last'].map((id) => ({ id, srTaskId: id, functions: [], task: {} as TaskRow })),
        message: 'batch', draftedBy: 'test', title: null, extraBody: null, dryRun: false,
      };
      expect(await repo.submitBatch({ ...input, dryRun: true })).toMatchObject({ ok: false, uncheckedClaims: [expect.stringContaining('first')] });
      expect(await repo.submitBatch(input)).toMatchObject({ ok: false, submissionStarted: false, uncheckedClaims: [expect.stringContaining('first')] });
      expect(actualSubmits).toBe(0);
      expect(await repo.submitBatch({ ...input, allowUncheckedClaims: true })).toMatchObject({ ok: true, submissionStarted: true });
      expect(actualSubmits).toBe(1);
      collision = true;
      expect(await repo.submitBatch({ ...input, allowUncheckedClaims: true })).toMatchObject({ ok: false, submissionStarted: false, blockers: [expect.stringContaining('open claim')] });
      expect(actualSubmits).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('upstream repository', () => {
  it('points every sr call and the submission at the project repository, Mudcrab-Team by default', async () => {
    const cfg = { repoPath: '/r', baseRef: 'main', worktreeRoot: '/w', localDir: '/l', python: 'python', slots: 1, sandbox: { mode: 'local' as const } };
    const seen: Array<Record<string, string> | undefined> = [];
    for (const [extra, slug] of [[{}, 'Mudcrab-Team/skyrim_decomp'], [{ upstream: 'someone/fork' }, 'someone/fork']] as const) {
      const repo = new SrRepo({ ...cfg, ...extra });
      vi.spyOn(repo.host, 'run').mockImplementation(async (_cmd, _args, opts) => {
        seen.push(opts?.env);
        return run('{}');
      });
      await repo.sr('/w', ['next'], { timeoutMs: 1000 });
      expect(seen.at(-1)).toMatchObject({ SR_UPSTREAM: slug, SR_CONTRIB_OFFLINE: '1' });
    }
  });
});

describe('claim collision probe', () => {
  const item = { url: 'https://github.com/o/r/issues/606', author: 'V0id-array', updated_at: '2026-11-20T23:48:18Z' };
  it('reports only the asked-for colliding functions from a complete report', () => {
    const out = run(JSON.stringify({ checked: true, me: 'me', collisions: { '0x24ff10': [item], '0xdead': [item], '0x1': 'junk' } }));
    expect(claimCollisionResult(out, ['0x24ff10', '0x1562a0', '0x1'])).toEqual({
      checked: true, error: null,
      collisions: { '0x24ff10': [{ url: item.url, author: 'V0id-array', updatedAt: item.updated_at }] },
    });
  });

  it('treats anything short of a complete report as not checked', () => {
    expect(claimCollisionResult(run(JSON.stringify({ checked: false, error: 'offline' })), ['0x1'])).toMatchObject({ checked: false, error: 'offline' });
    expect(claimCollisionResult(run('Traceback ...', { code: 1, stderr: 'ImportError' }), ['0x1'])).toMatchObject({ checked: false });
    expect(claimCollisionResult(run(JSON.stringify({ checked: true, collisions: {} }), { timedOut: true }), ['0x1'])).toMatchObject({ checked: false });
    expect(claimCollisionResult(run(JSON.stringify({ checked: true, collisions: {} }), { truncated: true }), ['0x1'])).toMatchObject({ checked: false });
    expect(claimCollisionResult(run('not json'), ['0x1'])).toMatchObject({ checked: false });
  });
});
