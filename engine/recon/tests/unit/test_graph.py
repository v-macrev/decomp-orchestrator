# SPDX-License-Identifier: AGPL-3.0-or-later
"""Graph algorithms against their definitions, on random graphs: dominance by removing a node, cycles by reachability."""
import random

from recon.core.analysis import graph as g


def reach(succ, root, without=None):
    seen, work = set(), [root] if root != without else []
    while work:
        n = work.pop()
        if n in seen:
            continue
        seen.add(n)
        work.extend(m for m in succ[n] if m != without)
    return seen


def graphs(count=300):
    r = random.Random(7)
    for _ in range(count):
        n = r.randrange(1, 11)
        yield [sorted({r.randrange(n) for _ in range(r.choice((0, 1, 1, 2, 2, 3)))}) for _ in range(n)]


def dominators_by_definition(succ, root):
    live = reach(succ, root)
    return {n: {d for d in live if d == n or n not in reach(succ, root, without=d)} for n in live}


def test_dominators_match_the_definition():
    for s in graphs():
        want = dominators_by_definition(s, 0)
        idom = g.immediate_dominators(s, 0)
        for n in range(len(s)):
            if n not in want:
                assert idom[n] is None
                continue
            got = {d for d in range(len(s)) if g.dominates(idom, d, n)}
            assert got == want[n]


def test_postdominators_match_the_definition_on_the_reversed_graph():
    for s in graphs():
        n = len(s)
        exits = [k for k in range(n) if not s[k]]
        rev = [[] for _ in range(n + 1)]
        for a, ss in enumerate(s):
            for b in ss:
                rev[b].append(a)
        rev[n] = exits
        want = dominators_by_definition(rev, n)
        got = g.immediate_postdominators(s, exits)
        for k in range(n):
            if k not in want:
                assert got[k] is None
            else:
                strict = want[k] - {k}
                # the immediate one is the strict dominator every other strict dominator dominates
                assert got[k] in strict and all(d in want[got[k]] for d in strict)


def test_components_are_the_cycles():
    for s in graphs():
        comp = g.strongly_connected(s)
        for k in range(len(s)):
            on_cycle = any(k in reach(s, m) for m in s[k])
            mine = [c for c in comp if k in c]
            assert bool(mine) == on_cycle
            if mine:
                assert set(mine[0]) == {m for m in reach(s, k) if k in reach(s, m)}


def test_natural_loops_and_reducibility():
    # two nested loops and an irreducible pair
    nested = [[1], [2], [3, 2], [1, 4], []]
    loops, reducible = g.natural_loops(nested, 0)
    assert reducible and [(lp.header, lp.body, lp.parent) for lp in loops] == [(1, (1, 2, 3), None), (2, (2,), 1)]
    loops, reducible = g.natural_loops([[1, 2], [2], [1, 3], []], 0)
    assert not reducible and loops == []
    for s in graphs():
        loops, reducible = g.natural_loops(s, 0)
        live = reach(s, 0)
        for lp in loops:
            dom = dominators_by_definition(s, 0)
            assert all(lp.header in dom[b] for b in lp.body) and all(lp.header in s[x] for x in lp.latches)
        if reducible:  # every cycle then has a loop header in it
            heads = {lp.header for lp in loops}
            assert all(set(c) & heads for c in g.strongly_connected([ss if k in live else [] for k, ss in enumerate(s)]) if set(c) <= live)
