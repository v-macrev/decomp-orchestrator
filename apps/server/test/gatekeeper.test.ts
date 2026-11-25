// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { GateChecks, type Verdict } from '@decomp/core';
import type { TaskRow } from '../src/db/store.js';
import { GateKeeper, insideTargetBody, lineInFile, wholeFileProblem, symbolMissingNote } from '../src/gatekeeper/gatekeeper.js';
import { isHeldOnly } from '../src/orchestrator/engine.js';
import { simIdent } from '../src/providers/mock.js';
import { SimRepo } from '../src/repo/simRepo.js';
import { Semaphore } from '../src/util/async.js';

const CHECKS = GateChecks.parse({});

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't1', runId: 'r1', unit: 'reconstruction/sim/Class0.cpp',
    functions: [{ rva: '0x100010', name: 'Class0::Method0', size: 40 }],
    state: 'leased', priority: 0, tier: 0, attemptsTotal: 0, attemptsAtTier: 0, noImprovementStreak: 0, bestExactBytes: 0,
    cheatStrikes: 0, infraFailures: 0, providerFailures: 0, leaseId: 'l', leaseExpiresAt: null, notBefore: 0, lastVerdictId: null,
    srTaskId: null, updatedAt: 0, difficulty: 'medium', complexity: 0, attemptsAtDifficulty: 0, assessment: null, ...over,
  };
}

function unit(repo: SimRepo, t: TaskRow, body?: string) {
  const f = t.functions[0]!;
  return `// Source exposure: public.\n// Code origin: original; test\n#include "Sim.h"\n\nint ${simIdent(f)}()\n{\n    ${body ?? repo.solution(f.rva)}\n}\n`;
}

async function run(repo: SimRepo, t: TaskRow, files: Array<{ path: string; content: string }>, checks = CHECKS) {
  const gk = new GateKeeper(repo, new Semaphore(2));
  const prepared = await repo.prepare(0, t);
  return gk.evaluate({ task: t, attemptId: 'a1', slot: 0, prepared, files, checks, compareTimeoutMs: 5_000, signal: new AbortController().signal });
}

