# SPDX-License-Identifier: AGPL-3.0-or-later
"""Compiler-undo hypotheses: what an optimiser may have been given, read off what it produced.

A hypothesis never changes a function. It names a value, an expression that is equal to it for every input, and the
readings of that expression a source could have had; machine code does not say which. `verify` proves the equality
(by SMT, or by a theorem whose premises are integers it checks), and a hypothesis that is not proved is dropped.
Nothing here knows any target: every recogniser works on the shape of the IR alone.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Union

from recon.core.analysis import graph
from recon.core.ir.model import Arg, Const, Fn, Op, Phi

# an expression over values of the function: a value, a constant, or (operation, operands, width)
Expr = Union[int, Const, tuple]

SMT, THEOREM, STRUCTURE = "smt", "theorem", "structure"


@dataclass(frozen=True, slots=True)
class Hypothesis:
    kind: str
    value: int                       # the value it is about, or -1 for memory and control
    at: tuple[int, ...]              # the instructions it is about
    expr: Expr | None
    readings: tuple[str, ...]        # in a fixed order, which says nothing about likelihood
    proof: str
    detail: tuple[tuple[str, int], ...] = ()

    def to_data(self) -> list:
        def e(x):
            return ["c", x.value, x.width] if isinstance(x, Const) else ["v", x] if isinstance(x, int) else [x[0], [e(a) for a in x[1]], x[2]] if x is not None else None
        return [self.kind, self.value, list(self.at), e(self.expr), list(self.readings), self.proof, [list(d) for d in self.detail]]


# ---------------------------------------------------------------------------------------- arithmetic theorems

def unsigned_magic(m: int, k: int, w: int) -> int | None:
    """The d >= 2 with floor(m * x / 2**k) == floor(x / d) for every 0 <= x < 2**w, when the theorem below shows one.

    If 2**k <= m * d <= 2**k + 2**(k - w), then x/d <= m*x/2**k < x/d + 1/d for 0 <= x < 2**w, and no integer lies strictly
    between x/d and x/d + 1/d."""
    if m <= 0 or k < w:
        return None
    d = -(-(1 << k) // m)
    if 2 <= d < 1 << w and (1 << k) <= m * d <= (1 << k) + (1 << (k - w)):
        return d
    return None


def signed_magic(m: int, k: int, w: int) -> int | None:
    """The d, |d| >= 2, with floor(m * x / 2**k) + (1 when that is negative) == x / d towards zero, for every -2**(w-1) <= x < 2**(w-1).

    For m > 0 the bounds are those above with one bit less. For m < 0 the sum is the negated quotient provided m*x/2**k is no
    integer for 0 < x < 2**(w-1), which the bounds exclude: with n = 2**k / gcd(a, 2**k) < 2**(w-1) they would put the whole number a * d * n / 2**k strictly between n and n + 1."""
    if m == 0 or k < w - 1:
        return None
    a = abs(m)
    d = -(-(1 << k) // a)
    if not 2 <= d < 1 << (w - 1) or not (1 << k) < a * d <= (1 << k) + (1 << (k - w + 1)):
        return None
    # x = -2**(w-1) is the one input of that size: m*x/2**k must still lie in the same gap, whose far end belongs to it when m > 0
    if a * (1 << (w - 1)) * d + (m < 0) > ((1 << (w - 1)) + 1) * (1 << k):
        return None
    return d if m > 0 else -d


# ---------------------------------------------------------------------------------------- matching

class Match:
    def __init__(self, fn: Fn) -> None:
        self.fn = fn
        self.d = {v: o for v, (_b, o) in fn.defining().items()}

    def op(self, a: Arg, kind: str) -> Op | None:
        o = self.d.get(a) if isinstance(a, int) else None
        return o if isinstance(o, Op) and o.kind == kind else None

    def with_const(self, a: Arg, kind: str) -> tuple[Arg, int] | None:
        o = self.op(a, kind)
        if o is not None and isinstance(o.args[1], Const):
            return o.args[0], o.args[1].value
        return None

    def sign(self, a: Arg) -> Arg | None:
        """x when `a` is all sign bits of x."""
        s = self.with_const(a, "ashr")
        return s[0] if s and s[1] == self.fn.width(a) - 1 else None

    def root(self, a: Expr) -> Expr:
        """`a`, spelled out when it is the lower part of a wider value, so that two spellings of one lower part are equal."""
        o = self.op(a, "trunc") if isinstance(a, int) else None
        return ("trunc", o.args, self.fn.width(a)) if o is not None else a  # type: ignore[arg-type]

    def wide(self, a: Expr) -> int:
        return a[2] if isinstance(a, tuple) else self.fn.width(a)

    def product(self, a: Arg) -> tuple[str, Expr, int, int] | None:
        """(extension, x, constant, width of the product) for ext(x) * constant."""
        o = self.op(a, "mul")
        if o is None or not isinstance(o.args[1], Const):
            return None
        low = self.with_const(o.args[0], "and")
        if low is not None and low[1] == 0xFFFFFFFF and o.args[1].width == 64:
            return "zext", ("trunc", (low[0],), 32), o.args[1].value, 64  # zero-extending a lower part is written as a mask
        for e in ("zext", "sext"):
            x = self.op(o.args[0], e)
            if x is not None:
                return e, self.root(x.args[0]), o.args[1].value, o.args[1].width
        return None

    def high(self, a: Arg) -> tuple[str, Expr, int, int, int] | None:
        """(extension, x, constant, product width, shift) when `a` is the product's upper part: trunc(product >> shift), or the same without trunc."""
        shift = 0
        kind = None
        for _ in range(4):
            o = self.d.get(a) if isinstance(a, int) else None
            if not isinstance(o, Op):
                return None
            if o.kind == "trunc":
                a = o.args[0]
            elif o.kind in ("lshr", "ashr") and isinstance(o.args[1], Const):
                if kind is not None and self.op(o.args[0], "mul") is None:
                    return None
                kind = o.kind
                shift += o.args[1].value
                a = o.args[0]
            elif o.kind == "mul":
                p = self.product(a)
                return (*p, shift) if p else None
            else:
                return None
        return None

    def tree(self, a: Arg, leaves: set[int], limit: int = 64) -> Expr | None:
        """The expression that defines `a` down to `leaves`; None when it is not all pure or too large."""
        count = 0

        def go(x: Arg) -> Expr | None:
            nonlocal count
            if not isinstance(x, int) or x in leaves:
                return x
            o = self.d.get(x)
            count += 1
            if not isinstance(o, Op) or not o.pure or o.kind in ("undef", "frame") or count > limit:
                return None
            args = tuple(go(y) for y in o.args)
            return None if any(y is None for y in args) else (o.kind, args, self.fn.width(x))
        return go(a)


