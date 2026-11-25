# SPDX-License-Identifier: AGPL-3.0-or-later
"""Basic blocks and the control-flow graph of one function, from its lifted instructions.

Where control goes is read from each instruction's terminator. A direct branch to an address that is not an
instruction start is an error, never repaired. An indirect jump is a switch only when the adapter resolved its
targets; otherwise it is an exit (a tail call, when the adapter says so) or `unresolved`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping

from recon.core.analysis import graph
from recon.core.sem import Branch, CallTo, Const, Goto, Lifted, ReturnTo, Trap

# how a block ends
FALL, GOTO, BRANCH, SWITCH = "fall", "goto", "branch", "switch"
RETURN, TAIL, TAIL_INDIRECT, TRAP, NORETURN, UNRESOLVED = "return", "tail", "tail-indirect", "trap", "noreturn-call", "unresolved"
EXITS = frozenset({RETURN, TAIL, TAIL_INDIRECT, TRAP, NORETURN, UNRESOLVED})


class CfgError(ValueError):
    """The instructions contradict themselves; `reason` is a fixed code."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Edge:
    to: int            # block index
    kind: str          # fall, jump, taken, not-taken, case


@dataclass
class Block:
    index: int
    start: int                       # RVA
    insns: tuple[Lifted, ...]
    end_kind: str = FALL
    edges: list[Edge] = field(default_factory=list)
    #: addresses control leaves the function to, when they are constants (a tail call, a conditional tail call)
    leaves_to: list[int] = field(default_factory=list)


@dataclass
class Cfg:
    blocks: list[Block]
    entry: int
    reachable: frozenset[int]
    idom: list[int | None]
    ipdom: list[int | None]
    loops: list[graph.Loop]
    reducible: bool
    components: list[list[int]]

    @property
    def succ(self) -> list[list[int]]:
        return [[e.to for e in b.edges] for b in self.blocks]

    def summary(self) -> dict:
        """Canonical and free of instruction content: shape only."""
        return {
            "blocks": [[b.start, len(b.insns), b.end_kind, [[e.to, e.kind] for e in b.edges]] for b in self.blocks],
            "reachable": sorted(self.reachable), "idom": self.idom, "ipdom": self.ipdom, "reducible": self.reducible,
            "loops": [[lp.header, list(lp.body), list(lp.latches), lp.parent] for lp in self.loops],
        }


def _always_traps(i: Lifted) -> bool:
    return any(isinstance(s, Trap) and isinstance(s.cond, Const) and s.cond.value == 1 for s in i.stmts)


def _effectless_after_call(b: Block) -> bool:
    for i in reversed(b.insns):
        if i.stmts:
            return isinstance(i.terminator, CallTo)
    return False


def build(insns: list[Lifted], base: int, *, switches: Mapping[int, tuple[int, ...]] | None = None, tails: frozenset[int] = frozenset()) -> Cfg:
    """`base` turns an RVA into the address the semantics use. `switches` maps an indirect jump's RVA to its target RVAs;
    `tails` holds the RVAs of indirect jumps known to leave the function."""
    if not insns:
        raise CfgError("empty-function")
    switches = switches or {}
    at = {i.rva: k for k, i in enumerate(insns)}
    lo, hi = insns[0].rva, insns[-1].end
    if any(a.end != b.rva for a, b in zip(insns, insns[1:])):
        raise CfgError("instructions-not-contiguous")

    def local(address: int) -> int | None:
        rva = address - base
        if not lo <= rva < hi:
            return None
        if rva not in at:
            raise CfgError("target-inside-instruction")
        return rva

    leaders = {lo}
    for i in insns:
        t = i.terminator
        targets: list[int | None] = []
        if isinstance(t, Goto) and isinstance(t.target, Const):
            targets = [local(t.target.value)]
        elif isinstance(t, Branch):
            assert isinstance(t.taken, Const) and isinstance(t.fall, Const)
            targets = [local(t.taken.value)]
        elif i.rva in switches:
            for s in switches[i.rva]:
                if s not in at:
                    raise CfgError("switch-target-not-an-instruction")
            targets = list(switches[i.rva])
        leaders.update(x for x in targets if x is not None)
        ends = isinstance(t, (Goto, Branch, ReturnTo)) or _always_traps(i)
        if ends and i.end < hi:
            leaders.add(i.end)

    starts = sorted(leaders)
    index = {s: k for k, s in enumerate(starts)}
    blocks: list[Block] = []
    for k, s in enumerate(starts):
        stop = starts[k + 1] if k + 1 < len(starts) else hi
        blocks.append(Block(k, s, tuple(insns[at[s]:at[stop] if stop in at else len(insns)])))

    for b in blocks:
        last = b.insns[-1]
        t = last.terminator

        def go(address: int, kind: str) -> None:
            r = local(address)
            if r is None:
                b.leaves_to.append(address - base)
            else:
                b.edges.append(Edge(index[r], kind))

        if _always_traps(last):
            b.end_kind = TRAP
        elif isinstance(t, ReturnTo):
            b.end_kind = RETURN
        elif isinstance(t, Branch):
            b.end_kind = BRANCH
            go(t.fall.value, "not-taken")  # type: ignore[union-attr]
            go(t.taken.value, "taken")  # type: ignore[union-attr]
            if last.end == hi and not any(e.kind == "not-taken" for e in b.edges):
                raise CfgError("falls-off-the-end")
        elif isinstance(t, Goto) and isinstance(t.target, Const):
            go(t.target.value, "jump")
            b.end_kind = GOTO if b.edges else TAIL
        elif isinstance(t, Goto):
            if last.rva in switches:
                b.end_kind = SWITCH
                for s in sorted(set(switches[last.rva])):
                    b.edges.append(Edge(index[s], "case"))
            else:
                b.end_kind = TAIL_INDIRECT if last.rva in tails else UNRESOLVED
        elif last.end < hi:
            b.edges.append(Edge(index[last.end], "fall"))
        elif isinstance(t, CallTo):
            b.end_kind = NORETURN  # nothing follows the call: it cannot come back here
        elif _effectless_after_call(b):
            b.end_kind = NORETURN  # ... nothing but padding follows it
        else:
            raise CfgError("falls-off-the-end")

    succ = [[e.to for e in b.edges] for b in blocks]
    reachable = frozenset(graph.reverse_postorder(succ, 0))
    exits = [b.index for b in blocks if b.index in reachable and (b.end_kind in EXITS or b.leaves_to)]
    loops, reducible = graph.natural_loops(succ, 0)
    return Cfg(blocks, 0, reachable, graph.immediate_dominators(succ, 0), graph.immediate_postdominators(succ, exits), loops, reducible,
               [c for c in graph.strongly_connected(succ) if set(c) & reachable])
