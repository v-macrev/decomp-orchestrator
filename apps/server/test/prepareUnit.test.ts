// SPDX-License-Identifier: AGPL-3.0-or-later
// `sr start` refuses a function that several existing units fit; the packet's unit, named at discovery, is one
// of them. Prepare starts again in that unit, and only then, so tooling without `--unit` is never given it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '../src/db/store.js';
import { SrRepo } from '../src/repo/srRepo.js';
import type { RunResult } from '../src/util/proc.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(refusal: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'decomp-prepare-'));
  dirs.push(root);
  mkdirSync(join(root, 'contrib'), { recursive: true });
  const repo = new SrRepo({ repoPath: root, baseRef: 'origin/main', localDir: root, worktreeRoot: root, python: 'python', slots: 1, sandbox: { mode: 'local' } });
  const run = (code: number): RunResult => ({ code, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, durationMs: 0 });
  const calls: string[][] = [];
  vi.spyOn(repo, 'sr').mockImplementation(async (_cwd, args) => {
    calls.push(args);
    if (args[0] === 'claim') {
      writeFileSync(join(root, 'contrib', 'claims.json'), JSON.stringify({ '0x10': { status: 'unpublished' } }));
      return { run: run(0), json: { claim: 'unpublished' } };
    }
    if (args[0] === 'start' && refusal !== null && !args.includes('--unit')) return { run: run(2), json: { error: refusal } };
    if (args[0] === 'start') return { run: run(0), json: { task: 'task-1', unit: ['reconstruction/a/A_10.cpp', 'reconstruction/a/A_10.h'], packs: [] } };
    return { run: run(0), json: { rva: args[1] } };
  });
  vi.spyOn(repo as unknown as { changedPaths: () => Promise<string[]> }, 'changedPaths').mockResolvedValue([]);
  const task = { unit: 'reconstruction/a/A_10.cpp', functions: [{ rva: '0x10', size: 8, name: 'A::B' }] } as unknown as TaskRow;
  const prepare = () => repo.prepare(0, task, { draftedBy: 'someone', model: 'recon-engine-0.1.0', signal: new AbortController().signal });
  return { prepare, calls };
}

const several = 'several units fit; rerun start with --unit and one of:\n  reconstruction/a/A.cpp\n  reconstruction/a/A_10.cpp';

describe('prepare when several units fit', () => {
  it('starts again in the unit discovery named', async () => {
    const s = setup(several);
    const p = await s.prepare();
    expect(p.srTaskId).toBe('task-1');
    const starts = s.calls.filter((a) => a[0] === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[0]).not.toContain('--unit');
    expect(starts[1]!.slice(-2)).toEqual(['--unit', 'reconstruction/a/A_10.cpp']);
  });

  it('never passes --unit when start does not refuse that way', async () => {
    const s = setup(null);
    await s.prepare();
    expect(s.calls.filter((a) => a[0] === 'start').every((a) => !a.includes('--unit'))).toBe(true);
  });

  it('does not choose a unit the refusal does not list, and releases the claim', async () => {
    const s = setup('several units fit; rerun start with --unit and one of:\n  reconstruction/a/A.cpp\n  reconstruction/a/A_20.cpp');
    await expect(s.prepare()).rejects.toThrow(/several units fit/);
    expect(s.calls.filter((a) => a[0] === 'start')).toHaveLength(1);
    expect(s.calls.some((a) => a[0] === 'release' && a[1] === '0x10')).toBe(true);
  });
});