def linear(m: Match, a: Arg, depth: int = 8) -> dict:
    """`a` as a sum of leaves (or lower parts of leaves) times constants, modulo its width. A leaf alone is {a: 1}; the constant part has key None."""
    w = m.fn.width(a)
    mask = (1 << w) - 1
    out: dict = {}

    def add(x: Arg, f: int, n: int) -> None:
        if isinstance(x, Const):
            out[None] = (out.get(None, 0) + f * x.value) & mask
            return
        o = m.d.get(x)
        # the low w bits of a sum are the sum of the low w bits
        if n and isinstance(o, Op) and (o.kind == "trunc" or o.kind in ("zext", "sext") and m.fn.width(o.args[0]) >= w):
            add(o.args[0], f, n - 1)
            return
        if n and isinstance(o, Op):
            if o.kind == "add":
                add(o.args[0], f, n - 1)
                add(o.args[1], f, n - 1)
                return
            if o.kind == "sub":
                add(o.args[0], f, n - 1)
                add(o.args[1], -f, n - 1)
                return
            if o.kind == "neg":
                add(o.args[0], -f, n - 1)
                return
            if o.kind == "mul" and isinstance(o.args[1], Const):
                add(o.args[0], f * o.args[1].value, n - 1)
                return
            if o.kind == "shl" and isinstance(o.args[1], Const) and o.args[1].value < w:
                add(o.args[0], f << o.args[1].value, n - 1)
                return
        key = x if m.fn.width(x) == w else ("trunc", (x,), w)
        out[key] = (out.get(key, 0) + f) & mask
    add(a, 1, depth)
    return {k: v for k, v in out.items() if v}


