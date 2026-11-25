# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exact IEEE 754 binary32 and binary64 arithmetic on bit patterns, in integers only, so that results never depend on
the host's floating point.

Fixed environment: round to nearest even unless an operation names another direction, subnormals kept, exceptions
masked. An invalid operation without a NaN operand gives the default NaN (negative, quiet, empty payload). With NaN
operands the first one, made quiet, is the result.
"""
from __future__ import annotations

from math import isqrt

#: width -> (exponent bits, fraction bits)
FORMAT = {32: (8, 23), 64: (11, 52)}

NEAREST, ZERO, DOWN, UP = "near", "zero", "down", "up"


def parts(v: int, w: int) -> tuple[int, int, int]:
    """(sign, biased exponent, fraction)."""
    e, f = FORMAT[w]
    return v >> (w - 1), v >> f & ((1 << e) - 1), v & ((1 << f) - 1)


def is_nan(v: int, w: int) -> bool:
    e, f = FORMAT[w]
    _s, x, m = parts(v, w)
    return x == (1 << e) - 1 and m != 0


def is_inf(v: int, w: int) -> bool:
    e, f = FORMAT[w]
    _s, x, m = parts(v, w)
    return x == (1 << e) - 1 and m == 0


def default_nan(w: int) -> int:
    e, f = FORMAT[w]
    return ((1 << (e + 2)) - 1) << (f - 1)


def quiet(v: int, w: int) -> int:
    return v | 1 << (FORMAT[w][1] - 1)


def inf(s: int, w: int) -> int:
    e, f = FORMAT[w]
    return s << (w - 1) | ((1 << e) - 1) << f


def zero(s: int, w: int) -> int:
    return s << (w - 1)


def finite(v: int, w: int) -> tuple[int, int]:
    """(signed integer significand, power of two) of a finite value."""
    e, f = FORMAT[w]
    s, x, m = parts(v, w)
    sig, exp = (m, 1) if x == 0 else (m | 1 << f, x)
    return (-sig if s else sig), exp - ((1 << (e - 1)) - 1) - f


def pack(sign: int, num: int, exp: int, sticky: bool, w: int) -> int:
    """The rounded value of num * 2**exp (num >= 0), slightly more in magnitude when `sticky`."""
    e, f = FORMAT[w]
    if num == 0:
        return zero(sign, w)  # a sticky zero cannot come from the operations here
    bias = (1 << (e - 1)) - 1
    least = 1 - bias - f  # exponent of the smallest subnormal's unit
    shift = max(num.bit_length() - (f + 1), least - exp)  # bits to drop so that f + 1 remain, or the subnormal unit is reached
    if shift > 0:
        q, r = num >> shift, num & ((1 << shift) - 1)
        half = 1 << (shift - 1)
        if r > half or r == half and (sticky or q & 1):
            q += 1
    else:
        q = num << -shift
        assert not sticky
    exp += shift
    if q >> (f + 1):
        q >>= 1
        exp += 1
    if q >> f == 0:
        return sign << (w - 1) | q
    biased = exp + f + bias
    if biased >= (1 << e) - 1:
        return inf(sign, w)
    return sign << (w - 1) | biased << f | q & ((1 << f) - 1)


def _nan2(a: int, b: int, w: int) -> int | None:
    if is_nan(a, w):
        return quiet(a, w)
    if is_nan(b, w):
        return quiet(b, w)
    return None


def add(a: int, b: int, w: int) -> int:
    n = _nan2(a, b, w)
    if n is not None:
        return n
    sa, sb = a >> (w - 1), b >> (w - 1)
    if is_inf(a, w):
        return default_nan(w) if is_inf(b, w) and sa != sb else a
    if is_inf(b, w):
        return b
    (x, ex), (y, ey) = finite(a, w), finite(b, w)
    e = min(ex, ey)
    s = (x << (ex - e)) + (y << (ey - e))
    if s == 0:
        return zero(sa & sb, w)
    return pack(int(s < 0), abs(s), e, False, w)


def sub(a: int, b: int, w: int) -> int:
    if is_nan(b, w):
        return _nan2(a, b, w)  # type: ignore[return-value]
    return add(a, b ^ 1 << (w - 1), w)


def mul(a: int, b: int, w: int) -> int:
    n = _nan2(a, b, w)
    if n is not None:
        return n
    s = (a ^ b) >> (w - 1)
    za, zb = a << 1 & ((1 << w) - 1) == 0, b << 1 & ((1 << w) - 1) == 0
    if is_inf(a, w) or is_inf(b, w):
        return default_nan(w) if za or zb else inf(s, w)
    (x, ex), (y, ey) = finite(a, w), finite(b, w)
    return pack(s, abs(x * y), ex + ey, False, w)


def div(a: int, b: int, w: int) -> int:
    n = _nan2(a, b, w)
    if n is not None:
        return n
    s = (a ^ b) >> (w - 1)
    if is_inf(a, w):
        return default_nan(w) if is_inf(b, w) else inf(s, w)
    if is_inf(b, w):
        return zero(s, w)
    (x, ex), (y, ey) = finite(a, w), finite(b, w)
    x, y = abs(x), abs(y)
    if y == 0:
        return inf(s, w) if x else default_nan(w)
    k = 2 * w + 4  # enough quotient bits that the remainder only ever breaks ties
    q, r = divmod(x << k, y)
    return pack(s, q << 1 | int(r != 0), ex - ey - k - 1, False, w)


def sqrt(a: int, w: int) -> int:
    if is_nan(a, w):
        return quiet(a, w)
    if a << 1 & ((1 << w) - 1) == 0:
        return a
    if a >> (w - 1):
        return default_nan(w)
    if is_inf(a, w):
        return a
    x, e = finite(a, w)
    k = 2 * w + 4
    if (e - k) & 1:
        k += 1
    n = x << k
    q = isqrt(n)
    return pack(0, q << 1 | int(q * q != n), (e - k) // 2 - 1, False, w)


def cmp(a: int, b: int, w: int) -> str:
    """"lt", "eq", "gt" or "un"."""
    if is_nan(a, w) or is_nan(b, w):
        return "un"

    def key(v: int) -> int:
        m = v & ((1 << (w - 1)) - 1)
        return -m if v >> (w - 1) else m
    x, y = key(a), key(b)
    return "lt" if x < y else "gt" if x > y else "eq"


def convert(a: int, w: int, to: int) -> int:
    s, _x, m = parts(a, w)
    f, g = FORMAT[w][1], FORMAT[to][1]
    if is_nan(a, w):
        payload = m << (g - f) if g >= f else m >> (f - g)
        return quiet(inf(s, to) | payload, to)
    if is_inf(a, w):
        return inf(s, to)
    x, e = finite(a, w)
    return pack(s, abs(x), e, False, to)


def from_int(v: int, to: int) -> int:
    """From a signed integer."""
    return pack(int(v < 0), abs(v), 0, False, to)


def integral(a: int, w: int, how: str) -> int | None:
    """The integer a rounds to, or None when it is not finite."""
    if is_nan(a, w) or is_inf(a, w):
        return None
    x, e = finite(a, w)
    if e >= 0:
        return x << e
    q, r = x >> -e, x & ((1 << -e) - 1)  # floor and the rest
    if r == 0 or how == DOWN:
        return q
    if how == UP:
        return q + 1
    if how == ZERO:
        return q + (x < 0)
    half = 1 << (-e - 1)
    return q + int(r > half or r == half and q & 1)


def to_int(a: int, w: int, out: int, how: str) -> int:
    """As a bit pattern of `out` bits; what does not fit (or is not a number) gives the most negative integer."""
    v = integral(a, w, how)
    if v is None or not -(1 << (out - 1)) <= v < 1 << (out - 1):
        return 1 << (out - 1)
    return v & ((1 << out) - 1)


def round_to_integral(a: int, w: int, how: str) -> int:
    if is_nan(a, w):
        return quiet(a, w)
    v = integral(a, w, how)
    if v is None:
        return a
    return from_int(v, w) if v else zero(a >> (w - 1), w)
