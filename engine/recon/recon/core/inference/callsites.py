# SPDX-License-Identifier: AGPL-3.0-or-later
"""What a caller's normal form says, at each direct call, for the signature of the function it calls (P8, D8-002, D8-005).

Like `sites.call_sites`, read off one normal form; unlike it, each call also says which argument locations hold nothing
the caller ever had (`left`), which is evidence that the callee takes no argument there; a constant has no width of its
own (0: it takes its parameter's); and a value's width is seen through a pair to the part the caller wrote.

It is its own module, filed with the analysis (`ANALYSIS_ROOTS`) and not with the readings of `sites.py` (`SITE_ROOTS`),
so that adding it does not read every site of the program again: it is read only for the callers of a function whose own
code gives no signature (D8-005).
"""
from __future__ import annotations

from typing import Callable

from recon.core.inference.signature import Convention
from recon.core.inference.sites import caller_set
from recon.core.ir.model import Arg, Const, Fn, Op


def written_width(fn: Fn, d: dict, v: Arg) -> int:
    """The width a value was computed in: a 32-bit write zero-extends to the whole register; a narrower write, or a
    scalar floating write, keeps the rest of the register, which is then the high part of a pair."""
    o = d.get(v) if isinstance(v, int) else None
    if isinstance(o, Op) and o.kind == "zext":
        return written_width(fn, d, o.args[0])
    if isinstance(o, Op) and o.kind == "cat":
        return written_width(fn, d, o.args[1])
    return v.width if isinstance(v, Const) else fn.width(v)


def left_behind(fn: Fn, conv: Convention, d: dict) -> Callable[[Arg], bool]:
    """Whether a value in an argument location at a call holds nothing the caller ever had: undefined, or what an earlier
    call left in a location other than its result (the convention lets a callee leave anything there). A merge is left
    behind when every one of its values is (the greatest fixed point over merges of merges)."""
    results = (conv.result_int, conv.result_float)
    left: set[int] = set()
    for b in fn.blocks:
        for o in (*b.ops, b.term):
            if o.kind == "call":
                for n, v in zip(o.attr("defs") or (), o.defs):  # type: ignore[call-overload]
                    if n not in results:
                        left.add(v)
    for v, o in d.items():
        if isinstance(o, Op) and o.kind == "undef":
            left.add(v)
    merges = {v: [a for _k, a in o.args] for v, o in d.items() if o is not None and not isinstance(o, Op)}
    gone = {v for v, xs in merges.items() if all(isinstance(a, int) for a in xs)}
    changed = True
    while changed:
        changed = False
        for v in sorted(gone):
            if not all(a in left or a in gone for a in merges[v]):
                gone.discard(v)
                changed = True
    left |= gone
    return lambda v: isinstance(v, int) and v in left


def call_evidence(fn: Fn, conv: Convention) -> dict[str, list[dict]]:
    """Per direct call (tails left out, as in `sites.call_sites`), by the callee's address: `set`, the argument locations
    the caller puts a value of its own in, with the width it wrote (0 for a constant); `left`, those that hold nothing it
    ever had; `reads`, the result locations whose value it uses after the call, with the width. A location it merely
    passes on from its own entry is neither set nor left."""
    d = {v: o for v, (_b, o) in fn.defining().items()}
    own = caller_set(fn, conv, d)
    gone = left_behind(fn, conv, d)
    uses: dict[int, int] = {}          # a value that only reaches a return may merely have been left there: not a use
    for b in fn.blocks:
        for a in [a for o in b.ops for a in o.args] + [a for p in b.phis for _k, a in p.args] + (list(b.term.args) if b.term.kind != "return" else []):
            if isinstance(a, int):
                uses[a] = uses.get(a, 0) + 1
    out: dict[str, list[dict]] = {}
    for b in fn.blocks:
        for o in b.ops:
            if o.kind != "call" or not o.args or not isinstance(o.args[0], Const):
                continue
            put, left = [], []
            for n, v in zip(o.attr("args") or (), o.args[1:]):  # type: ignore[call-overload]
                if isinstance(v, Const):
                    put.append([n, 0])
                elif own(v, n):
                    put.append([n, written_width(fn, d, v)])
                elif gone(v):
                    left.append(n)
            reads = [[n, fn.width(v)] for n, v in zip(o.attr("defs") or (), o.defs)  # type: ignore[call-overload]
                     if n in (conv.result_int, conv.result_float) and uses.get(v, 0)]
            out.setdefault(str(o.args[0].value), []).append({"set": sorted(put), "reads": sorted(reads), "left": sorted(left)})
    return out


__all__ = ["call_evidence", "left_behind", "written_width"]
