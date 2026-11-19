// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 2 routing: flow compilation, complexity scoring, pack features, work stealing, promotion.
import { describe, expect, it } from 'vitest';
import {
  ComplexityThresholds, assessPacket, compileFlowPlan, defaultFlow, scoreFeatures, sizeOnlyFeatures, stealSources, tierFor, validateFlow,
  type Flow, type FunctionFeatures,
} from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { partitionRouted } from '../src/intel/complexity.js';
import { classifyInstruction, featuresFromPack } from '../src/intel/x64features.js';
import { AccountPool } from '../src/pool/scheduler.js';
import { TaskQueue } from '../src/queue/taskQueue.js';
import { mockAccount, req } from './helpers.js';

const T = ComplexityThresholds.parse({});
const feat = (over: Partial<FunctionFeatures>): FunctionFeatures => ({ ...sizeOnlyFeatures(16), source: 'pack', instructions: 4, basicBlocks: 1, condBranches: 0, backEdges: 0, calls: 0, indirectCalls: 0, indirectJumps: 0, sseOps: 0, dataRefs: 0, unwindEntries: 1, tailCall: false, ...over });

describe('flow routing plan', () => {
  it('routes difficulties by dispatch-edge rules on the default ladder', () => {
    const plan = compileFlowPlan(defaultFlow());
    expect(plan.tiers.map((t) => t.capability)).toEqual(['fast', 'balanced', 'frontier']);
    expect(plan.route).toEqual({ easy: 0, medium: 1, hard: 2 });
    expect(plan.routeSource).toEqual({ easy: 'edge', medium: 'edge', hard: 'edge' });
    expect(validateFlow(defaultFlow()).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('infers capabilities for legacy single-dispatch flows (nearest capability, ties → cheaper)', () => {
    const f = defaultFlow();
    f.edges = f.edges.filter((e) => !e.id.startsWith('e-dispatch-')).concat({ id: 'd', source: 'orchestrator', target: 'worker-fast', kind: 'dispatch' });
    for (const n of f.nodes) delete n.data.capability;
    const plan = compileFlowPlan(f);
    expect(plan.tiers.map((t) => [t.capability, t.capabilityInferred])).toEqual([['fast', true], ['balanced', true], ['frontier', true]]);
    expect(plan.route).toEqual({ easy: 0, medium: 1, hard: 2 });
    // two tiers: medium is equidistant → cheaper tier
    const two: Flow = { ...f, nodes: f.nodes.filter((n) => n.id !== 'worker-balanced'), edges: f.edges.filter((e) => !e.source.includes('balanced') && !e.target.includes('balanced')).concat({ id: 'x', source: 'worker-fast', target: 'worker-frontier', kind: 'escalate' }) };
    expect(compileFlowPlan(two).route).toEqual({ easy: 0, medium: 0, hard: 1 });
  });

  it('rejects a difficulty routed twice and dispatch targets off the ladder', () => {
    const f = defaultFlow();
    f.edges.find((e) => e.id === 'e-dispatch-medium')!.difficulties = ['medium', 'easy'];
    expect(validateFlow(f).some((i) => i.level === 'error' && /routed by two/.test(i.message))).toBe(true);
    const g = defaultFlow();
    g.edges = g.edges.filter((e) => e.id !== 'e-escalate-2');
    expect(validateFlow(g).some((i) => i.level === 'error' && /not on the escalation ladder/.test(i.message))).toBe(true);
  });

  it('promotion never moves down and stealing only takes from lower capabilities', () => {
    const plan = compileFlowPlan(defaultFlow());
    expect(tierFor(plan, 'easy', 2)).toBe(2);
    expect(tierFor(plan, 'hard', 0)).toBe(2);
    expect(stealSources(plan, 2)).toEqual([1, 0]);
    expect(stealSources(plan, 1)).toEqual([0]);
    expect(stealSources(plan, 0)).toEqual([]);
  });
});

describe('complexity scoring', () => {
  it('is deterministic, explains itself and orders shapes sensibly', () => {
    const tiny = scoreFeatures(feat({ size: 8 }));
    const branchy = scoreFeatures(feat({ size: 120, condBranches: 6, backEdges: 1, calls: 3 }));
    const floaty = scoreFeatures(feat({ size: 140, condBranches: 4, sseOps: 14, indirectCalls: 2, unwindEntries: 3 }));
    expect(scoreFeatures(feat({ size: 120, condBranches: 6, backEdges: 1, calls: 3 }))).toEqual(branchy);
    expect(tiny.score).toBeLessThan(T.medium);
    expect(branchy.score).toBeGreaterThan(tiny.score);
    expect(floaty.score).toBeGreaterThanOrEqual(T.hard);
    expect(floaty.reasons.some((r) => /SSE/.test(r))).toBe(true);
    expect(floaty.reasons.some((r) => /unwind/.test(r))).toBe(true);
  });

  it('size-only estimates land on the same scale as pack features', () => {
    expect(assessPacket([sizeOnlyFeatures(12)], T).difficulty).toBe('easy');
    expect(assessPacket([sizeOnlyFeatures(110)], T).difficulty).toBe('medium');
    expect(assessPacket([sizeOnlyFeatures(400)], T).difficulty).toBe('hard');
  });

  it('packs hard functions alone and never drags easy siblings up', () => {
    const fn = (rva: string, size: number) => ({ rva, name: `C::F${rva}`, size, unit: 'reconstruction/x/C.cpp' });
    const items = [
      ...['0x10', '0x20', '0x30', '0x40', '0x50'].map((r) => ({ fn: fn(r, 8), features: feat({ size: 8 }), score: 0, difficulty: 'easy' as const, borderline: false, llm: false })),
      ...['0x60', '0x70'].map((r) => ({ fn: fn(r, 300), features: feat({ size: 300, condBranches: 8, sseOps: 10 }), score: 9, difficulty: 'hard' as const, borderline: false, llm: false })),
    ];
    const packets = partitionRouted(items, 4, T, true);
    const easy = packets.filter((p) => p.difficulty === 'easy');
    const hard = packets.filter((p) => p.difficulty === 'hard');
    expect(easy.map((p) => p.functions.length).sort()).toEqual([1, 4]);
    expect(hard.map((p) => p.functions.length)).toEqual([1, 1]);
    expect(packets.every((p) => p.assessment.functions && Object.keys(p.assessment.functions).length === p.functions.length)).toBe(true);
  });
});

describe('pack features (x64 classifier)', () => {
  it('recognises branches, loops, calls, virtual calls, SSE and tail jumps — counts only', () => {
    // 0: test ecx,ecx (85 c9) | 2: jz +5 (74 05) | 4: movss xmm0,[rcx+8] (f3 0f 10 41 08) | 9: call [rax+0x10] (ff 50 10)
    // c: dec ecx (ff c9) | e: jnz back to 4 (75 f4) | 10: call rel32 (e8 00 00 00 00) | 15: jmp rel32 out (e9 00 10 00 00)
    const bytes = '85c97405f30f104108ff5010ffc975f4e800000000e900100000';
    const rows = [[0, 2], [2, 2], [4, 5], [9, 3], [12, 2], [14, 2], [16, 5], [21, 5]].map(([offset, length]) => ({ offset: offset!, length: length!, field: null, target: null }));
    const f = featuresFromPack({ bytes_hex: bytes, instructions: rows, references: [{ target_rva: 1, kind: 'data-or-code' }], unwind_entries: 1, identity: { size: 26 } });
    expect(f).toMatchObject({ source: 'pack', size: 26, instructions: 8, condBranches: 2, backEdges: 1, calls: 1, indirectCalls: 1, sseOps: 1, dataRefs: 1, tailCall: true });
    expect(f.basicBlocks).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(f)).not.toContain('f30f'); // no bytes survive
    expect(classifyInstruction(Uint8Array.from([0x48, 0xff, 0x60, 0x08]), 0, 4)).toMatchObject({ kind: 'ijmp', viaMemory: true });
    expect(classifyInstruction(Uint8Array.from([0xff, 0x15, 0, 0, 0, 0]), 0, 6)).toMatchObject({ kind: 'icall', ripRelative: true, viaMemory: false });
  });
});

describe('work stealing (queue)', () => {
  it('an idle higher tier steals only the surplus beyond the lower tier’s idle slots', () => {
    const store = new Store(openDatabase(':memory:'));
    const run = store.createRun({ id: 'r', name: 'r', config: { flowId: 'default', selection: { source: 'synthetic', count: 3, seed: 1 } } as never, flow: defaultFlow() });
    store.insertTasks(run.id, ['a', 'b', 'c'].map((u, i) => ({ id: `t${i}`, unit: `reconstruction/x/${u}.cpp`, functions: [{ rva: `0x${i + 1}0`, name: null, size: 8 }], priority: 10 - i, tier: 0, difficulty: 'easy' as const })));
    const q = new TaskQueue(store);
    expect(q.lease(run.id, 2, 1, 10_000, { stealFrom: [{ tier: 0, minBacklog: 3 }] })).toEqual([]); // fast tier will absorb all 3
    const got = q.lease(run.id, 2, 1, 10_000, { stealFrom: [{ tier: 1, minBacklog: 0 }, { tier: 0, minBacklog: 1 }] });
    expect(got).toHaveLength(1);
    expect(got[0]!.stolenFrom).toBe(0);
    expect(store.getTask(got[0]!.task.id)!.tier).toBe(2); // continues on the stealer's tier
    expect(got[0]!.task.id).toBe('t0'); // highest priority first
    store.db.close();
  });
});

describe('capability-aware account selection', () => {
  it('prefers models declaring the capability and falls back to role matching', () => {
    const fast = mockAccount('haiku', { models: [{ id: 'h', roles: ['worker'], capability: 'fast', priceInPerMTok: 0.1, priceOutPerMTok: 0.5 }] as never });
    const strong = mockAccount('opus', { models: [{ id: 'o', roles: ['worker'], capability: 'frontier', priceInPerMTok: 4, priceOutPerMTok: 20 }] as never });
    const plain = mockAccount('plain');
    const pool = new AccountPool([fast, strong, plain], null, null);
    const binding = (capability?: 'fast' | 'balanced' | 'frontier') => ({ strategy: 'pool' as const, accountIds: [], tags: [], capability });
    expect(pool.resolve(binding('fast'), 'worker').map((c) => c.slot.account.id)).toEqual(['haiku']);
    expect(pool.resolve(binding('frontier'), 'worker').map((c) => c.slot.account.id)).toEqual(['opus']);
    expect(pool.resolve(binding('balanced'), 'worker').map((c) => c.slot.account.id).sort()).toEqual(['haiku', 'opus', 'plain']); // nobody declares balanced
    const lease = pool.tryAcquire(req({ binding: binding('fast') }));
    expect('lease' in lease && lease.lease.model.id).toBe('h');
    pool.close();
  });
});
