# SPDX-License-Identifier: AGPL-3.0-or-later
"""Graph algorithms over integer-numbered nodes: order, dominators, components, natural loops.

Every function is a pure function of its arguments and visits nodes in a fixed order, so results are reproducible.
"""
from __future__ import annotations

from dataclasses import dataclass

Succ = list[list[int]]


def reverse_postorder(succ: Succ, root: int) -> list[int]:
    seen = [False] * len(succ)
    out: list[int] = []
    stack: list[tuple[int, int]] = [(root, 0)]
    seen[root] = True
    while stack:
        n, k = stack.pop()
        if k < len(succ[n]):
            stack.append((n, k + 1))
            m = succ[n][k]
            if not seen[m]:
                seen[m] = True
                stack.append((m, 0))
        else:
            out.append(n)
    out.reverse()
    return out


def predecessors(succ: Succ) -> Succ:
    pred: Succ = [[] for _ in succ]
    for n, ss in enumerate(succ):
        for m in ss:
            if n not in pred[m]:
                pred[m].append(n)
    return pred


def immediate_dominators(succ: Succ, root: int) -> list[int | None]:
    """The immediate dominator of each node reachable from `root` (the root's is itself); None for the others."""
    order = reverse_postorder(succ, root)
    pos = {n: i for i, n in enumerate(order)}
    pred = predecessors(succ)
    idom: list[int | None] = [None] * len(succ)
    idom[root] = root
    changed = True
    while changed:
        changed = False
        for n in order:
            if n == root:
                continue
            new: int | None = None
            for p in pred[n]:
                if p not in pos or idom[p] is None:
                    continue
                if new is None:
                    new = p
                    continue
                a, b = p, new
                while a != b:
                    while pos[a] > pos[b]:
                        a = idom[a]  # type: ignore[assignment]
                    while pos[b] > pos[a]:
                        b = idom[b]  # type: ignore[assignment]
                new = a
            if new != idom[n]:
                idom[n] = new
                changed = True
    return idom


def dominates(idom: list[int | None], a: int, b: int) -> bool:
    """Whether `a` dominates `b`; False when either is unreachable."""
    if idom[a] is None or idom[b] is None:
        return False
    while True:
        if a == b:
            return True
        up = idom[b]
        if up is None or up == b:
            return False
        b = up


def immediate_postdominators(succ: Succ, exits: list[int]) -> list[int | None]:
    """With a virtual exit numbered len(succ) after every node of `exits`; None where no exit is reachable."""
    n = len(succ)
    rev: Succ = [[] for _ in range(n + 1)]
    for a, ss in enumerate(succ):
        for b in ss:
            if a not in rev[b]:
                rev[b].append(a)
    rev[n] = sorted(set(exits))
    return immediate_dominators(rev, n)[:n]


def strongly_connected(succ: Succ) -> list[list[int]]:
    """Components with a cycle, each sorted, in order of their smallest node (Tarjan, iterative)."""
    index: dict[int, int] = {}
    low: dict[int, int] = {}
    on: set[int] = set()
    stack: list[int] = []
    out: list[list[int]] = []
    for root in range(len(succ)):
        if root in index:
            continue
        work: list[tuple[int, int]] = [(root, 0)]
        while work:
            n, k = work.pop()
            if k == 0:
                index[n] = low[n] = len(index)
                stack.append(n)
                on.add(n)
            descend = False
            for j in range(k, len(succ[n])):
                m = succ[n][j]
                if m not in index:
                    work.append((n, j + 1))
                    work.append((m, 0))
                    descend = True
                    break
                if m in on:
                    low[n] = min(low[n], index[m])
            if descend:
                continue
            if low[n] == index[n]:
                comp = []
                while True:
                    m = stack.pop()
                    on.discard(m)
                    comp.append(m)
                    if m == n:
                        break
                if len(comp) > 1 or n in succ[n]:
                    out.append(sorted(comp))
            if work:
                p = work[-1][0]
                low[p] = min(low[p], low[n])
    return sorted(out, key=lambda c: c[0])


@dataclass(frozen=True)
class Loop:
    header: int
    body: tuple[int, ...]       # sorted, with the header
    latches: tuple[int, ...]    # sources of the back edges
    parent: int | None = None   # header of the innermost enclosing loop


def natural_loops(succ: Succ, root: int) -> tuple[list[Loop], bool]:
    """(loops by header, whether the graph is reducible). A cycle no header dominates makes it irreducible."""
    idom = immediate_dominators(succ, root)
    pred = predecessors(succ)
    back: dict[int, list[int]] = {}
    for n, ss in enumerate(succ):
        for h in ss:
            if dominates(idom, h, n):
                back.setdefault(h, []).append(n)
    loops: list[Loop] = []
    for h in sorted(back):
        body = {h}
        work = [n for n in back[h] if n != h]
        while work:
            n = work.pop()
            if n in body:
                continue
            body.add(n)
            work.extend(p for p in pred[n] if idom[p] is not None)
        loops.append(Loop(h, tuple(sorted(body)), tuple(sorted(set(back[h])))))
    nested = []
    for lp in loops:
        around = [o for o in loops if o.header != lp.header and lp.header in o.body]
        parent = min(around, key=lambda o: (len(o.body), o.header)).header if around else None
        nested.append(Loop(lp.header, lp.body, lp.latches, parent))
    # reducible: nothing but back edges closes a cycle
    forward: Succ = [[m for m in ss if not dominates(idom, m, n)] if idom[n] is not None else [] for n, ss in enumerate(succ)]
    return nested, not strongly_connected(forward)