def _power(v: int) -> int | None:
    return v.bit_length() - 1 if v > 0 and v & (v - 1) == 0 else None


def _c(v: int, w: int) -> Const:
    return Const(v & ((1 << w) - 1), w)


# ---------------------------------------------------------------------------------------- recognisers

def _division(m: Match, v: int, o: Op) -> Iterator[Hypothesis]:
    w = m.fn.width(v)
    if w not in (32, 64):
        return
    # -- unsigned: upper part of x * constant, shifted further
    h = m.high(v)
    if h is not None:
        ext, x, c, pw, k = h
        xw = m.wide(x)
        # the product must not wrap, and what is cut off above the result must be zero
        if ext == "zext" and c * ((1 << xw) - 1) < 1 << pw and xw <= w and _exact_shift(m, v, pw):
            d = unsigned_magic(c, k, xw)
            if d is not None and _power(d) is None:
                e: Expr = ("udiv", (x, _c(d, xw)), xw)
                yield Hypothesis("unsigned-division", v, o.at, e if xw == w else ("zext", (e,), w), ("division",), THEOREM, (("divisor", d), ("multiplier", c), ("shift", k)))
    # -- unsigned, multiplier one bit too wide: ((x - h) >> 1) + h, shifted on
    s = m.with_const(v, "lshr")
    add = m.op(s[0], "add") if s else None
    if s and add is not None:
        for p, q in (add.args, add.args[::-1]):
            half = m.with_const(p, "lshr")
            diff = m.op(half[0], "sub") if half and half[1] == 1 else None
            hi = m.high(q)
            if diff is not None and hi is not None and diff.args[1] == q and hi[0] == "zext" and hi[1] == m.root(diff.args[0]) and hi[4] == w == m.wide(hi[1]) and hi[3] == 2 * w and hi[2] < 1 << w:
                d = unsigned_magic(hi[2] + (1 << w), w + 1 + s[1], w)
                if d is not None:
                    yield Hypothesis("unsigned-division", v, o.at, ("udiv", (hi[1], _c(d, w)), w), ("division",), THEOREM, (("divisor", d), ("multiplier", hi[2] + (1 << w)), ("shift", w + 1 + s[1])))
    # -- signed: q + (q < 0), q = (upper part of x * constant, +- x) >> s
    if o.kind == "add":
        for q, b in (o.args, o.args[::-1]):
            top = m.with_const(b, "lshr")
            if top is None or top[1] != w - 1:
                continue
            by_quotient = top[0] == q
            s = m.with_const(q, "ashr")
            part, sh = (s[0], s[1]) if s else (q, 0)
            got = _signed_part(m, part, w)
            if got is None and s is None:
                continue
            if got is None:
                got = _signed_part(m, q, w)
                sh = 0
            if got is None:
                continue
            x, c, k = got
            if not by_quotient and not (m.root(top[0]) == x and c > 0):
                continue
            d = signed_magic(c, k + sh, w)
            if d is not None:
                yield Hypothesis("signed-division", v, o.at, ("sdiv", (x, _c(d, w)), w), ("division",), THEOREM, (("divisor", d), ("multiplier", c), ("shift", k + sh)))
    # -- signed, powers of two: (x + (sign & (2**k - 1))) >> k
    s = m.with_const(v, "ashr")
    if s:
        k = s[1]
        x = _biased(m, s[0], w, k)
        if x is not None and 0 < k < w - 1:
            yield Hypothesis("signed-division", v, o.at, ("sdiv", (x, _c(1 << k, w)), w), ("division",), SMT, (("divisor", 1 << k),))
    # -- signed remainder by a power of two: ((x + t) & (2**k - 1)) - t
    if o.kind == "sub":
        a = m.with_const(o.args[0], "and")
        add = m.op(a[0], "add") if a else None
        k2 = _power(a[1] + 1) if a else None
        if add is not None and k2 and o.args[1] in add.args:
            x = add.args[0] if add.args[1] == o.args[1] else add.args[1]
            if _bias(m, o.args[1], w, k2) == x:
                yield Hypothesis("signed-remainder", v, o.at, ("srem", (x, _c(1 << k2, w)), w), ("remainder",), SMT, (("divisor", 1 << k2),))


