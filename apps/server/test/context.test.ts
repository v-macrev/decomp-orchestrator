// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 2 context engineering: slicer, distiller, budgeted bundles, edits, retry delta, caching,
// knowledge, and an end-to-end routed run measured against the legacy bundles.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextConfig, defaultFlow, type Account, type Attempt, type Verdict } from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store, type TaskRow } from '../src/db/store.js';
import { HeaderSlicer } from '../src/intel/headerSlicer.js';
import { extractKnowledge } from '../src/intel/knowledge.js';
import { distillRules, tagText } from '../src/intel/ruleDistiller.js';
import { TaskContextBuilder, renderRetryDelta, shouldCacheTaskPrefix } from '../src/orchestrator/contextBuilder.js';
import { ELIDED_MARKER, applyEdit, elideBodies, materialise } from '../src/orchestrator/edits.js';
import { RunEngine } from '../src/orchestrator/engine.js';
import { renderBundle } from '../src/orchestrator/prompts.js';
import { userContent } from '../src/providers/anthropic.js';
import { PromptCacheSim } from '../src/providers/mock.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { AccountPool } from '../src/pool/scheduler.js';
import { simDocs, simSharedHeader } from '../src/repo/simContent.js';
import { SimRepo } from '../src/repo/simRepo.js';
import { EventBus } from '../src/telemetry/events.js';
import { mockAccount } from './helpers.js';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) if (s.db.open) s.db.close();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows may hold the WAL briefly */
    }
  }
});

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 't1', runId: 'r1', unit: 'reconstruction/sim/Class7.cpp', functions: [{ rva: '0x100010', name: 'Class7::Method2', size: 60 }],
  state: 'leased', priority: 0, tier: 0, attemptsTotal: 0, attemptsAtTier: 0, noImprovementStreak: 0, bestExactBytes: 0, cheatStrikes: 0,
  infraFailures: 0, providerFailures: 0, leaseId: 'l', leaseExpiresAt: null, notBefore: 0, lastVerdictId: null, srTaskId: null, updatedAt: 0,
  difficulty: 'medium', complexity: 3, attemptsAtDifficulty: 0, assessment: null, ...over,
});

describe('header slicer (tree-sitter)', () => {
  it('keeps the packet class, its bases and asserts; drops unrelated classes; respects the budget', async () => {
    const slicer = await HeaderSlicer.create();
    expect(slicer.engine).toBe('tree-sitter');
    const header = simSharedHeader(60);
    const r = slicer.slice({ headers: [{ path: 'Sim.h', text: header }], primary: ['Class7'], references: new Set(['Method2']), maxTokens: 900 });
    expect(r.text).toContain('class Class7 : public Class5');
    expect(r.text).toContain('class Class5 : public BaseForm'); // base, transitively
    expect(r.text).toContain('class BaseForm');
    expect(r.text).toContain('static_assert(sizeof(Class7)');
    expect(r.text).toContain('Method2'); // referenced method kept
    expect(r.text).toContain('field09'); // data members (layout) kept
    expect(r.text).not.toMatch(/class Class4[0-9]\b/); // unrelated classes gone
    expect(r.text).toMatch(/non-virtual member function\(s\) not used by this packet elided/);
    expect(r.tokens).toBeLessThanOrEqual(900 + 40);
    expect(r.rawTokens).toBeGreaterThan(r.tokens * 10);
    expect(r.patterns).toContain('vtable');
  });
});

describe('rule distiller', () => {
  it('is deterministic, fits its budget and turns cookbook sections into tagged recipes', () => {
    const docs = simDocs();
    const a = distillRules(docs, { maxTokens: 420, source: 'sim' });
    const b = distillRules(docs, { maxTokens: 420, source: 'sim' });
    expect(a.text).toBe(b.text);
    expect(a.tokens).toBeLessThanOrEqual(460);
    expect(a.rawTokens).toBeGreaterThan(a.tokens * 8);
    expect(a.recipes.find((r) => /SSE/.test(r.topic))!.tags).toContain('sse');
    expect(a.recipes.find((r) => /Virtual/.test(r.topic))!.tags).toContain('vtable');
    expect(tagText('keep the destructor funclet order')).toContain('eh');
  });
});

