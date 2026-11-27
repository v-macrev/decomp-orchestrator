# SPDX-License-Identifier: AGPL-3.0-or-later
"""The function as its source saw it: arguments by position, calls with the arguments the callee takes, one result.

The outcome is again an `Fn`, but no longer one the machine-level validator knows: parameters are named `a0, a1, ...`,
a call has the target and its arguments, a return has the result or nothing, and a tail exit is a call and a return.
Values nobody needs at their full width are computed at the width that is needed.
"""
from __future__ import annotations

from dataclasses import replace

from recon.core.analysis import graph
from recon.core.inference.signature import FLOAT, INT, CalleeOf, Convention, NotReconstructed, Signature, Slot
from recon.core.ir import memory as mem
from recon.core.ir import passes
from recon.core.ir.build import drop_dead, simplify_phis, substitute
from recon.core.ir.model import FRAME, Arg, Block, Const, Fn, Op, Phi, Term

#: operations whose low bits depend on the same low bits of their operands only
LOW = frozenset({"add", "sub", "mul", "neg", "not", "and", "or", "xor"})
ROUND = 40


class _Edit:
    """A function being rewritten: fresh values, and blocks as lists."""

    def __init__(self, fn: Fn) -> None:
        self.fn = fn
        self.types = dict(fn.types)
        self.top = max(self.types, default=-1) + 1

    def fresh(self, w: int) -> int:
        self.types[self.top] = w
        self.top += 1
        return self.top - 1

    def width(self, a: Arg) -> int:
        return a.width if isinstance(a, Const) else self.types[a]  # type: ignore[return-value]

    def low(self, a: Arg, w: int, ops: list[Op], at: tuple[int, ...] = ()) -> Arg:
        """The low `w` bits of a value, computed at the end of `ops`."""
        if self.width(a) == w:
            return a
        if isinstance(a, Const):
            return Const(a.value & (1 << w) - 1, w)
        v = self.fresh(w)
        ops.append(Op("trunc", (v,), (a,), (), (), at))
        return v


def lanes(fn: Fn) -> Fn:
    """The low part of a pair is (the low part of) its low half."""
    d = {o.defs[0]: o for _b, o in fn.ops() if o.kind == "cat"}

    def one(o: Op) -> Op:
        if o.kind == "trunc" and isinstance(o.args[0], int) and o.args[0] in d:
            low = d[o.args[0]].args[1]
            if fn.width(low) >= fn.width(o.defs[0]):
                return replace(o, args=(low,))
        return o
    ops = [(b, tuple(map(one, b.ops))) for b in fn.blocks]
    same = {o.defs[0]: o.args[0] for _b, os in ops for o in os if o.kind == "trunc" and fn.width(o.args[0]) == fn.width(o.defs[0])}
    return substitute(replace(fn, blocks=tuple(replace(b, ops=tuple(o for o in os if not (o.defs and o.defs[0] in same))) for b, os in ops)), same, set())


def _tidy(fn: Fn, abi) -> Fn:
    for _ in range(ROUND):
        before = fn.blocks
        fn = passes.merge(passes.simplify(lanes(fn), abi), abi)
        fn = drop_dead(simplify_phis(fn), "dead")
        if fn.blocks == before:
            return fn
    raise NotReconstructed("LOWERING_UNSETTLED")


def _cleaned(fn: Fn) -> Fn:
    """Loads nothing uses go too: what is left is what the source computes."""
    used = {a for b in fn.blocks for o in (*b.ops, b.term) for a in o.args if isinstance(a, int)} | {a for b in fn.blocks for p in b.phis for _k, a in p.args if isinstance(a, int)}
    blocks = tuple(replace(b, ops=tuple(o for o in b.ops if not (o.kind == "load" and o.defs[0] not in used and not o.attr("atomic")))) for b in fn.blocks)
    return drop_dead(replace(fn, blocks=blocks), "dead") if blocks != fn.blocks else fn


# ---------------------------------------------------------------------------------------- exits and calls