def _exact_shift(m: Match, v: int, pw: int) -> bool:
    """The chain from the product to v cuts only bits that are zero: every trunc happens after all bits above were shifted out or is the last."""
    a: Arg = v
    left = None
    chain = []
    while isinstance(a, int):
        o = m.d[a]
        assert isinstance(o, Op)
        if o.kind == "mul":
            break
        chain.append(o)
        a = o.args[0]
    # upwards: `have` is how many bits may be set; a trunc must keep all of them
    have = pw
    for o in reversed(chain):
        if o.kind == "trunc":
            if m.fn.width(o.defs[0]) < have:
                return False
        elif o.kind == "lshr":
            have -= o.args[1].value  # type: ignore[union-attr]
        else:
            return False
        left = have
    return left is not None and have > 0


def _signed_part(m: Match, a: Arg, w: int) -> tuple[Expr, int, int] | None:
    """(x, signed multiplier, shift) when `a` is floor(multiplier * x / 2**shift) with shift >= w, possibly mended by adding or subtracting x."""
    def signed(c: int, n: int) -> int:
        return c - (1 << n) if c >> (n - 1) else c

    def upper(q: Arg) -> tuple[Expr, int, int] | None:
        """trunc(ext(x) * constant >> shift), all of whose bits are the quotient's."""
        tr = m.op(q, "trunc")
        for how in ("ashr", "lshr"):
            s = m.with_const(tr.args[0], how) if tr is not None else None
            p = m.product(s[0]) if s else None
            if s and p and p[0] == "sext" and m.wide(p[1]) == w and p[3] == 2 * w and w <= s[1] < 2 * w and (how == "ashr" or s[1] == w):
                c = signed(p[2], 2 * w)
                if -(1 << (w - 1)) <= c < 1 << (w - 1):
                    return p[1], c, s[1]
        return None

    h = upper(a)
    if h is not None:
        return h
    for kind, f in (("add", 1), ("sub", -1)):
        o = m.op(a, kind)
        if o is None:
            continue
        for q, x in ((o.args, o.args[::-1]) if kind == "add" else (o.args,)):
            h = upper(q)
            if h is not None and h[0] == m.root(x) and h[2] == w:
                c = h[1] + f * (1 << w)
                if abs(c) < 1 << w:  # the sum has the sign a full-width product would have, so it did not wrap
                    return x, c, w
    return None


def _bias(m: Match, t: Arg, w: int, k: int) -> Arg | None:
    """x when t is 2**k - 1 for negative x and 0 otherwise."""
    a = m.with_const(t, "and")
    if a and a[1] == (1 << k) - 1:
        return m.sign(a[0])
    s = m.with_const(t, "lshr")
    if s and s[1] == w - k:
        x = m.sign(s[0])
        return x if x is not None else (s[0] if k == 1 else None)
    return None


def _biased(m: Match, a: Arg, w: int, k: int) -> Arg | None:
    o = m.op(a, "add")
    if o is not None:
        for x, t in (o.args, o.args[::-1]):
            if _bias(m, t, w, k) == x:
                return x
    o = m.op(a, "sub")
    if o is not None and k == 1 and m.sign(o.args[1]) == o.args[0]:
        return o.args[0]
    return None


