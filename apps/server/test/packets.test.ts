// SPDX-License-Identifier: AGPL-3.0-or-later
// The Packets table query: sort on any column, filter per column, totals and value lists.
import { describe, expect, it } from 'vitest';
import { defaultFlow } from '@decomp/core';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';

function seed() {
  const store = new Store(openDatabase(':memory:'));
  const run = store.createRun({ id: 'r', name: 'r', config: { flowId: 'default', selection: { source: 'synthetic', count: 6, seed: 1 } } as never, flow: defaultFlow() });
  const rows: Array<[string, string[], 'easy' | 'medium' | 'hard', string, number, string | null, number, number]> = [
    // unit, function names, difficulty, state, tier, worker, attempts, best bytes
    ['a', ['Alpha::Init'], 'hard', 'dead', 2, 'w-frontier', 9, 40],
    ['a', ['Alpha::Tick', 'Alpha::Run'], 'easy', 'passed', 0, 'w-fast', 1, 120],
    ['b', ['Beta_100%'], 'medium', 'pending', 1, null, 0, 0],
    ['b', ['Beta::Go'], 'medium', 'staged', 1, 'w-balanced', 3, 64],
    ['c', ['Gamma::X', 'Gamma::Y', 'Gamma::Z'], 'easy', 'passed', 0, 'w-fast', 2, 200],
    ['c', ['Gamma::W'], 'hard', 'leased', 2, 'w-frontier', 5, 8],
  ];
  store.insertTasks(run.id, rows.map(([u, fns, d, , tier], i) => ({
    id: `t${i}`, unit: `reconstruction/x/${u}.cpp`, functions: fns.map((name, k) => ({ rva: `0x${i}${k}0`, name, size: 8 })), priority: 10 - i, tier, difficulty: d,
  })));
  const up = store.db.prepare('UPDATE tasks SET state = ?, assigned_worker = ?, attempts_total = ?, best_exact_bytes = ? WHERE id = ?');
  rows.forEach(([, , , state, , worker, attempts, bytes], i) => up.run(state, worker, attempts, bytes, `t${i}`));
  return { store, run };
}

describe('packets query', () => {
  it('sorts on each column, ties by priority', () => {
    const { store, run } = seed();
    const ids = (q: Parameters<Store['queryTasks']>[1]) => store.queryTasks(run.id, q).rows.map((t) => t.id);
    expect(ids({})).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
    expect(ids({ sort: 'attempts', dir: 'desc' })).toEqual(['t0', 't5', 't3', 't4', 't1', 't2']);
    expect(ids({ sort: 'difficulty' })).toEqual(['t1', 't4', 't2', 't3', 't0', 't5']); // easy, medium, hard
    expect(ids({ sort: 'state' })).toEqual(['t2', 't5', 't1', 't4', 't3', 't0']); // lifecycle order
    expect(ids({ sort: 'functions', dir: 'desc' })[0]).toBe('t4');
    expect(ids({ sort: 'worker' })[0]).toBe('t2'); // no worker first
    expect(ids({ sort: 'bytes', dir: 'desc' })).toEqual(['t4', 't1', 't3', 't0', 't5', 't2']);
    store.db.close();
  });

  it('filters per column and counts each value list under the other filters', () => {
    const { store, run } = seed();
    const p = store.queryTasks(run.id, { values: { state: ['passed', 'dead'] } });
    expect(p.rows.map((t) => t.id)).toEqual(['t0', 't1', 't4']);
    expect(p.total).toBe(3);
    expect(p.functions).toBe(6);
    // The state list still shows every state (its own filter is left out), the others narrow.
    expect(p.facets.state.map((v) => v.value)).toEqual(['pending', 'leased', 'passed', 'staged', 'dead']);
    expect(p.facets.difficulty).toEqual([{ value: 'easy', n: 2 }, { value: 'hard', n: 1 }]);
    expect(p.facets.worker.map((v) => v.value)).toEqual(['w-fast', 'w-frontier']);

    expect(store.queryTasks(run.id, { values: { worker: [''] } }).rows.map((t) => t.id)).toEqual(['t2']);
    expect(store.queryTasks(run.id, { values: { tier: [2], difficulty: ['hard'] } }).total).toBe(2);
    expect(store.queryTasks(run.id, { unit: 'X/B' }).rows.map((t) => t.id)).toEqual(['t2', 't3']); // contains, any case
    expect(store.queryTasks(run.id, { fn: 'gamma::' }).total).toBe(2);
    expect(store.queryTasks(run.id, { fn: '100%' }).rows.map((t) => t.id)).toEqual(['t2']); // % is literal
    expect(store.queryTasks(run.id, { fn: '%' }).total).toBe(1);
    expect(store.queryTasks(run.id, { bytesMin: 50, bytesMax: 150 }).rows.map((t) => t.id)).toEqual(['t1', 't3']);
    store.db.close();
  });

  it('pages over the filtered rows', () => {
    const { store, run } = seed();
    const page = store.queryTasks(run.id, { sort: 'attempts', dir: 'asc', limit: 2, offset: 2 });
    expect(page.rows.map((t) => t.id)).toEqual(['t4', 't3']);
    expect(page.total).toBe(6);
    store.db.close();
  });
});