def expose(fn: Fn, conv: Convention, callee: CalleeOf, result: Slot | None) -> Fn:
    """Calls and exits with what the signatures say, entry values that are no arguments as undefined."""
    e = _Edit(fn)
    params = {v: n for n, v in fn.params}
    given = {n for pair in conv.slots for n in pair}
    preserved = {n for b in fn.blocks if b.term.kind in ("return", "tail") for n in b.term.attr("preserved")}  # type: ignore[union-attr]
    blocks: list[Block] = []
    start: list[Op] = [Op("undef", (v,)) for n, v in fn.params if n not in given]

    def signature(target: Arg) -> Signature:
        s = callee(target)
        if s is None:
            raise NotReconstructed("CALLEE_SIGNATURE_UNKNOWN" if isinstance(target, Const) else "INDIRECT_CALL")
        return s

    def arguments(s: Signature, names, args, ops: list[Op], at) -> list[Arg]:
        have = dict(zip(names, args))
        out = []
        for k, p in enumerate(s.params):
            if k >= len(conv.slots):
                raise NotReconstructed("STACK_ARGUMENTS")
            out.append(e.low(have[conv.place(k, p.kind)], p.width, ops, at))
        return out

    for b in fn.blocks:
        ops: list[Op] = list(start) if b.id == 0 else []
        for o in b.ops:
            if o.kind == FRAME:
                ops.append(o)
                continue
            if o.kind != "call":
                ops.append(o)
                continue
            s = signature(o.args[0])
            args = arguments(s, o.attr("args"), o.args[1:], ops, o.at)
            back: dict[str, int] = dict(zip(o.attr("defs") or (), o.defs))  # type: ignore[call-overload]
            defs: tuple[int, ...] = ()
            after: list[Op] = []
            if s.result is not None:
                n = conv.result(s.result.kind)
                r = e.fresh(s.result.width)
                defs = (r,)
                if n in back:
                    w = e.types[back[n]]
                    assert isinstance(w, int)
                    if w == s.result.width:
                        after.append(Op("trunc", (back[n],), (r,), (), (), o.at))
                    else:
                        high = e.fresh(w - s.result.width)  # what the callee leaves above its result
                        after.append(Op("undef", (high,), (), (), (), o.at))
                        after.append(Op("cat", (back[n],), (high, r), (), (), o.at))
                    del back[n]
            after += [Op("undef", (v,), (), (), (), o.at) for _n, v in sorted(back.items())]
            ops.append(Op("call", defs, (o.args[0], *args), tuple(x for x in o.attrs if x[0] in ("state",)), o.mem, o.at))
            ops += after
        t = b.term
        if t.kind in ("return", "tail"):
            for n, a in zip((*(t.attr("results") if t.kind == "return" else t.attr("args")), *t.attr("preserved")), t.args[0 if t.kind == "return" else 1:]):  # type: ignore[misc]
                if n in preserved and params.get(a) != n:  # type: ignore[arg-type]
                    raise NotReconstructed("PRESERVED_LOCATION_CHANGED")
            if t.kind == "return":
                value = [] if result is None else [e.low(dict(zip(t.attr("results"), t.args))[conv.result(result.kind)], result.width, ops, t.at)]  # type: ignore[call-overload]
            else:
                s = signature(t.args[0])
                args = arguments(s, t.attr("args"), t.args[1:], ops, t.at)
                value = []
                defs = ()
                if result is not None:
                    if s.result is None or s.result.kind != result.kind or s.result.width < result.width:
                        raise NotReconstructed("TAIL_RESULT_DIFFERS")
                if s.result is not None:
                    r = e.fresh(s.result.width)
                    defs = (r,)
                    if result is not None:
                        value = [r]
                ops.append(Op("call", defs, (t.args[0], *args), (("tail", True),), t.mem, t.at))
                if value:
                    value = [e.low(value[0], result.width, ops, t.at)]  # type: ignore[union-attr]
            t = Term("return", tuple(value), (), (), (), t.at)
        blocks.append(Block(b.id, b.start, b.phis, tuple(ops), t))
    return replace(fn, blocks=tuple(blocks), types=e.types, params=tuple((n, v) for n, v in fn.params if n in given))


# ---------------------------------------------------------------------------------------- widths