def _small(m: Match, v: int, o: Op) -> Iterator[Hypothesis]:
    w = m.fn.width(v)
    if o.kind == "lshr" and isinstance(o.args[1], Const) and 0 < o.args[1].value < w <= 64 and w >= 8:
        yield Hypothesis("shift-or-division", v, o.at, ("udiv", (o.args[0], _c(1 << o.args[1].value, w)), w), ("shift", "division"), SMT, (("divisor", 1 << o.args[1].value),))
    if o.kind == "and" and isinstance(o.args[1], Const) and 8 <= w <= 64:
        k = _power(o.args[1].value + 1)
        if k and k < w:
            yield Hypothesis("mask-or-remainder", v, o.at, ("urem", (o.args[0], _c(1 << k, w)), w), ("mask", "remainder", "narrowing") if k in (8, 16, 32) else ("mask", "remainder"), SMT, (("divisor", 1 << k),))
    if o.kind == "shl" and isinstance(o.args[1], Const) and 0 < o.args[1].value < w <= 64 and w >= 8:
        yield Hypothesis("shift-or-multiplication", v, o.at, ("mul", (o.args[0], _c(1 << o.args[1].value, w)), w), ("shift", "multiplication"), SMT, (("factor", 1 << o.args[1].value),))
    # -- multiplication by a constant, spelled as additions and shifts
    if o.kind in ("add", "sub") and 32 <= w <= 64:
        form = linear(m, v)
        rest = [(x, f) for x, f in form.items() if x is not None]
        if len(rest) == 1 and None not in form and rest[0][1] not in (1, (1 << w) - 1):
            x, f = rest[0]
            yield Hypothesis("multiplication", v, o.at, ("mul", (x, _c(f, w)), w), ("multiplication", "sum-of-shifts"), SMT, (("factor", f),))
    # -- absolute value
    if o.kind == "sub":
        x2 = m.op(o.args[0], "xor")
        if x2 is not None and o.args[1] in x2.args:
            x = x2.args[0] if x2.args[1] == o.args[1] else x2.args[1]
            if m.sign(o.args[1]) == x:
                yield Hypothesis("absolute-value", v, o.at, ("ite", (("slt", (x, _c(0, w)), 1), ("neg", (x,), w), x), w), ("abs", "conditional"), SMT)
    # -- a mask made from a condition
    if o.kind == "and":
        for p, q in (o.args, o.args[::-1]):
            s = m.op(p, "sext")
            if s is not None and m.fn.width(s.args[0]) == 1:
                yield Hypothesis("masked-value", v, o.at, ("ite", (s.args[0], q, _c(0, w)), w), ("conditional", "mask"), SMT)
    if o.kind == "add" and isinstance(o.args[1], Const):
        a = m.op(o.args[0], "and")
        if a is not None and isinstance(a.args[1], Const):
            s = m.op(a.args[0], "sext")
            if s is not None and m.fn.width(s.args[0]) == 1:
                yield Hypothesis("chosen-constant", v, o.at, ("ite", (s.args[0], _c(a.args[1].value + o.args[1].value, w), _c(o.args[1].value, w)), w), ("conditional",), SMT)
    # -- a range, tested with one comparison
    if o.kind in ("ult", "ule") and isinstance(o.args[1], Const):
        lw = o.args[1].width
        base = m.with_const(o.args[0], "sub")
        lo = base[1] if base else None
        if base is None and (base := m.with_const(o.args[0], "add")):
            lo = -base[1] & ((1 << lw) - 1)
        if base is not None and lo:
            n = o.args[1].value - (o.kind == "ult")
            hi = lo + n
            if n > 0:
                if hi < 1 << lw:
                    yield Hypothesis("range-test", v, o.at, ("and", (("ule", (_c(lo, lw), base[0]), 1), ("ule", (base[0], _c(hi, lw)), 1)), 1), ("two-unsigned-comparisons", "one-comparison"), SMT,
                                     (("low", lo), ("high", hi)))
                slo = lo - (1 << lw) if lo >> (lw - 1) else lo
                if slo + n < 1 << (lw - 1):
                    yield Hypothesis("range-test", v, o.at, ("and", (("sle", (_c(slo, lw), base[0]), 1), ("sle", (base[0], _c(slo + n, lw)), 1)), 1), ("two-signed-comparisons", "one-comparison"), SMT,
                                     (("low", slo), ("high", slo + n)))
    # -- one of two values
    if o.kind == "ite":
        c, x, y = o.args
        cmp = m.d.get(c) if isinstance(c, int) else None
        if isinstance(cmp, Op) and cmp.kind in ("slt", "sle", "ult", "ule", "flt", "fle") and set(cmp.args) == {x, y}:
            kind = "minimum" if cmp.args == (x, y) else "maximum"
            yield Hypothesis(kind, v, o.at, (o.kind, (c, x, y), w), (kind, "conditional", "branch"), STRUCTURE)
        else:
            yield Hypothesis("conditional-value", v, o.at, (o.kind, (c, x, y), w), ("conditional", "branch"), STRUCTURE)


