# SPDX-License-Identifier: AGPL-3.0-or-later
"""Undoing loop rotation: a test before a loop and the same test at its end become one test at its start.

The guard tests what the loop starts with, the latch what it goes on with. When both are one expression of the loop's
variables, and both leave to the same place, the loop is the same as one whose header makes the test. What the guard and
the latch hand to the exit becomes a variable of the new header. The test may read memory; it is made as often and at the
same points as before.
"""
from __future__ import annotations

from dataclasses import replace

from recon.core.analysis import graph
from recon.core.ir.build import drop_dead, simplify_phis
from recon.core.ir.model import Arg, Block, Const, Fn, Op, Phi, Term


class _Try:
    def __init__(self, fn: Fn) -> None:
        self.fn = fn
        self.types = dict(fn.types)
        self.d = {v: x for v, (_b, x) in fn.defining().items()}
        self.home = {v: b for v, (b, _x) in fn.defining().items()}

    def fresh(self, w) -> int:
        v = max(self.types) + 1
        self.types[v] = w
        return v


def _tests_agree(t: _Try, a: Arg, b: Arg, same_sense: bool, body: set[int], pairs: dict[int, Arg]) -> bool:
    """Whether the guard's condition is the latch's (or, when they lead on in opposite senses, its negation) for what the loop starts with."""
    if same_sense and _same(t, a, b, body, pairs):
        return True
    x, y = t.d.get(a) if isinstance(a, int) else None, t.d.get(b) if isinstance(b, int) else None
    if not isinstance(x, Op) or not isinstance(y, Op) or len(x.args) != 2 or len(y.args) != 2 or t.fn.width(x.args[0]) != t.fn.width(y.args[0]):
        return False

    def start(v: Arg) -> Arg:
        return pairs.get(v, v) if isinstance(v, int) else v
    turned = {"eq": "ne", "ne": "eq", "slt": "sle", "sle": "slt", "ult": "ule", "ule": "ult"}
    if not same_sense and x.kind in turned and turned[x.kind] == y.kind:
        back = y.args if x.kind in ("eq", "ne") else y.args[::-1]
        if all(_same(t, p, q, body, pairs) for p, q in zip(x.args, back)):
            return True
    if x.kind in ("eq", "ne") and y.kind in ("eq", "ne") and (x.kind == y.kind) == same_sense and all(_same(t, p, q, body, pairs) for p, q in zip(x.args, y.args[::-1])):
        return True
    # 0 < n is n != 0 without a sign
    zero = isinstance(start(x.args[0]), Const) and start(x.args[0]).value == 0  # type: ignore[union-attr]
    return x.kind == "ult" and zero and y.kind in ("eq", "ne") and (y.kind == "ne") == same_sense and y.args[1] == Const(0, t.fn.width(y.args[0])) and _same(t, x.args[1], y.args[0], body, pairs)


def _same(t: _Try, a: Arg, b: Arg, guard_blocks: set[int], pairs: dict[int, Arg], depth: int = 12) -> bool:
    """Whether `b`, computed for the guard, is `a`, computed in the loop, with what the loop goes on with replaced by what it starts with.
    `pairs`: value going on -> value it starts with."""
    if isinstance(a, int) and a in pairs and pairs[a] == b:
        return True
    if isinstance(a, Const) or isinstance(b, Const):
        return a == b
    x, y = t.d.get(a), t.d.get(b)
    if a == b:
        return a not in pairs and not (isinstance(x, Phi) and t.home[a] in guard_blocks)
    if not depth or not isinstance(x, Op) or not isinstance(y, Op) or x.kind != y.kind or len(x.args) != len(y.args) or t.fn.width(a) != t.fn.width(b):
        return False
    if not x.pure and x.kind != "load" or x.kind == "load" and x.attr("atomic"):
        return False
    return all(_same(t, p, q, guard_blocks, pairs, depth - 1) for p, q in zip(x.args, y.args))