def _demand(fn: Fn) -> dict[int, int]:
    """How many low bits of each value are needed."""
    need: dict[int, int] = {}
    d = {v: o for v, (_b, o) in fn.defining().items()}
    work: list[tuple[Arg, int]] = []

    def ask(a: Arg, w: int) -> None:
        if isinstance(a, int) and w > need.get(a, 0):
            need[a] = w
            work.append((a, w))

    for b in fn.blocks:
        for o in b.ops:
            if not o.pure:
                for a in o.args:
                    ask(a, fn.width(a))
        for a in b.term.args:
            ask(a, fn.width(a))
    while work:
        v, w = work.pop()
        assert isinstance(v, int)
        if w < need[v]:
            continue
        o = d[v]
        if isinstance(o, Phi):
            for _k, a in o.args:
                ask(a, w)
        elif isinstance(o, Op) and o.pure and o.kind != FRAME:
            if o.kind in LOW:
                for k, a in enumerate(o.args):
                    n = w
                    if o.kind == "and" and isinstance(o.args[1 - k], Const):
                        n = min(w, (o.args[1 - k].value & (1 << w) - 1).bit_length())  # type: ignore[union-attr]
                    ask(a, n)
            elif o.kind == "ite":
                ask(o.args[0], 1)
                ask(o.args[1], w)
                ask(o.args[2], w)
            elif o.kind == "trunc":
                ask(o.args[0], w)
            elif o.kind == "zext" or o.kind == "sext" and w <= fn.width(o.args[0]):
                ask(o.args[0], min(w, fn.width(o.args[0])))
            elif o.kind == "cat":
                low = fn.width(o.args[1])
                ask(o.args[1], min(w, low))
                ask(o.args[0], max(0, w - low))
            elif o.kind == "shl" and isinstance(o.args[1], Const):
                ask(o.args[0], max(0, w - o.args[1].value))
            elif o.kind == "lshr" and isinstance(o.args[1], Const):
                ask(o.args[0], min(fn.width(o.args[0]), w + o.args[1].value))
            else:
                for a in o.args:
                    ask(a, fn.width(a))
    return need


def narrow(fn: Fn) -> Fn:
    """Values of which fewer bits are needed are computed with fewer; operands none of whose bits are needed become zero."""
    need = _demand(fn)
    e = _Edit(fn)
    small: dict[int, int] = {}       # value -> its narrow stand-in
    target: dict[int, int] = {}
    for b in fn.blocks:
        for x in (*b.phis, *b.ops):
            if isinstance(x, Phi):
                if x.region is not None:
                    continue
                v = x.id
            else:
                if not x.pure or x.kind not in LOW and x.kind != "ite" and not (x.kind == "shl" and isinstance(x.args[1], Const)):
                    continue
                v = x.defs[0]
            w, n = fn.width(v), need.get(v, 0)
            to = next((s for s in (8, 16, 32, 64) if n <= s), w)
            if w > 32 and 0 < n and to < w:
                target[v] = to
    if not target and not any(n == 0 for n in (need.get(a, 0) for b in fn.blocks for o in b.ops if o.pure for a in o.args if isinstance(a, int))):
        return fn
    for v, w in target.items():
        small[v] = e.fresh(w)
    ends: dict[int, list[Op]] = {b.id: [] for b in fn.blocks}

    def zero(a: Arg) -> Arg:
        return Const(0, e.width(a)) if isinstance(a, int) and a in fn.types and need.get(a, 0) == 0 else a

    body: dict[int, tuple[list[Phi], list[Op]]] = {}
    for b in fn.blocks:
        phis: list[Phi] = []
        ops: list[Op] = []
        for p in b.phis:
            if p.region is not None:
                phis.append(p)
            elif p.id in target:
                w = target[p.id]
                phis.append(Phi(small[p.id], tuple((k, e.low(zero(a), w, ends[k])) for k, a in p.args)))
                ops.append(Op("zext", (p.id,), (small[p.id],)))
            else:
                phis.append(Phi(p.id, tuple((k, zero(a)) for k, a in p.args)))
        for o in b.ops:
            if o.pure and o.kind != FRAME and o.defs[0] in target:
                w = target[o.defs[0]]
                keep = {"ite": (0,), "shl": (1,)}.get(o.kind, ())
                args = tuple(zero(a) if k in keep else e.low(zero(a), w, ops, o.at) for k, a in enumerate(o.args))
                ops.append(Op(o.kind, (small[o.defs[0]],), args, (), (), o.at))
                ops.append(Op("zext", o.defs, (small[o.defs[0]],), (), (), o.at))
            else:
                ops.append(Op(o.kind, o.defs, tuple(map(zero, o.args)), o.attrs, o.mem, o.at) if o.pure else o)
        body[b.id] = (phis, ops)
    blocks = tuple(Block(b.id, b.start, tuple(body[b.id][0]), tuple(body[b.id][1] + ends[b.id]), b.term) for b in fn.blocks)
    return replace(fn, blocks=blocks, types=e.types)


