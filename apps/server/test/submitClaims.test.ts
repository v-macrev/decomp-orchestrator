// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '../src/db/store.js';
import { CLAIM_COLLISIONS_PY, FRESH_COMPARES_PY, SrRepo, claimCollisionResult, submitClaimsCheck } from '../src/repo/srRepo.js';
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
      for (const [id, rva] of [['first', '0x1234'], ['last', '0x5678']] as const) {
        const taskDir = join(root, 'contrib', 'tasks', id);
        mkdirSync(taskDir, { recursive: true });
        // An sr task lists every function ever started in its unit; re-verification narrows it to the batch's.
        writeFileSync(join(taskDir, 'task.json'), JSON.stringify({ contrib: { unit: [`${id}.cpp`] }, functions: [{ rva }, { rva: '0xdead' }] }));
      }
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
      const dryRunTasks: string[] = [];
      vi.spyOn(repo.host, 'run').mockImplementation(async (cmd, args) => {
        if (cmd === 'git') return run('');
        if (args[1] === FRESH_COMPARES_PY) return run('{}');
        // The other packets' claims: one GitHub read, not a dry run per task.
        if (args[1] === CLAIM_COLLISIONS_PY) {
          expect(JSON.parse(args[2]!)).toEqual(['0x1234']);
          return collision ? run(JSON.stringify({ checked: true, me: 'me', collisions: { '0x1234': [{ url: 'https://github.com/o/r/issues/1', author: 'x', updated_at: '2026-11-20T00:00:00Z' }] } })) : run('not json');
        }
        if (!args.includes('--dry-run')) {
          actualSubmits++;
          return run(JSON.stringify({ ok: true }));
        }
        dryRunTasks.push(args[args.indexOf('submit') + 1]!);
        return run(report());
      });
      const input = {
        runId: 'run_test', seq: 1, branch: 'decomp/run_test-b1-pr', files: [],
        tasks: [['first', '0x1234'], ['last', '0x5678']].map(([id, rva]) => ({ id: id!, srTaskId: id!, functions: [{ rva: rva!, name: null }] as TaskRow['functions'], task: {} as TaskRow })),
        message: 'batch', draftedBy: 'test', title: null, extraBody: null, dryRun: false,
      };
      expect(await repo.submitBatch({ ...input, dryRun: true })).toMatchObject({ ok: false, uncheckedClaims: [expect.stringContaining('first')] });
      expect(await repo.submitBatch(input)).toMatchObject({ ok: false, submissionStarted: false, uncheckedClaims: [expect.stringContaining('first')] });
      expect(actualSubmits).toBe(0);
      expect(await repo.submitBatch({ ...input, allowUncheckedClaims: true })).toMatchObject({ ok: true, submissionStarted: true });
      expect(actualSubmits).toBe(1);
      collision = true;
      expect(await repo.submitBatch({ ...input, allowUncheckedClaims: true })).toMatchObject({ ok: false, submissionStarted: false, blockers: [expect.stringMatching(/^first: another open claim or pull request names 0x1234/)] });
      expect(actualSubmits).toBe(1);
      // Only the task submitted through ran `sr submit --dry-run`, once per call.
      expect(new Set(dryRunTasks)).toEqual(new Set(['last']));
      expect(JSON.parse(readFileSync(join(root, 'contrib', 'tasks', 'first', 'task.json'), 'utf8')).functions).toEqual([{ rva: '0x1234' }]);
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

describe('fast re-verification', () => {
  it('compares each sr task once, and not at all while its last compare still proves the tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decomp-fresh-'));
    try {
      const dir = join(root, 'contrib', 'tasks', 'unit-a');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'task.json'), JSON.stringify({ contrib: { unit: ['a.cpp'] }, functions: [{ rva: '0x1' }, { rva: '0x2' }, { rva: '0x3' }] }));
      writeFileSync(join(dir, 'last-compare.json'), '{}');
      const repo = new SrRepo({ repoPath: root, baseRef: 'main', worktreeRoot: root, localDir: root, python: 'python', slots: 1, sandbox: { mode: 'local' } });
      vi.spyOn(repo.host, 'exists').mockReturnValue(true);
      vi.spyOn(repo, 'reset').mockResolvedValue();
      vi.spyOn(repo, 'writeFiles').mockResolvedValue();
      const compare = vi.spyOn(repo, 'compare').mockResolvedValue({ completed: true, allPass: true, compileError: false, functions: [], infraError: null, durationMs: 1 });
      let fresh = '{}';
      vi.spyOn(repo.host, 'run').mockImplementation(async (cmd, args) => (cmd === 'git' ? run('') : args[1] === FRESH_COMPARES_PY ? run(fresh) : run('{}')));
      // Two packets of one unit share its sr task; a dead packet's 0x3 is not the batch's.
      const tasks = [['p1', '0x1'], ['p2', '0x2']].map(([id, rva]) => ({ id: id!, srTaskId: 'unit-a', functions: [{ rva: rva!, name: null }] as TaskRow['functions'], task: { functions: [] } as unknown as TaskRow }));
      const r1 = await repo.stageBatch({ runId: 'r', seq: 1, files: [], tasks, message: 'm' });
      expect(r1).toMatchObject({ verified: true, compared: 1, reused: 0 });
      expect(compare).toHaveBeenCalledTimes(1);
      expect((compare.mock.calls[0]![1] as TaskRow).functions.map((f) => f.rva)).toEqual(['0x1', '0x2']);
      expect(JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')).functions).toEqual([{ rva: '0x1' }, { rva: '0x2' }]);
      // A passing compare leaves a mark naming this base.
      expect(JSON.parse(readFileSync(join(dir, 'orch-verified.json'), 'utf8'))).toMatchObject({ summary_sha256: expect.any(String) });
      fresh = JSON.stringify({ 'unit-a': { fresh: true, why: null } });
      const r2 = await repo.stageBatch({ runId: 'r', seq: 2, files: [], tasks, message: 'm' });
      expect(r2).toMatchObject({ verified: true, compared: 0, reused: 1 });
      expect(compare).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