describe('edits', () => {
  const unit = '// Source exposure: public.\n// Code origin: original\n#include "Sim.h"\n\nint Keep()\n{\n    return 7;\n}\n\nint Target()\n{\n    return 1;\n}\n';
  it('replaces by name, appends new functions, swaps the header and adds declarations once', () => {
    const r = applyEdit(unit, {
      path: 'u.cpp', header: '// Source exposure: public.\n// Code origin: original; edited', declarations: 'int Callee(int);',
      functions: [{ name: 'Target', code: 'int Target()\n{\n    return Callee(2);\n}' }, { name: 'Added', code: 'int Added()\n{\n    return 3;\n}' }],
    });
    expect(r.problems).toEqual([]);
    expect(r.content).toContain('return Callee(2);');
    expect(r.content).not.toContain('return 1;');
    expect(r.content).toContain('int Keep()\n{\n    return 7;\n}'); // untouched, byte for byte
    expect(r.content).toMatch(/int Added\(\)/);
    expect(r.content.startsWith('// Source exposure: public.\n// Code origin: original; edited\n#include')).toBe(true);
    expect(applyEdit(r.content, { path: 'u.cpp', declarations: 'int Callee(int);', functions: [] }).content.match(/int Callee\(int\);/g)).toHaveLength(1);
  });

  it('elides accepted bodies for prompts and refuses edits that return the placeholder', async () => {
    const e = elideBodies(unit, (n) => n === 'Target');
    expect(e.elided).toEqual(['Keep']);
    expect(e.text).toContain(ELIDED_MARKER);
    expect(e.text).toContain('return 1;');
    const m = await materialise({ edits: [{ path: 'u.cpp', functions: [{ name: 'Keep', code: `int Keep()\n{ /* ${ELIDED_MARKER} */ }` }] }] }, async () => unit);
    expect(m.problems[0]).toMatch(/elided placeholder/);
  });
});

describe('retry delta', () => {
  it('carries the verdict and only the failing function bodies — never the whole previous file', () => {
    const big = `// header\n${Array.from({ length: 80 }, (_, i) => `int Other${i}()\n{\n    return ${i};\n}\n`).join('\n')}\nint Class7_Method2()\n{\n    return 0x123;\n}\n`;
    const attempt = { n: 2, files: [{ path: 'reconstruction/sim/Class7.cpp', content: big }] } as Attempt;
    const verdict = {
      decision: 'reject', findings: [{ stage: 'compare', code: 'COMPARE_CODE_MISMATCH', severity: 'block', message: '0x100010 Class7::Method2: fail code-mismatch first mismatch at +0x1' }],
      compare: [{ rva: '0x100010', name: 'Class7::Method2', result: 'fail', reason: 'code-mismatch', hint: null, firstMismatch: '+0x1', candidateSize: 60, targetSize: 60, exactBytes: 42, totalBytes: 60 }],
    } as unknown as Verdict;
    const r = renderRetryDelta({ verdict, attempt }, task(), 600);
    expect(r.category).toBe('BYTE_MISMATCH');
    expect(r.text).toContain('42/60 bytes exact');
    expect(r.text).toContain('return 0x123;');
    expect(r.text).not.toContain('Other40');
    expect(r.rawTokens).toBeGreaterThan(r.text.length / 3.3 * 3);
  });

  it('tells a packet sent back from a failed batch check what the check reported, not that it was rejected', () => {
    const attempt = { n: 3, files: [] } as unknown as Attempt;
    const verdict = { decision: 'pass', findings: [], compare: [] } as unknown as Verdict;
    const fix = { batchId: 'b', seq: 7, check: 're-verify' as const, reasons: ['task_a,task_b: 0x100010 fail code-mismatch first mismatch at +0x8'], at: 1, verdictId: 'v' };
    const r = renderRetryDelta({ verdict, attempt, fix }, task(), 600);
    expect(r.category).toBe('BATCH_FIX');
    expect(r.text).toContain('batch 7 was re-verified');
    expect(r.text).toContain('- 0x100010 fail code-mismatch first mismatch at +0x8');
    expect(r.text).not.toContain('task_a');
    expect(r.text).not.toContain('rejected');
  });
});