def parameters(fn: Fn, conv: Convention) -> tuple[Fn, tuple[Slot, ...]]:
    """Parameters by position, as wide as they are needed. A position nothing uses, before one that is used, is an integer."""
    need = _demand(fn)
    place = {n: (k, kind) for k, pair in enumerate(conv.slots) for n, kind in zip(pair, (INT, FLOAT))}
    used: dict[int, tuple[str, int, int]] = {}
    e = _Edit(fn)
    for n, v in fn.params:
        if not need.get(v):
            continue
        k, kind = place[n]
        if k in used:
            raise NotReconstructed("PARAMETER_IN_TWO_LOCATIONS")
        w = next((s for s in ((32, 64) if kind == FLOAT else (8, 16, 32, 64)) if need[v] <= s), 0)
        if not w:
            raise NotReconstructed("VECTOR_PARAMETER")
        used[k] = (kind, v, w)
    slots: list[Slot] = []
    new: list[tuple[str, int]] = []
    start: list[Op] = []
    dropped = {v for n, v in fn.params}
    same: dict[int, Arg] = {}
    for k in range(max(used, default=-1) + 1):
        if k not in used:
            slots.append(Slot(INT, 64))
            continue
        kind, v, w = used[k]
        dropped.discard(v)
        slots.append(Slot(kind, w))
        p = e.fresh(w)
        new.append((f"a{k}", p))
        if w < e.width(v):
            start.append(Op("zext", (v,), (p,)))
        else:
            same[v] = p
    start += [Op("undef", (v,)) for v in sorted(dropped)]
    b0 = fn.blocks[0]
    fn = replace(fn, params=tuple(new), types=e.types, blocks=(replace(b0, ops=(*start, *b0.ops)), *fn.blocks[1:]))
    return substitute(fn, same, set()), tuple(slots)


def _environment(fn: Fn, conv: Convention, abi) -> set[int]:
    """Entry values of locations that are no argument, no result, not given back and not changed by calls: the machine's
    environment (the thread block's base, the direction flag), read and never set by any function."""
    given = {n for pair in conv.slots for n in pair}
    other = given | abi.arguments | abi.clobbered | abi.preserved | abi.results | {abi.stack}
    return {v for n, v in fn.params if n not in other}


def _spilled(fn: Fn, conv: Convention, abi, d: dict, params: dict) -> set[int]:
    """The positions whose entry value the function stores to the position's own home slot."""
    out: set[int] = set()
    names = {n: v for n, v in fn.params}
    for _b, o in fn.ops():
        if o.kind != "store" or len(o.args) < 2:
            continue
        at = mem.resolve(o.args[0], d.get, params)
        if at is None or at[0] != "frame" or (at[1] - abi.word) % abi.word:
            continue
        k = (at[1] - abi.word) // abi.word
        v = o.args[1]
        while isinstance(v, int) and isinstance(d.get(v), Op) and d[v].kind in ("zext", "sext", "trunc"):
            v = d[v].args[0]
        if 0 <= k < len(conv.slots) and v == names.get(f"a{k}"):
            out.add(k)
    return out


