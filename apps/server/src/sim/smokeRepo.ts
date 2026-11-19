// SPDX-License-Identifier: AGPL-3.0-or-later
// Smoke test of the real skyrim_decomp adapter (no LLM calls, no network writes):
//   worktree → sr next → claim/start → cheat candidate (must be rejected before compiling)
//   → skeleton through the real comparator (must run; a mismatch is expected) → integrity → cleanup.
// Private pack contents are never printed.
//
//   npm run smoke:repo -- --host wsl --distro Ubuntu --repo /home/me/skyrim_decomp \
//       --local /home/me/skyrim_decomp/.local --worktrees /home/me/decomp-orch-smoke
import { parseArgs } from 'node:util';
import { GateChecks, type FunctionTarget } from '@decomp/core';
import type { TaskRow } from '../db/store.js';
import { GateKeeper } from '../gatekeeper/gatekeeper.js';
import { SrRepo } from '../repo/srRepo.js';
import { Semaphore } from '../util/async.js';

const { values: a } = parseArgs({
  options: {
    host: { type: 'string', default: 'wsl' },
    distro: { type: 'string', default: 'Ubuntu' },
    repo: { type: 'string' },
    local: { type: 'string' },
    worktrees: { type: 'string' },
    base: { type: 'string', default: 'origin/main' },
    python: { type: 'string', default: 'python3' },
    'max-size': { type: 'string', default: '24' },
    rva: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
if (!a.repo || !a.local || !a.worktrees) throw new Error('--repo, --local and --worktrees are required');

/** What a worker is asked to do with the generated header: fill placeholders, drop wrapped guidance. */
function compactSkeleton(src: string): string {
  const lines = src.split('\n');
  let end = 0;
  while (end < lines.length && (lines[end]!.trim().startsWith('//') || !lines[end]!.trim())) end++;
  const head = lines.slice(0, end).filter((l) => l.trim());
  const keep: string[] = [];
  const exposure = head.find((l) => /Source exposure:/.test(l));
  if (exposure) keep.push('// Source exposure: mixed (community headers; the pinned image listing).');
  for (const l of head) if (/SPDX-License-Identifier/.test(l)) keep.push(l);
  keep.push('// Code origin: original; community declarations only');
  for (const l of head) if (/^\/\/\s*0x[0-9a-fA-F]+\s/.test(l) || /(COMMUNITY|SIBLING|GUESS|EXE_RTTI|STANDIN|OBSERVED)/.test(l)) keep.push(l);
  keep.push('// Adapted bodies: none');
  return [...[...new Set(keep)], ...lines.slice(end)].join('\n');
}

const t0 = Date.now();
const step = (s: string) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const repo = new SrRepo({
  repoPath: a.repo, baseRef: a.base, worktreeRoot: a.worktrees, localDir: a.local, python: a.python, slots: 1,
  host: a.host === 'wsl' ? { kind: 'wsl', distro: a.distro } : { kind: 'local' }, sandbox: { mode: 'local' },
});
const sig = new AbortController().signal;
let claimed: string[] = [];
let exitCode = 0;

try {
  step(`init: worktree ${repo.wt(0)} at ${a.base}`);
  await repo.init();
  console.log(`  base ${repo.baseSha.slice(0, 12)}; slot clean`);

  step('discover: sr next');
  const found = await repo.discover(a.rva ? { source: 'rva_list', rvas: [a.rva] } : { source: 'sr_next', count: 5, maxSize: Number(a['max-size']) });
  for (const f of found) console.log(`  ${f.rva.padEnd(10)} ${String(f.size).padStart(4)} B  ${f.name}  -> ${f.unit}`);
  const pick = found[0];
  if (!pick) throw new Error('no startable candidates');

  const fn: FunctionTarget = { rva: pick.rva, name: pick.name, size: pick.size, nameOrigin: pick.nameOrigin ?? null };
  const task: TaskRow = {
    id: 'smoke', runId: 'smoke', unit: pick.unit, functions: [fn], state: 'leased', priority: 0, tier: 0, attemptsTotal: 0,
    attemptsAtTier: 0, noImprovementStreak: 0, bestExactBytes: 0, cheatStrikes: 0, infraFailures: 0, providerFailures: 0,
    leaseId: 'l', leaseExpiresAt: null, notBefore: 0, lastVerdictId: null, srTaskId: null, updatedAt: 0,
    difficulty: 'medium', complexity: 0, attemptsAtDifficulty: 0, assessment: null,
  };

  step(`prepare: sr claim --offline-ok + sr start ${fn.rva}`);
  const prep = await repo.prepare(0, task, { draftedBy: 'decomp-orchestrator smoke test', model: 'none', signal: sig });
  claimed = [fn.rva];
  console.log(`  task ${prep.srTaskId}; allowed ${prep.allowedPaths.join(', ')}; ${prep.packs.length} private pack(s) (not read)`);
  if (prep.toolingChanges.length) console.log(`  tooling also changed: ${prep.toolingChanges.join(', ')}`);
  const cpp = prep.allowedPaths.find((p) => p.endsWith('.cpp'))!;
  const skeleton = (await repo.readFile(0, cpp)) ?? '';
  console.log(`  skeleton ${cpp}: ${skeleton.split('\n').length} lines; header:\n${skeleton.split('\n').slice(0, 8).map((l) => `    | ${l}`).join('\n')}`);

  const gate = new GateKeeper(repo, new Semaphore(1));
  const checks = GateChecks.parse({});

  step('gate A: cheating candidate (inline asm) — must be rejected before any write/compile');
  const cheat = await gate.evaluate({ task, attemptId: 'smoke-a', slot: 0, prepared: prep, checks, compareTimeoutMs: 600_000, signal: sig, files: [{ path: cpp, content: `${skeleton}\nint SmokeCheat() { __asm { nop } return 0; }\n` }] });
  console.log(`  decision ${cheat.verdict.decision}/${cheat.verdict.route}; strike=${cheat.strike}; written=${cheat.written.length}`);
  console.log(`  stages ${cheat.verdict.stages.map((s) => `${s.name}:${s.skipped ? 'skip' : s.ok ? 'ok' : 'FAIL'}`).join(' ')}`);
  console.log(`  findings ${cheat.verdict.findings.map((f) => f.code).join(', ')}`);
  if (cheat.verdict.decision === 'pass' || cheat.written.length) exitCode = 1;

  step('gate B: skeleton with placeholders filled and header compacted, through the real comparator (expect a mismatch, not infra)');
  const candidate = compactSkeleton(skeleton);
  console.log(`  candidate header:\n${candidate.split('\n').slice(0, 8).map((l) => `    | ${l}`).join('\n')}`);
  const plain = await gate.evaluate({ task, attemptId: 'smoke-b', slot: 0, prepared: prep, checks, compareTimeoutMs: 900_000, signal: sig, files: [{ path: cpp, content: candidate }] });
  console.log(`  decision ${plain.verdict.decision}/${plain.verdict.route}; infra=${plain.infra}; exactBytes=${plain.verdict.exactBytes}`);
  console.log(`  stages ${plain.verdict.stages.map((s) => `${s.name}:${s.skipped ? 'skip' : s.ok ? 'ok' : 'FAIL'}(${s.ms}ms)`).join(' ')}`);
  for (const c of plain.verdict.compare ?? []) console.log(`  compare ${c.rva} ${c.result} reason=${c.reason} first=${c.firstMismatch} bytes=${c.exactBytes}/${c.targetSize} hint=${c.hint ?? ''}`);
  for (const f of plain.verdict.findings) console.log(`  [${f.severity}] ${f.stage} ${f.code}: ${f.message.slice(0, 240)}`);
  if (plain.infra) exitCode = 1;
  if (plain.verdict.findings.some((f) => f.message === 'preflight exit 1')) {
    console.log('  preflight returned no parseable reasons');
    exitCode = 1;
  }

  step('integrity: worktree changes after evaluation');
  console.log(`  changed: ${(await repo.changedPaths(0)).join(', ') || 'none'}`);
} catch (e) {
  exitCode = 1;
  console.error(`\nFAILED: ${(e as Error).stack ?? e}`);
} finally {
  step('cleanup');
  if (claimed.length) {
    const rel = await repo.releaseClaims(claimed, 'decomp-orchestrator smoke test').catch((e) => [{ rva: '?', ok: false, error: String(e) }]);
    console.log(`  release: ${JSON.stringify(rel)}`);
    if (rel.some((r) => !r.ok)) exitCode = 1;
  }
  if (!a.keep) {
    await repo.removeWorktrees().catch((e) => console.log(`  worktree removal failed: ${e}`));
    console.log('  worktrees removed');
  } else console.log(`  kept ${repo.wt(0)}`);
  console.log(`\n${exitCode === 0 ? 'SMOKE OK' : 'SMOKE FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(exitCode);
}