describe('GateKeeper pipeline', () => {
  it('accepts a matching, clean candidate', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }]);
    expect(r.verdict.decision).toBe('pass');
    expect(r.verdict.route).toBe('accept');
    expect(r.verdict.exactBytes).toBe(40);
    expect(r.verdict.stages.map((s) => s.name)).toEqual(['scope', 'leak', 'cheat', 'integrity_pre', 'compare', 'integrity_post', 'preflight', 'review']);
  });

  it('rejects a mismatch with per-function diagnostics and partial byte credit', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t, 'return 0x123456;') }]);
    expect(r.verdict.decision).toBe('reject');
    expect(r.verdict.findings.some((f) => f.code === 'COMPARE_CODE_MISMATCH' && f.message.includes('first mismatch'))).toBe(true);
    expect(r.verdict.exactBytes).toBe(28);
  });

  it('never writes or compiles a candidate that fails static checks', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t, '__asm { nop } return 0;') }]);
    expect(r.verdict.decision).toBe('reject');
    expect(r.strike).toBe(true);
    expect(r.written).toEqual([]);
    expect(repo.compares).toBe(0);
    expect(await repo.readFile(0, t.unit)).not.toContain('__asm');
  });

  it('blocks writes outside the allowlist without touching the worktree', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: 'tools/compare.py', content: 'def compare(): return "pass"' }]);
    expect(r.verdict.findings.map((f) => f.code)).toContain('SCOPE_PROTECTED_PATH');
    expect(await repo.changedPaths(0)).not.toContain('tools/compare.py');
  });

  it('quarantines on the second strike', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task({ cheatStrikes: 1 });
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t, 'return reinterpret_cast<int(*)()>(0x1401de5e0)();') }]);
    expect(r.verdict.decision).toBe('quarantine');
    expect(r.verdict.route).toBe('quarantine');
  });

  it('quarantines immediately when protected inputs change during compare', async () => {
    const repo = new SimRepo({ slots: 1, onCompare: (slot, rp) => rp.tamper(slot) });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }]);
    expect(r.verdict.decision).toBe('quarantine');
    expect(r.verdict.findings.map((f) => f.code)).toContain('INTEGRITY_HOST_TAMPER');
  });

  it('flags stray changes in the worktree as integrity violations', async () => {
    const repo = new SimRepo({ slots: 1, onCompare: (slot, rp) => rp.stray(slot, 'reconstruction/sim/Other.cpp') });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }]);
    expect(r.verdict.decision).not.toBe('pass');
    expect(r.verdict.findings.map((f) => f.code)).toContain('INTEGRITY_UNEXPECTED_CHANGE');
  });

  it('reports infrastructure failures as infra (not the candidate’s fault)', async () => {
    const repo = new SimRepo({ slots: 1, infraRate: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }]);
    expect(r.infra).toBe(true);
    expect(r.strike).toBe(false);
    expect(r.verdict.route).toBe('retry');
  });

  it('blocks preflight findings in the packet but only warns on untouched files outside it', async () => {
    class Repo extends SimRepo {
      override async preflight() {
        return { completed: true, ok: false, infraError: null, problems: [
          'reconstruction/sim/Class0.h:1: missing reconstruction origin statement in leading header',
          'reconstruction/shared/TESForm.h:1: missing reconstruction origin statement in leading header',
        ] };
      }
    }
    const repo = new Repo({ slots: 1 });
    const t = task();
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }]);
    const f = r.verdict.findings.filter((x) => x.stage === 'preflight');
    expect(f.map((x) => [x.code, x.severity, x.file])).toEqual([
      ['PREFLIGHT_PROBLEM', 'block', 'reconstruction/sim/Class0.h'],
      ['PREFLIGHT_OUT_OF_SCOPE', 'warn', 'reconstruction/shared/TESForm.h'],
    ]);
    expect(r.verdict.decision).toBe('reject');

    class OnlyUpstream extends SimRepo {
      override async preflight() {
        return { completed: true, ok: false, infraError: null, problems: ['reconstruction/shared/TESForm.h:1: missing reconstruction origin statement'] };
      }
    }
    const repo2 = new OnlyUpstream({ slots: 1 });
    const ok = await run(repo2, t, [{ path: t.unit, content: unit(repo2, t) }]);
    expect(ok.verdict.decision).toBe('pass');
  });

  it('tells a problem on a line the packet did not write apart from one in its own code', async () => {
    const t = task();
    class Upstream extends SimRepo {
      override async baseFile(path: string) {
        return path === t.unit ? '#include "Sim.h"\n#include <algorithm>\n' : null;
      }
      override async preflight(slot: number) {
        const lines = ((await this.readFile(slot, t.unit)) ?? '').split('\n');
        const at = (text: string) => lines.findIndex((l) => l.trim() === text) + 1;
        return { completed: true, ok: false, infraError: null, problems: [
          `${t.unit}:${at('#include <algorithm>')}: deterministic screen: include-outside-roots; fix: use a reconstruction-root header path`,
          `${t.unit}:${at('#include <memory>')}: deterministic screen: include-outside-roots; fix: use a reconstruction-root header path`,
        ] };
      }
    }
    const repo = new Upstream({ slots: 1 });
    const src = unit(repo, t).replace('#include "Sim.h"\n', '#include "Sim.h"\n#include <algorithm>\n#include <memory>\n');
    const r = await run(repo, t, [{ path: t.unit, content: src }], GateChecks.parse({ leak: false }));
    expect(r.verdict.findings.filter((x) => x.stage === 'preflight').map((x) => [x.code, x.line])).toEqual([
      ['PREFLIGHT_PREEXISTING', 4], // in the base already: another body may need it
      ['PREFLIGHT_PROBLEM', 5], // added by this packet
    ]);
    expect(r.verdict.findings[0]!.message).toMatch(/already in the file before this packet/);
  });

  it('judges a whole-file problem (reported at line 1) by the file, not by its first line', async () => {
    const cc0 = 'r/A.cpp:1: the header states GPL; drop "// SPDX-License-Identifier: CC0-1.0"; fix: resolve it';
    expect(wholeFileProblem(cc0, '// Licence: GPL-3.0\nint a;\n').before).toBe(false);
    expect(wholeFileProblem(cc0, '// Licence: GPL-3.0\n// SPDX-License-Identifier: CC0-1.0\n').before).toBe(true);
    expect(wholeFileProblem(cc0, null).before).toBe(false);
    const cap = 'r/A.h:1: deterministic screen: file-size-cap; fix: reduce it';
    expect(wholeFileProblem(cap, 'x'.repeat(65_536)).before).toBe(false);
    expect(wholeFileProblem(cap, 'x'.repeat(65_537))).toEqual({ before: true, why: 'the file was already over the cap before this packet' });
    expect(wholeFileProblem('r/A.h:1: header comment must label name origin', 'a\n').before).toBe(false);
    // Through the gate: line 1 was in the base, the CC0 line was not.
    const t = task();
    class Upstream extends SimRepo {
      override async baseFile(path: string) {
        return path === t.unit ? '// Licence: GPL-3.0\n#include "Sim.h"\n' : null;
      }
      override async preflight() {
        return { completed: true, ok: false, infraError: null, problems: [t.unit + ':1: the header states GPL; drop "// SPDX-License-Identifier: CC0-1.0"'] };
      }
    }
    const repo = new Upstream({ slots: 1 });
    const r = await run(repo, t, [{ path: t.unit, content: '// Licence: GPL-3.0\n' + unit(repo, t) }], GateChecks.parse({ leak: false }));
    expect(r.verdict.findings.filter((x) => x.stage === 'preflight').map((x) => x.code)).toEqual(['PREFLIGHT_PROBLEM']);
  });

  it('blocks a matching candidate whose names clash with an accepted function of the unit', async () => {
    const t = task();
    const clash = { symbol: '??_7A@@6B@', rva: t.functions[0]!.rva, address: '0x20', acceptedRva: '0x99', acceptedAddress: '0x30' };
    class Clashing extends SimRepo {
      override async compare(...a: Parameters<SimRepo['compare']>) {
        return { ...(await super.compare(...a)), allPass: false, clashes: [clash] };
      }
    }
    const repo = new Clashing({ slots: 1 });
    const r = await run(repo, t, [{ path: t.unit, content: unit(repo, t) }], GateChecks.parse({ leak: false }));
    expect(r.verdict.decision).toBe('reject');
    expect(r.infra).toBe(false);
    const f = r.verdict.findings.find((x) => x.code === 'UNIT_SYMBOL_CLASH');
    expect(f?.message.startsWith(clash.rva)).toBe(true);
    for (const part of ['??_7A@@6B@', '0x20', '0x99', '0x30']) expect(f?.message).toContain(part);
    expect(r.verdict.compare?.every((x) => x.result === 'pass')).toBe(true);
  });

  it('never calls a line inside the packet\'s own function pre-existing', () => {
    const src = 'int Foo::Bar()\n{\n    return 1;\n}\nint Foo::Baz()\n{\n    return 2;\n}\n';
    expect(lineInFile(src, 3)).toBe('    return 1;');
    expect(lineInFile(src, 99)).toBeNull();
    expect(insideTargetBody(src, 3, [{ rva: '0x1', name: 'Foo::Bar', size: 8 }])).toBe(true);
    expect(insideTargetBody(src, 3, [{ rva: '0x1', name: 'Bar', size: 8 }])).toBe(true);
    expect(insideTargetBody(src, 7, [{ rva: '0x1', name: 'Foo::Bar', size: 8 }])).toBe(false);
  });

  it('holds only a verdict whose functions all pass and whose every block is pre-existing', () => {
    const base = { id: 'v', taskId: 't', attemptId: 'a', decision: 'reject', route: 'retry', exactBytes: 40, stages: [], createdAt: 0 } as const;
    const pre = { stage: 'preflight', code: 'PREFLIGHT_PREEXISTING', severity: 'block', message: 'x' } as const;
    const pass = [{ rva: '0x1', name: 'F', result: 'pass' }] as unknown as Verdict['compare'];
    expect(isHeldOnly({ ...base, findings: [pre], compare: pass } as unknown as Verdict)).toBe(true);
    expect(isHeldOnly({ ...base, findings: [pre, { ...pre, code: 'PREFLIGHT_PROBLEM' }], compare: pass } as unknown as Verdict)).toBe(false);
    expect(isHeldOnly({ ...base, findings: [pre], compare: [{ rva: '0x1', name: 'F', result: 'fail' }] } as unknown as unknown as Verdict)).toBe(false);
    expect(isHeldOnly({ ...base, findings: [pre], compare: null } as unknown as Verdict)).toBe(false);
  });

  it('LLM review can block but deterministic failure always wins', async () => {
    const repo = new SimRepo({ slots: 1 });
    const t = task();
    const approve = { review: async () => [] };
    const block = { review: async () => [{ stage: 'review', code: 'REVIEW_BYTE_STEERING', severity: 'block' as const, message: 'dead store' }] };
    const checks = GateChecks.parse({ llmReview: true });
    const prepared = await repo.prepare(0, t);
    const sig = new AbortController().signal;
    const ok = await new GateKeeper(repo, new Semaphore(1), approve).evaluate({ task: t, attemptId: 'a', slot: 0, prepared, files: [{ path: t.unit, content: unit(repo, t) }], checks, compareTimeoutMs: 1000, signal: sig });
    expect(ok.verdict.decision).toBe('pass');
    const blocked = await new GateKeeper(repo, new Semaphore(1), block).evaluate({ task: t, attemptId: 'a', slot: 0, prepared, files: [{ path: t.unit, content: unit(repo, t) }], checks, compareTimeoutMs: 1000, signal: sig });
    expect(blocked.verdict.decision).toBe('reject');
    const mismatch = await new GateKeeper(repo, new Semaphore(1), approve).evaluate({ task: t, attemptId: 'a', slot: 0, prepared, files: [{ path: t.unit, content: unit(repo, t, 'return 0x1;') }], checks, compareTimeoutMs: 1000, signal: sig });
    expect(mismatch.verdict.decision).toBe('reject');
    expect(mismatch.verdict.stages.find((s) => s.name === 'review')).toBeUndefined();
  });

  it("counts only the packet's and the carried functions' compare results when told which", async () => {
    // sr start keeps one task per class: its compare also reports a dead packet's function 0x4497c0.
    const repo = new SimRepo({ slots: 1 });
    const inner = repo.compare.bind(repo);
    repo.compare = async (...args: Parameters<SimRepo['compare']>) => {
      const r = await inner(...args);
      return { ...r, allPass: false, functions: [...r.functions, { rva: '0x4497c0', name: 'Class0::Gone', result: 'fail', reason: 'function-symbol-missing' } as (typeof r.functions)[number]] };
    };
    const t = task();
    const prepared = await repo.prepare(0, t);
    const files = [{ path: t.unit, content: unit(repo, t) }];
    const sig = new AbortController().signal;
    const gk = new GateKeeper(repo, new Semaphore(1));
    const all = await gk.evaluate({ task: t, attemptId: 'a', slot: 0, prepared, files, checks: CHECKS, compareTimeoutMs: 1000, signal: sig });
    expect(all.verdict.findings.map((f) => f.code)).toContain('COMPARE_FUNCTION_SYMBOL_MISSING');
    const focused = await gk.evaluate({ task: t, attemptId: 'a', slot: 0, prepared, files, checks: CHECKS, compareTimeoutMs: 1000, signal: sig, compared: new Set(['0x100010']) });
    expect(focused.verdict.decision).toBe('pass');
    expect(focused.verdict.compare?.map((c) => c.rva)).toEqual(['0x100010']);
    const carried = await gk.evaluate({ task: t, attemptId: 'a', slot: 0, prepared, files, checks: CHECKS, compareTimeoutMs: 1000, signal: sig, compared: new Set(['0x4497C0']) });
    expect(carried.verdict.decision).toBe('reject');
  });
});

describe('symbol-missing feedback', () => {
  it('says when the candidate never defined the function, and when its definition is not the bound one', () => {
    const kept = [{ path: 'reconstruction/a/E.cpp', content: '#include "E.h"\nint E::Function400() { return value; }\n' }];
    expect(symbolMissingNote('E::Function454', kept)).toMatch(/do not define E::Function454 at all/);
    const both = [{ path: 'reconstruction/a/E.cpp', content: `${kept[0]!.content}int E::Function454() { return 1; }\n` }];
    expect(symbolMissingNote('E::Function454', both)).toMatch(/is defined in your \.cpp, but the object has no symbol/);
  });
});
