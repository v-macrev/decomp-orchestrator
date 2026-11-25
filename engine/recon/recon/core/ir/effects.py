# SPDX-License-Identifier: AGPL-3.0-or-later
"""What a function does besides returning a value, and whether two of its memory accesses may touch the same bytes.

Both are read off the IR and hold under its stated assumptions. "May" answers are upper bounds; a callee is unknown here.
"""
from __future__ import annotations

from dataclasses import dataclass

from recon.core.ir import memory as mm
from recon.core.ir.build import cleans
from recon.core.ir.model import Fn, Op


@dataclass(frozen=True)
class Effects:
    reads: tuple[str, ...]        # bases of memory read outside the frame: "param:<location>", "global", "other"
    writes: tuple[str, ...]
    calls: int
    indirect_calls: int
    traps: tuple[str, ...]
    fences: int
    atomics: int
    opens_frame: bool             # a frame address leaves
    ends: tuple[str, ...]         # kinds of exit
    cleaned_up_after: int         # calls out of which an exception runs cleanups of this function
    noexcept: bool

    @property
    def pure(self) -> bool:
        """Nothing but a value: no memory outside the frame, no call, trap or synchronisation, and it returns."""
        return not (self.reads or self.writes or self.calls or self.traps or self.fences or self.atomics) and set(self.ends) <= {"return"}

    @property
    def read_only(self) -> bool:
        return not (self.writes or self.calls or self.traps or self.fences or self.atomics) and set(self.ends) <= {"return"}


def effects(fn: Fn) -> Effects:
    d = {v: o for v, (_b, o) in fn.defining().items()}
    params = {v: n for n, v in fn.params}
    reads: set[str] = set()
    writes: set[str] = set()
    traps: set[str] = set()
    calls = indirect = fences = atomics = 0
    frame = False
    for _b, o in fn.ops():
        atomics += bool(o.attr("atomic"))
        fences += o.kind == "fence"
        if o.kind == "trap":
            traps.add(str(o.attr("why")))
        if o.kind == "call":
            calls += 1
            indirect += isinstance(o.args[0], int)
        for e, w in mm.access_extents(o, d.get, params, fn.width):
            base = e.place[0] if e.place else "other"
            if base == "frame":
                continue
            (writes if w else reads).add(base)
    frame = any(not r.private and r.base == mm.FRAME_REGION for r in fn.regions)
    return Effects(tuple(sorted(reads)), tuple(sorted(writes)), calls, indirect, tuple(sorted(traps)), fences, atomics, frame,
                   tuple(sorted({b.term.kind for b in fn.blocks if not b.term.targets})), sum(1 for _b, o in fn.ops() if cleans(fn, o)), fn.noexcept)


MUST, MAY, NO = "same-bytes", "may-overlap", "disjoint"


def alias(fn: Fn, a: Op, b: Op) -> str:
    """How the memory two loads or stores touch is related, when both run in one activation."""
    d = {v: o for v, (_b, o) in fn.defining().items()}
    params = {v: n for n, v in fn.params}

    def one(o: Op):
        if o.kind not in ("load", "store"):
            raise ValueError("not a load or a store")
        return mm.access_extents(o, d.get, params, fn.width)[0][0]
    x, y = one(a), one(b)
    if a.args[0] == b.args[0] and x.size == y.size and _settled(fn, a.args[0]):
        return MUST
    if x.place and y.place and x.place[0] == y.place[0]:
        if x.place == y.place and x.size == y.size:
            return MUST
        (p, q) = (x.place[1], y.place[1])
        return NO if p + x.size <= q or q + y.size <= p else MAY  # type: ignore[operator]
    ra, rb = fn.region(str(a.attr("region"))), fn.region(str(b.attr("region")))
    return MAY if mm.may_alias(ra, rb) else NO


def _settled(fn: Fn, v) -> bool:
    """Whether a value is the same each time it is seen in one activation: it is not made inside a loop."""
    from recon.core.analysis import graph

    if not isinstance(v, int):
        return True
    home = fn.defining()[v][0]
    return not any(home in c and (len(c) > 1 or home in fn.succ[home]) for c in graph.strongly_connected(fn.succ))


__all__ = ["Effects", "MAY", "MUST", "NO", "alias", "effects"]