def _frame_for_signature(fn: Fn, conv: Convention, abi) -> None:
    """What a frame left in memory may still say about the parameters (D-070, D-071): a read at or above the first stack
    argument is an argument there (STACK_ARGUMENTS). The address of a home slot leaving the function's own reads and writes
    is how a variable argument list is walked (VARIADIC) when every position from that slot on has its entry value spilled to
    its own home slot, as `va_start` needs; any other home slot whose address leaves is a local the compiler placed there.
    Locals in memory change no parameter."""
    first = abi.word + abi.home
    d = {v: o for v, (_b, o) in fn.defining().items()}
    params = {v: n for n, v in fn.params}
    home: set[int] = set()
    for _b, o in fn.ops():
        if o.kind == FRAME:
            off = int(o.attr("off"))  # type: ignore[call-overload]
            if off >= first:
                raise NotReconstructed("STACK_ARGUMENTS")
            if off >= abi.word:
                home.add(o.defs[0])
        elif o.kind in ("load", "store") and o.args:
            at = mem.resolve(o.args[0], d.get, params)
            if at is not None and at[0] == "frame" and at[1] >= first:
                raise NotReconstructed("STACK_ARGUMENTS")
    spilled: set[int] | None = None
    work = list(home)
    while work:      # values computed from a home-space address by a fixed offset are home-space addresses too
        v = work.pop()
        for b in fn.blocks:
            for x in (*b.phis, *b.ops, b.term):
                args = [a for _k, a in x.args] if isinstance(x, Phi) else list(x.args)
                if v not in args:
                    continue
                if isinstance(x, Op) and x.kind in ("load", "store") and x.args[0] == v and v not in args[1:]:
                    continue
                if isinstance(x, Op) and (x.kind == "add" and any(isinstance(a, Const) for a in x.args) or x.kind == "sub" and isinstance(x.args[1], Const) and x.args[0] == v):
                    if x.defs[0] not in home:
                        home.add(x.defs[0])
                        work.append(x.defs[0])
                    continue
                at = mem.resolve(v, d.get, params)
                if at is None or at[0] != "frame":
                    raise NotReconstructed("VARIADIC")
                if spilled is None:
                    spilled = _spilled(fn, conv, abi, d, params)
                k = max(0, -(-(at[1] - abi.word) // abi.word))
                if all(j in spilled for j in range(k, len(conv.slots))):
                    raise NotReconstructed("VARIADIC")


def lower(fn: Fn, conv: Convention, abi, callee: CalleeOf, result: Slot | None,
          signature_only: bool = False) -> tuple[Fn, tuple[Slot, ...]]:
    """(the function at source level, its parameters), or NotReconstructed. With `signature_only`, only the parameters are
    wanted (D-070): what the source would still have to spell (a local in memory, a read of the machine's environment, a
    value wider than a register inside the body) does not stop them, while anything that leaves them unsure does."""
    env = _environment(fn, conv, abi) if signature_only else set()
    fn = _tidy(expose(fn, conv, callee, result), abi)
    for _ in range(ROUND):
        before = fn.blocks
        fn = _tidy(_cleaned(narrow(fn)), abi)
        if fn.blocks == before:
            break
    fn, slots = parameters(fn, conv)
    for _ in range(ROUND):
        before = fn.blocks
        fn = _tidy(_cleaned(narrow(fn)), abi)
        if fn.blocks == before:
            break
    if any(o.kind == "undef" and not (o.defs[0] in env) for _b, o in fn.ops()):
        raise NotReconstructed("READS_A_LOCATION_NOBODY_SET")
    if signature_only:
        _frame_for_signature(fn, conv, abi)
        return fn, slots
    if any(o.kind == FRAME for _b, o in fn.ops()):
        raise NotReconstructed("LOCAL_IN_MEMORY")
    reach = set(graph.reverse_postorder(fn.succ, 0))
    if any(isinstance(fn.types[v], int) and fn.width(v) > 64 for b in fn.blocks if b.id in reach for x in (*b.phis, *b.ops) for v in ((x.id,) if isinstance(x, Phi) else x.defs) if isinstance(fn.types.get(v), int)):
        raise NotReconstructed("VECTOR_VALUE")
    return fn, slots


__all__ = ["expose", "lower", "narrow", "parameters"]
