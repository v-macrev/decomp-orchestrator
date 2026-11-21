// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '../src/db/store.js';
import { batchPrText, withClaimLine, type CompareSummary } from '../src/repo/batchPr.js';
import { CLAIM_COLLISIONS_PY, CLAIM_PUBLISH_PY, FRESH_COMPARES_PY, SrRepo } from '../src/repo/srRepo.js';
import type { RunResult } from '../src/util/proc.js';

const run = (stdout: string, extra: Partial<RunResult> = {}): RunResult => ({
  code: 0, stdout, stderr: '', timedOut: false, aborted: false, truncated: false, durationMs: 1, ...extra,
});
const fn = (rva: string, name: string) => ({ rva, name, result: 'pass', reason: 'all-checks-passed', candidate_size: 24, target_size: 24, coverage: { code_bytes_total: 24 }, code_section_sha256: `${rva.slice(2)}aaaaaaaaaaaaaaaaaaaa` });
const summary = (unit: string, fns: CompareSummary['functions']): CompareSummary => ({ unit, source_revision: `rev-${unit}`, recipe: 'r.json', recipe_sha256: 'ab', compiler: 'pinned', image_sha256_pinned: true, comparator: { version: '1' }, contract_version: 2, functions: fns });
const tick = '`';
/** What `sr submit` writes for the one task it submits (the project's template, filled). */
const srBody = (s: CompareSummary) => [
  'Function intake: project confirmation/review follows this PR.',
  '',
  '## Reconstructed function(s)',
  '',
  '| RVA | name (community, unverified) | local result | reason | candidate/target bytes | code section (first 16) |',
  '|---|---|---|---|---|---|',
  ...s.functions.map((r) => `| ${tick}${r.rva}${tick} | ${tick}${r.name}${tick} | pass | ${tick}all-checks-passed${tick} | 24/24 | ${tick}x${tick} |`),
  '',
  'A local pass is **not** acceptance.',
  '',
  '## Sanitized local comparator summary',
  '',
  `Produced by ${tick}tools/contrib.py compare${tick} at tool revision ${tick}4ab131440487${tick}. Hashes only.`,
  '',
  `${tick.repeat(3)}json`,
  `{"unit": "${s.unit}"}`,
  tick.repeat(3),
  '',
  '## Provenance and assistance',
  '',
  '- Drafted by: me',
  `- Label check (${tick}tools/check_labels.py${tick}, advisory):`,
  '- a.h:5: some label finding',
  '',
].join('\n');

describe('batch pull request text', () => {
  const a = summary('reconstruction/a/A.cpp', [fn('0x1234', 'A::One'), fn('0x1240', 'A::Two')]);
  const b = summary('reconstruction/b/B.cpp', [fn('0x5678', 'B::Three')]);

  it('names every function of every unit in the title, the commit and the description', () => {
    const t = batchPrText([a, b], 'me, assisted by a model');
    expect(t.title).toBe('Reconstruct A::One, A::Two, B::Three (0x1234, 0x1240, 0x5678)');
    expect(t.message.split('\n')[0]).toBe(t.title);
    expect(t.message).toContain('- reconstruction/a/A.cpp: 0x1234 A::One, 0x1240 A::Two');
    expect(t.message).toContain('- reconstruction/b/B.cpp: 0x5678 B::Three');
    expect(t.message).toMatch(/Drafted by me, assisted by a model\. Local comparator pass/);
    const body = t.body(srBody(b), 'base12345678');
    for (const rva of ['0x1234', '0x1240', '0x5678']) expect(body).toContain(`| ${tick}${rva}${tick} |`);
    expect(body).toContain('## Units in this pull request');
    expect(body.indexOf('## Units in this pull request')).toBeLessThan(body.indexOf('## Sanitized local comparator summary'));
    const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)![1]!);
    expect(json.map((x: { unit: string }) => x.unit)).toEqual([a.unit, b.unit]);
    expect(body).toContain(`at tool revision ${tick}base12345678${tick}`);
    // sr's label and origin checks (run over every file of the branch) stay.
    expect(body).toContain('- a.h:5: some label finding');
  });

  it("keeps a long batch title within GitHub's limits and still lists every function in the commit", () => {
    const many = summary('reconstruction/c/C.cpp', Array.from({ length: 40 }, (_, i) => fn(`0x${(0x1000 + i).toString(16)}`, `SomeVeryLongClassName::Function${i}`)));
    const t = batchPrText([many, b], 'me');
    expect(t.title.length).toBeLessThanOrEqual(200);
    expect(t.title).toMatch(/^Reconstruct 41 functions in 2 units: SomeVeryLongClassName::Function0, .* and \d+ more$/);
    expect(t.message).toContain('Function39');
  });
});

