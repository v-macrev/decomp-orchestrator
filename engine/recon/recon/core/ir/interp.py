# SPDX-License-Identifier: AGPL-3.0-or-later
"""Concrete execution of the IR, for differential tests against the lifted instructions and between transformations.

Memory is one flat byte store: regions and tokens are claims about it, and the interpreter checks them while it runs.
Every operation must name the tokens that are current, and bytes of a private region may be touched only through it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from recon.core.evaluate import UNDEF, Trapped, UndefinedControl, apply
from recon.core.ir.model import FRAME, Arg, Const, Fn, Op
from recon.core.sem import OPAQUE

MASK = (1 << 64) - 1


class ClaimBroken(AssertionError):
    """The IR says something about memory that this execution contradicts."""


@dataclass
class World:
    """What the function runs in. `call(target, {location: value}, sp)` gives the values of clobbered locations (and may use memory)."""

    read: Callable[[int, int], object]
    write: Callable[[int, int, object], None]
    entry: dict[str, object]
    frame: int
    call: Callable[[object, dict[str, object], int], dict[str, object]]
    #: called with the frame spans a callee (or the cleanups an exception out of it runs) reads, before the call
    sees: Callable[[list[tuple[int, int]]], None] = lambda spans: None
    #: the value of an operation that is a function of its argument but not defined here
    opaque: Callable[[str, int], int] = lambda op, x: UNDEF  # type: ignore[assignment,return-value]


@dataclass(frozen=True)
class Exit:
    kind: str
    target: object = None
    values: tuple[tuple[str, object], ...] = ()


@dataclass
class _State:
    env: dict[int, object] = field(default_factory=dict)
    current: dict[str, int] = field(default_factory=dict)


def run(fn: Fn, w: World, steps: int = 20000) -> Exit | None:
    """How the function ends; None when it runs out of steps. Raises Trapped, UndefinedControl or ClaimBroken."""
    s = _State({v: w.entry[n] for n, v in fn.params}, dict(fn.tokens))
    env = s.env
    private = [(r.name, w.frame + r.lo, w.frame + r.hi) for r in fn.regions if r.private]

    def val(a: Arg):
        return a.value if isinstance(a, Const) else env[a]

    def must(a: Arg) -> int:
        v = val(a)
        if v is UNDEF:
            raise UndefinedControl
        return v  # type: ignore[return-value]

    def tokens(o) -> None:
        for m in o.mem:
            if s.current[m.region] != m.before:
                raise ClaimBroken("a token that is not current")
            if m.after is not None:
                s.current[m.region] = m.after

    def claim(o: Op, addr: int, size: int) -> None:
        named = {m.region for m in o.mem}
        for name, lo, hi in private:
            if addr < hi and lo < addr + size:
                if name not in named or not (lo <= addr and addr + size <= hi):
                    raise ClaimBroken("a private region reached from outside")

    prev, k = -1, 0
    for _ in range(steps):
        b = fn.blocks[k]
        new = {p.id: dict(p.args)[prev] for p in b.phis}
        incoming = {p.id: (new[p.id] if p.region is not None else val(new[p.id])) for p in b.phis}
        for p in b.phis:
            if p.region is not None:
                if s.current[p.region] != incoming[p.id]:
                    raise ClaimBroken("a token that is not current")
                s.current[p.region] = p.id
            else:
                env[p.id] = incoming[p.id]
        for o in b.ops:
            kind = o.kind
            if o.mem:
                tokens(o)
            if kind == FRAME:
                env[o.defs[0]] = (w.frame + o.attr("off")) & MASK  # type: ignore[operator]
            elif o.pure:
                args = [val(a) for a in o.args]
                if kind == "ite":
                    env[o.defs[0]] = UNDEF if args[0] is UNDEF else (args[1] if args[0] else args[2])
                elif any(a is UNDEF for a in args):
                    env[o.defs[0]] = UNDEF
                elif kind in OPAQUE:
                    env[o.defs[0]] = w.opaque(kind, args[0])  # type: ignore[arg-type]
                else:
                    env[o.defs[0]] = apply(kind, args, [fn.width(a) for a in o.args], fn.width(o.defs[0]))
            elif kind == "load":
                a, n = must(o.args[0]), fn.width(o.defs[0]) // 8
                claim(o, a, n)
                env[o.defs[0]] = w.read(a, n)
            elif kind == "store":
                a, n = must(o.args[0]), fn.width(o.args[1]) // 8
                claim(o, a, n)
                w.write(a, n, val(o.args[1]))
            elif kind == "trap":
                if must(o.args[0]):
                    raise Trapped(str(o.attr("why")))
            elif kind in ("blockcopy", "blockfill"):
                size = int(o.attr("size")) if kind == "blockcopy" else fn.width(o.args[1]) // 8  # type: ignore[call-overload]
                step = -size if must(o.args[3]) else size
                d, src = must(o.args[0]), val(o.args[1])
                for _n in range(must(o.args[2])):
                    claim(o, d, size)
                    if kind == "blockcopy":
                        claim(o, src, size)  # type: ignore[arg-type]
                        w.write(d, size, w.read(src, size))  # type: ignore[arg-type]
                        src = (src + step) & MASK  # type: ignore[operator]
                    else:
                        w.write(d, size, src)
                    d = (d + step) & MASK
            elif kind == "call":
                names = o.attr("args")
                w.sees([(r.lo, r.hi) for r in fn.regions if r.private for m in o.mem if m.region == r.name and m.after is None])
                left = w.call(must(o.args[0]), dict(zip(names, map(val, o.args[1:]))), (w.frame + int(o.attr("sp"))) & MASK)  # type: ignore[call-overload,arg-type]
                for n, v in zip(o.attr("defs"), o.defs):  # type: ignore[arg-type]
                    env[v] = left[n]
        t = b.term
        tokens(t)
        if t.kind == "goto":
            to = t.targets[0]
        elif t.kind == "branch":
            to = t.targets[0] if must(t.args[0]) else t.targets[1]
        elif t.kind == "switch":
            at = must(t.args[0])
            goes = dict(t.attr("cases"))  # type: ignore[call-overload]
            if at not in goes:
                raise ClaimBroken("a switch to an address that is no case")
            to = goes[at]
        elif t.kind == "return":
            return Exit("return", None, tuple(zip((*t.attr("results"), *t.attr("preserved")), map(val, t.args))))  # type: ignore[misc]
        elif t.kind == "tail":
            return Exit("tail", must(t.args[0]), tuple(zip((*t.attr("args"), *t.attr("preserved")), map(val, t.args[1:]))))  # type: ignore[misc]
        else:
            return Exit("unreachable")
        prev, k = k, to
    return None