def _loop(fn: Fn, header: int, body: set[int], latch: int) -> Fn | None:
    t = _Try(fn)
    preds = fn.preds()
    outside = [p for p in preds[header] if p not in body]
    if len(outside) != 1 or fn.blocks[latch].term.kind != "branch":
        return None
    entered, between = header, []
    g = outside[0]
    while fn.blocks[g].term.kind == "goto" and len(preds[g]) == 1:     # blocks that only lead in
        if any(not o.pure for o in fn.blocks[g].ops):
            return None
        between.append(g)
        entered, g = g, preds[g][0]
    if fn.blocks[g].term.kind != "branch" or entered not in fn.blocks[g].term.targets:
        return None
    gt, lt = fn.blocks[g].term, fn.blocks[latch].term
    if len(set(gt.targets)) != 2 or len(set(lt.targets)) != 2 or header not in lt.targets:
        return None
    x = lt.targets[1 - lt.targets.index(header)]
    gx = gt.targets[1 - gt.targets.index(entered)]
    if x in body:
        return None
    phis = [p for p in fn.blocks[header].phis if p.region is None]
    last = outside[0]                                   # the block outside the loop that leads into it
    pairs: dict[int, Arg] = {}
    for p in phis:
        go_on, start = dict(p.args)[latch], dict(p.args)[last]
        if isinstance(go_on, int):
            if go_on in pairs and pairs[go_on] != start:
                return None
            pairs[go_on] = start
    if [k for k, _a in (phis[0].args if phis else ())] != sorted({last, latch}) and phis:
        return None
    if not _tests_agree(t, lt.args[0], gt.args[0], (lt.targets[0] == header) == (gt.targets[0] == entered), body, pairs):
        return None
    # where both leave to: the same block, or two blocks that only return the same constant or value
    if x != gx:
        merged = _join_exits(fn, g, gx, latch, x, pairs)
        if merged is None:
            return None
        fn, x = merged
        t = _Try(fn)
    n = len(fn.blocks)                                  # the new header
    first: dict[int, int] = {}                          # header phi -> its new one
    new_phis: list[Phi] = []

    def make(start: Arg, go_on: Arg, w) -> int:
        for q in new_phis:
            if dict(q.args) == {last: start, latch: go_on}:
                return q.id
        v = t.fresh(w)
        new_phis.append(Phi(v, tuple(sorted(((last, start), (latch, go_on))))))
        return v

    for p in [p for p in fn.blocks[header].phis if p.region is None]:
        first[p.id] = make(dict(p.args)[last], dict(p.args)[latch], t.types[p.id])
    exit_args: dict[int, Arg] = {}
    preds = fn.preds()
    for p in fn.blocks[x].phis:
        if p.region is None:
            a, b = dict(p.args)[g], dict(p.args)[latch]
            exit_args[p.id] = a if a == b and isinstance(a, Const) else make(a, b, t.types[p.id])
    inside = set(body)
    ops: list[Op] = []
    clone: dict[int, Arg] = {}

    def copy(a: Arg) -> Arg:
        if isinstance(a, Const):
            return a
        for q in new_phis:
            if dict(q.args)[latch] == a:
                return q.id
        if a in clone:
            return clone[a]
        o = t.d.get(a)
        if not isinstance(o, Op) or t.home[a] not in inside:
            return a
        args = tuple(copy(y) for y in o.args)
        v = t.fresh(fn.types[a])
        ops.append(Op(o.kind, (v,), args, o.attrs, o.mem, o.at))
        clone[a] = v
        return v
    cond = copy(lt.args[0])
    swap = {p.id: first[p.id] for p in fn.blocks[header].phis if p.region is None}
    blocks: list[Block] = []
    yes = lt.targets[0] == header

    def target(v: int, frm: int) -> int:
        return n if v == header and frm in (last, latch) else v

    for b in fn.blocks:
        phis2 = b.phis
        term = b.term
        if b.id == header:
            phis2 = tuple(p for p in b.phis if p.region is not None)
        if b.id == x:
            phis2 = tuple(p if p.region is not None else Phi(p.id, tuple(sorted([*((k, a) for k, a in p.args if k not in (g, latch)), (n, exit_args[p.id])]))) for p in b.phis)
        if b.id == g:
            term = Term("goto", (), (target(entered, g) if entered == header else entered,), (), (), b.term.at)
        elif b.id == latch:
            term = Term("goto", (), (n,), (), (), b.term.at)
        elif header in b.term.targets:
            term = replace(b.term, targets=tuple(target(v, b.id) for v in b.term.targets))
        blocks.append(Block(b.id, b.start, phis2, b.ops, term))
    blocks.append(Block(n, -1, tuple(new_phis), tuple(ops), Term("branch", (cond,), (header, x) if yes else (x, header), (), (), lt.at)))
    out = replace(fn, blocks=tuple(blocks), types=t.types, history=(*fn.history, "unrotate"))
    # a value of the loop that is used after it must still be made on every way there
    idom = graph.immediate_dominators(out.succ, 0)
    for b in out.blocks:
        if b.id in inside:
            continue
        used = [(a, b.id) for o in b.ops for a in o.args] + [(a, b.id) for a in b.term.args] + [(a, k) for p in b.phis if p.region is None for k, a in p.args]
        for a, where in used:
            if b.id != n and isinstance(a, int) and t.home.get(a) in inside and where not in inside and not graph.dominates(idom, t.home[a], where):
                return None
    return drop_dead(_rename(out, swap), "dead")


