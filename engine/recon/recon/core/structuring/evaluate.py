# SPDX-License-Identifier: AGPL-3.0-or-later
"""Execution of a source-level tree with the meaning C++ gives it, and the comparison with the IR it came from.

The tree is run on its own: nothing of how it was made is used. What both do is compared at every call and at the end:
the arguments, every byte of memory written so far, and the result. A value the language leaves undefined ends the run
as a rejection, except that signed arithmetic wraps and is counted, because it is a stated assumption of the body.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from recon.core.evaluate import UNDEF, Trapped, UndefinedControl, apply
from recon.core.inference import types as ty
from recon.core.inference.signature import Convention, Signature
from recon.core.ir import interp
from recon.core.ir.model import Fn
from recon.core.structuring import ast as A

M64 = (1 << 64) - 1


class Rejected(Exception):
    """The tree does something the language gives no meaning to."""


class OutOfSteps(Exception):
    pass


@dataclass
class Machine:
    read: Callable[[int, int], int]
    write: Callable[[int, int, int], None]
    call: Callable[[int, tuple[int, ...]], int]          # (target, arguments) -> result bits
    size: Callable[[ty.CType], int]                      # of what a pointer points to
    steps: int = 1500
    locals: dict[int, int] = field(default_factory=dict)
    wrapped: int = 0

    # -- expressions ----------------------------------------------------------------------------
    def promote(self, v: int, t: ty.CType) -> tuple[int, int, bool]:
        """(value as a Python integer, width, signed) after the integer promotions."""
        if isinstance(t, ty.Bool):
            return v & 1, 32, True
        if isinstance(t, ty.Ptr):
            return v, 64, False
        if not isinstance(t, ty.Int):
            raise Rejected("integer operation on another type")
        x = ty.signed(v, t.width) if t.signed else v
        return (x, 32, True) if t.width < 32 else (x, t.width, t.signed)

    def convert(self, v: int, a: ty.CType, b: ty.CType) -> int:
        if a == b:
            return v
        if isinstance(a, ty.Float) and isinstance(b, ty.Float):
            return apply("fcvt", [v], [a.width], b.width)  # type: ignore[return-value]
        if isinstance(a, ty.Float):
            if isinstance(b, ty.Bool) or not isinstance(b, ty.Int) or not b.signed:
                raise Rejected("conversion")
            return apply("ftosi_zero", [v], [a.width], b.width)  # type: ignore[return-value]
        if isinstance(b, ty.Float):
            x, w, s = self.promote(v, a)
            if not s:
                raise Rejected("conversion of an unsigned integer")
            return apply("sitof", [x & (1 << w) - 1], [w], b.width)  # type: ignore[return-value]
        if isinstance(a, ty.Ptr) or isinstance(b, ty.Ptr):
            if isinstance(a, ty.Ptr) and isinstance(b, ty.Ptr) and isinstance(b.to, ty.Void):
                return v
            if isinstance(b, ty.Bool):
                return int(v != 0)
            raise Rejected("conversion of a pointer")
        if isinstance(b, ty.Bool):
            return int(v != 0)
        x, _w, _s = self.promote(v, a)
        return x & (1 << b.width) - 1

    def address(self, x: A.Expr) -> int:
        self.tick()
        if isinstance(x, A.Field):
            return (self.value(x.base) + x.offset) & M64
        if isinstance(x, A.Index):
            base = self.value(x.base)
            assert isinstance(x.base.type, ty.Ptr)
            i = 0 if x.index is None else self.promote(self.value(x.index), x.index.type)[0]
            return (base + i * self.size(x.base.type.to) + (x.member or 0)) & M64
        if isinstance(x, A.Global):
            return x.address
        raise Rejected("not a place in memory")

    def tick(self) -> None:
        self.steps -= 1
        if self.steps < 0:
            raise OutOfSteps

    def truth(self, x: A.Expr) -> bool:
        return self.convert(self.value(x), x.type, ty.BOOL) != 0

    def value(self, x: A.Expr) -> int:
        if isinstance(x, A.Local):
            if x.id not in self.locals:
                raise Rejected("a variable read before it is set")
            return self.locals[x.id]
        if isinstance(x, A.Num):
            return x.value & (1 << x.type.width) - 1
        if isinstance(x, (A.Field, A.Index, A.Global)):
            return self.read(self.address(x), x.type.width // 8)
        if isinstance(x, A.AddressOf):
            return self.address(x.arg)
        if isinstance(x, A.Cast):
            return self.convert(self.value(x.arg), x.arg.type, x.type)
        if isinstance(x, A.Call):
            r = self.call(x.target, tuple(self.value(a) for a in x.args))
            return int(r & 255 != 0) if isinstance(x.type, ty.Bool) else r
        if isinstance(x, A.Choose):
            y = x.yes if self.truth(x.cond) else x.no
            return self.convert(self.value(y), y.type, x.type)
        if isinstance(x, A.Unary):
            if x.op == "!":
                return int(not self.truth(x.arg))
            v, w, s = self.promote(self.value(x.arg), x.arg.type)
            return self.wrap(-v, w, s) if x.op == "-" else ~v & (1 << w) - 1
        assert isinstance(x, A.Binary)
        return self.binary(x)

    def wrap(self, v: int, w: int, s: bool) -> int:
        if s and not -(1 << (w - 1)) <= v < 1 << (w - 1):
            self.wrapped += 1
        return v & (1 << w) - 1

    def binary(self, x: A.Binary) -> int:
        op = x.op
        if op in ("&&", "||"):
            left = self.truth(x.left)
            return int(left and self.truth(x.right) if op == "&&" else left or self.truth(x.right))
        a, b = self.value(x.left), self.value(x.right)
        if isinstance(x.left.type, ty.Float) or isinstance(x.right.type, ty.Float):
            if x.left.type != x.right.type:
                raise Rejected("operands of different types")
            w = x.left.type.width
            kind = {"+": "fadd", "-": "fsub", "*": "fmul", "/": "fdiv", "<": "flt", "<=": "fle", "==": "feq"}
            if op in kind:
                return apply(kind[op], [a, b], [w, w], w if op in "+-*/" else 1)  # type: ignore[return-value]
            if op in (">", ">="):
                return apply("flt" if op == ">" else "fle", [b, a], [w, w], 1)  # type: ignore[return-value]
            if op == "!=":
                return 1 - apply("feq", [a, b], [w, w], 1)  # type: ignore[operator]
            raise Rejected("operation on floating point")
        if isinstance(x.left.type, ty.Ptr) and op in "+-":
            i = self.promote(b, x.right.type)[0] * self.size(x.left.type.to)
            return (a + i if op == "+" else a - i) & M64
        p, pw, ps = self.promote(a, x.left.type)
        q, qw, qs = self.promote(b, x.right.type)
        if op in ("<<", ">>"):
            if not 0 <= q < pw:
                raise Rejected("shift amount")
            return (p << q if op == "<<" else p >> q) & (1 << pw) - 1
        w = max(pw, qw)                                       # the usual arithmetic conversions
        s = (ps if pw > qw else qs if qw > pw else ps and qs)
        if not s:
            p, q = p & (1 << w) - 1, q & (1 << w) - 1
        if op in ("==", "!=", "<", "<=", ">", ">="):
            return int({"==": p == q, "!=": p != q, "<": p < q, "<=": p <= q, ">": p > q, ">=": p >= q}[op])
        if op in ("/", "%"):
            if q == 0 or s and q == -1 and p == -(1 << (w - 1)):
                raise Trapped("divide-error")
            d = abs(p) // abs(q)
            d = -d if (p < 0) != (q < 0) else d
            return (d if op == "/" else p - d * q) & (1 << w) - 1
        r = {"+": lambda: p + q, "-": lambda: p - q, "*": lambda: p * q, "&": lambda: p & q, "|": lambda: p | q, "^": lambda: p ^ q}[op]()
        return self.wrap(r, w, s) if op in "+-*" else r & (1 << w) - 1

    # -- statements -----------------------------------------------------------------------------
    def store(self, to: A.Expr, v: int, t: ty.CType) -> None:
        v = self.convert(v, t, to.type)
        if isinstance(to, A.Local):
            self.locals[to.id] = v
        else:
            self.write(self.address(to), to.type.width // 8, v)

    def block(self, body: tuple[A.Stmt, ...], k: int = 0) -> tuple | None:
        """How control leaves the list: None at its end, or ("return", value), ("break",), ("continue",), ("goto", label)."""
        while k < len(body):
            out = self.stmt(body[k])
            if out is not None:
                if out[0] == "goto":
                    at = next((j for j, s in enumerate(body) if isinstance(s, A.Label) and s.label == out[1]), None)
                    if at is not None:
                        k = at
                        self.tick()
                        continue
                return out
            k += 1
        return None

    def stmt(self, s: A.Stmt) -> tuple | None:
        self.tick()
        if isinstance(s, A.Assign):
            self.store(s.to, self.value(s.value), s.value.type)
        elif isinstance(s, A.Declare):
            self.locals.pop(s.var.id, None)
            if s.value is not None:
                self.store(s.var, self.value(s.value), s.value.type)
        elif isinstance(s, A.Do):
            self.value(s.value)
        elif isinstance(s, A.Return):
            return ("return", None if s.value is None else (self.value(s.value), s.value.type))
        elif isinstance(s, A.Break):
            return ("break",)
        elif isinstance(s, A.Continue):
            return ("continue",)
        elif isinstance(s, A.Goto):
            return ("goto", s.label)
        elif isinstance(s, A.If):
            return self.block(s.then if self.truth(s.cond) else s.other)
        elif isinstance(s, A.Loop):
            while s.form != "while" or self.truth(s.cond):  # type: ignore[arg-type]
                self.tick()
                out = self.block(s.body)
                if out is not None and out[0] == "break":
                    break
                if out is not None and out[0] != "continue":
                    return out
                if s.form == "do" and not self.truth(s.cond):  # type: ignore[arg-type]
                    break
        return None


def run(body: A.Body, m: Machine, args: list[int]) -> int | None:
    """The result's bits (None for void)."""
    for p, v in zip(body.params, args):
        m.locals[p.id] = v & (1 << p.type.width) - 1 if not isinstance(p.type, ty.Bool) else int(v & 255 != 0)
    out = m.block(body.stmts)
    if out is None or out[1] is None:
        if not isinstance(body.result, ty.Void):
            raise Rejected("no result")
        return None
    if out[0] != "return":
        raise Rejected("a jump that leads nowhere")
    v, t = out[1]
    return m.convert(v, t, body.result)