def _remainders(m: Match, found: list[Hypothesis]) -> Iterator[Hypothesis]:
    """x - (x / d) * d, where x / d was recognised."""
    quotient = {h.value: h for h in found if h.kind in ("unsigned-division", "signed-division") and isinstance(h.expr, tuple) and h.expr[0] in ("udiv", "sdiv")}
    for _b, o in m.fn.ops():
        if o.kind not in ("sub", "add") or not o.defs:
            continue
        v = o.defs[0]
        w = m.fn.width(v)
        if w not in (32, 64):
            continue
        form = linear(m, v)
        rest = {m.root(x) if x is not None else None: f for x, f in form.items()}
        for q, f in form.items():
            h = quotient.get(q) if isinstance(q, int) else None
            if h is None or set(rest) != {m.root(q), h.expr[1][0]} or rest[h.expr[1][0]] != 1:  # type: ignore[index]
                continue
            d = h.expr[1][1].value  # type: ignore[index]
            if f == -d & ((1 << w) - 1):
                kind = "urem" if h.expr[0] == "udiv" else "srem"  # type: ignore[index]
                yield Hypothesis("unsigned-remainder" if kind == "urem" else "signed-remainder", v, o.at, (kind, (h.expr[1][0], _c(d, w)), w), ("remainder", "difference"), THEOREM,  # type: ignore[index]
                                 (("divisor", dict(h.detail)["divisor"]), ("quotient", q)))  # type: ignore[arg-type]


def _memory(m: Match) -> Iterator[Hypothesis]:
    for b in m.fn.blocks:
        for o in b.ops:
            if o.kind == "blockfill":
                yield Hypothesis("fill", -1, o.at, None, ("memset", "fill-loop"), STRUCTURE)
            elif o.kind == "blockcopy":
                yield Hypothesis("copy", -1, o.at, None, ("memcpy", "structure-assignment", "copy-loop"), STRUCTURE)
        # stores of one repeated byte to adjacent places, nothing between them that could see the order
        run: list[tuple[tuple, int, int, Op]] = []

        def close() -> Iterator[Hypothesis]:
            spans = sorted((lo, n) for _k, lo, n, _o in run)
            if len(run) >= 2 and all(a + n == c for (a, n), (c, _n) in zip(spans, spans[1:])):
                yield Hypothesis("fill", -1, tuple(sorted(a for *_x, o in run for a in o.at)), None, ("separate-assignments", "memset", "aggregate-initialisation"), STRUCTURE,
                                 (("bytes", sum(n for _l, n in spans)), ("byte", run[0][0][2])))
        for o in b.ops:
            if o.pure:
                continue
            key = _fill_key(m, o)
            if key is None or run and key[0] != run[0][0]:
                yield from close()
                run = []
            if key is not None:
                run.append((*key, o))
        yield from close()


def _fill_key(m: Match, o: Op) -> tuple[tuple, int, int] | None:
    """((base, region kind, byte), offset, size) for a plain store of a constant that repeats one byte."""
    if o.kind != "store" or o.attr("atomic") or not isinstance(o.args[1], Const):
        return None
    n = o.args[1].width // 8
    raw = o.args[1].value.to_bytes(n, "little")
    if len(set(raw)) != 1:
        return None
    a, off = o.args[0], 0
    add = m.with_const(a, "add")
    if add is not None:
        a, off = add
    d = m.d.get(a) if isinstance(a, int) else None
    if isinstance(a, Const):
        off, a = a.value, -1  # type: ignore[assignment]
    elif isinstance(d, Op) and d.kind == "frame":
        off, a = off + int(d.attr("off")), -2  # type: ignore[call-overload]
    if off >> 63 & 1:
        off -= 1 << 64
    return (a, "s", raw[0]), off, n