def _rename(fn: Fn, sub: dict[int, int]) -> Fn:
    def a(v: Arg) -> Arg:
        return sub.get(v, v) if isinstance(v, int) else v
    blocks = tuple(Block(b.id, b.start, tuple(Phi(p.id, tuple((k, a(v)) for k, v in p.args), p.region) for p in b.phis),
                         tuple(replace(o, args=tuple(map(a, o.args))) for o in b.ops), replace(b.term, args=tuple(map(a, b.term.args)))) for b in fn.blocks)
    return simplify_phis(replace(fn, blocks=blocks, types={v: w for v, w in fn.types.items() if v not in sub}))


def _join_exits(fn: Fn, g: int, gx: int, latch: int, x: int, pairs: dict[int, Arg]) -> tuple[Fn, int] | None:
    """The guard's and the latch's exits as one block, when each is a return of its own and nothing else."""
    preds = fn.preds()
    a, b = fn.blocks[gx], fn.blocks[x]
    if preds[gx] != [g] or preds[x] != [latch] or a.ops or b.ops or a.term.kind != "return" or b.term.kind != "return" or a.phis or b.phis:
        return None
    if len(a.term.args) != len(b.term.args):
        return None
    types = dict(fn.types)
    phis = ()
    args: tuple[Arg, ...] = ()
    if a.term.args:
        v = max(types) + 1
        types[v] = fn.width(a.term.args[0])
        phis = (Phi(v, tuple(sorted(((g, a.term.args[0]), (latch, b.term.args[0]))))),)
        args = (v,)
    blocks = list(fn.blocks)
    blocks[x] = replace(b, phis=phis, term=replace(b.term, args=args))
    blocks[g] = replace(blocks[g], term=replace(blocks[g].term, targets=tuple(x if s == gx else s for s in blocks[g].term.targets)))
    return replace(fn, blocks=tuple(blocks), types=types), x


def unrotate(fn: Fn) -> Fn:
    """Every loop for which the argument above holds, innermost first."""
    done: set[int] = set()
    while True:
        loops, reducible = graph.natural_loops(fn.succ, 0)
        if not reducible:
            return fn
        for lp in sorted(loops, key=lambda lp: (len(lp.body), lp.header)):
            if lp.header in done or len(lp.latches) != 1:
                continue
            done.add(lp.header)
            out = _loop(fn, lp.header, set(lp.body), lp.latches[0])
            if out is not None:
                fn = out
                break
        else:
            return fn


__all__ = ["unrotate"]
