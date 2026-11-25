# SPDX-License-Identifier: AGPL-3.0-or-later
"""Concrete evaluation of instruction semantics, for differential tests and checks.

A value is an integer or `UNDEF`. `UNDEF` spreads through every operation; only the arm an `ite` selects counts.
Memory is a callback pair, so the evaluator touches nothing it is not given. Nothing is approximated: an
operation on undefined control (a branch, trap or address) raises.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from recon.core import softfloat as sf
from recon.core.sem import (
    OPAQUE, Atom, BlockCopy, BlockFill, Branch, CallTo, Const, Fence, Get, Goto, Let, Lifted, Load, Put, ReturnTo, Store, Trap, Val,
)


class _Undef:
    __slots__ = ()

    def __repr__(self) -> str:
        return "UNDEF"


UNDEF = _Undef()


class Trapped(Exception):
    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


class UndefinedControl(Exception):
    """A branch, trap, address or count is undefined: there is no meaning to evaluate."""


def signed(v: int, w: int) -> int:
    return v - (1 << w) if v >> (w - 1) & 1 else v


_FLOAT2 = {"fadd": sf.add, "fsub": sf.sub, "fmul": sf.mul, "fdiv": sf.div}
_FLOATCMP = {"flt": ("lt",), "fle": ("lt", "eq"), "feq": ("eq",), "funo": ("un",)}


def _float(op: str, args: list, w: int, out: int):
    a = args[0]
    if op in _FLOAT2:
        return _FLOAT2[op](a, args[1], w)
    if op in _FLOATCMP:
        return int(sf.cmp(a, args[1], w) in _FLOATCMP[op])
    if op == "fsqrt":
        return sf.sqrt(a, w)
    if op == "fcvt":
        return sf.convert(a, w, out)
    if op == "sitof":
        return sf.from_int(signed(a, w), out)
    if op.startswith("ftosi_"):
        return sf.to_int(a, w, out, op[6:])
    if op.startswith("fround_"):
        return sf.round_to_integral(a, w, op[7:])
    if op in OPAQUE:
        return UNDEF  # a function of its argument whose value is not defined here
    raise AssertionError(op)


def apply(op: str, args: list, widths: list[int], out: int):
    """One operation on integers that fit their widths."""
    m = (1 << out) - 1
    if op == "ite":
        return args[1] if args[0] else args[2]
    if op == "undef":
        return UNDEF
    a = args[0]
    w = widths[0]
    if op[0] == "f" or op == "sitof":
        return _float(op, args, w, out)
    if len(args) == 1:
        if op == "not":
            return ~a & m
        if op == "neg":
            return -a & m
        if op == "zext":
            return a
        if op == "sext":
            return signed(a, w) & m
        if op == "trunc":
            return a & m
        if op == "popcount":
            return a.bit_count()
        if op == "clz":
            return w - a.bit_length()
        if op == "ctz":
            return (a & -a).bit_length() - 1 if a else w
        raise AssertionError(op)
    b = args[1]
    if op == "add":
        return (a + b) & m
    if op == "sub":
        return (a - b) & m
    if op == "mul":
        return (a * b) & m
    if op == "and":
        return a & b
    if op == "or":
        return a | b
    if op == "xor":
        return a ^ b
    if op == "shl":
        return (a << b) & m if b < out else 0
    if op == "lshr":
        return a >> b if b < out else 0
    if op == "ashr":
        return (signed(a, w) >> min(b, w)) & m
    if op == "eq":
        return int(a == b)
    if op == "ne":
        return int(a != b)
    if op == "ult":
        return int(a < b)
    if op == "ule":
        return int(a <= b)
    if op == "slt":
        return int(signed(a, w) < signed(b, w))
    if op == "sle":
        return int(signed(a, w) <= signed(b, w))
    if op == "cat":
        return a << widths[1] | b
    if b == 0:
        return UNDEF  # division by zero has no value; the instruction's own trap comes first
    if op == "udiv":
        return a // b
    if op == "urem":
        return a % b
    sa, sb = signed(a, w), signed(b, w)
    q = abs(sa) // abs(sb)
    if (sa < 0) != (sb < 0):
        q = -q
    if op == "sdiv":
        return q & m
    if op == "srem":
        return (sa - q * sb) & m
    raise AssertionError(op)


@dataclass
class Machine:
    """Storage by location name, and memory through callbacks (address, size) -> int / (address, size, value)."""

    read: Callable[[int, int], int]
    write: Callable[[int, int, int], None]
    locs: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class Outcome:
    """`kind`: fall, goto, branch-taken, branch-fall, call or return; `target` is the address control goes to (None: falls)."""

    kind: str
    target: int | None


def run(ins: Lifted, m: Machine) -> Outcome:
    """Execute the statements on `m`. Raises `Trapped` before any effect that follows the trap."""
    env: dict[int, object] = {}

    def val(a: Atom):
        return a.value if isinstance(a, Const) else env[a.id]

    def must(a: Atom) -> int:
        v = val(a)
        if v is UNDEF:
            raise UndefinedControl
        return v  # type: ignore[return-value]

    for s in ins.stmts:
        if isinstance(s, Let):
            args = [val(a) for a in s.args]
            if s.op == "ite":
                env[s.dst.id] = UNDEF if args[0] is UNDEF else (args[1] if args[0] else args[2])
            elif any(a is UNDEF for a in args):
                env[s.dst.id] = UNDEF
            else:
                env[s.dst.id] = apply(s.op, args, [a.width for a in s.args], s.dst.width)
        elif isinstance(s, Get):
            env[s.dst.id] = m.locs[s.loc.name]
        elif isinstance(s, Put):
            m.locs[s.loc.name] = val(s.val)
        elif isinstance(s, Load):
            env[s.dst.id] = m.read(must(s.addr), s.dst.width // 8)
        elif isinstance(s, Store):
            m.write(must(s.addr), s.val.width // 8, val(s.val))  # an undefined value may be stored
        elif isinstance(s, Trap):
            if must(s.cond):
                raise Trapped(s.kind)
        elif isinstance(s, Fence):
            pass  # orders memory between threads; one thread cannot observe it
        elif isinstance(s, BlockCopy):
            step = -s.size if must(s.backward) else s.size
            d, src = must(s.dst), must(s.src)
            for _ in range(must(s.count)):
                m.write(d, s.size, m.read(src, s.size))
                d, src = (d + step) & (2**64 - 1), (src + step) & (2**64 - 1)
        elif isinstance(s, BlockFill):
            size = s.val.width // 8
            step = -size if must(s.backward) else size
            d = must(s.dst)
            for _ in range(must(s.count)):
                m.write(d, size, must(s.val))
                d = (d + step) & (2**64 - 1)
        elif isinstance(s, Goto):
            return Outcome("goto", must(s.target))
        elif isinstance(s, Branch):
            c = must(s.cond)
            return Outcome("branch-taken" if c else "branch-fall", must(s.taken) if c else must(s.fall))
        elif isinstance(s, CallTo):
            return Outcome("call", must(s.target))
        elif isinstance(s, ReturnTo):
            return Outcome("return", must(s.target))
        else:  # pragma: no cover - the union is closed
            raise AssertionError(type(s))
    return Outcome("fall", None)


__all__ = ["UNDEF", "Trapped", "UndefinedControl", "Machine", "Outcome", "Val", "apply", "run", "signed"]