describe('budgeted bundle', () => {
  it('stays within section budgets, keeps a byte-identical static prefix and records raw-vs-sent tokens', async () => {
    const store = new Store(openDatabase(':memory:'));
    stores.push(store);
    const repo = new SimRepo({ slots: 1 });
    const found = await repo.discover({ source: 'synthetic', count: 40, seed: 3 });
    const b = new TaskContextBuilder(repo, store);
    const cfg = ContextConfig.parse({});
    const bundles = [];
    for (const f of found.slice(0, 6)) {
      const t = task({ id: `t${f.rva}`, unit: f.unit, functions: [f] });
      const prep = await repo.prepare(0, t);
      bundles.push(await b.build(t, prep, 0, { runId: 'r1', exposureConsent: true, carried: [], attemptNo: 1, feedback: null, pitfalls: [], context: cfg }));
      await repo.reset(0);
    }
    expect(new Set(bundles.map((x) => x.staticPrefixHash)).size).toBe(1);
    expect(new Set(bundles.map((x) => x.sections[0]!.content)).size).toBe(1);
    for (const x of bundles) {
      // (The packet's own class is shown even beyond the unit budget, up to twice of it.)
      for (const s of x.sections) expect(s.tokens / (s.kind === 'unit_files' ? 2 : 1)).toBeLessThanOrEqual(s.budgetTokens + 60);
      expect(x.tokens.sent).toBeLessThan(x.tokens.raw * 0.5);
      expect(x.containsPrivate).toBe(true);
      expect(x.sections.map((s) => s.kind)[0]).toBe('static_system_prefix');
    }
    const persisted = store.getBundle(bundles[0]!.hash) as { sections: Array<{ privacy: string; content: string }> };
    expect(persisted.sections.filter((s) => s.privacy === 'private').every((s) => s.content.startsWith('[private:'))).toBe(true);
    const r = renderBundle(bundles[0]!, 1, true);
    expect(r.system).toBe(bundles[0]!.sections[0]!.content);
    expect(r.blocks[0]!.cache).toBe(true);
    expect(r.blocks[0]!.text).toContain('<task_spec>');
    expect(r.blocks[1]!.text).toContain('<attempt n="1"/>');
  });

  it('only marks the per-packet cache breakpoint when a retry is likely', () => {
    expect(shouldCacheTaskPrefix('auto', 'easy', 1, 3000)).toBe(false);
    expect(shouldCacheTaskPrefix('auto', 'easy', 2, 3000)).toBe(true);
    expect(shouldCacheTaskPrefix('auto', 'hard', 1, 3000)).toBe(true);
    expect(shouldCacheTaskPrefix('auto', 'hard', 1, 200)).toBe(false); // below the cacheable minimum
    expect(shouldCacheTaskPrefix('never', 'hard', 3, 3000)).toBe(false);
  });
});

