# SPDX-License-Identifier: AGPL-3.0-or-later
"""Data flow over named locations: uses and definitions, liveness, reaching definitions, definition-use chains.

What a call reads, changes and what must survive to an exit are the calling convention's business, so they come
in as an `Abi` the adapter fills. A location a call may change is a definition made by the call.
"""
from __future__ import annotations

from dataclasses import dataclass

from recon.core.analysis.cfg import NORETURN, RETURN, TAIL, TAIL_INDIRECT, TRAP, UNRESOLVED, Cfg
from recon.core.sem import CallTo, Get, Lifted, Put


@dataclass(frozen=True)
class Abi:
    """Location names. `arguments`: what a call may read; `clobbered`: what it may change; `preserved`: what a function
    must give back unchanged; `results`: what a return may hand to the caller; `stack`: the stack pointer; `word`: its width in bytes;
    `home`: bytes above the return address the callee may use freely."""

    arguments: frozenset[str]
    clobbered: frozenset[str]
    preserved: frozenset[str]
    results: frozenset[str]
    stack: str
    word: int
    home: int
    #: on entry the stack pointer plus align[1] is a multiple of align[0]
    align: tuple[int, int] = (16, 8)

    @property
    def live_at_return(self) -> frozenset[str]:
        return self.results | self.preserved | {self.stack}


@dataclass(frozen=True)
class Effect:
    uses: frozenset[str]     # read before this instruction writes it
    defs: frozenset[str]     # written


def effect(i: Lifted, abi: Abi) -> Effect:
    uses: set[str] = set()
    defs: set[str] = set()
    for s in i.stmts:
        if isinstance(s, Get) and s.loc.name not in defs:
            uses.add(s.loc.name)
        elif isinstance(s, Put):
            defs.add(s.loc.name)
    if isinstance(i.terminator, CallTo):
        uses |= abi.arguments - defs
        defs |= abi.clobbered
    return Effect(frozenset(uses), frozenset(defs))


ENTRY = -1  # the definition every location has on entry
Def = tuple[int, str]  # (instruction RVA or ENTRY, location)


@dataclass(frozen=True)
class Flow:
    live_in: tuple[frozenset[str], ...]
    live_out: tuple[frozenset[str], ...]
    reach_in: tuple[frozenset[Def], ...]
    #: use (instruction RVA, location) -> the definitions that may reach it, sorted
    use_def: dict[tuple[int, str], tuple[int, ...]]

    def summary(self) -> dict:
        return {"live_in": [sorted(x) for x in self.live_in], "live_out": [sorted(x) for x in self.live_out],
                "use_def": [[r, n, list(ds)] for (r, n), ds in sorted(self.use_def.items())]}


def live_at_exit(kind: str, abi: Abi) -> frozenset[str]:
    if kind == RETURN:
        return abi.live_at_return
    if kind in (TAIL, TAIL_INDIRECT):
        return abi.arguments | abi.preserved | {abi.stack}
    if kind in (TRAP, NORETURN):
        return frozenset()
    if kind == UNRESOLVED:
        return abi.live_at_return | abi.arguments
    return frozenset()


def solve(cfg: Cfg, abi: Abi) -> Flow:
    n = len(cfg.blocks)
    effects = [[effect(i, abi) for i in b.insns] for b in cfg.blocks]
    every = sorted({x for es in effects for e in es for x in e.uses | e.defs} | abi.live_at_return | abi.arguments)
    exit_live = []
    for b in cfg.blocks:
        x = set(live_at_exit(b.end_kind, abi))
        if b.leaves_to:
            x |= live_at_exit(TAIL, abi)
        exit_live.append(frozenset(x))

    # liveness, backwards
    use_b, def_b = [], []
    for es in effects:
        u: set[str] = set()
        d: set[str] = set()
        for e in es:
            u |= e.uses - d
            d |= e.defs
        use_b.append(u)
        def_b.append(d)
    live_in: list[set[str]] = [set() for _ in range(n)]
    live_out: list[set[str]] = [set() for _ in range(n)]
    succ = cfg.succ
    changed = True
    while changed:
        changed = False
        for k in range(n - 1, -1, -1):
            out = set(exit_live[k])
            for m in succ[k]:
                out |= live_in[m]
            inn = use_b[k] | (out - def_b[k])
            if out != live_out[k] or inn != live_in[k]:
                live_out[k], live_in[k] = out, inn
                changed = True

    # reaching definitions, forwards over the reachable blocks
    reach_in: list[set[Def]] = [set() for _ in range(n)]
    reach_in[cfg.entry] = {(ENTRY, x) for x in every}

    def through(k: int) -> set[Def]:
        cur = set(reach_in[k])
        for i, e in zip(cfg.blocks[k].insns, effects[k]):
            if e.defs:
                cur = {d for d in cur if d[1] not in e.defs} | {(i.rva, x) for x in e.defs}
        return cur

    work = [cfg.entry]
    seen = {cfg.entry}
    while work:
        k = work.pop(0)
        out = through(k)
        for m in succ[k]:
            if not out <= reach_in[m] or m not in seen:
                reach_in[m] |= out
                seen.add(m)
                if m not in work:
                    work.append(m)

    use_def: dict[tuple[int, str], tuple[int, ...]] = {}
    for k in sorted(cfg.reachable):
        cur = set(reach_in[k])
        for i, e in zip(cfg.blocks[k].insns, effects[k]):
            for x in e.uses:
                use_def[(i.rva, x)] = tuple(sorted(d for d, name in cur if name == x))
            if e.defs:
                cur = {d for d in cur if d[1] not in e.defs} | {(i.rva, x) for x in e.defs}
    return Flow(tuple(frozenset(x) for x in live_in), tuple(frozenset(x) for x in live_out), tuple(frozenset(x) for x in reach_in), use_def)
