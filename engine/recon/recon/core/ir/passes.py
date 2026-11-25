# SPDX-License-Identifier: AGPL-3.0-or-later
"""Transformations of the IR. Each states what it needs and what it keeps; `apply` checks the IR before and after.

None of them loses an instruction: an operation that stands for another takes its addresses over, and an instruction
left without one is recorded with the reason. Every one is tested by SMT on small generated functions and by execution
on larger ones; the rules `simplify` applies are proved one by one.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from recon.core.analysis import graph
from recon.core.analysis.dataflow import Abi
from recon.core.evaluate import UNDEF
from recon.core.evaluate import apply as compute
from recon.core.ir import memory as mm
from recon.core.ir import rules as ru
from recon.core.ir import validate
from recon.core.ir.build import drop_dead, record, settle_memory, simplify_phis, substitute, thread_with
from recon.core.ir.model import FRAME, Arg, Block, Const, Fn, Observation, Op, Phi, Term
from recon.core.sem import OPAQUE, OPS


@dataclass(frozen=True)
class Pass:
    name: str
    precondition: str
    guarantee: str
    run: Callable[[Fn, Abi], Fn]


def _with(fn: Fn, **kw) -> Fn:
    from dataclasses import replace
    return replace(fn, **kw)


def apply(p: Pass, fn: Fn, abi: Abi) -> Fn:
    """The transformed function, or InvalidIr when the function is not valid before or after."""
    found = validate.problems(fn, abi)
    if found:
        raise validate.InvalidIr([f"before {p.name}: {x}" for x in found])
    return _run(p, fn, abi)


def _run(p: Pass, fn: Fn, abi: Abi) -> Fn:
    """The pass on a function already found valid. What it leaves as it was needs no second look."""
    out = settle_memory(p.run(fn, abi), abi)
    if _with(out, history=fn.history) != fn:
        found = validate.problems(out, abi)
        if found:
            raise validate.InvalidIr([f"after {p.name}: {x}" for x in found])
    return _with(out, history=(*fn.history, p.name))


# ---------------------------------------------------------------------------------------- simplify

class _Simplifier:
    def __init__(self, fn: Fn) -> None:
        self.fn = fn
        self.types = dict(fn.types)
        self.top = max(self.types, default=-1) + 1
        self.defs: dict[int, Op] = {o.defs[0]: o for _b, o in fn.ops() if o.pure}
        self.sub: dict[int, Arg] = {}
        self.index = ru.index()

    def arg(self, a: Arg) -> Arg:
        while isinstance(a, int) and a in self.sub:
            a = self.sub[a]
        return a

    def width(self, a: Arg) -> int:
        return a.width if isinstance(a, Const) else self.types[a]  # type: ignore[return-value]

    def match(self, x: ru.Term, a: Arg, env: dict[str, Arg], at: list[int]) -> bool:
        a = self.arg(a)
        if self.width(a) != x.width:
            return False
        if isinstance(x, (ru.V, ru.K)):
            if isinstance(x, ru.K) and not isinstance(a, Const):
                return False
            if x.name in env:
                return env[x.name] == a
            env[x.name] = a
            return True
        if isinstance(x, ru.N):
            return isinstance(a, Const) and a.value == x.value
        o = self.defs.get(a) if isinstance(a, int) else None
        if o is None or o.kind != x.op or len(o.args) != len(x.args):
            return False
        at.extend(o.at)
        return all(self.match(p, q, env, at) for p, q in zip(x.args, o.args))

    def make(self, x: ru.Term, env: dict[str, Arg], at: tuple[int, ...], out: list[Op]) -> Arg:
        if ru.constant(x):
            return Const(ru.value_of(x, {k: v.value for k, v in env.items() if isinstance(v, Const)}), x.width)
        if isinstance(x, ru.V):
            return env[x.name]
        assert isinstance(x, ru.T)
        args = tuple(self.make(a, env, at, out) for a in x.args)
        v = self.top
        self.top += 1
        self.types[v] = x.width
        o = Op(x.op, (v,), args, (), (), at)
        self.defs[v] = o
        out.append(o)
        return v

    def rewrite(self, o: Op, out: list[Op]) -> Op | Arg:
        """A value the operation always has, or the operation to keep in its place (operations it needs are put on `out`)."""
        if all(isinstance(a, Const) for a in o.args) and o.args and o.kind not in OPAQUE:
            r = compute(o.kind, [a.value for a in o.args], [a.width for a in o.args], self.width(o.defs[0]))  # type: ignore[union-attr]
            return o if r is UNDEF else Const(r, self.width(o.defs[0]))
        if o.kind == "ite" and isinstance(o.args[0], Const):
            return o.args[1] if o.args[0].value else o.args[2]
        if o.kind in ru.COMMUTES and len(o.args) == 2 and isinstance(o.args[0], Const) and not isinstance(o.args[1], Const):
            return Op(o.kind, o.defs, o.args[::-1], o.attrs, o.mem, o.at)
        if not o.args:
            return o
        for r in self.index.get((o.kind, self.width(o.defs[0]), self.width(o.args[0])), ()):
            env: dict[str, Arg] = {}
            at: list[int] = list(o.at)
            if not all(self.match(p, q, env, at) for p, q in zip(r.lhs.args, o.args)):
                continue
            if r.when:
                consts = {k: v.value for k, v in env.items() if isinstance(v, Const)}
                if not all(ru.value_of(c, consts) for c in r.when):
                    continue
            where = tuple(sorted(set(at)))
            made: list[Op] = []
            x = self.make(r.rhs, env, where, made)
            if not made:
                return x
            out.extend(made[:-1])  # the last one made is the root: it keeps the old value's name
            root = made[-1]
            del self.types[root.defs[0]]
            del self.defs[root.defs[0]]
            return Op(root.kind, o.defs, root.args, (), (), where)
        return o

    def go(self) -> Fn:
        blocks = {}
        gone: set[int] = set()
        for b in graph.reverse_postorder(self.fn.succ, 0):
            blk = self.fn.blocks[b]
            ops: list[Op] = []
            queue = list(reversed(blk.ops))
            budget = 64 * len(queue) + 64
            while queue:
                o = queue.pop()
                o = Op(o.kind, o.defs, tuple(map(self.arg, o.args)), o.attrs, o.mem, o.at)
                if not o.pure or o.kind in (FRAME, "undef"):
                    ops.append(o)
                    continue
                made: list[Op] = []
                r = self.rewrite(o, made) if budget > 0 else o
                budget -= 1
                if isinstance(r, Op):
                    if r == o:
                        self.defs[o.defs[0]] = o
                        ops.append(o)
                    else:  # what was made may itself be simplified, operands first
                        queue.append(r)
                        queue.extend(reversed(made))
                else:
                    self.sub[o.defs[0]] = r
                    del self.types[o.defs[0]]
                    self.defs.pop(o.defs[0], None)
                    gone.update(o.at)
            blocks[b] = Block(b, blk.start, blk.phis, tuple(ops), blk.term)
        fn = _with(self.fn, types=self.types, blocks=tuple(blocks[k] for k in range(len(blocks))))
        return record(substitute(fn, self.sub, set()), gone, "folded")


def simplify(fn: Fn, _abi: Abi) -> Fn:
    return drop_dead(simplify_phis(_Simplifier(fn).go()), "dead")


# ---------------------------------------------------------------------------------------- merge

def merge(fn: Fn, _abi: Abi) -> Fn:
    """One operation for equal pure operations (and loads of one state of memory) where the first dominates the second; equal phis of a block."""
    idom = graph.immediate_dominators(fn.succ, 0)
    children: dict[int, list[int]] = {}
    for b, d in enumerate(idom):
        if b and d is not None:
            children.setdefault(d, []).append(b)
    sub: dict[int, Arg] = {}
    extra: dict[int, set[int]] = {}
    removed: set[int] = set()

    def arg(a: Arg) -> Arg:
        while isinstance(a, int) and a in sub:
            a = sub[a]
        return a

    # one scope per block on the way down the dominator tree
    stack: list[tuple[int, dict]] = [(0, {})]
    while stack:
        b, outer = stack.pop()
        table = dict(outer)
        seen: dict = {}
        for p in fn.blocks[b].phis:
            key = (p.region, tuple((k, arg(a)) for k, a in p.args))
            if key in seen and p.id not in {a for _k, a in p.args}:
                sub[p.id] = seen[key]
            else:
                seen.setdefault(key, p.id)
        for o in fn.blocks[b].ops:
            if o.kind == "undef" or not (o.pure or o.kind == "load" and not o.attr("atomic")):
                continue
            key = (o.kind, tuple(map(arg, o.args)), o.attrs, tuple((m.region, arg(m.before)) for m in o.mem), fn.types[o.defs[0]])
            first = table.get(key)
            if first is None:
                table[key] = o.defs[0]
            else:
                sub[o.defs[0]] = first
                removed.add(o.defs[0])
                extra.setdefault(first, set()).update(o.at)
        stack.extend((c, table) for c in reversed(children.get(b, [])))
    if not sub:
        return fn
    blocks = tuple(Block(b.id, b.start, b.phis, tuple(
        Op(o.kind, o.defs, o.args, o.attrs, o.mem, tuple(sorted({*o.at, *extra[o.defs[0]]}))) if o.defs and o.defs[0] in extra and o.kind != "call" and o.kind != FRAME else o
        for o in b.ops if not (o.defs and o.defs[0] in removed)), b.term) for b in fn.blocks)
    gone = {a for s in extra.values() for a in s}
    phis = {v for v in sub if v not in removed}
    fn = substitute(_with(fn, blocks=blocks, types={v: x for v, x in fn.types.items() if v not in removed}), sub, phis)
    return simplify_phis(record(fn, gone, "merged"))


# ---------------------------------------------------------------------------------------- private memory

def _region_uses(fn: Fn) -> dict[str, list[tuple[Op | Term, bool]]]:
    out: dict[str, list[tuple[Op | Term, bool]]] = {r.name: [] for r in fn.regions}
    for b in fn.blocks:
        for o in (*b.ops, b.term):
            for m in o.mem:
                out[m.region].append((o, m.after is not None))
    return out


def promote(fn: Fn, abi: Abi) -> Fn:
    """A private region every access of which covers it exactly, and that no call or exit touches, becomes values."""
    d = fn.defining()
    params = {v: n for n, v in fn.params}
    look = {v: o for v, (_b, o) in d.items()}
    uses = _region_uses(fn)
    types = dict(fn.types)
    top = max(types, default=-1) + 1
    sub: dict[int, Arg] = {}
    new_phis: dict[int, list[Phi]] = {}
    gone: dict[int, str] = {}
    dead_regions: set[str] = set()
    removed: set[int] = set()  # ids of operations
    for r in fn.regions:
        if not r.private:
            continue
        ops = [o for o, _c in uses[r.name]]
        size = r.hi - r.lo
        if not ops or any(not isinstance(o, Op) or o.kind not in ("load", "store") or o.attr("atomic") for o in ops):
            continue
        ext = [mm.access_extents(o, look.get, params, fn.width)[0][0] for o in ops]  # type: ignore[arg-type]
        if any(e.place != ("frame", r.lo) or e.size != size for e in ext):
            continue
        # what each token stands for, asked for from the loads
        value: dict[int, Arg] = {}
        phis: dict[int, Phi] = {}
        ok = True
        work = [m.before for o in ops if o.kind == "load" for m in o.mem]
        while work and ok:
            tk = work.pop()
            if tk in value:
                continue
            src = look[tk]
            if src is None:
                ok = False  # what was in the slot before the function wrote it
            elif isinstance(src, Phi):
                value[tk] = top
                types[top] = 8 * size
                top += 1
                phis[tk] = src
                work += [a for _k, a in src.args]  # type: ignore[misc]
            else:
                value[tk] = src.args[1]
        if not ok:
            for tk in phis:
                del types[value[tk]]  # type: ignore[arg-type]
            continue
        for tk, p in phis.items():
            new_phis.setdefault(d[tk][0], []).append(Phi(value[tk], tuple((k, value[a]) for k, a in p.args)))  # type: ignore[arg-type,index]
        for o in ops:
            assert isinstance(o, Op)
            removed.add(id(o))
            if o.kind == "load":
                sub[o.defs[0]] = value[o.mem[0].before]
                del types[o.defs[0]]
            for a in o.at:
                gone[a] = ("save" if o.kind == "store" else "restore") if r.keeps else "folded"
        dead_regions.add(r.name)
    if not dead_regions:
        return fn
    blocks = tuple(Block(b.id, b.start, (*b.phis, *new_phis.get(b.id, ())), tuple(o for o in b.ops if id(o) not in removed), b.term) for b in fn.blocks)
    fn = substitute(_with(fn, blocks=blocks, types=types), sub, set())
    for why in ("save", "restore", "folded"):
        fn = record(fn, {a for a, w in gone.items() if w == why}, why)
    regions = [r for r in fn.regions if r.name not in dead_regions]
    return drop_dead(simplify_phis(thread_with(_drop_tokens(fn), regions, abi, fn.assumptions)), "dead")


def _drop_tokens(fn: Fn) -> Fn:
    """Without memory operands; `thread_with` makes them anew."""
    types = {v: t for v, t in fn.types.items() if not isinstance(t, str)}
    blocks = tuple(Block(b.id, b.start, tuple(p for p in b.phis if p.region is None), tuple(Op(o.kind, o.defs, o.args, o.attrs, (), o.at) for o in b.ops),
                         Term(b.term.kind, b.term.args, b.term.targets, b.term.attrs, (), b.term.at)) for b in fn.blocks)
    return _with(fn, blocks=blocks, types=types, tokens=())


def dead_stores(fn: Fn, abi: Abi) -> Fn:
    """Stores into a private region that nothing ever reads."""
    uses = _region_uses(fn)
    dead: set[str] = set()
    for r in fn.regions:
        if r.private and uses[r.name] and all(isinstance(o, Op) and changes and o.kind in ("store", "call") for o, changes in uses[r.name]):
            if any(o.kind == "store" for o, _c in uses[r.name]):
                dead.add(r.name)
    if not dead:
        return fn
    gone: dict[int, str] = {}
    blocks = []
    for b in fn.blocks:
        ops = []
        for o in b.ops:
            if o.kind == "store" and o.attr("region") in dead and not o.attr("atomic"):
                for a in o.at:
                    gone[a] = "save" if fn.region(str(o.attr("region"))).keeps else "dead"
            else:
                ops.append(o)
        blocks.append(Block(b.id, b.start, b.phis, tuple(ops), b.term))
    fn = _with(fn, blocks=tuple(blocks))
    for why in ("save", "dead"):
        fn = record(fn, {a for a, w in gone.items() if w == why}, why)
    regions = [r for r in fn.regions if r.name not in dead]
    return drop_dead(simplify_phis(thread_with(_drop_tokens(fn), regions, abi, fn.assumptions)), "dead")


def forward(fn: Fn, _abi: Abi) -> Fn:
    """A load that reads exactly what a store into the same region wrote, with nothing in between, is the stored value."""
    d = fn.defining()
    look = {v: o for v, (_b, o) in d.items()}
    params = {v: n for n, v in fn.params}
    sub: dict[int, Arg] = {}
    gone: set[int] = set()
    for _b, o in fn.ops():
        if o.kind != "load" or o.attr("atomic"):
            continue
        src = look[o.mem[0].before]
        if not isinstance(src, Op) or src.kind != "store" or src.attr("atomic") or fn.width(src.args[1]) != fn.width(o.defs[0]):
            continue
        a = mm.access_extents(o, look.get, params, fn.width)[0][0]
        s = mm.access_extents(src, look.get, params, fn.width)[0][0]
        if o.args[0] == src.args[0] or a.place is not None and a.place == s.place:
            sub[o.defs[0]] = src.args[1]
            gone.update(o.at)
    if not sub:
        return fn
    blocks = tuple(Block(b.id, b.start, b.phis, tuple(o for o in b.ops if not (o.defs and o.defs[0] in sub)), b.term) for b in fn.blocks)
    fn = substitute(_with(fn, blocks=blocks, types={v: t for v, t in fn.types.items() if v not in sub}), sub, set())
    return drop_dead(record(fn, gone, "folded"), "dead")


# ---------------------------------------------------------------------------------------- control

def polarity(fn: Fn, _abi: Abi) -> Fn:
    """A branch on `not c` becomes a branch on `c` the other way round, which is recorded."""
    d = {v: o for v, (_b, o) in fn.defining().items()}
    blocks = []
    obs = set(fn.observations)
    for b in fn.blocks:
        t = b.term
        a = t.args[0] if t.kind == "branch" else None
        o = d.get(a) if isinstance(a, int) else None
        if isinstance(o, Op) and o.kind == "not":
            obs.update(Observation(x, "polarity") for x in t.at)
            t = Term("branch", o.args, t.targets[::-1], t.attrs, t.mem, tuple(sorted({*t.at, *o.at})))
        blocks.append(Block(b.id, b.start, b.phis, b.ops, t))
    return drop_dead(_with(fn, blocks=tuple(blocks), observations=tuple(sorted(obs))), "dead")


def straighten(fn: Fn, _abi: Abi) -> Fn:
    """A block whose only way in is another's only way out becomes part of it."""
    preds = fn.preds()
    into: dict[int, int] = {}
    for b in fn.blocks:
        if b.term.kind == "goto" and b.id != 0:
            t = b.term.targets[0]
            if preds[t] == [b.id] and t != b.id:
                into[t] = b.id
    if not into:
        return fn
    sub: dict[int, Arg] = {}
    for t in into:
        for p in fn.blocks[t].phis:
            sub[p.id] = p.args[0][1]
    heads = [b.id for b in fn.blocks if b.id not in into]
    follow = {p: t for t, p in into.items()}
    number = {h: k for k, h in enumerate(heads)}
    tail: dict[int, int] = {}   # the last block of a chain -> its head
    blocks, gone = [], set()
    for h in heads:
        chain = [h]
        while chain[-1] in follow:
            chain.append(follow[chain[-1]])
        tail[chain[-1]] = h
        for c in chain[:-1]:
            gone.update(fn.blocks[c].term.at)
        last = fn.blocks[chain[-1]].term
        cases = last.attr("cases")
        attrs = tuple((k, tuple((a, number[x]) for a, x in cases) if k == "cases" else v) for k, v in last.attrs)  # type: ignore[union-attr]
        blocks.append(Block(number[h], fn.blocks[h].start, fn.blocks[h].phis, tuple(o for c in chain for o in fn.blocks[c].ops),
                            Term(last.kind, last.args, tuple(number[x] for x in last.targets), attrs, last.mem, last.at)))
    blocks = [Block(b.id, b.start, tuple(Phi(p.id, tuple(sorted((number[tail[k]], a) for k, a in p.args)), p.region) for p in b.phis), b.ops, b.term) for b in blocks]
    phis = set(sub)
    return record(substitute(_with(fn, blocks=tuple(blocks)), sub, phis), gone, "jump")


