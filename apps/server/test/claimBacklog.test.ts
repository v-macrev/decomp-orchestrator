// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SrRepo } from '../src/repo/srRepo.js';
import type { RunResult } from '../src/util/proc.js';

function repoWithBacklog(claimsChecked: boolean) {
  const root = resolve('.');
  const repo = new SrRepo({
    repoPath: root, baseRef: 'origin/main', localDir: root, worktreeRoot: root,
    python: 'python', slots: 1, sandbox: { mode: 'local' },
  });
  Object.assign(repo, { sha: 'pinned' });
  const functions = [1, 2, 3, 4, 5].map((rva) => ({ rva, size: 8, status: rva === 1 ? 'matched' : 'mapped' }));
  const progress = JSON.stringify({ target_build_id: 'build', functions });
  vi.spyOn(repo, 'baseFile').mockResolvedValue(progress);
  const result = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false, truncated: false, durationMs: 0 });
  const host = vi.spyOn(repo.host, 'run').mockImplementation(async (cmd, args) => {
    if (cmd === 'git') {
      if (args[0] === 'remote') return result('origin\n');
      if (args[0] === 'rev-parse') return result('synced\n');
      if (args[0] === 'show') return result(progress);
      return result('');
    }
    return result(JSON.stringify({
      claims_checked: claimsChecked,
      // 0x6 is on the published target-hash list with no inventory entry yet.
      candidates: [...functions, { rva: 6, size: 8 }].map(({ rva, size }) => ({ rva: `0x${rva}`, size, unit: 'test.cpp', startable: rva !== 3 })),
    }));
  });
  return { repo, host };
}

describe('synced claim backlog', () => {
  it('filters before applying the cap and returns the available subset when short', async () => {
    const { repo, host } = repoWithBacklog(true);
    const options = { exclude: new Set(['0x2']) };
    const selection = { source: 'sr_next' as const, maxSize: 64 };
    expect((await repo.discover({ ...selection, count: 1 }, options)).map((fn) => fn.rva)).toEqual(['0x4']);
    expect((await repo.discover({ ...selection, count: 500 }, options)).map((fn) => fn.rva)).toEqual(['0x4', '0x5', '0x6']);
    expect(host.mock.calls.find(([cmd]) => cmd === 'python')?.[2].env).not.toHaveProperty('SR_CONTRIB_OFFLINE');
    expect(host.mock.calls.some(([cmd, args]) => cmd === 'git' && args.includes('+refs/heads/main:refs/decomp/claim-base/origin/main'))).toBe(true);
  });

  it('keeps published functions without an inventory entry and drops those matched upstream', async () => {
    const { repo } = repoWithBacklog(true);
    const rvas = (await repo.discover({ source: 'sr_next', count: 500, maxSize: 64 })).map((fn) => fn.rva);
    expect(rvas).toContain('0x6');
    expect(rvas).not.toContain('0x1');
  });

  it('refuses the unchecked fallback returned by sr next when GitHub is unavailable', async () => {
    const { repo } = repoWithBacklog(false);
    await expect(repo.discover({ source: 'sr_next', count: 500, maxSize: 64 })).rejects.toThrow(/GitHub claims could not be checked/);
  });
});