describe('prompt caching', () => {
  it('Anthropic adapter puts cache_control on flagged user blocks (≤3 besides the system)', () => {
    const c = userContent({ system: 's', prompt: 'x', blocks: [{ text: 'a', cache: true }, { text: 'b', cache: false }, { text: '', cache: true }] } as never);
    expect(c).toEqual([{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'b' }]);
    expect(userContent({ system: 's', prompt: 'plain' } as never)).toBe('plain');
  });

  it('cache simulator: second call reads the shared prefix, a retry reads the packet block too', () => {
    const sim = new PromptCacheSim();
    const sys = 'S'.repeat(4_000);
    const a1 = { system: sys, prompt: '', blocks: [{ text: 'A'.repeat(6_000), cache: true }, { text: 'tail1', cache: false }] } as never;
    const first = sim.usage('acct/m', a1, 0);
    expect(first.cacheReadTokens).toBe(0);
    expect(first.cacheWriteTokens).toBeGreaterThan(0);
    const other = sim.usage('acct/m', { system: sys, prompt: '', blocks: [{ text: 'B'.repeat(6_000), cache: true }, { text: 't', cache: false }] } as never, 1_000);
    expect(other.cacheReadTokens).toBe(Math.ceil(4_000 / 3.3)); // static prefix only
    const retry = sim.usage('acct/m', { system: sys, prompt: '', blocks: [{ text: 'A'.repeat(6_000), cache: true }, { text: 'tail2', cache: false }] } as never, 2_000);
    expect(retry.cacheReadTokens).toBe(Math.ceil(4_000 / 3.3) + Math.ceil(6_000 / 3.3));
    expect(sim.usage('other/m', a1, 3_000).cacheReadTokens).toBe(0); // caches are per account+model
    expect(sim.usage('acct/m', a1, 10 * 60_000).cacheReadTokens).toBe(0); // TTL expired
  });
});

describe('run knowledge', () => {
  it('extracts only new, verified facts from accepted files', () => {
    const base = '#include "X.h"\nint Old(int);\n';
    const accepted = `#include "X.h"\nint Old(int);\nint Callee(float a, int b);\nextern unsigned int g_counter;\nstruct Pair\n{\n    int a; // 00\n    int b; // 04\n};\nstatic_assert(sizeof(Pair) == 8, "Pair size");\nint Foo::Bar()\n{\n    return Callee(1.0f, g_counter);\n}\n`;
    const k = extractKnowledge({ runId: 'r', taskId: 't', unit: 'u.cpp', files: [{ path: 'u.cpp', content: accepted }], base: new Map([['u.cpp', base]]) });
    const by = (kind: string, symbol: string) => k.find((e) => e.kind === kind && e.symbol === symbol);
    expect(by('function_signature', 'Callee')!.content).toBe('int Callee(float a, int b);');
    expect(by('function_signature', 'Foo::Bar')!.content).toBe('int Foo::Bar();');
    expect(by('global', 'g_counter')).toBeTruthy();
    expect(by('struct_layout', 'Pair')!.content).toContain('static_assert(sizeof(Pair) == 8');
    expect(by('function_signature', 'Old')).toBeUndefined(); // already in base
  });
});

// ------------------------------------------------------------------------------------------------
// End to end: tiered routing + budgeted context on the simulator, compared with legacy bundles.
// ------------------------------------------------------------------------------------------------

function tieredAccounts(): Account[] {
  const m = (id: string, capability: 'fast' | 'balanced' | 'frontier', price: [number, number]) => [{ id, roles: ['worker', 'gatekeeper', 'orchestrator'], capability, priceInPerMTok: price[0], priceOutPerMTok: price[1], priceCacheReadPerMTok: price[0] / 10, priceCacheWritePerMTok: price[0] * 1.25 }];
  const o = { latencyMs: [1, 3] };
  return [
    mockAccount('haiku-a', { models: m('haiku', 'fast', [0.1, 0.5]) as never, options: o }),
    mockAccount('haiku-b', { models: m('haiku', 'fast', [0.1, 0.5]) as never, options: o }),
    mockAccount('sonnet', { models: m('sonnet', 'balanced', [2, 10]) as never, options: o }),
    mockAccount('opus', { models: m('opus', 'frontier', [4, 20]) as never, options: o }),
  ];
}

function setup(dbPath: string) {
  const store = new Store(openDatabase(dbPath));
  stores.push(store);
  const events = new EventBus(store);
  const repo = new SimRepo({ slots: 10, compareLatencyMs: [1, 3], infraRate: 0 });
  const pool = new AccountPool(tieredAccounts(), store, events, { circuitBaseMs: 100, rateLimitBaseMs: 20, overloadCooldownMs: 20 });
  const engine = new RunEngine({ store, pool, providers: new ProviderRegistry({ oracle: repo }), repo, events }, { leaseMs: 5_000, heartbeatMs: 500, infraBackoffMs: 5, idlePollMs: 20 });
  return { store, events, repo, pool, engine };
}

