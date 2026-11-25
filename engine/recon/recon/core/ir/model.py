# SPDX-License-Identifier: AGPL-3.0-or-later
"""The semantic IR of one function: SSA values, memory SSA over regions, explicit effects, machine details beside it.

* A value is a bit vector of a width or a *memory token*, the state of one memory region at one point. Signedness,
  precision and rounding belong to operations (`recon.core.sem.OPS`), never to values.
* Pure operations compute values. Effects (load, store, block operations, fences, traps, calls) name every region they
  read and, when they change it, the token they leave. A store names every region it may change.
* What a machine word of the function means is not in the IR; where each operation came from (`at`) and the choices
  that matter only to matching (`Observation`) are kept beside it and are not part of its meaning.

`Fn.digest()` covers everything. `Fn.semantic_digest()` covers the meaning: it does not change with the order of
operations whose order is not observable, with which instruction computed what, or with value numbers.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Iterator, Union

from recon.core import sem
from recon.core.canonical import canonical_bytes, digest
from recon.core.sem import Const

IR_VERSION = 1

Arg = Union[int, Const]           # a value id or a constant
Type = Union[int, str]            # a width in bits, or the region whose token it is

#: the address `frame + off`, where frame is the stack pointer on entry
FRAME = "frame"
#: effects: kind -> number of arguments, None when it varies
EFFECTS: dict[str, int | None] = {"load": 1, "store": 2, "blockcopy": 4, "blockfill": 4, "fence": 0, "trap": 1, "call": None}
#: terminators: kind -> (number of arguments, number of targets), None when it varies
TERMS: dict[str, tuple[int | None, int | None]] = {
    "goto": (0, 1), "branch": (1, 2), "switch": (1, None), "return": (None, 0), "tail": (None, 0), "unreachable": (0, 0)}

OTHER = "other"                   # memory no other region is known to hold
FRAME_REGION = "open-frame"            # the part of the frame whose address left


@dataclass(frozen=True, slots=True)
class Region:
    """`base`: "frame", "open-frame", "param:<location>", "global" or "other"; [lo, hi) are byte offsets from it.

    A private region is a part of the frame no other access, callee or pointer can reach."""

    name: str
    base: str
    lo: int
    hi: int
    private: bool = False
    #: the location whose entry value this part of the frame keeps (the frame analysis proved it), or ""
    keeps: str = ""


@dataclass(frozen=True, slots=True)
class Mem:
    """One region an operation depends on: the token before and, when the operation may change it, the token after."""

    region: str
    before: int
    after: int | None = None


@dataclass(frozen=True, slots=True)
class Op:
    kind: str
    defs: tuple[int, ...]
    args: tuple[Arg, ...] = ()
    attrs: tuple[tuple[str, object], ...] = ()
    mem: tuple[Mem, ...] = ()
    at: tuple[int, ...] = ()      # addresses (RVA) of the instructions it came from

    def attr(self, name: str, default=None):
        for k, v in self.attrs:
            if k == name:
                return v
        return default

    @property
    def pure(self) -> bool:
        return self.kind not in EFFECTS


@dataclass(frozen=True, slots=True)
class Phi:
    id: int
    #: predecessor block -> value, in order of block id
    args: tuple[tuple[int, Arg], ...]
    region: str | None = None


@dataclass(frozen=True, slots=True)
class Term:
    kind: str
    args: tuple[Arg, ...] = ()
    targets: tuple[int, ...] = ()
    attrs: tuple[tuple[str, object], ...] = ()
    mem: tuple[Mem, ...] = ()
    at: tuple[int, ...] = ()

    def attr(self, name: str, default=None):
        for k, v in self.attrs:
            if k == name:
                return v
        return default


@dataclass(frozen=True, slots=True)
class Block:
    id: int
    start: int                    # RVA of the first instruction; -1 for a block that has none of its own
    phis: tuple[Phi, ...]
    ops: tuple[Op, ...]
    term: Term


#: what an instruction (or part of one) was when it has no operation of its own. Closed: anything else is not coverage.
OBSERVATIONS = frozenset({
    "copy",             # moves a value between registers
    "constant",         # puts a constant in a register
    "stack-adjust",     # moves the stack pointer by an amount the frame analysis proved
    "return-address",   # the push of a call or the pop of a return
    "jump",             # an unconditional jump inside the function
    "no-operation",     # has no effect in the semantics
    "dead",             # computed nothing that is used (a flag nobody reads, say)
    "save", "restore",  # keeps and gives back a register the caller owns
    "unwind-help",      # sets the place in the frame the exception runtime keeps for itself
    "merged",           # computes what another operation computes
    "folded",           # its value follows from constants or from a validated identity
    "polarity",         # the branch tests the opposite condition
})


@dataclass(frozen=True, slots=True, order=True)
class Observation:
    rva: int
    kind: str
    detail: str = ""


@dataclass(frozen=True)
class Fn:
    rva: int
    params: tuple[tuple[str, int], ...]             # location -> its value on entry
    tokens: tuple[tuple[str, int], ...]             # region -> its token on entry
    types: dict[int, Type]
    blocks: tuple[Block, ...]                       # blocks[k].id == k; block 0 is the entry and has no predecessor
    regions: tuple[Region, ...]
    insns: tuple[int, ...]                          # every reachable instruction of the function
    observations: tuple[Observation, ...] = ()
    assumptions: tuple[str, ...] = ()
    #: names of the transformations applied, in order
    history: tuple[str, ...] = ()
    version: int = IR_VERSION
    #: exception states: (the state after its cleanup, the cleanup's address or 0); a call names the state an exception finds
    unwind: tuple[tuple[int, int], ...] = ()
    noexcept: bool = False                          # an exception that would leave the function ends the program

    # -- access ---------------------------------------------------------------------------------
    def width(self, a: Arg) -> int:
        if isinstance(a, Const):
            return a.width
        t = self.types[a]
        assert isinstance(t, int)
        return t

    def region(self, name: str) -> Region:
        for r in self.regions:
            if r.name == name:
                return r
        raise KeyError(name)

    def cleanups(self, state: int) -> tuple[int, ...]:
        """What runs, in order, when an exception arrives in the state."""
        out = []
        while state >= 0:
            state, action = self.unwind[state]
            if action:
                out.append(action)
        return tuple(out)

    @property
    def succ(self) -> list[list[int]]:
        return [list(dict.fromkeys(b.term.targets)) for b in self.blocks]

    def preds(self) -> list[list[int]]:
        out: list[list[int]] = [[] for _ in self.blocks]
        for b in self.blocks:
            for t in dict.fromkeys(b.term.targets):
                out[t].append(b.id)
        return out

    def ops(self) -> Iterator[tuple[Block, Op]]:
        for b in self.blocks:
            for o in b.ops:
                yield b, o

    def defining(self) -> dict[int, tuple[int, Op | Phi | None]]:
        """value -> (block, what defines it; None for an entry value)."""
        d: dict[int, tuple[int, Op | Phi | None]] = {v: (0, None) for _n, v in (*self.params, *self.tokens)}
        for b in self.blocks:
            for p in b.phis:
                d[p.id] = (b.id, p)
            for o in b.ops:
                for v in o.defs:
                    d[v] = (b.id, o)
                for m in o.mem:
                    if m.after is not None:
                        d[m.after] = (b.id, o)
        return d

    # -- serialisation --------------------------------------------------------------------------
    def to_data(self) -> dict:
        def arg(a: Arg) -> list:
            return ["c", a.value, a.width] if isinstance(a, Const) else ["v", a]

        def attrs(xs) -> list:
            return [[k, _plain(v)] for k, v in xs]

        def mem(ms) -> list:
            return [[m.region, m.before, m.after] for m in ms]

        return {
            "version": self.version, "rva": self.rva, "params": [list(p) for p in self.params], "tokens": [list(t) for t in self.tokens],
            "types": [[k, self.types[k]] for k in sorted(self.types)],
            "regions": [[r.name, r.base, r.lo, r.hi, r.private, r.keeps] for r in self.regions],
            "blocks": [{
                "id": b.id, "start": b.start,
                "phis": [[p.id, p.region, [[k, arg(a)] for k, a in p.args]] for p in b.phis],
                "ops": [[o.kind, list(o.defs), [arg(a) for a in o.args], attrs(o.attrs), mem(o.mem), list(o.at)] for o in b.ops],
                "term": [b.term.kind, [arg(a) for a in b.term.args], list(b.term.targets), attrs(b.term.attrs), mem(b.term.mem), list(b.term.at)],
            } for b in self.blocks],
            "insns": list(self.insns), "observations": [[o.rva, o.kind, o.detail] for o in self.observations],
            "assumptions": list(self.assumptions), "history": list(self.history), "unwind": [list(u) for u in self.unwind], "noexcept": self.noexcept,
        }

    @staticmethod
    def from_data(d: dict) -> "Fn":
        if d.get("version") != IR_VERSION:
            raise ValueError("another IR version")

        def arg(a) -> Arg:
            return Const(a[1], a[2]) if a[0] == "c" else a[1]

        def attrs(xs) -> tuple:
            return tuple((k, _frozen(v)) for k, v in xs)

        def mem(ms) -> tuple:
            return tuple(Mem(*m) for m in ms)

        return Fn(
            d["rva"], tuple((n, v) for n, v in d["params"]), tuple((n, v) for n, v in d["tokens"]), {k: t for k, t in d["types"]},
            tuple(Block(b["id"], b["start"], tuple(Phi(p[0], tuple((k, arg(a)) for k, a in p[2]), p[1]) for p in b["phis"]),
                        tuple(Op(o[0], tuple(o[1]), tuple(map(arg, o[2])), attrs(o[3]), mem(o[4]), tuple(o[5])) for o in b["ops"]),
                        Term(b["term"][0], tuple(map(arg, b["term"][1])), tuple(b["term"][2]), attrs(b["term"][3]), mem(b["term"][4]), tuple(b["term"][5])))
                  for b in d["blocks"]),
            tuple(Region(*r) for r in d["regions"]), tuple(d["insns"]), tuple(Observation(*o) for o in d["observations"]),
            tuple(d["assumptions"]), tuple(d["history"]), d["version"], tuple((a, b) for a, b in d["unwind"]), d["noexcept"])

    def to_bytes(self) -> bytes:
        return canonical_bytes(self.to_data())

    def digest(self) -> str:
        return digest(self.to_data())

    def semantic_data(self) -> dict:
        """The meaning only: pure operations and loads appear where they are first needed, values are numbered in that order."""
        from recon.core.analysis import graph

        names: dict[int, int] = {}
        out_ops: list = []
        defined = self.defining()
        place = {b: k for k, b in enumerate(graph.reverse_postorder(self.succ, 0))}
        slots: dict[str, int] = {}          # private regions are named by first use: where a compiler puts a slot is its choice
        private = {r.name for r in self.regions if r.private}
        param = {v: n for n, v in self.params}

        def region(n: str) -> list:
            if n in private:
                return ["private", slots.setdefault(n, len(slots))]
            r = self.region(n)
            return [r.base, r.lo, r.hi]

        def number(v: int) -> int:
            return names.setdefault(v, len(names))

        def arg(a: Arg) -> list:
            return ["c", a.value, a.width] if isinstance(a, Const) else ["p", param[a]] if a in param else ["v", names[a]]

        def slot(o: Op) -> int | None:
            """Where in its private region an access lies, when its address is a place in the frame."""
            r = o.attr("region")
            d = defined[o.args[0]][1] if o.kind in ("load", "store") and r in private and isinstance(o.args[0], int) else None
            return int(d.attr("off")) - self.region(str(r)).lo if isinstance(d, Op) and d.kind == FRAME else None

        def address(o: Op) -> list:
            """The operands of a memory access; one inside a private region is named by the region and the offset in it."""
            at = slot(o)
            return [arg(a) for a in o.args] if at is None else [["slot", region(str(o.attr("region"))), at], *map(arg, o.args[1:])]

        def operands(o: Op) -> list[int]:
            """The values it needs, without an address that is named by its slot."""
            return [a for a in (o.args[1:] if slot(o) is not None else o.args) if isinstance(a, int)]

        def floats(o: Op) -> bool:
            return o.pure or o.kind == "load" and not o.attr("atomic")

        def emit(o: Op, done: set[int]) -> None:
            for v in o.defs:
                number(v)
            before = [[region(m.region), token(m.before)] for m in o.mem] if o.kind == "load" else []
            out_ops.append([o.kind, [names[v] for v in o.defs], address(o) if o.kind in ("load", "store") else [arg(a) for a in o.args],
                            [[k, region(v) if k == "region" else list(self.cleanups(v)) if k == "state" else _plain(v)] for k, v in o.attrs if k != "rva"], before])

        def token(v: int) -> list:
            d = defined[v][1]
            if d is None:
                return ["entry"]
            if isinstance(d, Phi):
                return ["phi", place[defined[v][0]], number(v)]
            return ["after", number(v)]

        def need(roots: list[int], done: set[int], block_phis: set[int]) -> None:
            stack = [(v, False) for v in reversed(roots)]
            while stack:
                v, ready = stack.pop()
                d = defined[v][1]
                if not isinstance(d, Op) or not floats(d) or id(d) in done:
                    continue
                if ready:
                    done.add(id(d))
                    emit(d, done)
                else:
                    stack.append((v, True))
                    stack.extend((a, False) for a in reversed(operands(d)))

        done: set[int] = set()
        blocks = []
        order = sorted(place, key=lambda b: place[b])
        for b in order:  # values that come from phis and effects are numbered by where they are made
            for p in self.blocks[b].phis:
                if p.region is None:
                    number(p.id)
            for o in self.blocks[b].ops:
                if not floats(o):
                    for v in (*o.defs, *(m.after for m in o.mem if m.after is not None)):
                        number(v)
        for b in order:
            blk = self.blocks[b]
            out_ops = []
            for o in blk.ops:
                if not floats(o):
                    need(operands(o), done, set())
                    emit(o, done)
            need([a for a in blk.term.args if isinstance(a, int)], done, set())
            need([o.defs[0] for o in blk.ops if o.kind == "load" and floats(o)], done, set())
            for t in dict.fromkeys(blk.term.targets):
                for p in self.blocks[t].phis:
                    if p.region is None:
                        need([a for k, a in p.args if k == b and isinstance(a, int)], done, set())
            blocks.append([out_ops, blk.term.kind, [arg(a) for a in blk.term.args], [place[t] for t in blk.term.targets],
                           [[k, _plain(v)] for k, v in blk.term.attrs if k != "rva"]])
        phis = [[[names[p.id], sorted([place[k], arg(a)] for k, a in p.args if k in place)] for p in sorted(self.blocks[b].phis, key=lambda p: names.get(p.id, -1))
                 if p.region is None and p.id in names] for b in order]
        return {"version": self.version, "blocks": blocks, "phis": phis, "noexcept": self.noexcept}

    def semantic_digest(self) -> str:
        return digest(self.semantic_data())


def _plain(v):
    return [_plain(x) for x in v] if isinstance(v, (tuple, list)) else v


def _frozen(v):
    return tuple(_frozen(x) for x in v) if isinstance(v, (tuple, list)) else v


def op_width(kind: str, args: tuple[Arg, ...], widths: list[int], out: int | None) -> int:
    """The result width of a pure operation, or SemanticsError."""
    if kind == FRAME:
        return out if out is not None else 64
    return sem.result_width(kind, tuple(Const(0, w) for w in widths), out)


__all__ = ["Arg", "Block", "Const", "EFFECTS", "FRAME", "FRAME_REGION", "Fn", "IR_VERSION", "Mem", "OBSERVATIONS", "OTHER", "Observation", "Op", "Phi", "Region", "TERMS", "Term",
           "Type", "op_width", "replace"]
