# SPDX-License-Identifier: AGPL-3.0-or-later
"""From the lifted instructions of one function, its graph, data flow and frame, to the IR.

Registers become SSA values first, then memory is cut into regions and threaded with tokens. The stack pointer never
becomes a value: the frame analysis proved its height at every instruction, so reading it gives an address of the
frame. What a call reads and changes comes from the calling convention. Anything that cannot be represented is a
`BuildRefusal` with a fixed reason.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

from recon.core import sem
from recon.core.analysis import cfg as cf
from recon.core.analysis import graph
from recon.core.analysis.dataflow import Abi, Flow
from recon.core.analysis.frame import Frame
from recon.core.ir import memory as mm
from recon.core.ir.model import EFFECTS, FRAME, FRAME_REGION, OTHER, Arg, Block, Const, Fn, Mem, Observation, Op, Phi, Region, Term

#: the part of memory a callee or the caller's caller owns, by name of the assumption a result rests on
ARRIVAL = "stack-pointer-aligned-on-entry"
#: rounding to nearest, subnormals kept, exceptions masked (see softfloat)
FLOATING = "floating-point-control-is-default"


@dataclass(frozen=True)
class Unwinding:
    """What an exception does in a function that only cleans up after one."""

    states: tuple[tuple[int, int], ...]
    at: tuple[tuple[int, int], ...]        # (where a call returns to, the state there)
    help: int | None                       # the runtime's own place in the frame
    noexcept: bool = False


HELP_VALUE = (1 << 64) - 2


class BuildRefusal(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class _Op:
    kind: str
    defs: list[int]
    args: list[Arg]
    attrs: dict[str, object]
    at: tuple[int, ...]
    #: call: location -> the value it leaves there, made when first read
    left: dict[str, int] = field(default_factory=dict)
    sp: int = 0


@dataclass
class _Block:
    ops: list[_Op] = field(default_factory=list)
    phis: list[tuple[int, str, dict[int, Arg]]] = field(default_factory=list)
    term: tuple[str, list[Arg], list[int], dict[str, object], tuple[int, ...]] | None = None
    sp: int = 0


class _Left:
    """The value a call leaves in a location, until something reads it."""

    __slots__ = ("op", "loc")

    def __init__(self, op: _Op, loc: str) -> None:
        self.op, self.loc = op, loc


_DEAD = object()


class _Builder:
    def __init__(self, g: cf.Cfg, flow: Flow, frame: Frame, abi: Abi, widths: dict[str, int], base: int, rva: int, eh: Unwinding | None = None) -> None:
        self.eh = eh
        self.states = dict(eh.at) if eh is not None else {}
        self.g, self.flow, self.frame, self.abi, self.widths, self.base, self.rva = g, flow, frame, abi, widths, base, rva
        self.types: dict[int, int | str] = {}
        self.params: dict[str, int] = {}
        self.frames: dict[int, int] = {}
        self.frame_of: dict[int, int] = {}
        self.blocks: list[_Block] = []
        self.obs: set[Observation] = set()
        self.insns: list[int] = []
        self.assumed: set[str] = set(frame.assumptions)
        self.order = [b for b in graph.reverse_postorder(g.succ, g.entry)]
        self.number = {b: n + 1 for n, b in enumerate(self.order)}  # block 0 is the entry

    def value(self, t: int | str) -> int:
        v = len(self.types)
        self.types[v] = t
        return v

    def param(self, loc: str) -> int:
        v = self.params.get(loc)
        if v is None:
            v = self.params[loc] = self.value(self.widths[loc])
        return v

    def frame_address(self, off: int) -> int:
        v = self.frames.get(off)
        if v is None:
            v = self.frames[off] = self.value(8 * self.abi.word)
            self.frame_of[v] = off
        return v

    # -- one block ------------------------------------------------------------------------------
    def read(self, state: dict, loc: str) -> Arg:
        v = state.get(loc)
        if v is None:
            v = state[loc] = self.param(loc)
        elif v is _DEAD:
            raise BuildRefusal("reads-a-location-that-was-not-live")  # a defect of the liveness, not of the function
        elif isinstance(v, _Left):
            x = v.op.left.get(v.loc)
            if x is None:
                x = v.op.left[v.loc] = self.value(self.widths[v.loc])
            v = state[loc] = x
        return v

    def let(self, s: sem.Let, args: list[Arg], blk: _Block, at: int) -> Arg:
        if s.op in ("add", "sub"):
            x, y = args
            if isinstance(x, int) and x in self.frame_of and isinstance(y, Const):
                return self.frame_address(self.frame_of[x] + (1 if s.op == "add" else -1) * mm.signed64(y.value))
            if s.op == "add" and isinstance(y, int) and y in self.frame_of and isinstance(x, Const):
                return self.frame_address(self.frame_of[y] + mm.signed64(x.value))
        elif s.op == "trunc" and isinstance(args[0], int) and args[0] in self.frame_of and 1 << s.dst.width <= self.abi.align[0]:
            self.assumed.add(ARRIVAL)
            return Const((self.frame_of[args[0]] + self.abi.align[1]) & ((1 << s.dst.width) - 1), s.dst.width)
        v = self.value(s.dst.width)
        blk.ops.append(_Op(s.op, [v], args, {}, (at,)))
        return v

    def instruction(self, i: sem.Lifted, blk: _Block, state: dict) -> None:
        env: dict[int, Arg] = {}
        abi = self.abi
        height = self.frame.heights[i.rva]
        state[abi.stack] = self.frame_address(height)
        n_ops = len(blk.ops)
        puts: list[tuple[str, Arg]] = []
        t = i.terminator

        def val(a: sem.Atom) -> Arg:
            return a if isinstance(a, Const) else env[a.id]

        def emit(kind: str, args: list[Arg], defs: list[int] | None = None, **attrs: object) -> None:
            blk.ops.append(_Op(kind, defs or [], args, attrs, (i.rva,)))

        for s in i.stmts:
            if isinstance(s, sem.Let):
                env[s.dst.id] = self.let(s, [val(a) for a in s.args], blk, i.rva)
            elif isinstance(s, sem.Get):
                env[s.dst.id] = self.read(state, s.loc.name)
            elif isinstance(s, sem.Put):
                v = val(s.val)
                if s.loc.name == abi.stack and isinstance(t, sem.CallTo):
                    continue  # the callee takes the return address off again
                state[s.loc.name] = v
                puts.append((s.loc.name, v))
            elif isinstance(s, sem.Load):
                v = val(s.addr)
                if isinstance(t, sem.ReturnTo) and v == self.frame_address(0):
                    env[s.dst.id] = v  # the return address; where a return goes is not a value of this function
                    self.obs.add(Observation(i.rva, "return-address"))
                    continue
                d = self.value(s.dst.width)
                env[s.dst.id] = d
                emit("load", [v], [d], **({"atomic": 1} if s.atomic else {}))
            elif isinstance(s, sem.Store):
                if isinstance(t, sem.CallTo) and s.val == t.ret and val(s.addr) == self.frame_address(height - abi.word):
                    self.obs.add(Observation(i.rva, "return-address"))
                    continue
                if self.eh is not None and self.eh.help is not None and s.val == Const(HELP_VALUE, 64) and not s.atomic and val(s.addr) == self.frame_address(self.eh.help):
                    self.obs.add(Observation(i.rva, "unwind-help"))
                    continue
                emit("store", [val(s.addr), val(s.val)], **({"atomic": 1} if s.atomic else {}))
            elif isinstance(s, sem.Trap):
                c = val(s.cond)
                if not (isinstance(c, Const) and c.value == 0):
                    emit("trap", [c], why=s.kind)
            elif isinstance(s, sem.Fence):
                emit("fence", [], why=s.kind)
            elif isinstance(s, sem.BlockCopy):
                emit("blockcopy", [val(s.dst), val(s.src), val(s.count), val(s.backward)], size=s.size)
            elif isinstance(s, sem.BlockFill):
                emit("blockfill", [val(s.dst), val(s.val), val(s.count), val(s.backward)])
            elif isinstance(s, sem.CallTo):
                self.call(i, val(s.target), blk, state, height)
            elif isinstance(s, sem.Branch):
                env[-1] = val(s.cond)
            elif isinstance(s, sem.Goto):
                env[-1] = val(s.target)
        blk.term = blk.term if -1 not in env else ("", [env[-1]], [], {}, (i.rva,))
        self.insns.append(i.rva)
        if len(blk.ops) == n_ops or any(n == self.abi.stack for n, _v in puts) and all(o.kind not in EFFECTS for o in blk.ops[n_ops:]):
            self.observe(i, puts)

    def observe(self, i: sem.Lifted, puts: list[tuple[str, Arg]]) -> None:
        """An instruction that became no operation is recorded with what it was."""
        stack = [v for n, v in puts if n == self.abi.stack]
        if isinstance(i.terminator, (sem.Branch, sem.ReturnTo)) or isinstance(i.terminator, sem.Goto) and not isinstance(i.terminator.target, Const):
            return  # the block's terminator carries it
        if isinstance(i.terminator, sem.Goto):
            return
        if stack:
            self.obs.add(Observation(i.rva, "stack-adjust", str(stack[-1] in self.frame_of and self.frame_of[stack[-1]])))
        elif not puts:
            self.obs.add(Observation(i.rva, "no-operation"))
        else:
            kind = "constant" if all(isinstance(v, Const) for _n, v in puts) else "folded" if any(isinstance(s, sem.Let) for s in i.stmts) else "copy"
            self.obs.add(Observation(i.rva, kind, ",".join(sorted({n for n, _v in puts}))))

    def call(self, i: sem.Lifted, target: Arg, blk: _Block, state: dict, height: int) -> None:
        abi = self.abi
        names = sorted(abi.arguments)
        attrs: dict[str, object] = {"args": tuple(names), "sp": height}
        if self.eh is not None and self.eh.states:
            attrs["state"] = self.states[i.end]
        op = _Op("call", [], [target, *(self.read(state, n) for n in names)], attrs, (i.rva,), sp=height)
        blk.ops.append(op)
        for n in abi.clobbered:
            state[n] = _Left(op, n)

    # -- the function ---------------------------------------------------------------------------
    def go(self) -> Fn:
        g = self.g
        preds = {b: [p for p in self.order if b in {e.to for e in g.blocks[p].edges}] for b in self.order}
        entry = _Block(term=("goto", [], [self.number[g.entry]], {}, ()), sp=0)
        self.blocks = [entry] + [_Block() for _ in self.order]
        out: dict[int, dict] = {}
        for b in self.order:
            blk = self.blocks[self.number[b]]
            if b == g.entry and not preds[b]:
                state: dict = {}
            elif len(preds[b]) == 1 and b != g.entry:
                state = dict(out[preds[b][0]])
            else:
                state = {n: _DEAD for n in self.widths}
                for n in sorted(self.flow.live_in[b]):
                    if n != self.abi.stack:
                        v = self.value(self.widths[n])
                        blk.phis.append((v, n, {}))
                        state[n] = v
            for i in g.blocks[b].insns:
                self.instruction(i, blk, state)
            out[b] = state
        exits: list[_Block] = []
        for b in self.order:
            self.terminate(b, out[b], exits)
        self.blocks += exits
        for b in self.order:
            blk = self.blocks[self.number[b]]
            for _v, n, args in blk.phis:
                if b == g.entry:
                    args[0] = self.param(n)
                for p in preds[b]:
                    args[self.number[p]] = self.read(out[p], n)
        if any(sem.OPS[o.kind][1] in ("fsame", "fun", "f2f", "i2f", "f2i") for x in self.blocks for o in x.ops if o.kind in sem.OPS):
            self.assumed.add(FLOATING)
        fn = self.finish()
        if self.eh is not None:
            fn = replace(fn, unwind=self.eh.states, noexcept=self.eh.noexcept)
            h = self.eh.help if any(o.kind == "unwind-help" for o in self.obs) else None
            d = {v: o for v, (_b, o) in fn.defining().items()}
            for _b, o in fn.ops():
                for e, _w in mm.access_extents(o, d.get, {v: n for n, v in fn.params}, fn.width):
                    if h is not None and e.place is not None and e.place[0] == "frame" and (e.size is None or e.place[1] < h + 8 and h < e.place[1] + e.size):
                        raise BuildRefusal("exception-runtime-slot-is-also-used")
        return thread_memory(drop_dead(simplify_phis(fn), "dead"), self.frame, self.abi, self.widths)

    def terminate(self, b: int, state: dict, exits: list[_Block]) -> None:
        src = self.g.blocks[b]
        blk = self.blocks[self.number[b]]
        last = src.insns[-1]
        raw = blk.term
        at = (last.rva,)
        kind = src.end_kind
        abi = self.abi

        def to(edge_kind: str) -> int | None:
            return next((self.number[e.to] for e in src.edges if e.kind == edge_kind), None)

        def leave(target: Arg, st: dict, where: _Block, at: tuple[int, ...]) -> None:
            names = sorted(abi.arguments) + sorted(abi.preserved)
            where.term = ("tail", [target, *(self.read(st, n) for n in names)], [], {"args": tuple(sorted(abi.arguments)), "preserved": tuple(sorted(abi.preserved))}, at)

        if kind in (cf.FALL, cf.GOTO):
            blk.term = ("goto", [], [self.number[src.edges[0].to]], {}, at if kind == cf.GOTO else ())
        elif kind == cf.BRANCH:
            assert raw is not None
            targets = []
            for k, name in ((to("taken"), "taken"), (to("not-taken"), "not-taken")):
                if k is None:
                    assert isinstance(last.terminator, sem.Branch)
                    a = last.terminator.taken if name == "taken" else last.terminator.fall
                    x = _Block(sp=self.frame.heights[last.rva])
                    leave(a, state, x, at)  # type: ignore[arg-type]
                    exits.append(x)
                    k = len(self.blocks) + len(exits) - 1
                targets.append(k)
            if targets[0] == targets[1]:
                blk.term = ("goto", [], targets[:1], {}, at)
            else:
                blk.term = ("branch", raw[1], targets, {}, at)
        elif kind == cf.SWITCH:
            assert raw is not None
            cases = tuple((self.g.blocks[e.to].start + self.base, self.number[e.to]) for e in sorted(src.edges, key=lambda e: self.g.blocks[e.to].start))
            blk.term = ("switch", raw[1], [n for _a, n in cases], {"cases": cases}, at)
        elif kind == cf.RETURN:
            names = sorted(abi.results) + sorted(abi.preserved)
            blk.term = ("return", [self.read(state, n) for n in names], [], {"results": tuple(sorted(abi.results)), "preserved": tuple(sorted(abi.preserved))}, at)
        elif kind == cf.TAIL:
            leave(Const(src.leaves_to[0] + self.base, 8 * abi.word), state, blk, at)
        elif kind == cf.TAIL_INDIRECT:
            assert raw is not None
            leave(raw[1][0], state, blk, at)
        elif kind in (cf.TRAP, cf.NORETURN):
            blk.term = ("unreachable", [], [], {}, at)
        else:
            raise BuildRefusal("unresolved-jump")

    def finish(self) -> Fn:
        # entry values and frame addresses belong to the entry block; a frame address is an operation without operands
        frames = tuple(Op(FRAME, (v,), (), (("off", off),)) for off, v in sorted(self.frames.items()))
        blocks = []
        for k, x in enumerate(self.blocks):
            ops = []
            for o in x.ops:
                defs, attrs = list(o.defs), dict(o.attrs)
                if o.kind == "call":
                    left = sorted(o.left.items())
                    defs, attrs["defs"] = [v for _n, v in left], tuple(n for n, _v in left)
                ops.append(Op(o.kind, tuple(defs), tuple(o.args), tuple(sorted(attrs.items())), (), o.at))
            assert x.term is not None
            kind, args, targets, attrs2, at = x.term
            start = self.g.blocks[self.order[k - 1]].start if 0 < k <= len(self.order) else -1
            blocks.append(Block(k, start, tuple(Phi(v, tuple(sorted(a.items()))) for v, _n, a in x.phis), (frames if k == 0 else ()) + tuple(ops),
                                Term(kind, tuple(args), tuple(targets), tuple(sorted(attrs2.items())), (), at)))
        return Fn(self.rva, tuple(sorted(self.params.items())), (), dict(self.types), tuple(blocks), (), tuple(sorted(self.insns)),
                  tuple(sorted(self.obs)), tuple(sorted(self.assumed)))


# ---------------------------------------------------------------------------------------- phis

def substitute(fn: Fn, sub: dict[int, Arg], drop_phis: set[int]) -> Fn:
    """Replace values everywhere (following chains) and drop the named phis."""
    def a(x: Arg) -> Arg:
        while isinstance(x, int) and x in sub:
            x = sub[x]
        return x

    def tok(x: int) -> int:
        r = a(x)
        assert isinstance(r, int)
        return r

    def mem(ms: tuple[Mem, ...]) -> tuple[Mem, ...]:
        return tuple(Mem(m.region, tok(m.before), m.after) for m in ms)

    blocks = tuple(Block(b.id, b.start, tuple(Phi(p.id, tuple((k, a(v)) for k, v in p.args), p.region) for p in b.phis if p.id not in drop_phis),
                         tuple(Op(o.kind, o.defs, tuple(map(a, o.args)), o.attrs, mem(o.mem), o.at) for o in b.ops),
                         Term(b.term.kind, tuple(map(a, b.term.args)), b.term.targets, b.term.attrs, mem(b.term.mem), b.term.at)) for b in fn.blocks)
    types = {v: t for v, t in fn.types.items() if v not in drop_phis}
    return replace(fn, types=types, blocks=blocks)


def simplify_phis(fn: Fn) -> Fn:
    """A phi whose arguments are one value (or itself) is that value; a phi nothing uses goes."""
    sub: dict[int, Arg] = {}
    dead: set[int] = set()

    def final(x: Arg) -> Arg:
        while isinstance(x, int) and x in sub:
            x = sub[x]
        return x

    phis = [p for b in fn.blocks for p in b.phis]
    changed = True
    while changed:
        changed = False
        for p in phis:
            if p.id in sub:
                continue
            vals = {final(v) for _k, v in p.args} - {p.id}
            if len(vals) == 1:
                sub[p.id] = vals.pop()
                changed = True
    left = [p for p in phis if p.id not in sub]
    by = {p.id: p for p in left}
    used: set[int] = set()
    work = [final(x) for b in fn.blocks for o in (*b.ops, b.term) for x in (*o.args, *(m.before for m in o.mem))]
    while work:
        v = work.pop()
        if isinstance(v, int) and v not in used:
            used.add(v)
            if v in by:
                work += [final(x) for _k, x in by[v].args]
    dead = {p.id for p in left if p.id not in used}
    return substitute(fn, sub, dead | set(sub))


def drop_dead(fn: Fn, why: str) -> Fn:
    """Remove pure operations and phis whose values nothing uses, and such loads from private regions. An instruction left without
    an operation is recorded as `why`. Any other load stays: reading memory can be the very purpose of an instruction."""
    d = fn.defining()
    private = {r.name for r in fn.regions if r.private}

    def removable(o: Op) -> bool:
        return o.pure or o.kind == "load" and o.attr("region") in private and not o.attr("atomic")

    used: set[int] = set()
    work: list[Arg] = []
    for b in fn.blocks:
        for o in b.ops:
            if not removable(o):
                work += [*o.args, *(m.before for m in o.mem)]
        work += [*b.term.args, *(m.before for m in b.term.mem)]
    while work:
        v = work.pop()
        if not isinstance(v, int) or v in used:
            continue
        used.add(v)
        o2 = d[v][1]
        if isinstance(o2, Phi):
            work += [a for _k, a in o2.args]
        elif isinstance(o2, Op) and removable(o2):
            work += [*o2.args, *(m.before for m in o2.mem)]

    def keep(o: Op) -> bool:
        return not removable(o) or o.defs[0] in used

    gone = {a for _b, o in fn.ops() if not keep(o) for a in o.at}
    blocks = tuple(Block(b.id, b.start, tuple(p for p in b.phis if p.id in used), tuple(o for o in b.ops if keep(o)), b.term) for b in fn.blocks)
    params = tuple((n, v) for n, v in fn.params if v in used)
    types = {v: t for v, t in fn.types.items() if v in used or v in d and (d[v][1] is None and isinstance(t, str) or isinstance(d[v][1], Op) and keep(d[v][1]))}
    out = replace(fn, params=params, types=types, blocks=blocks)
    return record(out, gone, why)


def record(fn: Fn, gone: set[int], why: str) -> Fn:
    """Observe the instructions in `gone` that no operation stands for any more."""
    have = {a for b in fn.blocks for o in (*b.ops, b.term) for a in o.at} | {o.rva for o in fn.observations}
    new = tuple(sorted({*fn.observations, *(Observation(a, why) for a in gone - have)}))
    return replace(fn, observations=new)


# ---------------------------------------------------------------------------------------- memory

def call_memory(regions: list[Region], abi: Abi, sp: int, cleans: bool = False) -> list[tuple[Region, bool]]:
    """What a callee may reach when the stack pointer before the call is `sp`: everything that is not private; its home space, which it
    may change; what lies below the stack pointer, which is gone; and stack arguments, which it reads. `cleans`: an exception out of it
    runs cleanups, which read the frame (they may change it too, but nothing of the function runs after them)."""
    out = []
    for r in regions:
        if not r.private:
            out.append((r, True))
        elif r.keeps and r.lo >= sp + abi.home:
            continue
        elif r.lo < sp + abi.home and r.base == "frame":
            out.append((r, True))
        elif r.lo >= sp + abi.home and (r.lo < 0 or cleans):
            out.append((r, False))
    return out


def exit_memory(regions: list[Region], abi: Abi, tail: bool) -> list[tuple[Region, bool]]:
    """What is still observable after the function: all memory outside its frame, and for a tail call its own stack arguments."""
    return [(r, False) for r in regions if not r.private and r.name != FRAME_REGION or tail and (r.name == FRAME_REGION or r.private and r.hi > abi.word + abi.home)]


def cleans(fn: Fn, o: Op) -> bool:
    s = o.attr("state")
    return isinstance(s, int) and bool(fn.cleanups(s))


def op_memory(o: Op, regions: list[Region], abi_call, extents) -> list[tuple[Region, bool]]:
    """(region, whether it may change) for one operation, in the order of `regions`."""
    shared = [(r, True) for r in regions if not r.private]
    if o.kind == "call":
        return abi_call(o)
    if o.kind == "fence":
        return shared
    if o.kind == "trap":
        return [(r, False) for r, _c in shared]
    if o.kind not in ("load", "store", "blockcopy", "blockfill"):
        return []
    change: set[str] = set()
    read: set[str] = set()
    for e, written in extents(o):
        r = mm.region_of(e, regions)
        if written:
            change |= {q.name for q in mm.touched(r, regions)}
        elif e.size is None:
            read |= {q.name for q in mm.touched(r, regions)}
        else:
            read.add(r.name)
    if o.attr("atomic"):
        change |= {r.name for r, _c in shared}
    return [(r, r.name in change) for r in regions if r.name in change or r.name in read]


def main_region(o: Op, regions: list[Region], extents) -> str | None:
    """The region a load reads or a store is aimed at."""
    if o.kind not in ("load", "store"):
        return None
    return mm.region_of(extents(o)[0][0], regions).name


def plan_regions(fn: Fn, frame_saved: dict[tuple[int, int], str], assumed: set[str] | None = None) -> list[Region]:
    d = {v: o for v, (_b, o) in fn.defining().items()}
    params = {v: n for n, v in fn.params}
    ext = [e for _b, o in fn.ops() for e, _w in mm.access_extents(o, d.get, params, fn.width)]
    escapes = mm.frame_escapes(fn)
    regions = mm.classify(ext, escapes, frame_saved)
    if assumed is not None and escapes and any(r.private for r in regions):
        from recon.core.analysis.frame import IN_BOUNDS
        assumed.add(IN_BOUNDS)
    return regions


def thread_memory(fn: Fn, frame: Frame, abi: Abi, widths: dict[str, int]) -> Fn:
    assumed = set(fn.assumptions)
    saved = {(off, off + widths[n] // 8): n for n, off in frame.saved.items()}
    regions = plan_regions(fn, saved, assumed)
    return thread_with(fn, regions, abi, tuple(sorted(assumed)))


def thread_with(fn: Fn, regions: list[Region], abi: Abi, assumptions: tuple[str, ...]) -> Fn:
    """Give every memory operation its tokens over `regions` (any tokens it had are replaced)."""
    d = {v: o for v, (_b, o) in fn.defining().items()}
    params = {v: n for n, v in fn.params}
    old = {v for v, t in fn.types.items() if isinstance(t, str)}
    types: dict[int, int | str] = {v: t for v, t in fn.types.items() if v not in old}
    top = max(types, default=-1) + 1

    def fresh(region: str) -> int:
        nonlocal top
        v = top
        top += 1
        types[v] = region
        return v

    def extents(o: Op):
        return mm.access_extents(o, d.get, params, fn.width)

    def abi_call(o: Op):
        return call_memory(regions, abi, int(o.attr("sp")), cleans(fn, o))  # type: ignore[call-overload]

    preds = fn.preds()
    entry = {r.name: fresh(r.name) for r in regions}
    out: dict[int, dict[str, int]] = {}
    made: dict[int, dict[str, int]] = {}
    blocks: dict[int, Block] = {}
    for b in graph.reverse_postorder(fn.succ, 0):
        blk = fn.blocks[b]
        if b == 0:
            cur = dict(entry)
        elif len(preds[b]) == 1:
            cur = dict(out[preds[b][0]])
        else:
            cur = {r.name: fresh(r.name) for r in regions}
            made[b] = dict(cur)
        ops = []
        for o in blk.ops:
            ms = mm.thread(op_memory(o, regions, abi_call, extents), cur, fresh)
            attrs = dict(o.attrs)
            m = main_region(o, regions, extents)
            if m is not None:
                attrs["region"] = m
            ops.append(Op(o.kind, o.defs, o.args, tuple(sorted(attrs.items())), ms, o.at))
        t = blk.term
        tm: tuple[Mem, ...] = ()
        if t.kind in ("return", "tail"):
            tm = mm.thread(exit_memory(regions, abi, t.kind == "tail"), cur, fresh)
        blocks[b] = Block(b, blk.start, tuple(p for p in blk.phis if p.region is None), tuple(ops), Term(t.kind, t.args, t.targets, t.attrs, tm, t.at))
        out[b] = cur
    done = []
    for k, blk in enumerate(fn.blocks):
        x = blocks[k]
        if k in made:
            x = Block(x.id, x.start, x.phis + tuple(Phi(v, tuple((p, out[p][n]) for p in sorted(preds[k])), n) for n, v in made[k].items()), x.ops, x.term)
        done.append(x)
    return simplify_phis(replace(fn, tokens=tuple(entry.items()), types=types, blocks=tuple(done), regions=tuple(regions), assumptions=assumptions))


def settle_memory(fn: Fn, abi: Abi) -> Fn:
    """The function with its memory cut and threaded anew when its addresses have become clearer (or fewer) than its regions say.
    Threading removes phis that join one value only, which can make another address clearer; so until it stays as it is."""
    for _ in range(1 + sum(len(b.phis) for b in fn.blocks)):  # every round but the last removes a phi of a value
        out = _settle_once(fn, abi)
        if out is fn:
            break
        fn = out
    return fn


def _settle_once(fn: Fn, abi: Abi) -> Fn:
    d = {v: o for v, (_b, o) in fn.defining().items()}
    params = {v: n for n, v in fn.params}
    regions = list(fn.regions)

    def extents(o: Op):
        return mm.access_extents(o, d.get, params, fn.width)

    def as_it_is(o: Op) -> bool:
        want = op_memory(o, regions, lambda o: call_memory(regions, abi, int(o.attr("sp")), cleans(fn, o)), extents)
        return [(m.region, m.after is not None) for m in o.mem] == [(r.name, c) for r, c in want] and main_region(o, regions, extents) == o.attr("region")
    assumed = set(fn.assumptions)
    planned = plan_regions(fn, {(r.lo, r.hi): r.keeps for r in regions if r.keeps}, assumed)
    try:
        # the frame keeps its cut, which calls and exits name, as long as every access still fits it
        kept = [r for r in regions if r.base in (FRAME, FRAME_REGION)] + [r for r in planned if r.base not in (FRAME, FRAME_REGION)]
        if kept == regions and all(as_it_is(o) for _b, o in fn.ops()):
            return fn
        for _b, o in fn.ops():
            for e, _w in extents(o):
                mm.region_of(e, kept)
        return thread_with(fn, kept, abi, fn.assumptions)
    except KeyError:  # an access of the frame that no region holds
        pass
    return thread_with(fn, planned, abi, tuple(sorted(assumed)))


def build(g: cf.Cfg, flow: Flow, frame: Frame | None, abi: Abi, widths: dict[str, int], base: int, rva: int, eh: Unwinding | None = None) -> Fn:
    """The IR, or BuildRefusal. `eh`: what exceptions do in the function, when it has a handler."""
    if frame is None:
        raise BuildRefusal("no-frame")
    return _Builder(g, flow, frame, abi, widths, base, rva, eh).go()


__all__ = ["ARRIVAL", "BuildRefusal", "OTHER", "Unwinding", "build", "cleans", "settle_memory", "simplify_phis", "substitute", "thread_with"]