const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), 'decomp-ctx-'));
  dirs.push(d);
  return join(d, 'orch.db');
};

function flow(fast: number, balanced: number, frontier: number) {
  const f = defaultFlow();
  f.nodes.find((n) => n.id === 'worker-fast')!.data.instances = fast;
  f.nodes.find((n) => n.id === 'worker-balanced')!.data.instances = balanced;
  f.nodes.find((n) => n.id === 'worker-frontier')!.data.instances = frontier;
  return f;
}

async function runOnce(mode: 'budgeted' | 'legacy', routing: boolean) {
  const s = setup(tmpDb());
  const run = s.engine.createRun(mode, { flowId: 'default', selection: { source: 'synthetic', count: 120, seed: 21 }, exposureConsent: true, context: { mode }, routing: { enabled: routing } }, flow(1, 3, 3)); // fast tier under-provisioned → idle higher tiers steal
  await s.engine.start(run.id);
  await s.engine.waitFor(run.id);
  const u = s.store.runUsage(run.id);
  const r = s.store.getRun(run.id)!;
  const out = { s, run: r, usage: u, fc: s.store.functionCounts(run.id) };
  s.pool.close();
  s.engine.close();
  return out;
}

describe('end to end: routed + budgeted vs legacy', () => {
  it('routes by difficulty, steals, promotes, shares knowledge and cuts input tokens', async () => {
    const routed = await runOnce('budgeted', true);
    const { s, run } = routed;
    expect(run.status).toBe('completed');
    const fc = routed.fc;
    expect(Object.values(fc).reduce((a, b) => a + b, 0)).toBe(120);
    expect(fc.staged ?? 0).toBeGreaterThan(80);

    // routing: every difficulty entered at its own tier
    const entry = s.store.db.prepare(`SELECT difficulty, MIN(tier) t FROM attempts WHERE run_id = ? AND n = 1 GROUP BY difficulty`).all(run.id) as Array<{ difficulty: string; t: number }>;
    const byD = Object.fromEntries(entry.map((e) => [e.difficulty, e.t]));
    if (byD.hard !== undefined) expect(byD.hard).toBe(2);
    if (byD.easy !== undefined) expect(byD.easy).toBe(0);
    const kinds = Object.fromEntries((s.store.db.prepare(`SELECT kind, COUNT(*) n FROM events WHERE run_id = ? GROUP BY kind`).all(run.id) as Array<{ kind: string; n: number }>).map((k) => [k.kind, k.n]));
    // A packet leaves a tier only after the tier's attempts (no early promotion any more).
    expect(kinds['task.promoted'] ?? 0).toBe(0);
    expect(kinds['task.stolen'] ?? 0).toBeGreaterThan(0);
    // knowledge from passing packets reached later bundles
    expect(s.store.knowledgeStats(run.id).reduce((a, k) => a + k.n, 0)).toBeGreaterThan(0);
    // caching + telemetry
    expect(run.cachedInputTokens).toBeGreaterThan(0);
    expect(run.cachedInputTokens / run.inputTokens).toBeGreaterThan(0.25);
    expect(routed.usage.context_tokens).toBeLessThan(routed.usage.context_raw_tokens * 0.5);
    // accepted output never contains an elision placeholder
    const accepted = s.store.db.prepare(`SELECT a.files_json FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE v.decision = 'pass' AND a.run_id = ?`).all(run.id) as Array<{ files_json: string }>;
    for (const a of accepted) expect(a.files_json).not.toContain(ELIDED_MARKER);

    // Same routing, legacy bundles: isolates what context engineering + caching save.
    const legacy = await runOnce('legacy', true);
    expect(legacy.run.status).toBe('completed');
    const perFnRouted = routed.run.inputTokens / 120;
    const perFnLegacy = legacy.run.inputTokens / 120;
    expect(perFnRouted).toBeLessThan(perFnLegacy * 0.6); // ≥40% fewer input tokens per function
    expect(routed.run.costUsd).toBeLessThan(legacy.run.costUsd);
  }, 120_000);
});