def _rotated_loops(m: Match) -> Iterator[Hypothesis]:
    """A loop tested at its end, entered only past the same test made on the values it starts with: a loop tested at its start, turned."""
    fn = m.fn
    loops, _ok = graph.natural_loops(fn.succ, 0)
    preds = fn.preds()
    for lp in loops:
        outside = [p for p in preds[lp.header] if p not in lp.body]
        if len(outside) != 1 or len(lp.latches) != 1:
            continue
        latch, guard = fn.blocks[lp.latches[0]], fn.blocks[outside[0]]
        if guard.term.kind == "goto" and len(preds[guard.id]) == 1:
            entered = guard.id
            guard = fn.blocks[preds[guard.id][0]]
        else:
            entered = lp.header
        if latch.term.kind != "branch" or guard.term.kind != "branch" or entered not in guard.term.targets:
            continue
        stay = latch.term.targets[0] == lp.header
        into = guard.term.targets[0] == entered
        first: dict[int, Arg] = {}
        again: dict[int, Arg] = {}
        for p in fn.blocks[lp.header].phis:
            if p.region is None:
                args = dict(p.args)
                first[p.id], again[p.id] = args[outside[0]], args[latch.id]
        lc, gc = latch.term.args[0], guard.term.args[0]
        if _same(m, lc, gc, {a: first[p] for p, a in again.items() if isinstance(a, int)}, first) and stay == into or _same_equality(m, lc, gc, first, again, stay == into):
            yield Hypothesis("rotated-loop", -1, tuple(sorted({*latch.term.at, *guard.term.at})), None, ("while", "for", "guarded-do-while"), STRUCTURE, (("header", lp.header),))


def _same(m: Match, a: Arg, b: Arg, replace: dict[int, Arg], phis: dict[int, Arg], depth: int = 8) -> bool:
    """Whether `b` is `a` with each value of `replace` (or each phi) replaced by what the loop starts with."""
    if isinstance(a, Const) or isinstance(b, Const):
        return a == b or isinstance(a, int) and replace.get(a, phis.get(a)) == b
    if a in replace and replace[a] == b or a in phis and phis[a] == b:
        return True
    if a == b:
        return a not in replace and a not in phis
    x, y = m.d.get(a), m.d.get(b)
    if depth and isinstance(x, Op) and isinstance(y, Op) and x.pure and x.kind == y.kind and x.attrs == y.attrs and len(x.args) == len(y.args):
        return all(_same(m, p, q, replace, phis, depth - 1) for p, q in zip(x.args, y.args))
    return False


def _same_equality(m: Match, a: Arg, b: Arg, first: dict[int, Arg], again: dict[int, Arg], same_sense: bool) -> bool:
    """The same for an equality, whose sides may have been moved across: both as a sum that is compared with zero."""
    x, y = m.d.get(a) if isinstance(a, int) else None, m.d.get(b) if isinstance(b, int) else None
    if not (isinstance(x, Op) and isinstance(y, Op) and x.kind in ("eq", "ne") and y.kind in ("eq", "ne") and (x.kind == y.kind) == same_sense and m.fn.width(x.args[0]) == m.fn.width(y.args[0])):
        return False
    mask = (1 << m.fn.width(x.args[0])) - 1

    def zero_sum(o: Op) -> dict[Arg, int]:
        out = dict(linear(m, o.args[0]))
        for k, f in linear(m, o.args[1]).items():
            out[k] = (out.get(k, 0) - f) & mask
        return out
    at_start: dict = {}
    for k, f in zero_sum(x).items():
        parts: dict = {k: 1}
        if k in again:  # p at the test is one step behind: what the header will have is p + step
            step = dict(linear(m, again[k]))
            if step.pop(k, 0) != 1 or set(step) - {None}:
                return False
            parts = {**linear(m, first[k]), None: (linear(m, first[k]).get(None, 0) - step.get(None, 0))}
        for q, g in parts.items():
            at_start[q] = (at_start.get(q, 0) + f * g) & mask
    l, r = {k: f for k, f in at_start.items() if f}, {k: f for k, f in zero_sum(y).items() if f}
    return l == r or l == {k: -f & mask for k, f in r.items()}


# ---------------------------------------------------------------------------------------- the list