describe('claim line', () => {
  it('links the claim right under the intake line, once', () => {
    const body = ['Function intake: review follows.', '', '## Reconstructed function(s)', ''].join('\n');
    const once = withClaimLine(body, ['https://github.com/o/r/issues/5']);
    expect(once).toBe(['Function intake: review follows.', '', 'Claim issue for these functions: https://github.com/o/r/issues/5', '', '## Reconstructed function(s)', ''].join('\n'));
    expect(withClaimLine(once, ['https://github.com/o/r/issues/6'])).toBe(once.replace('issues/5', 'issues/6'));
  });
});

describe('submitting a batch of several units', () => {
  it('makes one commit of every file, names every function, and restores the sr task afterwards', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decomp-onepr-'));
    try {
      const sums = { first: summary('first.cpp', [fn('0x1234', 'First::Fn')]), last: summary('last.cpp', [fn('0x5678', 'Last::Fn')]) };
      for (const [id, s] of Object.entries(sums)) {
        const dir = join(root, 'contrib', 'tasks', id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'task.json'), JSON.stringify({ contrib: { unit: [`${id}.cpp`] }, functions: s.functions.map((f) => ({ rva: f.rva })) }));
        writeFileSync(join(dir, 'last-compare.json'), JSON.stringify(s));
      }
      const lastTask = join(root, 'contrib', 'tasks', 'last', 'task.json');
      const repo = new SrRepo({ repoPath: root, baseRef: 'main', worktreeRoot: root, localDir: root, python: 'python', slots: 1, sandbox: { mode: 'local' } });
      vi.spyOn(repo.host, 'exists').mockReturnValue(true);
      vi.spyOn(repo, 'reset').mockResolvedValue();
      vi.spyOn(repo, 'writeFiles').mockResolvedValue();
      vi.spyOn(repo, 'compare').mockResolvedValue({ completed: true, allPass: true, compileError: false, functions: [], infraError: null, durationMs: 1 });
      const gitCalls: string[][] = [];
      let unitDuringSubmit: string[] = [];
      let patch: { args: string[]; body: string } | null = null;
      const claimCalls: Array<{ rvas: string[]; pr: string }> = [];
      let dryRun = true;
      vi.spyOn(repo.host, 'run').mockImplementation(async (cmd, args) => {
        if (args[1] === CLAIM_PUBLISH_PY) {
          expect(dryRun).toBe(false);
          claimCalls.push(JSON.parse(args[2]!));
          return run(JSON.stringify({ ok: true, urls: ['https://github.com/Mudcrab-Team/skyrim_decomp/issues/42'] }));
        }
        if (cmd === 'git') {
          gitCalls.push(args);
          const [verb] = args;
          if (verb === 'merge-base') return run('base0\n');
          if (verb === 'rev-parse') return run(args[1] === 'HEAD^{tree}' ? 'tree1\n' : 'head1\n');
          if (verb === 'config') return run('fork\n');
          if (verb === 'ls-remote') return run('head1\trefs/heads/decomp/run_test-b1-pr\n');
          if (verb === 'rev-list') return run('1\n');
          if (verb === 'log') return run('Reconstruct Last::Fn (0x5678)\n\nDrafted by me.\n');
          return run('');
        }
        if (cmd === 'gh' && !args.includes('-X')) return run('open false\n');
        if (cmd === 'gh') {
          const bodyArg = args.find((x) => x.startsWith('body=@'))!;
          patch = { args, body: readFileSync(bodyArg.slice('body=@'.length), 'utf8') };
          return run('{}');
        }
        if (args[1] === FRESH_COMPARES_PY) return run('{}');
        if (args[1] === CLAIM_COLLISIONS_PY) return run(JSON.stringify({ checked: true, me: 'me', collisions: {} }));
        if (args.includes('--dry-run')) return run(JSON.stringify({ dry_run: true, blockers: [], warnings: [] }));
        // The real `sr submit`: commits its task's unit files, records the branch, opens the PR.
        const task = JSON.parse(readFileSync(lastTask, 'utf8'));
        unitDuringSubmit = task.contrib.unit;
        writeFileSync(lastTask, JSON.stringify({ ...task, contrib: { ...task.contrib, submitted: 'decomp/run_test-b1-pr' } }));
        writeFileSync(join(root, 'contrib', 'tasks', 'last', 'pr-body.md'), srBody(sums.last));
        return run(JSON.stringify({ ok: true, pull_request: 'https://github.com/Mudcrab-Team/skyrim_decomp/pull/9' }));
      });
      const input = {
        runId: 'run_test', seq: 1, branch: 'decomp/run_test-b1-pr', files: [{ path: 'first.cpp', content: 'a' }, { path: 'first.h', content: 'b' }, { path: 'last.cpp', content: 'c' }],
        tasks: (['first', 'last'] as const).map((id) => ({ id, srTaskId: id, functions: sums[id].functions.map((f) => ({ rva: f.rva, name: f.name })) as TaskRow['functions'], task: {} as TaskRow })),
        message: 'unused', draftedBy: 'me', title: null, extraBody: null, dryRun: true,
      };
      // A dry run publishes nothing (the mock fails the test if it tries).
      expect(await repo.submitBatch(input)).toMatchObject({ ok: true });
      expect(claimCalls).toEqual([]);
      dryRun = false;
      const r = await repo.submitBatch({ ...input, dryRun: false });
      expect(r).toMatchObject({ ok: true, title: 'Reconstruct First::Fn, Last::Fn (0x1234, 0x5678)', claims: ['https://github.com/Mudcrab-Team/skyrim_decomp/issues/42'] });
      // One claim, for exactly the PR's functions, naming the PR.
      expect(claimCalls).toEqual([{ rvas: ['0x1234', '0x5678'], pr: 'https://github.com/Mudcrab-Team/skyrim_decomp/pull/9' }]);
      // sr committed the whole batch: its unit named every file while it ran; nothing was committed before it.
      expect(new Set(unitDuringSubmit)).toEqual(new Set(['last.cpp', 'first.cpp', 'first.h']));
      const commitIndex = gitCalls.findIndex((x) => x[0] === 'commit');
      expect(gitCalls.slice(0, commitIndex).some((x) => x[0] === 'reset' && x.includes('--soft'))).toBe(true);
      const commit = gitCalls[commitIndex]!;
      expect(commit[commit.indexOf('-m') + 1]).toMatch(/^Reconstruct First::Fn, Last::Fn \(0x1234, 0x5678\)\n\n- first\.cpp: 0x1234 First::Fn\n- last\.cpp: 0x5678 Last::Fn/);
      expect(gitCalls.find((x) => x[0] === 'push')).toEqual(['push', '--force-with-lease=refs/heads/decomp/run_test-b1-pr:head1', 'fork', 'HEAD:refs/heads/decomp/run_test-b1-pr']);
      // Afterwards the task lists its own unit again, and keeps what sr recorded.
      expect(JSON.parse(readFileSync(lastTask, 'utf8')).contrib).toEqual({ unit: ['last.cpp'], submitted: 'decomp/run_test-b1-pr' });
      expect(patch!.args.slice(0, 4)).toEqual(['api', '-X', 'PATCH', 'repos/Mudcrab-Team/skyrim_decomp/pulls/9']);
      expect(patch!.args).toContain('title=Reconstruct First::Fn, Last::Fn (0x1234, 0x5678)');
      expect(patch!.body).toContain(`| ${tick}0x1234${tick} |`);
      expect(patch!.body).toContain(`| ${tick}0x5678${tick} |`);
      expect(patch!.body).toContain('Claim issue for these functions: https://github.com/Mudcrab-Team/skyrim_decomp/issues/42');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a merged pull request exactly as it is', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decomp-merged-'));
    try {
      for (const id of ['first', 'last']) {
        const dir = join(root, 'contrib', 'tasks', id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'last-compare.json'), JSON.stringify(summary(`${id}.cpp`, [fn('0x1', `${id}::Fn`)])));
      }
      const repo = new SrRepo({ repoPath: root, baseRef: 'main', worktreeRoot: root, localDir: root, python: 'python', slots: 1, sandbox: { mode: 'local' } });
      vi.spyOn(repo.host, 'exists').mockReturnValue(true);
      vi.spyOn(repo, 'reset').mockResolvedValue();
      const calls: string[][] = [];
      vi.spyOn(repo.host, 'run').mockImplementation(async (cmd, args) => {
        calls.push([cmd, ...args]);
        return cmd === 'gh' ? run('closed true\n') : run('');
      });
      const r = await repo.tidyPullRequest({
        branch: 'decomp/run_test-b1-pr', draftedBy: 'me', pullRequest: 'https://github.com/Mudcrab-Team/skyrim_decomp/pull/9',
        tasks: ['first', 'last'].map((id) => ({ id, srTaskId: id, functions: [] as TaskRow['functions'], task: {} as TaskRow })),
      });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already merged: nothing was rewritten/) });
      expect(calls.some((c) => c[0] === 'git' && ['reset', 'commit', 'push'].includes(c[1]!))).toBe(false);
      expect(calls.some((c) => c.includes('PATCH'))).toBe(false);
      expect(calls.some((c) => c.includes(CLAIM_PUBLISH_PY))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
