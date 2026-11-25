# SPDX-License-Identifier: AGPL-3.0-or-later
"""Lifting of the SSE, SSE2 and some later 128-bit instructions (legacy encodings).

The floating-point environment is fixed and stated, not modelled: round to nearest, subnormals kept, exceptions
masked, sticky exception flags not observed (`FP_ENVIRONMENT`). The processor's approximations of a reciprocal
and a reciprocal square root are opaque functions. Vector lanes are bit fields of a 128-bit location, lane 0 lowest.
"""
from __future__ import annotations

from typing import Callable

from recon.core.sem import Atom, Const, Val

#: the assumption every result with floating-point operations rests on
FP_ENVIRONMENT = "floating-point-control-is-default"

Handler = Callable[..., None]


def lanes(l, v: Atom, w: int) -> list[Atom]:
    return [field(l, v, k * w, w) for k in range(v.width // w)]


def field(l, v: Atom, off: int, w: int) -> Atom:
    b = l.b
    if off:
        v = b.op("lshr", v, l.c(off, 8))
    return v if v.width == w else b.op("trunc", v, width=w)


def join(l, parts: list[Atom]) -> Atom:
    acc = parts[-1]
    for p in reversed(parts[:-1]):
        acc = l.b.op("cat", acc, p)
    return acc


def low_into(l, i: int, v: Atom) -> None:
    """Write the low lane of the register operand and keep the rest."""
    w = v.width
    l.xput(i, l.b.op("cat", field(l, l.xget(i), w, 128 - w), v))


def zero_into(l, i: int, v: Atom) -> None:
    l.xput(i, v if v.width == 128 else l.b.op("zext", v, width=128))


# ---------------------------------------------------------------------------------------- moves

def h_mov(aligned: bool) -> Handler:
    def f(l) -> None:
        l.xwr(0, l.xrd(1, 128, aligned), aligned)
    return f


def h_mov_scalar(w: int) -> Handler:
    def f(l) -> None:
        if l.is_mem(0):
            l.b.store(l.ea(), field(l, l.xget(1), 0, w))
        elif l.is_mem(1):
            zero_into(l, 0, l.b.load(l.ea(), w))
        else:
            low_into(l, 0, field(l, l.xget(1), 0, w))
    return f


def h_movq(l) -> None:
    """MOVQ and MOVD between vector registers, general registers and memory."""
    w = 32 if l.m == "MOVD" else 64
    if l.is_xmm(0):
        v = field(l, l.xget(1), 0, w) if l.is_xmm(1) else l.rd(1)
        if v.width != w:
            v = l.b.op("trunc", v, width=w)
        zero_into(l, 0, v)
    else:
        v = field(l, l.xget(1), 0, w)
        if l.is_mem(0):
            l.b.store(l.ea(), v)
        elif l.is_xmm(0):
            zero_into(l, 0, v)
        else:
            l.wr(0, v)


def h_mov_half(high: bool) -> Handler:
    def f(l) -> None:
        if l.is_mem(0):
            l.b.store(l.ea(), field(l, l.xget(1), 64 if high else 0, 64))
            return
        old = l.xget(0)
        v = l.b.load(l.ea(), 64)
        l.xput(0, l.b.op("cat", v, field(l, old, 0, 64)) if high else l.b.op("cat", field(l, old, 64, 64), v))
    return f


def h_movhlps(l) -> None:
    s, d = l.xget(1), l.xget(0)
    l.xput(0, l.b.op("cat", field(l, d, 64, 64), field(l, s, 64, 64)))


def h_movlhps(l) -> None:
    s, d = l.xget(1), l.xget(0)
    l.xput(0, l.b.op("cat", field(l, s, 0, 64), field(l, d, 0, 64)))


def h_store_gp(l) -> None:
    l.b.store(l.ea(), l.rd(1))


def h_dup(w: int, which: tuple[int, ...]) -> Handler:
    def f(l) -> None:
        if l.m == "MOVDDUP":
            v = [l.xrd(1, 64)]
        else:
            v = lanes(l, l.xrd(1, 128, True), w)
        l.xput(0, join(l, [v[k] for k in which]))
    return f


def h_movmsk(w: int) -> Handler:
    def f(l) -> None:
        v = l.xget(1)
        bits = [field(l, v, k * w + w - 1, 1) for k in range(128 // w)]
        l.wr(0, l.b.op("zext", join(l, bits), width=l.width(0)))
    return f


# ---------------------------------------------------------------------------------------- floating point

def _apply(op: str) -> Callable[..., Atom]:
    def f(l, x: Atom, y: Atom) -> Atom:
        if op == "min":  # both directions hand over the second operand when the comparison does not hold
            return l.b.op("ite", l.b.op("flt", x, y), x, y)
        if op == "max":
            return l.b.op("ite", l.b.op("flt", y, x), x, y)
        return l.b.op(op, x, y)
    return f


def h_arith(op: str, w: int, scalar: bool) -> Handler:
    g = _apply(op)

    def f(l) -> None:
        if scalar:
            y = l.xrd(1, w)
            low_into(l, 0, g(l, field(l, l.xget(0), 0, w), y))
        else:
            y = l.xrd(1, 128, True)
            l.xput(0, join(l, [g(l, a, b) for a, b in zip(lanes(l, l.xget(0), w), lanes(l, y, w))]))
    return f


def h_unary(op: str, w: int, scalar: bool) -> Handler:
    def f(l) -> None:
        if scalar:
            low_into(l, 0, l.b.op(op, l.xrd(1, w)))
        else:
            l.xput(0, join(l, [l.b.op(op, v) for v in lanes(l, l.xrd(1, 128, True), w)]))
    return f


def h_comis(w: int) -> Handler:
    def f(l) -> None:
        b = l.b
        y = l.xrd(1, w)
        x = field(l, l.xget(0), 0, w)
        un = b.op("funo", x, y)
        z = l.c(0, 1)
        l.put_flags({"cf": b.op("or", un, b.op("flt", x, y)), "pf": un, "zf": b.op("or", un, b.op("feq", x, y)), "of": z, "sf": z, "af": z})
    return f


def h_cmp(w: int, scalar: bool) -> Handler:
    def one(l, x: Atom, y: Atom) -> Atom:
        b = l.b
        k = l.ins.immediate(2) & 7
        op, negated = [("feq", False), ("flt", False), ("fle", False), ("funo", False), ("feq", True), ("flt", True), ("fle", True), ("funo", True)][k]
        c = b.op(op, x, y)
        return b.op("sext", b.op("not", c) if negated else c, width=w)

    def f(l) -> None:
        if scalar:
            y = l.xrd(1, w)
            low_into(l, 0, one(l, field(l, l.xget(0), 0, w), y))
        else:
            y = l.xrd(1, 128, True)
            l.xput(0, join(l, [one(l, p, q) for p, q in zip(lanes(l, l.xget(0), w), lanes(l, y, w))]))
    return f


def h_int_to_float(to: int) -> Handler:
    def f(l) -> None:
        low_into(l, 0, l.b.op("sitof", l.rd(1), width=to))
    return f


def h_float_to_int(w: int, how: str) -> Handler:
    def f(l) -> None:
        l.wr(0, l.b.op("ftosi_" + how, l.xrd(1, w), width=l.width(0)))
    return f


def h_convert(w: int, to: int) -> Handler:
    def f(l) -> None:
        low_into(l, 0, l.b.op("fcvt", l.xrd(1, w), width=to))
    return f


def h_convert_packed(op: str, w: int, to: int) -> Handler:
    def f(l) -> None:
        n = min(128 // w, 128 // to)
        v = l.xrd(1, n * w, n * w == 128)
        zero_into(l, 0, join(l, [l.b.op(op, x, width=to) for x in lanes(l, v, w)]))
    return f


def h_round(w: int, scalar: bool) -> Handler:
    def f(l) -> None:
        k = l.ins.immediate(2)
        op = "fround_near" if k & 4 else "fround_" + ("near", "down", "up", "zero")[k & 3]  # bit 2: the current direction
        if scalar:
            low_into(l, 0, l.b.op(op, l.xrd(1, w)))
        else:
            l.xput(0, join(l, [l.b.op(op, v) for v in lanes(l, l.xrd(1, 128, True), w)]))
    return f


# ---------------------------------------------------------------------------------------- whole register, shuffles

def h_logic(op: str) -> Handler:
    def f(l) -> None:
        y = l.xrd(1, 128, True)
        x = l.xget(0)
        l.xput(0, l.b.op("and", l.b.op("not", x), y) if op == "andn" else l.b.op(op, x, y))
    return f


def h_unpack(w: int, high: bool) -> Handler:
    def f(l) -> None:
        y = lanes(l, l.xrd(1, 128, True), w)
        x = lanes(l, l.xget(0), w)
        n = len(x) // 2
        at = range(n, 2 * n) if high else range(n)
        l.xput(0, join(l, [p for k in at for p in (x[k], y[k])]))
    return f


def h_shufps(l) -> None:
    k = l.ins.immediate(2)
    y = lanes(l, l.xrd(1, 128, True), 32)
    x = lanes(l, l.xget(0), 32)
    l.xput(0, join(l, [x[k & 3], x[k >> 2 & 3], y[k >> 4 & 3], y[k >> 6 & 3]]))


def h_shufpd(l) -> None:
    k = l.ins.immediate(2)
    y = lanes(l, l.xrd(1, 128, True), 64)
    x = lanes(l, l.xget(0), 64)
    l.xput(0, join(l, [x[k & 1], y[k >> 1 & 1]]))


def h_pshufd(l) -> None:
    k = l.ins.immediate(2)
    y = lanes(l, l.xrd(1, 128, True), 32)
    l.xput(0, join(l, [y[k >> 2 * i & 3] for i in range(4)]))


def h_pshufw(high: bool) -> Handler:
    def f(l) -> None:
        k = l.ins.immediate(2)
        y = lanes(l, l.xrd(1, 128, True), 16)
        o = 4 if high else 0
        new = list(y)
        for i in range(4):
            new[o + i] = y[o + (k >> 2 * i & 3)]
        l.xput(0, join(l, new))
    return f


def h_pshufb(l) -> None:
    b = l.b
    y = lanes(l, l.xrd(1, 128, True), 8)
    x = l.xget(0)
    out = []
    for c in y:
        at = b.op("shl", b.op("and", c, l.c(15, 8)), l.c(3, 8))
        v = b.op("trunc", b.op("lshr", x, at), width=8)
        out.append(b.op("ite", l.msb(c), l.c(0, 8), v))
    l.xput(0, join(l, out))


# ---------------------------------------------------------------------------------------- integers

def _clamp(l, v: Val, w: int, signed: bool) -> Atom:
    """A signed value of 2w bits to w bits, saturating."""
    b, W = l.b, v.width
    lo, hi = (-(1 << (w - 1)), (1 << (w - 1)) - 1) if signed else (0, (1 << w) - 1)
    low = b.op("slt", v, l.c(lo, W))
    high = b.op("slt", l.c(hi, W), v)
    return b.op("ite", low, l.c(lo, w), b.op("ite", high, l.c(hi, w), b.op("trunc", v, width=w)))


def _int(op: str) -> Callable[..., Atom]:
    def f(l, x: Atom, y: Atom) -> Atom:
        b, w = l.b, x.width
        if op in ("add", "sub", "mul"):
            return b.op(op, x, y)
        if op in ("adds", "subs", "addus", "subus"):
            ext = "zext" if op.endswith("us") else "sext"
            v = b.op(op[:3], b.op(ext, x, width=2 * w), b.op(ext, y, width=2 * w))
            return _clamp(l, v, w, ext == "sext")
        if op in ("eq", "gt"):
            return b.op("sext", b.op("eq", x, y) if op == "eq" else b.op("slt", y, x), width=w)
        if op in ("umin", "umax", "smin", "smax"):
            c = b.op("ult" if op[0] == "u" else "slt", x, y)
            return b.op("ite", c, x, y) if op.endswith("min") else b.op("ite", c, y, x)
        if op in ("umulh", "smulh"):
            e = "zext" if op[0] == "u" else "sext"
            return field(l, b.op("mul", b.op(e, x, width=2 * w), b.op(e, y, width=2 * w)), w, w)
        if op == "avg":
            s = b.op("add", b.op("add", b.op("zext", x, width=w + 1), b.op("zext", y, width=w + 1)), l.c(1, w + 1))
            return b.op("trunc", b.op("lshr", s, l.c(1, 8)), width=w)
        raise AssertionError(op)
    return f


def h_int(op: str, w: int) -> Handler:
    g = _int(op)

    def f(l) -> None:
        y = l.xrd(1, 128, True)
        l.xput(0, join(l, [g(l, p, q) for p, q in zip(lanes(l, l.xget(0), w), lanes(l, y, w))]))
    return f


def h_pmuludq(l) -> None:
    y = lanes(l, l.xrd(1, 128, True), 64)
    x = lanes(l, l.xget(0), 64)
    b = l.b

    def low(v: Atom) -> Val:
        return b.op("and", v, l.c(0xFFFFFFFF, 64))
    l.xput(0, join(l, [b.op("mul", low(p), low(q)) for p, q in zip(x, y)]))


def h_pmaddwd(l) -> None:
    y = lanes(l, l.xrd(1, 128, True), 16)
    x = lanes(l, l.xget(0), 16)
    b = l.b
    p = [b.op("mul", b.op("sext", u, width=32), b.op("sext", v, width=32)) for u, v in zip(x, y)]
    l.xput(0, join(l, [b.op("add", p[k], p[k + 1]) for k in range(0, 8, 2)]))


def h_psadbw(l) -> None:
    b = l.b
    y = lanes(l, l.xrd(1, 128, True), 8)
    x = lanes(l, l.xget(0), 8)
    d = [b.op("zext", b.op("ite", b.op("ult", u, v), b.op("sub", v, u), b.op("sub", u, v)), width=64) for u, v in zip(x, y)]
    out = []
    for o in (0, 8):
        s: Atom = d[o]
        for k in range(1, 8):
            s = b.op("add", s, d[o + k])
        out.append(s)
    l.xput(0, join(l, out))


def h_pack(w: int, signed: bool) -> Handler:
    """Lanes of 2w bits, signed, to w bits with saturation: the first operand's in the low half."""
    def f(l) -> None:
        y = lanes(l, l.xrd(1, 128, True), 2 * w)
        x = lanes(l, l.xget(0), 2 * w)
        l.xput(0, join(l, [_clamp(l, v, w, signed) for v in x + y]))
    return f


def h_shift(op: str, w: int) -> Handler:
    def f(l) -> None:
        if l.is_xmm(1) or l.is_mem(1):
            n: Atom = field(l, l.xrd(1, 128, True), 0, 64)
        else:
            n = l.c(l.ins.immediate(1) & 0xFF, 8)
        l.xput(0, join(l, [l.b.op(op, v, n) for v in lanes(l, l.xget(0), w)]))
    return f


def h_shift_bytes(op: str) -> Handler:
    def f(l) -> None:
        n = min(l.ins.immediate(1) & 0xFF, 16)
        l.xput(0, l.b.op(op, l.xget(0), l.c(8 * n, 8)))
    return f


def h_palignr(l) -> None:
    n = min(l.ins.immediate(2) & 0xFF, 32)
    y = l.xrd(1, 128, True)
    wide = l.b.op("cat", l.xget(0), y)
    l.xput(0, l.b.op("trunc", l.b.op("lshr", wide, l.c(8 * n, 16)), width=128))


def h_extend(kind: str, w: int, to: int) -> Handler:
    def f(l) -> None:
        n = 128 // to
        l.xput(0, join(l, [l.b.op(kind, v, width=to) for v in lanes(l, l.xrd(1, n * w), w)]))
    return f


def h_pextr(w: int) -> Handler:
    def f(l) -> None:
        k = l.ins.immediate(2) & (128 // w - 1)
        v = field(l, l.xget(1), k * w, w)
        if l.is_mem(0):
            l.b.store(l.ea(), v)
        else:
            l.wr(0, v if l.width(0) == w else l.b.op("zext", v, width=l.width(0)))
    return f


def h_pinsr(w: int) -> Handler:
    def f(l) -> None:
        k = l.ins.immediate(2) & (128 // w - 1)
        if l.is_mem(1):
            v: Atom = l.b.load(l.ea(), w)
        else:
            v = l.rd(1)
            if v.width != w:
                v = l.b.op("trunc", v, width=w)
        new = lanes(l, l.xget(0), w)
        new[k] = v
        l.xput(0, join(l, new))
    return f


def h_ptest(l) -> None:
    b = l.b
    y = l.xrd(1, 128, True)
    x = l.xget(0)
    z = l.c(0, 1)
    l.put_flags({"zf": b.op("eq", b.op("and", x, y), l.c(0, 128)), "cf": b.op("eq", b.op("and", b.op("not", x), y), l.c(0, 128)),
                 "of": z, "sf": z, "af": z, "pf": z})


def h_none(_l) -> None:
    """A hint (prefetch): it accesses nothing."""


HANDLERS: dict[str, Handler] = {
    "MOVAPS": h_mov(True), "MOVAPD": h_mov(True), "MOVDQA": h_mov(True), "MOVUPS": h_mov(False), "MOVUPD": h_mov(False), "MOVDQU": h_mov(False), "LDDQU": h_mov(False),
    "MOVNTPS": h_mov(True), "MOVNTPD": h_mov(True), "MOVNTDQ": h_mov(True), "MOVNTDQA": h_mov(True), "MOVNTI": h_store_gp,
    "MOVSS": h_mov_scalar(32), "MOVD": h_movq, "MOVQ": h_movq,
    "MOVLPS": h_mov_half(False), "MOVLPD": h_mov_half(False), "MOVHPS": h_mov_half(True), "MOVHPD": h_mov_half(True), "MOVHLPS": h_movhlps, "MOVLHPS": h_movlhps,
    "MOVSLDUP": h_dup(32, (0, 0, 2, 2)), "MOVSHDUP": h_dup(32, (1, 1, 3, 3)), "MOVDDUP": h_dup(64, (0, 0)),
    "MOVMSKPS": h_movmsk(32), "MOVMSKPD": h_movmsk(64), "PMOVMSKB": h_movmsk(8),
    "UCOMISS": h_comis(32), "COMISS": h_comis(32), "UCOMISD": h_comis(64), "COMISD": h_comis(64),
    "CMPSS": h_cmp(32, True), "CMPPS": h_cmp(32, False), "CMPPD": h_cmp(64, False),
    "CVTSI2SS": h_int_to_float(32), "CVTSI2SD": h_int_to_float(64),
    "CVTTSS2SI": h_float_to_int(32, "zero"), "CVTTSD2SI": h_float_to_int(64, "zero"), "CVTSS2SI": h_float_to_int(32, "near"), "CVTSD2SI": h_float_to_int(64, "near"),
    "CVTSS2SD": h_convert(32, 64), "CVTSD2SS": h_convert(64, 32),
    "CVTPS2PD": h_convert_packed("fcvt", 32, 64), "CVTPD2PS": h_convert_packed("fcvt", 64, 32), "CVTDQ2PS": h_convert_packed("sitof", 32, 32),
    "CVTDQ2PD": h_convert_packed("sitof", 32, 64), "CVTTPS2DQ": h_convert_packed("ftosi_zero", 32, 32), "CVTPS2DQ": h_convert_packed("ftosi_near", 32, 32),
    "CVTTPD2DQ": h_convert_packed("ftosi_zero", 64, 32), "CVTPD2DQ": h_convert_packed("ftosi_near", 64, 32),
    "ROUNDSS": h_round(32, True), "ROUNDSD": h_round(64, True), "ROUNDPS": h_round(32, False), "ROUNDPD": h_round(64, False),
    "UNPCKLPS": h_unpack(32, False), "UNPCKHPS": h_unpack(32, True), "UNPCKLPD": h_unpack(64, False), "UNPCKHPD": h_unpack(64, True),
    "PUNPCKLBW": h_unpack(8, False), "PUNPCKLWD": h_unpack(16, False), "PUNPCKLDQ": h_unpack(32, False), "PUNPCKLQDQ": h_unpack(64, False),
    "PUNPCKHBW": h_unpack(8, True), "PUNPCKHWD": h_unpack(16, True), "PUNPCKHDQ": h_unpack(32, True), "PUNPCKHQDQ": h_unpack(64, True),
    "SHUFPS": h_shufps, "SHUFPD": h_shufpd, "PSHUFD": h_pshufd, "PSHUFLW": h_pshufw(False), "PSHUFHW": h_pshufw(True), "PSHUFB": h_pshufb, "PALIGNR": h_palignr,
    "PMULUDQ": h_pmuludq, "PMADDWD": h_pmaddwd, "PSADBW": h_psadbw, "PACKSSWB": h_pack(8, True), "PACKSSDW": h_pack(16, True), "PACKUSWB": h_pack(8, False), "PACKUSDW": h_pack(16, False),
    "PSLLDQ": h_shift_bytes("shl"), "PSRLDQ": h_shift_bytes("lshr"), "PTEST": h_ptest,
    "PEXTRB": h_pextr(8), "PEXTRW": h_pextr(16), "PEXTRD": h_pextr(32), "PEXTRQ": h_pextr(64), "EXTRACTPS": h_pextr(32),
    "PINSRB": h_pinsr(8), "PINSRW": h_pinsr(16), "PINSRD": h_pinsr(32), "PINSRQ": h_pinsr(64),
    "PREFETCHNTA": h_none, "PREFETCHT0": h_none, "PREFETCHT1": h_none, "PREFETCHT2": h_none, "PREFETCHW": h_none,
    "PMULLW": h_int("mul", 16), "PMULLD": h_int("mul", 32), "PMULHW": h_int("smulh", 16), "PMULHUW": h_int("umulh", 16), "PAVGB": h_int("avg", 8), "PAVGW": h_int("avg", 16),
}
for _s, _w, _scalar in (("SS", 32, True), ("SD", 64, True), ("PS", 32, False), ("PD", 64, False)):
    for _n, _op in (("ADD", "fadd"), ("SUB", "fsub"), ("MUL", "fmul"), ("DIV", "fdiv"), ("MIN", "min"), ("MAX", "max")):
        HANDLERS[_n + _s] = h_arith(_op, _w, _scalar)
    HANDLERS["SQRT" + _s] = h_unary("fsqrt", _w, _scalar)
    if _w == 32:
        HANDLERS["RCP" + _s] = h_unary("frcp_approx", 32, _scalar)
        HANDLERS["RSQRT" + _s] = h_unary("frsqrt_approx", 32, _scalar)
for _n, _op in (("AND", "and"), ("ANDN", "andn"), ("OR", "or"), ("XOR", "xor")):
    for _s in ("PS", "PD"):
        HANDLERS[_n + _s] = h_logic(_op)
for _n, _op in (("PAND", "and"), ("PANDN", "andn"), ("POR", "or"), ("PXOR", "xor")):
    HANDLERS[_n] = h_logic(_op)
for _s, _w in (("B", 8), ("W", 16), ("D", 32), ("Q", 64)):
    HANDLERS["PADD" + _s], HANDLERS["PSUB" + _s] = h_int("add", _w), h_int("sub", _w)
    HANDLERS["PCMPEQ" + _s], HANDLERS["PCMPGT" + _s] = h_int("eq", _w), h_int("gt", _w)
    if _w < 64:
        for _k, _op in (("MINU", "umin"), ("MAXU", "umax"), ("MINS", "smin"), ("MAXS", "smax")):
            HANDLERS["P" + _k + _s] = h_int(_op, _w)
    if _w < 32:
        for _k, _op in (("ADDS", "adds"), ("SUBS", "subs"), ("ADDUS", "addus"), ("SUBUS", "subus")):
            HANDLERS["P" + _k + _s] = h_int(_op, _w)
    if _w > 8:
        HANDLERS["PSLL" + _s], HANDLERS["PSRL" + _s] = h_shift("shl", _w), h_shift("lshr", _w)
        if _w < 64:
            HANDLERS["PSRA" + _s] = h_shift("ashr", _w)
for _k, _kind in (("ZX", "zext"), ("SX", "sext")):
    for _a, _w in (("B", 8), ("W", 16), ("D", 32)):
        for _b, _to in (("W", 16), ("D", 32), ("Q", 64)):
            if _to > _w:
                HANDLERS[f"PMOV{_k}{_a}{_b}"] = h_extend(_kind, _w, _to)

MOVSD, CMPSD = h_mov_scalar(64), h_cmp(64, True)  # mnemonics shared with string instructions

__all__ = ["CMPSD", "Const", "FP_ENVIRONMENT", "HANDLERS", "MOVSD"]