def propose(fn: Fn) -> list[Hypothesis]:
    """Every hypothesis the recognisers make, in a fixed order, before any is verified."""
    m = Match(fn)
    out: list[Hypothesis] = []
    for _b, o in fn.ops():
        if o.pure and o.defs and isinstance(fn.types[o.defs[0]], int):
            out += _division(m, o.defs[0], o)
            out += _small(m, o.defs[0], o)
    out += _remainders(m, list(out))
    out += _memory(m)
    out += _rotated_loops(m)
    return out


def verify(fn: Fn, h: Hypothesis) -> bool:
    """Whether the hypothesis is proved. A theorem's premises are checked again from the numbers it names; SMT proves the equality itself."""
    if h.proof == STRUCTURE:
        return True  # it claims a form, not an equality: the expression, if any, is the value's own operation
    m = Match(fn)
    if h.proof == THEOREM:
        x = dict(h.detail)
        if h.kind.endswith("remainder"):
            q = x["quotient"]
            o = m.d[q]
            assert isinstance(o, Op)
            return any(g.kind == h.kind.replace("remainder", "division") and dict(g.detail)["divisor"] == x["divisor"] and verify(fn, g) for g in _division(m, q, o))
        e = h.expr[1][0] if h.expr[0] == "zext" else h.expr  # type: ignore[index]
        if e[1][1] != _c(x["divisor"], m.wide(e[1][0])):  # type: ignore[index]
            return False
        width = m.wide(e[1][0])  # type: ignore[index]
        f = signed_magic if h.kind == "signed-division" else unsigned_magic
        if f(x["multiplier"], x["shift"], width) != x["divisor"]:
            return False
        o = m.d.get(h.value)
        return isinstance(o, Op) and h in _division(m, h.value, o)  # the numbers are those of the value's own operations
    from recon.core.ir import smt

    leaves: set[int] = set()

    def collect(e: Expr | None) -> None:
        if isinstance(e, int):
            leaves.add(e)
        elif isinstance(e, tuple):
            for a in e[1]:
                collect(a)
    collect(h.expr)
    tree = m.tree(h.value, leaves)
    if tree is None:
        return False
    z = smt.z3()
    env: dict[int, object] = {}

    def enc(e: Expr):
        if isinstance(e, Const):
            return z.BitVecVal(e.value, e.width)
        if isinstance(e, int):
            return env.setdefault(e, z.BitVec(f"v{e}", fn.width(e)))
        return smt.apply(e[0], [enc(a) for a in e[1]], e[2])
    assert h.expr is not None
    return smt.check(enc(tree) == enc(h.expr)) == smt.PROVED


def accept(fn: Fn, h: Hypothesis) -> Fn:
    """The function with the value computed the way the hypothesis says. Only for a verified hypothesis with an expression."""
    from dataclasses import replace

    from recon.core.ir.build import drop_dead
    from recon.core.ir.model import Block

    if h.expr is None or h.value < 0 or not verify(fn, h):
        raise ValueError("nothing proved to accept")
    types = dict(fn.types)
    blocks = []
    for b in fn.blocks:
        ops: list[Op] = []
        for o in b.ops:
            if not (o.defs and o.defs[0] == h.value):
                ops.append(o)
                continue

            def make(e: Expr) -> Arg:
                if not isinstance(e, tuple):
                    return e
                v = max(types) + 1
                args = tuple(make(a) for a in e[1])
                v = max(types) + 1
                types[v] = e[2]
                ops.append(Op(e[0], (v,), args, (), (), o.at))
                return v
            assert isinstance(h.expr, tuple)
            ops.append(Op(h.expr[0], o.defs, tuple(make(a) for a in h.expr[1]), (), (), o.at))
        blocks.append(Block(b.id, b.start, b.phis, tuple(ops), b.term))
    return drop_dead(replace(fn, blocks=tuple(blocks), types=types), "folded")


def hypotheses(fn: Fn) -> list[Hypothesis]:
    """The proved ones."""
    return [h for h in propose(fn) if verify(fn, h)]


__all__ = ["Hypothesis", "Phi", "accept", "hypotheses", "propose", "signed_magic", "unsigned_magic", "verify"]
