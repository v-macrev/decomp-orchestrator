# SPDX-License-Identifier: AGPL-3.0-or-later
"""Rewrite rules, as data: a left side, a right side, and conditions, all terms over the same operations.

Every rule is instantiated for explicit widths and, where an operation commutes, for both orders of its arguments, so
that what is applied is exactly what `smt.prove_rule` proves: for all values of its variables and constants, the conditions
imply that both sides are equal. A rule may not have operations that are undefined or opaque on its right side only.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Iterator, Union

from recon.core.evaluate import UNDEF, apply
from recon.core.sem import Const as SConst
from recon.core.sem import result_width

COMMUTES = frozenset({"add", "mul", "and", "or", "xor", "eq", "ne", "feq", "funo"})
WORDS = (8, 16, 32, 64)
WIDE = (1, 8, 16, 32, 64, 128)
CMP = ("eq", "ne", "ult", "ule", "slt", "sle")


@dataclass(frozen=True, slots=True)
class V:
    """Any value of the width."""

    name: str
    width: int


@dataclass(frozen=True, slots=True)
class K:
    """Any constant of the width."""

    name: str
    width: int


@dataclass(frozen=True, slots=True)
class N:
    value: int
    width: int


@dataclass(frozen=True, slots=True)
class T:
    op: str
    args: tuple["Term", ...]
    width: int


Term = Union[V, K, N, T]


def t(op: str, *args: Term, width: int | None = None) -> T:
    return T(op, args, result_width(op, tuple(SConst(0, a.width) for a in args), width))


def n(value: int, width: int) -> N:
    return N(value & ((1 << width) - 1), width)


@dataclass(frozen=True, slots=True)
class Rule:
    name: str
    lhs: T
    rhs: Term
    when: tuple[Term, ...] = ()


def _rules() -> Iterator[Rule]:
    # -- identities -----------------------------------------------------------------------------
    for w in WIDE:
        x, y, z = V("x", w), V("y", w), V("z", w)
        zero, ones = n(0, w), n(-1, w)
        c, d = K("c", w), K("d", w)
        for op in ("add", "or", "xor"):
            yield Rule(f"{op}-zero", t(op, x, zero), x)
        yield Rule("sub-zero", t("sub", x, zero), x)
        yield Rule("and-ones", t("and", x, ones), x)
        yield Rule("and-zero", t("and", x, zero), zero)
        yield Rule("or-ones", t("or", x, ones), ones)
        yield Rule("xor-ones", t("xor", x, ones), t("not", x))
        yield Rule("mul-one", t("mul", x, n(1, w)), x)
        yield Rule("mul-zero", t("mul", x, zero), zero)
        for op in ("sub", "xor"):
            yield Rule(f"{op}-self", t(op, x, x), zero)
        for op in ("and", "or"):
            yield Rule(f"{op}-self", t(op, x, x), x)
        yield Rule("not-not", t("not", t("not", x)), x)
        yield Rule("neg-neg", t("neg", t("neg", x)), x)
        yield Rule("zero-minus", t("sub", zero, x), t("neg", x))
        yield Rule("ite-same", t("ite", V("k", 1), x, x), x)
        yield Rule("ite-not", t("ite", t("not", V("k", 1)), x, y), t("ite", V("k", 1), y, x))
        for op in CMP:
            yield Rule(f"{op}-self", t(op, x, x), n(op in ("eq", "ule", "sle"), 1))
        for op in ("add", "mul", "and", "or", "xor"):
            yield Rule(f"{op}-constants", t(op, t(op, x, c), d), t(op, x, t(op, c, d)))
        yield Rule("sub-add-constants", t("add", t("sub", x, c), d), t("add", x, t("sub", d, c)))
        yield Rule("add-sub-constants", t("sub", t("add", x, c), d), t("add", x, t("sub", c, d)))
        yield Rule("sub-sub-constants", t("sub", t("sub", x, c), d), t("sub", x, t("add", c, d)))
        yield Rule("add-sub-cancel", t("sub", t("add", x, y), y), x)
        yield Rule("sub-add-cancel", t("add", t("sub", x, y), y), x)
        yield Rule("xor-cancel", t("xor", t("xor", x, y), y), x)
        # -- comparisons ------------------------------------------------------------------------
        yield Rule("difference-is-zero", t("eq", t("sub", x, y), zero), t("eq", x, y))
        yield Rule("difference-is-not-zero", t("ne", t("sub", x, y), zero), t("ne", x, y))
        yield Rule("xor-is-zero", t("eq", t("xor", x, y), zero), t("eq", x, y))
        yield Rule("eq-sum-constants", t("eq", t("add", x, c), d), t("eq", x, t("sub", d, c)))
        yield Rule("below-or-equal", t("or", t("ult", x, y), t("eq", x, y)), t("ule", x, y))
        yield Rule("less-or-equal", t("or", t("slt", x, y), t("eq", x, y)), t("sle", x, y))
        yield Rule("equal-or-not", t("and", t("ule", x, y), t("ne", x, y)), t("ult", x, y))
        yield Rule("less-and-not-equal", t("and", t("sle", x, y), t("ne", x, y)), t("slt", x, y))
        yield Rule("at-least-one", t("ult", zero, x), t("ne", x, zero))
        yield Rule("below-one", t("ult", x, n(1, w)), t("eq", x, zero))
        if w > 1:
            # the overflow of a subtraction mends its sign
            r = t("sub", x, y)
            over = t("slt", t("and", t("xor", x, y), t("xor", x, r)), zero)
            yield Rule("signed-less", t("xor", t("slt", r, zero), over), t("slt", x, y))
            yield Rule("below-minimum", t("slt", x, n(1 << (w - 1), w)), n(0, 1))
        for a, b in (("eq", "ne"),):
            yield Rule("not-eq", t("not", t(a, x, y)), t(b, x, y))
            yield Rule("not-ne", t("not", t(b, x, y)), t(a, x, y))
        for a, b in (("ult", "ule"), ("slt", "sle")):
            yield Rule(f"not-{a}", t("not", t(a, x, y)), t(b, y, x))
            yield Rule(f"not-{b}", t("not", t(b, x, y)), t(a, y, x))
        # a conditional between a comparison's operands and its own result
        yield Rule("ite-eq", t("ite", t("eq", x, y), x, y), y)
    # -- one-bit values -------------------------------------------------------------------------
    k = V("k", 1)
    yield Rule("bit-eq-zero", t("eq", k, n(0, 1)), t("not", k))
    yield Rule("bit-ne-zero", t("ne", k, n(0, 1)), k)
    yield Rule("bit-eq-one", t("eq", k, n(1, 1)), k)
    yield Rule("bit-sign", t("slt", k, n(0, 1)), k)
    yield Rule("bit-ite", t("ite", k, n(1, 1), n(0, 1)), k)
    yield Rule("bit-ite-not", t("ite", k, n(0, 1), n(1, 1)), t("not", k))
    for w in (*WORDS, 128):
        one = n(1, w)
        zero = n(0, w)
        for e in ("zext", "sext"):
            yield Rule(f"bool-{e}-eq", t("eq", t(e, k, width=w), zero), t("not", k))
            yield Rule(f"bool-{e}-ne", t("ne", t(e, k, width=w), zero), k)
            yield Rule(f"bool-{e}-sign", t("slt", t(e, k, width=w), zero), n(0, 1) if e == "zext" else k)
        yield Rule("bool-eq-one", t("eq", t("zext", k, width=w), one), k)
        yield Rule("bool-mask", t("neg", t("zext", k, width=w)), t("sext", k, width=w))
        yield Rule("mask-bool", t("neg", t("sext", k, width=w)), t("zext", k, width=w))
        yield Rule("mask-and-one", t("and", t("sext", k, width=w), one), t("zext", k, width=w))
        yield Rule("bool-and-one", t("and", t("zext", k, width=w), one), t("zext", k, width=w))
        yield Rule("bool-xor-one", t("xor", t("zext", k, width=w), one), t("zext", t("not", k), width=w))
        yield Rule("ite-bool", t("ite", k, one, zero), t("zext", k, width=w))
        yield Rule("ite-not-bool", t("ite", k, zero, one), t("zext", t("not", k), width=w))
        for op in ("and", "or", "xor"):
            yield Rule(f"bool-{op}", t(op, t("zext", k, width=w), t("zext", V("j", 1), width=w)), t("zext", t(op, k, V("j", 1)), width=w))
    # -- carries, as flags compute them ---------------------------------------------------------
    for w in WORDS:
        x, y = V("x", w), V("y", w)
        W = w + 1

        def z(v: Term, W: int = W) -> T:
            return t("zext", v, width=W)
        c = K("c", w)
        C = K("C", W)
        fits = (t("ult", C, n(1 << w, W)),)
        low = t("trunc", C, width=w)
        for amount in (8, W):
            s = n(w, amount)
            wide = t("sub", z(x), z(y))
            yield Rule("borrow", t("trunc", t("lshr", wide, s), width=1), t("ult", x, y))
            yield Rule("borrow-constant", t("trunc", t("lshr", t("sub", z(x), C), s), width=1), t("ult", x, low), fits)
            yield Rule("borrow-from-constant", t("trunc", t("lshr", t("sub", C, z(x)), s), width=1), t("ult", low, x), fits)
            yield Rule("carry", t("trunc", t("lshr", t("add", z(x), z(y)), s), width=1), t("ult", t("add", x, y), x))
            yield Rule("carry-constant", t("trunc", t("lshr", t("add", z(x), C), s), width=1), t("ult", t("add", x, low), x), fits)
        for op in ("add", "sub", "mul", "and", "or", "xor"):
            yield Rule(f"narrow-{op}", t("trunc", t(op, z(x), z(y)), width=w), t(op, x, y))
            yield Rule(f"narrow-{op}-constant", t("trunc", t(op, z(x), C), width=w), t(op, x, t("trunc", C, width=w)))
            yield Rule(f"narrow-constant-{op}", t("trunc", t(op, C, z(x)), width=w), t(op, t("trunc", C, width=w), x))
        yield Rule("narrow-borrow", t("trunc", t("sub", t("sub", z(x), z(y)), z(k)), width=w), t("sub", t("sub", x, y), t("zext", k, width=w)))
        yield Rule("narrow-carry", t("trunc", t("add", t("add", z(x), z(y)), z(k)), width=w), t("add", t("add", x, y), t("zext", k, width=w)))
        del c
    # -- widths ---------------------------------------------------------------------------------
    ws = (1, 8, 16, 32, 64, 128)
    for a in ws:
        x = V("x", a)
        for b in (*ws, a + 1):
            if b <= a:
                continue
            for e in ("zext", "sext"):
                ex = t(e, x, width=b)
                for d in ws:
                    if d == a:
                        yield Rule(f"trunc-{e}", t("trunc", ex, width=d), x)
                    elif d < a:
                        yield Rule(f"trunc-{e}", t("trunc", ex, width=d), t("trunc", x, width=d))
                    elif d < b:
                        yield Rule(f"trunc-{e}", t("trunc", ex, width=d), t(e, x, width=d))
                    elif d > b:
                        yield Rule(f"{e}-{e}", t(e, ex, width=d), t(e, x, width=d))
                        if e == "zext":
                            yield Rule("sext-zext", t("sext", ex, width=d), t("zext", x, width=d))
                if b in ws:
                    K1 = K("c", b)
                    for op in ("eq", "ne", *(("ult", "ule") if e == "zext" else ("slt", "sle"))):
                        fits = (t("eq", t(e, t("trunc", K1, width=a), width=b), K1),)
                        yield Rule(f"{op}-{e}-constant", t(op, ex, K1), t(op, x, t("trunc", K1, width=a)), fits)
                        yield Rule(f"{op}-{e}", t(op, ex, t(e, V("y", a), width=b)), t(op, x, V("y", a)))
                    if e == "zext":
                        yield Rule("sign-of-zext", t("slt", ex, n(0, b)), n(0, 1))
                        for op in ("and", "or", "xor"):
                            yield Rule(f"zext-{op}", t(op, ex, t("zext", V("y", a), width=b)), t("zext", t(op, x, V("y", a)), width=b))
                        yield Rule("zext-and-constant", t("and", ex, K1), t("zext", t("and", x, t("trunc", K1, width=a)), width=b))
        for b in ws:
            if b >= a:
                continue
            tr = t("trunc", x, width=b)
            for d in ws:
                if d < b:
                    yield Rule("trunc-trunc", t("trunc", tr, width=d), t("trunc", x, width=d))
            if a <= 128:
                yield Rule("zext-trunc", t("zext", tr, width=a), t("and", x, n((1 << b) - 1, a)))
            # writing part of a register and reading that part back
            y = V("y", b)
            K1 = K("c", a)
            part = t("or", t("and", x, K1), t("zext", y, width=a))
            yield Rule("read-written-part", t("trunc", part, width=b), y, (t("eq", t("trunc", K1, width=b), n(0, b)),))
            for d in ws:
                if d < b:
                    yield Rule("read-written-part", t("trunc", part, width=d), t("trunc", y, width=d), (t("eq", t("trunc", K1, width=b), n(0, b)),))
            yield Rule("trunc-masked", t("trunc", t("and", x, K1), width=b), tr, (t("eq", t("trunc", K1, width=b), n(-1, b)),))
            yield Rule("trunc-masked-off", t("trunc", t("and", x, K1), width=b), n(0, b), (t("eq", t("trunc", K1, width=b), n(0, b)),))
            for op in ("add", "sub", "mul", "and", "or", "xor"):
                if (a in WORDS or a == 128 and op == "mul") and b in WORDS:
                    yield Rule(f"trunc-{op}-constant", t("trunc", t(op, x, K1), width=b), t(op, tr, t("trunc", K1, width=b)))
                    for e in ("zext", "sext"):
                        yield Rule(f"trunc-{op}-{e}", t("trunc", t(op, t(e, y, width=a), t(e, V("z", b), width=a)), width=b), t(op, y, V("z", b)))
        # -- two halves -------------------------------------------------------------------------
        for h in ws:
            lo, hi = V("x", a), V("y", h)
            both = t("cat", hi, lo)
            yield Rule("low-of-pair", t("trunc", both, width=a), lo)
            if both.width <= 256:
                for amount in (8,):
                    yield Rule("high-of-pair", t("trunc", t("lshr", both, n(a, amount)), width=h), hi)
            for d in ws:
                if d < a:
                    yield Rule("low-of-low", t("trunc", both, width=d), t("trunc", lo, width=d))
            yield Rule("pair-of-zero", t("cat", n(0, h), lo), t("zext", lo, width=a + h))
            yield Rule("pair-is-zero", t("eq", both, n(0, a + h)), t("and", t("eq", hi, n(0, h)), t("eq", lo, n(0, a))))
    for w, parts in ((128, (32, 64)), (64, (32,))):
        x = V("x", w)
        for p in parts:
            for o in range(p, w, p):
                for q in (p,):
                    yield Rule("lane-of-zext", t("trunc", t("lshr", t("zext", V("y", p), width=w), n(o, 8)), width=q), n(0, q))
                    hi = V("h", w - p)
                    # the lanes above a replaced low lane
                    if o + q <= w:
                        src = t("lshr", hi, n(o - p, 8)) if o > p else hi
                        yield Rule("lane-above", t("trunc", t("lshr", t("cat", hi, V("y", p)), n(o, 8)), width=q), t("trunc", src, width=q) if hi.width > q else src)
            yield Rule("rebuilt", t("cat", t("trunc", t("lshr", x, n(p, 8)), width=w - p), t("trunc", x, width=p)), x)
    # -- floating-point comparisons, as flags compute them --------------------------------------
    for w in (32, 64):
        x, y = V("x", w), V("y", w)
        un, lt, eq = t("funo", x, y), t("flt", x, y), t("feq", x, y)
        cf, zf = t("or", un, lt), t("or", un, eq)
        yield Rule("float-above", t("not", t("or", cf, zf)), t("flt", y, x))
        yield Rule("float-not-above", t("or", cf, zf), t("not", t("flt", y, x)))
        yield Rule("float-at-least", t("not", cf), t("fle", y, x))
        yield Rule("float-below", cf, t("not", t("fle", y, x)))
        yield Rule("float-not-above-2", t("or", t("not", t("fle", y, x)), zf), t("not", t("flt", y, x)))
        yield Rule("float-equal", t("and", t("not", un), zf), eq)
        yield Rule("float-equal-2", t("and", zf, t("not", un)), eq)
        yield Rule("float-different", t("or", un, t("not", zf)), t("not", eq))
        yield Rule("float-different-2", t("or", t("not", zf), un), t("not", eq))
        yield Rule("float-nan", t("not", t("feq", x, x)), t("funo", x, x))


def _orders(x: Term) -> Iterator[Term]:
    if not isinstance(x, T):
        yield x
        return

    def args(k: int) -> Iterator[tuple[Term, ...]]:
        if k == len(x.args):
            yield ()
            return
        for a in _orders(x.args[k]):
            for rest in args(k + 1):
                yield (a, *rest)
    for a in args(0):
        yield T(x.op, a, x.width)
        if x.op in COMMUTES and a[0] != a[1]:
            yield T(x.op, a[::-1], x.width)


@lru_cache(maxsize=1)
def instances() -> tuple[Rule, ...]:
    """Every rule at every width and order it is applied in, each once, in a fixed order."""
    seen: dict[tuple, Rule] = {}
    for r in _rules():
        for lhs in _orders(r.lhs):
            assert isinstance(lhs, T)
            seen.setdefault((lhs, r.when), Rule(r.name, lhs, r.rhs, r.when))
    return tuple(seen.values())


@lru_cache(maxsize=1)
def index() -> dict[tuple[str, int, int], tuple[Rule, ...]]:
    """By operation, result width and first argument's width."""
    out: dict[tuple[str, int, int], list[Rule]] = {}
    for r in instances():
        out.setdefault((r.lhs.op, r.lhs.width, r.lhs.args[0].width), []).append(r)
    return {k: tuple(v) for k, v in out.items()}


def value_of(x: Term, env: dict[str, int]) -> int:
    """A term over constants only."""
    if isinstance(x, N):
        return x.value
    if isinstance(x, K):
        return env[x.name]
    assert isinstance(x, T)
    r = apply(x.op, [value_of(a, env) for a in x.args], [a.width for a in x.args], x.width)
    assert r is not UNDEF
    return r


def constant(x: Term) -> bool:
    return isinstance(x, (K, N)) or isinstance(x, T) and all(map(constant, x.args))