# ---------------------------------------------------------------------------------------- against the IR

HEAP, SPAN = 0x5000_0000, 0x400
FRAME = 0x7A3B_5C6D_0008


def _mix(*xs: int) -> int:
    h = 0x9E3779B97F4A7C15
    for x in xs:
        h = (h ^ (x & M64)) * 0xBF58476D1CE4E5B9 & M64
        h ^= h >> 29
    return h


class World:
    """Memory, arguments and callees made from a seed: the same for both executions."""

    def __init__(self, seed: int, image: Callable[[int, int], bytes | None]) -> None:
        self.seed = seed
        self.image = image
        self.memory: dict[int, int] = {}
        self.written: dict[int, int] = {}
        self.trace: list = []
        self.calls = 0

    def scalar(self, *key: int) -> int:
        h = _mix(self.seed, *key)
        return (0, 1, 2, 5, M64, M64 - 2, h & 0xFF, h & 0xFFFF, h, 0x3F800000 + (h & 0x7FFFFF), 0x7FFFFFFF, HEAP + (h & 0x3F) * 16)[h >> 40 & 15 if (h >> 40 & 15) < 12 else 8]

    def argument(self, k: int, pointer: bool) -> int:
        if pointer:
            return 0 if _mix(self.seed, 3, k) % 12 == 0 else HEAP + (_mix(self.seed, 4, k) % 4) * 0x40
        return self.scalar(5, k)

    def byte(self, a: int) -> int:
        if a in self.memory:
            return self.memory[a]
        b = self.image(a, 1)
        if b is not None:
            return b[0]
        base = a & ~7
        h = _mix(self.seed, 1, base)
        # whole words look like null, pointers into the heap, or small or arbitrary numbers
        pick = h >> 50 & 7
        word = 0 if pick < 2 else HEAP + (h % 8) * 0x20 if pick < 4 else (h & 15) | (h >> 8 & 15) << 32 if pick < 6 else h
        return word >> 8 * (a - base) & 255

    def read(self, a: int, n: int) -> int:
        return sum(self.byte((a + k) & M64) << 8 * k for k in range(n))

    def write(self, a: int, n: int, v) -> None:
        for k in range(n):
            x = (a + k) & M64
            self.memory[x] = 0 if v is UNDEF else v >> 8 * k & 255
            if not FRAME - 0x10000 <= x < FRAME + 0x100:
                self.written[x] = self.memory[x]

    def callee(self, target: int, args: tuple[int, ...]) -> int:
        self.calls += 1
        if self.calls > 24:
            raise OutOfSteps
        self.trace.append((target, args, tuple(sorted(self.written.items()))))
        self.written = {}  # each call carries the bytes written since the last
        for k in range(6):
            a = HEAP + (_mix(self.seed, 5, self.calls, k) & (SPAN // 4 - 1)) * 4
            for j in range(4):
                self.memory[a + j] = self.written[a + j] = _mix(self.seed, 6, self.calls, k) >> 8 * j & 0x0F
        return self.scalar(9, self.calls)


def _end_tree(body: A.Body, seed: int, image, sig: Signature, callees: dict[int, Signature], pointers: frozenset[int], size) -> tuple:
    w = World(seed, image)

    def call(target: int, args: tuple[int, ...]) -> int:
        r = callees[target].result
        v = w.callee(target, args)
        return 0 if r is None else v & (1 << r.width) - 1
    m = Machine(w.read, w.write, call, size)
    try:
        v = run(body, m, [w.argument(k, k in pointers) for k in range(len(sig.params))])
        return ("return", v), w, m
    except Trapped:
        return ("trap",), w, m
    except OutOfSteps:
        return ("out",), w, m
    except Rejected as e:
        return ("rejected", str(e)), w, m


def _end_ir(fn: Fn, seed: int, image, conv: Convention, sig: Signature, callees: dict[int, Signature], pointers: frozenset[int]) -> tuple:
    w = World(seed, image)
    entry: dict[str, object] = {}
    for n, v in fn.params:
        entry[n] = _mix(seed, 17, v) & (1 << fn.width(v)) - 1
    for k, p in enumerate(sig.params):
        n = conv.place(k, p.kind)
        if n in entry:
            # above what the parameter uses there may be anything
            x = w.argument(k, k in pointers)
            full = dict((a, fn.width(b)) for a, b in fn.params)[n]
            entry[n] = x & (1 << p.width) - 1 | (_mix(seed, 18, k) << p.width & (1 << full) - 1 if p.width < full else 0)

    def values(at: object, have: dict[str, object]) -> tuple[int, Signature]:
        s = callees[at]  # type: ignore[index]
        args = tuple(_low(have[conv.place(k, p.kind)], p.width) for k, p in enumerate(s.params))
        return w.callee(at, args), s  # type: ignore[arg-type]

    def call(target, have, _sp):
        v, s = values(target, have)
        out = {}
        for o in (x for _b, x in fn.ops() if x.kind == "call"):
            for n, d in zip(o.attr("defs") or (), o.defs):
                out.setdefault(n, _mix(seed, w.calls, len(n), ord(n[-1])) & (1 << fn.width(d)) - 1)
        if s.result is not None:
            n = conv.result(s.result.kind)
            if n in out:
                full = next(fn.width(d) for _b, o in fn.ops() if o.kind == "call" for m, d in zip(o.attr("defs") or (), o.defs) if m == n)
                out[n] = v & (1 << s.result.width) - 1 | (out[n] >> s.result.width << s.result.width if s.result.width < full else 0)
        return out

    try:
        x = interp.run(fn, interp.World(w.read, w.write, entry, FRAME, call, lambda _s: None, lambda op, v: _mix(len(op), v) & 0xFFFFFFFF), 250)
    except Trapped:
        return ("trap",), w
    except OutOfSteps:
        return ("out",), w
    except UndefinedControl:
        return ("undefined",), w
    if x is None:
        return ("out",), w
    vs = dict(x.values)
    if x.kind == "tail":
        try:
            v, s = values(x.target, vs)
        except OutOfSteps:
            return ("out",), w
        return ("return", None if sig.result is None or s.result is None else v & (1 << sig.result.width) - 1), w
    if x.kind != "return":
        return (x.kind,), w
    return ("return", None if sig.result is None else _low(vs[conv.result(sig.result.kind)], sig.result.width)), w


def _low(v: object, w: int) -> int:
    if v is UNDEF:
        raise UndefinedControl
    return v & (1 << w) - 1  # type: ignore[operator]


@dataclass(frozen=True)
class Verdict:
    agree: bool
    runs: int
    complete: int                # runs that ended within the steps on both sides
    why: str = ""
    signed_wraps: int = 0


def compare(body: A.Body, fn: Fn, conv: Convention, sig: Signature, callees: dict[int, Signature], size, image, seeds: int = 96) -> Verdict:
    """Whether the tree and the function do the same on `seeds` worlds. `fn`: the normal form before anything source-level was decided."""
    pointers = frozenset(k for k, p in enumerate(body.params) if isinstance(p.type, ty.Ptr))
    complete = wraps = 0
    for seed in range(seeds):
        try:
            want, a = _end_ir(fn, seed, image, conv, sig, callees, pointers)
        except UndefinedControl:
            return Verdict(False, seed, complete, "undefined value reaches a call or the result")
        got, b, m = _end_tree(body, seed, image, sig, callees, pointers, size)
        wraps += m.wrapped
        if got[0] == "rejected":
            return Verdict(False, seed + 1, complete, got[1], wraps)
        if want[0] == "undefined":
            continue
        if "out" in (want[0], got[0]):
            n = min(len(a.trace), len(b.trace))
            if a.trace[:n] != b.trace[:n]:
                return Verdict(False, seed + 1, complete, "calls differ", wraps)
            continue
        complete += 1
        if got[0] == "return" and want[0] == "return" and isinstance(body.result, ty.Bool) and want[1] not in (0, 1):
            return Verdict(False, seed + 1, complete, "a truth value that is neither 0 nor 1", wraps)
        if a.trace != b.trace:
            return Verdict(False, seed + 1, complete, "calls differ", wraps)
        if got != want:
            return Verdict(False, seed + 1, complete, "result differs", wraps)
        if a.written != b.written:
            return Verdict(False, seed + 1, complete, "memory differs", wraps)
    return Verdict(complete > 0, seeds, complete, "" if complete else "no run ended", wraps)


__all__ = ["Machine", "OutOfSteps", "Rejected", "Verdict", "World", "compare", "run"]
