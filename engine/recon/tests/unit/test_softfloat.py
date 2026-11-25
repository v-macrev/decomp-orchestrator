# SPDX-License-Identifier: AGPL-3.0-or-later
"""The integer-only floating point against the host's (and, in `validate-lift`, against the processor's own instructions)."""
import math
import random
import struct

import pytest

from recon.core import softfloat as sf

EDGE = {32: [0, 1, 0x7FFFFF, 0x800000, 0x3F800000, 0x3F7FFFFF, 0x7F7FFFFF, 0x7F800000, 0x4B000001, 0x4EFFFFFF, 0x4F000000, 0x33800000],
        64: [0, 1, (1 << 52) - 1, 1 << 52, 0x3FF << 52, (0x3FF << 52) - 1, (0x7FF << 52) - 1, 0x7FF << 52, 0x41DFFFFFFFC00000, 0x43E << 52, 0x3CA << 52]}


def value(r, w):
    v = r.choice(EDGE[w]) if r.random() < 0.4 else r.getrandbits(w)
    return v | r.getrandbits(1) << (w - 1)


def host(v, w):
    return struct.unpack("<f" if w == 32 else "<d", v.to_bytes(w // 8, "little"))[0]


def bits(x, w):
    if w == 64:
        return int.from_bytes(struct.pack("<d", x), "little")
    try:
        return int.from_bytes(struct.pack("<f", x), "little")
    except OverflowError:
        return sf.inf(int(x < 0), 32)


def divide(x, y):
    if y == 0:
        return math.nan if x == 0 or math.isnan(x) else math.copysign(math.inf, x) * math.copysign(1, y)
    return x / y


@pytest.mark.parametrize("w", [32, 64])
def test_arithmetic_is_the_hosts(w):
    r = random.Random(w)
    ops = {"add": lambda x, y: x + y, "sub": lambda x, y: x - y, "mul": lambda x, y: x * y, "div": divide}
    for _ in range(6000):
        a, b = value(r, w), value(r, w)
        x, y = host(a, w), host(b, w)
        for name, f in ops.items():
            got = getattr(sf, name)(a, b, w)
            # for these operations, rounding a 53-bit result again to 24 bits rounds once
            want = f(x, y)
            assert sf.is_nan(got, w) if math.isnan(want) else got == bits(want, w), (name, hex(a), hex(b))
        s = sf.sqrt(a, w)
        assert sf.is_nan(s, w) if math.isnan(x) or x < 0 else s == bits(math.sqrt(x), w)
        assert sf.cmp(a, b, w) == ("un" if math.isnan(x) or math.isnan(y) else "lt" if x < y else "gt" if x > y else "eq")


def test_conversions():
    r = random.Random(5)
    for _ in range(6000):
        a, d = value(r, 32), value(r, 64)
        if not sf.is_nan(a, 32):
            assert sf.convert(a, 32, 64) == bits(host(a, 32), 64)
        if not sf.is_nan(d, 64):
            assert sf.convert(d, 64, 32) == bits(host(d, 64), 32)
        n = r.choice((0, 1, -1, 2**31 - 1, -2**31, 2**63 - 1, -2**63, 2**53 + 1, r.getrandbits(62) - 2**61))
        assert sf.from_int(n, 64) == bits(float(n), 64)
        x = host(d, 64)
        for out in (32, 64):
            whole = math.trunc(x) if math.isfinite(x) else None
            fits = whole is not None and -2**(out - 1) <= whole < 2**(out - 1)
            assert sf.to_int(d, 64, out, sf.ZERO) == (whole & (2**out - 1) if fits else 2**(out - 1))
            whole = round(x) if math.isfinite(x) else None
            fits = whole is not None and -2**(out - 1) <= whole < 2**(out - 1)
            assert sf.to_int(d, 64, out, sf.NEAREST) == (whole & (2**out - 1) if fits else 2**(out - 1))
        if math.isfinite(x):
            for how, f in ((sf.DOWN, math.floor), (sf.UP, math.ceil), (sf.ZERO, math.trunc), (sf.NEAREST, round)):
                got = sf.round_to_integral(d, 64, how)
                assert host(got, 64) == f(x) and got >> 63 == d >> 63


def test_a_whole_number_from_a_single_is_rounded_once():
    # 2**24 + 1 lies half way and goes to the even neighbour; by way of nothing else
    assert sf.from_int(2**24 + 1, 32) == bits(float(2**24), 32)
    assert sf.from_int(2**24 + 3, 32) == bits(float(2**24 + 4), 32)
    assert sf.from_int(2**54 + 2**30 + 1, 32) == bits(float(2**54 + 2**31), 32)  # going through 53 bits first would round to even


def test_numbers_that_are_not():
    quiet = 0x7FC12345
    signalling = 0x7F812345
    assert sf.add(quiet, 0x3F800000, 32) == quiet and sf.add(0x3F800000, signalling, 32) == signalling | 1 << 22
    assert sf.add(quiet, signalling, 32) == quiet                                      # the first operand's
    assert sf.sub(0x7F800000, 0x7F800000, 32) == sf.default_nan(32) == 0xFFC00000      # an invalid operation
    assert sf.mul(0, 0x7F800000, 32) == sf.div(0, 0, 32) == sf.sqrt(0xBF800000, 32) == 0xFFC00000
    assert sf.convert(signalling, 32, 64) == 0x7FF << 52 | (0x12345 | 1 << 22) << 29