# ---------------------------------------------------------------------------------------- the list

_PURE = "the value of every observable effect, its order, every exit and its values stay the same for every input"
PASSES: dict[str, Pass] = {p.name: p for p in (
    Pass("simplify", "valid IR", f"each rewrite is an instance of a proved rule or the constant value of an operation; {_PURE}", simplify),
    Pass("merge", "valid IR", f"a removed operation equals one that dominates it and reads the same memory state; {_PURE}", merge),
    Pass("forward", "valid IR; the regions are disjoint as they claim", f"a removed load reads exactly what the store that made its token wrote; {_PURE}", forward),
    Pass("promote", "valid IR; a promoted region is private, accessed only whole and only by plain loads and stores, and never read before it is written",
         f"each load has the value its token stands for; {_PURE}", promote),
    Pass("dead-stores", "valid IR; the region is private and nothing reads it", f"only bytes of the frame that nothing reads change; {_PURE}", dead_stores),
    Pass("dead", "valid IR", f"only pure operations, and loads of private regions, whose values nothing uses go; {_PURE}", lambda f, _a: drop_dead(simplify_phis(f), "dead")),
    Pass("polarity", "valid IR", f"the branch takes the same way for every input; {_PURE}", polarity),
    Pass("straighten", "valid IR", f"blocks on one way are joined in order; {_PURE}", straighten),
)}

#: the order normalisation runs them in, until nothing changes
NORMAL = ("simplify", "merge", "forward", "promote", "dead-stores", "dead")


class Unsettled(RuntimeError):
    """Normalisation did not reach a fixed point: a defect, never an input."""


def normalise(fn: Fn, abi: Abi, check: bool = True) -> Fn:
    """The IR after the transformations above. With `check`, the validator runs before the first and after each that changed anything."""
    if check:
        found = validate.problems(fn, abi)
        if found:
            raise validate.InvalidIr([f"before normalisation: {x}" for x in found])

    def one(name: str, f: Fn) -> Fn:
        return _run(PASSES[name], f, abi) if check else _with(settle_memory(PASSES[name].run(f, abi), abi), history=(*f.history, name))

    def content(f: Fn) -> tuple:
        return (f.blocks, f.regions, f.observations)

    for _ in range(24):
        before = content(fn)
        for name in NORMAL:
            fn = one(name, fn)
        if content(fn) == before:
            break
    else:
        raise Unsettled
    for name in ("polarity", "straighten"):
        fn = one(name, fn)
    return fn


__all__ = ["NORMAL", "OPS", "PASSES", "Pass", "apply", "normalise"]
