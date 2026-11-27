# SPDX-License-Identifier: AGPL-3.0-or-later
"""What a function's normal form shows of the calls it makes: the functions it calls, and per call site the argument
locations the caller sets and the results it reads; for a call through a value, the signature the site shows.

These are read off one normal form and nothing else, so they are filed beside normal forms, under the code that makes
normal forms and this module (`recon.core.knowledge.SITE_ROOTS`): a change here reads them again without making the
normal forms again.
"""
from __future__ import annotations

from typing import Callable

from recon.core.inference import signature as sg
from recon.core.inference.signature import INT, Convention, Signature, Slot
from recon.core.ir.model import Arg, Const, Fn, Op


def direct_callees(fn: Fn) -> tuple[int, ...]:
    """The addresses a normal form calls or jumps to as a call, in order of first appearance."""
    out: dict[int, None] = {}
    for b in fn.blocks:
        for o in (*b.ops, b.term):
            if o.kind in ("call", "tail") and o.args and isinstance(o.args[0], Const):
                out.setdefault(o.args[0].value, None)
    return tuple(out)


def computed_width(fn: Fn, d: dict, v: Arg) -> int:
    """The width a value was computed in (a 32-bit write zero-extends to the whole register)."""
    o = d.get(v) if isinstance(v, int) else None
    if isinstance(o, Op) and o.kind == "zext":
        return computed_width(fn, d, o.args[0])
    return v.width if isinstance(v, Const) else fn.width(v)


def caller_set(fn: Fn, conv: Convention, d: dict) -> Callable[[Arg, str], bool]:
    """Whether a value in an argument location at a call site is one the caller put there of its own: a constant, or a
    value it computed. Not an entry value it merely passes on, not an undefined one, and not what an earlier call left: the
    convention lets a callee leave anything in the volatile locations other than its result, so a caller never means them
    as arguments, though every call's normal form lists every argument location with whatever it holds. An earlier call's
    result is the caller's when the caller moved it; left where the call put it (the floating result is also the first
    floating argument location) it is not told apart from what any call leaves there, and is not counted. A merge is the
    caller's own when one of its values is (the least fixed point, so a loop of merges of nothing set is not)."""
    params = {v for _n, v in fn.params}
    results = (conv.result_int, conv.result_float)
    left: set[int] = set()
    placed: dict[int, str] = {}                   # an earlier call's result -> where the call left it
    for b in fn.blocks:
        for o in (*b.ops, b.term):
            if o.kind == "call":
                for n, v in zip(o.attr("defs") or (), o.defs):  # type: ignore[call-overload]
                    if n in results:
                        placed[v] = n
                    else:
                        left.add(v)
    own: set[int] = set()
    users: dict[int, list[int]] = {}
    for v, o in d.items():
        if isinstance(o, Op):
            if v not in params and v not in left and o.kind != "undef":
                own.add(v)
        elif o is not None:                       # a merge
            for _k, a in o.args:
                if isinstance(a, Const):
                    own.add(v)
                elif isinstance(a, int):
                    users.setdefault(a, []).append(v)
    work = list(own)
    while work:
        for u in users.get(work.pop(), ()):
            if u not in own:
                own.add(u)
                work.append(u)
    return lambda v, at: isinstance(v, Const) or (isinstance(v, int) and v in own and placed.get(v) != at)


def call_sites(fn: Fn, conv: Convention) -> dict[str, list[dict]]:
    """What a caller's normal form shows of each call it makes (tails are left out: what they pass is the caller's own).

    Per call: `set`, the argument locations the caller puts a value of its own in, with the value's width; `reads`, the
    result locations whose value it uses after the call, with the width. A location it merely passes on from its own entry is
    not set: it may be an argument of the caller that the callee ignores."""
    d = {v: o for v, (_b, o) in fn.defining().items()}
    own = caller_set(fn, conv, d)
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
            put = []
            for n, v in zip(o.attr("args") or (), o.args[1:]):  # type: ignore[call-overload]
                if isinstance(v, Const):
                    put.append([n, 64])
                elif own(v, n):
                    put.append([n, computed_width(fn, d, v)])
            reads = [[n, fn.width(v)] for n, v in zip(o.attr("defs") or (), o.defs)  # type: ignore[call-overload]
                     if n in (conv.result_int, conv.result_float) and uses.get(v, 0)]
            out.setdefault(str(o.args[0].value), []).append({"set": sorted(put), "reads": sorted(reads)})
    return out


def _int_slot(w: int) -> Slot:
    return Slot(INT, next(x for x in (64, 32, 16, 8) if w >= x) if w >= 8 else 64)


def _float_slot(w: int) -> Slot:
    return Slot(sg.FLOAT, 32 if w == 32 else 64)


def indirect_signatures(fn: Fn, conv: Convention) -> dict[int, Signature]:
    """For each value a call jumps through (a virtual call, a function pointer), what the call site shows of its signature:
    arguments up to the last location the caller sets with a value of its own (one it merely passes on below that counts
    too), and a result where the caller reads one. For the signature of the function that makes the call; the call itself
    is still written only when its target is known.

    A tail jump through a value shows nothing: what it passes on is whatever the function was given, and its result is the
    function's own, which no use at the site reads. It has no reading here, so that the function's signature stays unknown
    rather than being read as taking nothing and returning nothing (D-051)."""
    d = {v: o for v, (_b, o) in fn.defining().items()}
    own = caller_set(fn, conv, d)
    uses: dict[int, int] = {}          # a value that only reaches a return may merely have been left there: not a use
    for b in fn.blocks:
        for a in [a for o in b.ops for a in o.args] + [a for p in b.phis for _k, a in p.args] + (list(b.term.args) if b.term.kind != "return" else []):
            if isinstance(a, int):
                uses[a] = uses.get(a, 0) + 1

    def width(v: Arg) -> int:
        return computed_width(fn, d, v)

    out: dict[int, Signature] = {}
    for b in fn.blocks:
        for o in (*b.ops, b.term):
            if o.kind != "call" or not o.args or not isinstance(o.args[0], int) or o.args[0] in out:
                continue
            have = dict(zip(o.attr("args") or (), o.args[1:]))  # type: ignore[call-overload]
            last = max((k for k, (i_loc, f_loc) in enumerate(conv.slots) if (i_loc in have and own(have[i_loc], i_loc)) or (f_loc in have and own(have[f_loc], f_loc))), default=-1)
            slots = []
            for i_loc, f_loc in conv.slots[: last + 1]:
                if i_loc in have and own(have[i_loc], i_loc):
                    slots.append(_int_slot(width(have[i_loc])))
                elif f_loc in have and own(have[f_loc], f_loc):
                    slots.append(_float_slot(width(have[f_loc])))
                else:
                    slots.append(Slot(INT, 64))      # passed on from the caller's own entry
            result = None
            back = dict(zip(o.attr("defs") or (), o.defs))  # type: ignore[call-overload]
            if conv.result_float in back and uses.get(back[conv.result_float], 0):
                result = _float_slot(fn.width(back[conv.result_float]))
            elif conv.result_int in back and uses.get(back[conv.result_int], 0):
                result = _int_slot(fn.width(back[conv.result_int]))
            out[o.args[0]] = Signature(tuple(slots), result, (("indirect", "SITE"),))
    return out


__all__ = ["call_sites", "caller_set", "computed_width", "direct_callees", "indirect_signatures"]
