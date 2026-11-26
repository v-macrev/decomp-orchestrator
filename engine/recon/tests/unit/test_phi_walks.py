# SPDX-License-Identifier: AGPL-3.0-or-later
"""The walks through phis that read a function's result: each value looked at once, with the answers the walks that
followed every path gave. The path-following walks are kept here, verbatim, as the reference."""
from __future__ import annotations

import random
import time

from recon.core.inference import signature as sg
from recon.core.ir.model import Op, Phi
from recon.core.sem import Const


class Widths:
    def __init__(self, widths: dict[int, int]) -> None:
        self.widths = widths

    def width(self, a) -> int:
        return a.width if isinstance(a, Const) else self.widths[a]


# ------------------------------------------------------------------------------------ the reference: every path

def zero_above_by_paths(fn, d, a, w, seen=frozenset()) -> bool:
    if isinstance(a, Const):
        return a.value >> w == 0
    if a in seen:
        return True
    o = d.get(a)
    if isinstance(o, Phi):
        return all(zero_above_by_paths(fn, d, x, w, seen | {a}) for _k, x in o.args)
    if isinstance(o, Op):
        if o.kind == "zext":
            return fn.width(o.args[0]) <= w or zero_above_by_paths(fn, d, o.args[0], w, seen)
        if o.kind == "and":
            return any(zero_above_by_paths(fn, d, x, w, seen) for x in o.args)
        if o.kind == "ite":
            return all(zero_above_by_paths(fn, d, x, w, seen) for x in o.args[1:])
        if o.kind == "lshr" and isinstance(o.args[1], Const):
            return fn.width(a) - o.args[1].value <= w
    return False


def by_chance_by_paths(d, uses, given, constants, a, via=0, seen=frozenset()) -> bool:
    if isinstance(a, Const):
        return a.value in constants
    if a in seen:
        return True
    o = d.get(a)
    if isinstance(o, Phi):
        return all(by_chance_by_paths(d, uses, given, constants, x, 1, seen | {a}) for _k, x in o.args)
    if isinstance(o, Op) and o.kind in ("zext", "trunc", "cat", "and") and uses.get(a, 0) <= via and not isinstance(o.args[-1], Const):
        return by_chance_by_paths(d, uses, given, constants, o.args[-1], 1, seen)
    return a in given or uses.get(a, 0) > via or isinstance(o, Op) and o.kind == "call"


# ------------------------------------------------------------------------------------ random value graphs

KINDS = ("phi", "phi", "phi", "zext", "trunc", "cat", "and", "ite", "lshr", "add", "call", "param")


def graph(rng: random.Random, n: int):
    """Values 1..n, each a phi or an operation over values and constants, as SSA has them: an operation uses values
    defined before it, a phi any value (a loop), so every cycle passes through a phi."""
    def arg(below: int):
        if below <= 1 or rng.random() < 0.2:
            return Const(rng.choice((0, 1, 7, 1 << 40)), 64)
        return rng.randint(1, below - 1)
    d, widths = {}, {}
    for v in range(1, n + 1):
        widths[v] = rng.choice((8, 16, 32, 64))
        k = rng.choice(KINDS)
        if k == "phi":
            d[v] = Phi(v, tuple((b, arg(n + 1)) for b in range(rng.randint(1, 3))))
        elif k == "lshr":
            d[v] = Op("lshr", (v,), (arg(v), Const(rng.choice((0, 16, 32, 40)), 8)))
        elif k == "ite":
            d[v] = Op("ite", (v,), (arg(v), arg(v), arg(v)))
        elif k in ("zext", "trunc"):
            d[v] = Op(k, (v,), (arg(v),))
        elif k != "param":
            d[v] = Op(k, (v,), (arg(v), arg(v)))
    uses = {v: rng.randint(0, 2) for v in range(1, n + 1)}
    given = {v for v in range(1, n + 1) if rng.random() < 0.15}
    constants = {0, 7} if rng.random() < 0.5 else {1}
    return d, Widths(widths), uses, given, constants


def test_the_walks_give_what_following_every_path_gave():
    rng = random.Random(20261126)
    compared = 0
    for _ in range(1500):
        n = rng.randint(1, 11)
        d, fn, uses, given, constants = graph(rng, n)
        for v in range(1, n + 1):
            for w in (8, 32):
                assert sg._zero_above(fn, d, v, w) == zero_above_by_paths(fn, d, v, w), (d, v, w)
            assert sg._by_chance(d, uses, given, constants, v) == by_chance_by_paths(d, uses, given, constants, v), (d, v)
            compared += 1
    assert compared > 5000


def test_a_ladder_of_merges_costs_its_size_not_its_paths():
    d, widths = {}, {}
    n = 60
    d[1] = Op("add", (1,), (Const(1, 64), Const(2, 64)))
    widths[1] = 64
    for r in range(n):                                  # v[r+1] = phi(zext? v[r], v[r]) twice over: 2**60 paths
        lo, mid, hi = 1 + 2 * r, 2 + 2 * r, 3 + 2 * r
        d[mid] = Phi(mid, ((0, lo), (1, lo)))
        d[hi] = Phi(hi, ((0, mid), (1, lo)))
        widths[mid] = widths[hi] = 64
    top = 1 + 2 * n
    fn = Widths(widths)
    uses = {v: 0 for v in widths}
    t0 = time.monotonic()
    assert sg._zero_above(fn, d, top, 32) is False      # the add at the bottom may set any bit
    assert sg._by_chance(d, uses, set(), set(), top) is False
    assert sg._by_chance(d, {**uses, 1: 2}, set(), set(), top) is True
    assert time.monotonic() - t0 < 1.0
