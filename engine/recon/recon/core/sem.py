# SPDX-License-Identifier: AGPL-3.0-or-later
"""Architecture-independent semantics of one machine instruction.

An instruction becomes a straight list of statements over *values* (bit vectors of an explicit width),
*locations* (named storage the adapter defines, such as a register or a one-bit flag) and byte-addressed
little-endian memory. Every effect is a statement: there are no implicit writes. What an instruction leaves
undefined is written as an `undef` value, never dropped and never guessed.

`Builder` checks widths when a statement is made, so a badly typed semantics cannot be constructed.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Union


class SemanticsError(ValueError):
    """The semantics being built are badly typed; a defect of the lifter, never of the input."""


@dataclass(frozen=True, slots=True)
class Val:
    id: int
    width: int


@dataclass(frozen=True, slots=True)
class Const:
    value: int
    width: int

    def __post_init__(self) -> None:
        if self.width <= 0 or not 0 <= self.value < (1 << self.width):
            raise SemanticsError("constant does not fit its width")


@dataclass(frozen=True, slots=True)
class Loc:
    """Storage outside memory, e.g. one register or one flag. The adapter chooses names; a name has one width."""

    name: str
    width: int


Atom = Union[Val, Const]


@dataclass(frozen=True, slots=True)
class Let:
    dst: Val
    op: str
    args: tuple[Atom, ...]


@dataclass(frozen=True, slots=True)
class Get:
    dst: Val
    loc: Loc


@dataclass(frozen=True, slots=True)
class Put:
    loc: Loc
    val: Atom


@dataclass(frozen=True, slots=True)
class Load:
    dst: Val
    addr: Atom
    atomic: bool = False


@dataclass(frozen=True, slots=True)
class Store:
    addr: Atom
    val: Atom
    atomic: bool = False


@dataclass(frozen=True, slots=True)
class Trap:
    """Control does not continue when `cond` is 1. `kind` names why (division, breakpoint, invalid opcode)."""

    kind: str
    cond: Atom


@dataclass(frozen=True, slots=True)
class Fence:
    kind: str


@dataclass(frozen=True, slots=True)
class BlockCopy:
    """`count` elements of `size` bytes, one at a time in ascending order, or descending when `backward` is 1."""

    dst: Atom
    src: Atom
    count: Atom
    size: int
    backward: Atom


@dataclass(frozen=True, slots=True)
class BlockFill:
    dst: Atom
    val: Atom
    count: Atom
    backward: Atom


# Terminators. Addresses are values of the address width; an instruction without one falls through.
@dataclass(frozen=True, slots=True)
class Goto:
    target: Atom


@dataclass(frozen=True, slots=True)
class Branch:
    cond: Atom
    taken: Atom
    fall: Atom


@dataclass(frozen=True, slots=True)
class CallTo:
    target: Atom
    ret: Atom


@dataclass(frozen=True, slots=True)
class ReturnTo:
    target: Atom


Stmt = Union[Let, Get, Put, Load, Store, Trap, Fence, BlockCopy, BlockFill, Goto, Branch, CallTo, ReturnTo]
TERMINATING = (Goto, Branch, CallTo, ReturnTo)

#: op -> (arity, rule). Rules: same = all arguments and the result have one width; cmp = equal widths, result 1 bit;
#: shift = the result has the first argument's width, the amount any width; ext/trunc = one argument, result width given;
#: ite = condition 1 bit, arms equal; cat = (high, low), widths add up; un = one argument, same width; bit = one argument, 1 bit;
#: undef = no argument, result width given. Floating point works on bit patterns of 32 or 64 bits (`core/softfloat.py` fixes rounding
#: and NaNs): fsame, fun and fcmp are the rules above; f2f, i2f and f2i convert, result width given; the integer side is signed.
OPS: dict[str, tuple[int, str]] = {
    "add": (2, "same"), "sub": (2, "same"), "mul": (2, "same"), "udiv": (2, "same"), "urem": (2, "same"), "sdiv": (2, "same"), "srem": (2, "same"),
    "and": (2, "same"), "or": (2, "same"), "xor": (2, "same"), "not": (1, "un"), "neg": (1, "un"),
    "shl": (2, "shift"), "lshr": (2, "shift"), "ashr": (2, "shift"),
    "eq": (2, "cmp"), "ne": (2, "cmp"), "ult": (2, "cmp"), "ule": (2, "cmp"), "slt": (2, "cmp"), "sle": (2, "cmp"),
    "zext": (1, "ext"), "sext": (1, "ext"), "trunc": (1, "trunc"), "cat": (2, "cat"), "ite": (3, "ite"),
    "popcount": (1, "un"), "clz": (1, "un"), "ctz": (1, "un"), "undef": (0, "undef"),
    "fadd": (2, "fsame"), "fsub": (2, "fsame"), "fmul": (2, "fsame"), "fdiv": (2, "fsame"), "fsqrt": (1, "fun"),
    "flt": (2, "fcmp"), "fle": (2, "fcmp"), "feq": (2, "fcmp"), "funo": (2, "fcmp"),
    "fcvt": (1, "f2f"), "sitof": (1, "i2f"), "ftosi_zero": (1, "f2i"), "ftosi_near": (1, "f2i"),
    "fround_near": (1, "fun"), "fround_zero": (1, "fun"), "fround_down": (1, "fun"), "fround_up": (1, "fun"),
    # the processor's own approximation of 1/x and 1/sqrt(x): a function of its argument, and nothing more is known of it
    "frcp_approx": (1, "fun"), "frsqrt_approx": (1, "fun"),
}
FLOAT_WIDTHS = (32, 64)
#: operations that are functions of their arguments but whose value is not defined here
OPAQUE = frozenset({"frcp_approx", "frsqrt_approx"})


def result_width(op: str, args: tuple[Atom, ...], width: int | None) -> int:
    if op not in OPS:
        raise SemanticsError(f"unknown operation {op}")
    arity, rule = OPS[op]
    if len(args) != arity:
        raise SemanticsError(f"{op} takes {arity} arguments")
    w = [a.width for a in args]
    if rule in ("fsame", "fcmp", "fun", "f2f", "f2i") and any(x not in FLOAT_WIDTHS for x in w) or rule in ("f2f", "i2f") and width not in FLOAT_WIDTHS:
        raise SemanticsError(f"{op}: not a floating-point width")
    rule = {"fsame": "same", "fcmp": "cmp", "fun": "un"}.get(rule, rule)
    if rule in ("same", "cmp"):
        if w[0] != w[1]:
            raise SemanticsError(f"{op}: widths {w[0]} and {w[1]} differ")
        out = w[0] if rule == "same" else 1
    elif rule in ("un", "shift"):
        out = w[0]
    elif rule == "ite":
        if w[0] != 1 or w[1] != w[2]:
            raise SemanticsError("ite needs a 1-bit condition and equal arms")
        out = w[1]
    elif rule == "cat":
        out = w[0] + w[1]
    else:
        if width is None or width <= 0:
            raise SemanticsError(f"{op} needs a result width")
        if rule == "ext" and width < w[0] or rule == "trunc" and width > w[0]:
            raise SemanticsError(f"{op}: cannot go from {w[0]} to {width} bits")
        return width
    if width is not None and width != out:
        raise SemanticsError(f"{op}: result is {out} bits, not {width}")
    return out


class Builder:
    """Makes statements in order, numbering values from 0, and refuses ill-typed ones."""

    def __init__(self, addr_width: int = 64) -> None:
        self.stmts: list[Stmt] = []
        self.addr_width = addr_width
        self._n = 0
        self._done = False

    def _emit(self, s: Stmt) -> None:
        if self._done:
            raise SemanticsError("a statement follows the instruction's terminator")
        self.stmts.append(s)
        self._done = isinstance(s, TERMINATING)

    def _new(self, width: int) -> Val:
        v = Val(self._n, width)
        self._n += 1
        return v

    def op(self, name: str, *args: Atom, width: int | None = None) -> Val:
        v = self._new(result_width(name, args, width))
        self._emit(Let(v, name, args))
        return v

    def const(self, value: int, width: int) -> Const:
        return Const(value & ((1 << width) - 1), width)

    def undef(self, width: int) -> Val:
        return self.op("undef", width=width)

    def get(self, loc: Loc) -> Val:
        v = self._new(loc.width)
        self._emit(Get(v, loc))
        return v

    def put(self, loc: Loc, val: Atom) -> None:
        if val.width != loc.width:
            raise SemanticsError(f"{loc.name} holds {loc.width} bits, not {val.width}")
        self._emit(Put(loc, val))

    def _addr(self, a: Atom) -> None:
        if a.width != self.addr_width:
            raise SemanticsError("an address has the address width")

    def load(self, addr: Atom, width: int, atomic: bool = False) -> Val:
        self._addr(addr)
        if width % 8:
            raise SemanticsError("memory is accessed in whole bytes")
        v = self._new(width)
        self._emit(Load(v, addr, atomic))
        return v

    def store(self, addr: Atom, val: Atom, atomic: bool = False) -> None:
        self._addr(addr)
        if val.width % 8:
            raise SemanticsError("memory is accessed in whole bytes")
        self._emit(Store(addr, val, atomic))

    def trap(self, kind: str, cond: Atom) -> None:
        if cond.width != 1:
            raise SemanticsError("a trap condition is one bit")
        self._emit(Trap(kind, cond))

    def fence(self, kind: str) -> None:
        self._emit(Fence(kind))

    def block_copy(self, dst: Atom, src: Atom, count: Atom, size: int, backward: Atom) -> None:
        self._addr(dst)
        self._addr(src)
        if backward.width != 1:
            raise SemanticsError("a direction is one bit")
        self._emit(BlockCopy(dst, src, count, size, backward))

    def block_fill(self, dst: Atom, val: Atom, count: Atom, backward: Atom) -> None:
        self._addr(dst)
        if backward.width != 1 or val.width % 8:
            raise SemanticsError("a fill needs whole bytes and a one-bit direction")
        self._emit(BlockFill(dst, val, count, backward))

    def goto(self, target: Atom) -> None:
        self._addr(target)
        self._emit(Goto(target))

    def branch(self, cond: Atom, taken: Atom, fall: Atom) -> None:
        if cond.width != 1:
            raise SemanticsError("a branch condition is one bit")
        self._addr(taken)
        self._addr(fall)
        self._emit(Branch(cond, taken, fall))

    def call(self, target: Atom, ret: Atom) -> None:
        self._addr(target)
        self._addr(ret)
        self._emit(CallTo(target, ret))

    def ret(self, target: Atom) -> None:
        self._addr(target)
        self._emit(ReturnTo(target))


@dataclass(frozen=True)
class Lifted:
    """The semantics of one instruction at `rva`. `form` names the instruction form the adapter decoded."""

    rva: int
    length: int
    form: str
    stmts: tuple[Stmt, ...]

    @property
    def end(self) -> int:
        return self.rva + self.length

    @property
    def terminator(self) -> Stmt | None:
        return self.stmts[-1] if self.stmts and isinstance(self.stmts[-1], TERMINATING) else None


@dataclass(frozen=True)
class Unsupported:
    """A structured refusal: `reason` is a fixed code, `form` the instruction form it concerns."""

    rva: int
    form: str
    reason: str
