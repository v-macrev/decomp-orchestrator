# SPDX-License-Identifier: AGPL-3.0-or-later
"""Basic types, by unification over one function at source level.

Every value has a type variable. What an operation does with a value adds to it: floating-point operations make it
floating point, an access through it makes it a pointer to something that has a member there, signed operations are
evidence that it is signed. Variables of values that flow into each other are one variable. Nothing is named: a layout is
what the accesses show, and a property without evidence stays open (`open_signs`), to be tried both ways.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator, Union

from recon.core.inference.signature import FLOAT, INT, Evidence, NotReconstructed, Signature, Slot
from recon.core.ir.model import Arg, Const, Fn, Op, Phi

#: the weight of a declared sign: more than any count of uses can reach
DECLARED = 1 << 20

M64 = (1 << 64) - 1


def signed(v: int, w: int) -> int:
    return v - (1 << w) if v >> (w - 1) & 1 else v


# ---------------------------------------------------------------------------------------- the answer

@dataclass(frozen=True, slots=True)
class Int:
    width: int
    signed: bool


@dataclass(frozen=True, slots=True)
class Float:
    width: int


@dataclass(frozen=True, slots=True)
class Bool:
    width: int = 8


@dataclass(frozen=True, slots=True)
class Ptr:
    to: "CType"
    width: int = 64


@dataclass(frozen=True, slots=True)
class Named:
    """A class of the layout, by number."""

    number: int
    width: int = 0


@dataclass(frozen=True, slots=True)
class Void:
    width: int = 0


CType = Union[Int, Float, Bool, Ptr, Named, Void]
BOOL, VOID = Bool(), Void()


@dataclass(frozen=True, slots=True)
class Member:
    offset: int
    type: CType
    evidence: Evidence = Evidence.CONSTRAINED


@dataclass(frozen=True, slots=True)
class Layout:
    """A class of which only the accessed members are known. `size`: known when it is the step of a pointer."""

    number: int
    members: tuple[Member, ...]
    size: int | None = None


# ---------------------------------------------------------------------------------------- variables

@dataclass
class Pointee:
    members: dict[int, "Var"] = field(default_factory=dict)
    #: what is accessed at an offset with another width than the member there, by (offset, width): a union's other member
    #: or a part of a member; the layout leaves them out, a declared class names them (D-063)
    other: dict[tuple[int, int], "Var"] = field(default_factory=dict)
    steps: set[int] = field(default_factory=set)
    link: "Pointee | None" = None
    number: int = 0


@dataclass
class Var:
    width: int
    id: int
    kind: str = ""                   # "", "float" or "pointer"
    signed: int = 0
    unsigned: int = 0
    flag: bool = False               # holds a truth value
    number: bool = False             # something is computed with it that a truth value would not be used for
    sum: bool = False                # it is the result or an operand of arithmetic that could overflow
    to: Pointee | None = None
    link: "Var | None" = None


@dataclass(frozen=True)
class Address:
    """base + offset, or base + index * scale + offset. Without a base it is absolute."""

    base: Arg | None
    offset: int
    index: int | None = None
    scale: int = 0


class Types:
    def __init__(self, fn: Fn, signature: Signature, callees: dict[int, Signature], flip: frozenset[int] = frozenset(), own: int = -1) -> None:
        """`flip`: open signs to take the other way, by position among the open ones. `own`: the address the function calls itself by."""
        self.own = own
        self.fn = fn
        self.sig = signature
        self.callees = callees
        self.flip = flip
        self.vars: dict[int, Var] = {}
        self.params: dict[tuple[int, int], Var] = {}     # (callee or -1, position) -> its variable; position -1: the result
        self.globals: dict[int, Var] = {}
        self.count = 0
        self.d = {v: o for v, (_b, o) in fn.defining().items()}
        self.layouts: dict[int, Pointee] = {}
        #: pointers that are carried from one round of a loop, or one arm of a branch, to what follows
        self.carried = {a for b in fn.blocks for p in b.phis if p.region is None and fn.width(p.id) == 64 for _k, a in p.args if isinstance(a, int)}
        self._run()

    # -- variables ------------------------------------------------------------------------------
    def new(self, w: int) -> Var:
        self.count += 1
        return Var(w, self.count)

    def find(self, v: Var) -> Var:
        while v.link is not None:
            v = v.link
        return v

    def target(self, p: Pointee) -> Pointee:
        while p.link is not None:
            p = p.link
        return p

    def of(self, a: int) -> Var:
        if a not in self.vars:
            self.vars[a] = self.new(self.fn.width(a))
        return self.find(self.vars[a])

    def slot(self, f: int, k: int, s: Slot) -> Var:
        if f == self.own:
            f = -1
        if (f, k) not in self.params:
            v = self.params[f, k] = self.new(s.width)
            if s.kind == FLOAT:
                v.kind = "float"
            elif s.sign:                     # a declared type outweighs whatever the code suggests
                setattr(v, s.sign, getattr(v, s.sign) + DECLARED)
        return self.find(self.params[f, k])

    def unify(self, a: Var, b: Var) -> None:
        a, b = self.find(a), self.find(b)
        if a is b:
            return
        if a.width != b.width:
            raise NotReconstructed("TYPES_OF_DIFFERENT_WIDTH")
        if a.id > b.id:
            a, b = b, a
        if a.kind and b.kind and a.kind != b.kind:
            raise NotReconstructed("CONFLICTING_TYPES")
        b.link = a
        a.kind = a.kind or b.kind
        a.signed += b.signed
        a.unsigned += b.unsigned
        a.flag &= b.flag
        a.number |= b.number
        a.sum |= b.sum
        if a.to is not None and b.to is not None:
            self.join(a.to, b.to)
        elif b.to is not None:
            a.to = b.to

    def join(self, p: Pointee, q: Pointee) -> None:
        p, q = self.target(p), self.target(q)
        if p is q:
            return
        q.link = p
        p.steps |= q.steps
        for off, v in sorted(q.members.items()):
            if off in p.members:
                self._place(p, off, v)
            else:
                p.members[off] = v
        for (off, _w), v in sorted(q.other.items()):
            self._place(p, off, v)

    def _place(self, p: Pointee, off: int, v: "Var") -> None:
        """`v` accessed at `off` of `p`: the member there when the width is its own, else the other access of that width."""
        w = self.find(v).width
        if off not in p.members:
            p.members[off] = v
        elif self.find(p.members[off]).width == w:
            self.unify(p.members[off], v)
        elif (off, w) in p.other:
            self.unify(p.other[(off, w)], v)
        else:
            p.other[(off, w)] = v

    def pointer(self, v: Var) -> Pointee:
        v = self.find(v)
        if v.width != 64 or v.kind == "float":
            raise NotReconstructed("CONFLICTING_TYPES")
        v.kind = "pointer"
        if v.to is None:
            v.to = Pointee()
        return self.target(v.to)

    def member(self, p: Pointee, off: int, w: int) -> Var:
        p = self.target(p)
        if off in p.members:
            v = self.find(p.members[off])
            if v.width == w:
                return v
            if (off, w) not in p.other:
                p.other[(off, w)] = self.new(w)
            return self.find(p.other[(off, w)])
        p.members[off] = self.new(w)
        return p.members[off]

    # -- addresses ------------------------------------------------------------------------------
    def address(self, a: Arg) -> Address:
        off = 0
        terms: list[tuple[int, int]] = []

        def walk(x: Arg, f: int) -> None:
            nonlocal off
            if isinstance(x, Const):
                off += signed(x.value, 64) * f
                return
            o = self.d.get(x)
            if isinstance(o, Op) and self.fn.width(x) == 64 and not (x in self.carried and f == 1):
                if o.kind == "add":
                    walk(o.args[0], f)
                    walk(o.args[1], f)
                    return
                if o.kind == "sub" and isinstance(o.args[1], Const):
                    walk(o.args[0], f)
                    off -= signed(o.args[1].value, 64) * f
                    return
                if o.kind == "shl" and isinstance(o.args[1], Const) and o.args[1].value < 8:
                    walk(o.args[0], f << o.args[1].value)
                    return
                if o.kind == "mul" and isinstance(o.args[1], Const) and o.args[1].value < 1 << 16:
                    walk(o.args[0], f * o.args[1].value)
                    return
            terms.append((x, f))
        walk(a, 1)
        off = signed(off & M64, 64)
        if not terms:
            return Address(None, off & M64)
        if len(terms) == 1 and terms[0][1] == 1:
            return Address(terms[0][0], off)
        if len(terms) == 2:
            (x, f), (y, g) = terms
            if f == 1 and g == 1:
                if self._is_index(x) and not self._is_index(y):
                    return Address(y, off, x, 1)
                return Address(x, off, y, 1)
            if f == 1:
                return Address(x, off, y, g)
            if g == 1:
                return Address(y, off, x, f)
        raise NotReconstructed("ADDRESS_FORM")

    def _is_index(self, a: int) -> bool:
        o = self.d.get(a)
        return isinstance(o, Op) and o.kind in ("sext", "zext")

    def access(self, a: Arg, w: int) -> Var:
        """The variable of what an access of `w` bits at the address reads or writes."""
        x = self.address(a)
        if x.base is None:
            at = x.offset
            if at not in self.globals:
                self.globals[at] = self.new(w)
            v = self.find(self.globals[at])
            if v.width != w:
                raise NotReconstructed("LAYOUT_CONFLICT")
            return v
        assert isinstance(x.base, int)
        p = self.pointer(self.of(x.base))
        if x.index is not None:
            p.steps.add(x.scale)
        return self.member(p, x.offset, w)

    # -- evidence -------------------------------------------------------------------------------
    def _run(self) -> None:
        fn = self.fn
        for k, s in enumerate(self.sig.params):
            self.slot(-1, k, s)
        if self.sig.result is not None:
            self.slot(-1, -1, self.sig.result)
        for n, v in fn.params:
            self.unify(self.of(v), self.slot(-1, int(n[1:]), self.sig.params[int(n[1:])]))
        steps: list[Op] = []
        for b in fn.blocks:
            for p in b.phis:
                if p.region is None:
                    for _k, a in p.args:
                        if isinstance(a, int):
                            self.unify(self.of(p.id), self.of(a))
            for o in b.ops:
                self._op(o, steps)
            if b.term.kind == "return" and b.term.args and isinstance(b.term.args[0], int):
                assert self.sig.result is not None
                self.unify(self.slot(-1, -1, self.sig.result), self.of(b.term.args[0]))
        for _ in range(2):           # an addition is a step of a pointer once the pointer is known
            for o in steps:
                self._step(o)
        self._flags()

    def _op(self, o: Op, steps: list[Op]) -> None:
        k, fn = o.kind, self.fn

        def vote(a: Arg, sign: bool, weight: int = 1) -> None:
            if isinstance(a, int):
                v = self.of(a)
                if sign:
                    v.signed += weight
                else:
                    v.unsigned += weight

        def floats(*xs: Arg) -> None:
            for x in xs:
                if isinstance(x, int):
                    v = self.of(x)
                    if v.kind == "pointer":
                        raise NotReconstructed("CONFLICTING_TYPES")
                    v.kind = "float"

        def computed(*xs: Arg, sums: bool = False) -> None:
            for x in xs:
                if isinstance(x, int):
                    self.of(x).number = True
                    self.of(x).sum |= sums

        if k == "load":
            self.unify(self.of(o.defs[0]), self.access(o.args[0], fn.width(o.defs[0])))
        elif k == "store":
            w = fn.width(o.args[1])
            if isinstance(o.args[1], Const) and self._split(o.args[0], w):
                for j in range(self._split(o.args[0], w)):
                    n = w // self._split(o.args[0], w)
                    self._member_at(o.args[0], j * n // 8, n)
                return
            v = self.access(o.args[0], w)
            if isinstance(o.args[1], int):
                self.unify(v, self.of(o.args[1]))
        elif k == "call":
            target = o.args[0]
            assert isinstance(target, Const)
            s = self.callees[target.value]
            for j, (a, slot) in enumerate(zip(o.args[1:], s.params)):
                v = self.slot(target.value, j, slot)
                if isinstance(a, int):
                    self.unify(v, self.of(a))
            if o.defs:
                assert s.result is not None
                self.unify(self.slot(target.value, -1, s.result), self.of(o.defs[0]))
        elif k in ("fadd", "fsub", "fmul", "fdiv", "fsqrt", "fcvt", "fround_near", "fround_zero", "fround_down", "fround_up", "frcp_approx", "frsqrt_approx"):
            floats(*o.args, *o.defs)
        elif k in ("flt", "fle", "feq", "funo"):
            floats(*o.args)
        elif k == "sitof":
            vote(o.args[0], True)
            floats(*o.defs)
        elif k in ("ftosi_zero", "ftosi_near"):
            floats(*o.args)
            vote(o.defs[0], True)
        elif k in ("eq", "ne"):
            a, b = o.args
            if isinstance(a, int) and isinstance(b, int):
                self.unify(self.of(a), self.of(b))
        elif k in ("slt", "sle", "ult", "ule"):
            a, b = o.args
            for x in o.args:
                vote(x, k[0] == "s", 2)
            computed(*o.args)
            if isinstance(a, int) and isinstance(b, int):
                self.unify(self.of(a), self.of(b))
        elif k == "ite":
            for x in o.args[1:]:
                if isinstance(x, int):
                    self.unify(self.of(o.defs[0]), self.of(x))
        elif k in ("sdiv", "srem", "ashr"):
            vote(o.args[0], True, 2)
            vote(o.defs[0], True)
            if k != "ashr":
                vote(o.args[1], True, 2)
            computed(*o.args, *o.defs)
        elif k in ("udiv", "urem", "lshr"):
            vote(o.args[0], False, 2)
            vote(o.defs[0], False)
            if k != "lshr":
                vote(o.args[1], False, 2)
            computed(*o.args, *o.defs)
        elif k == "sext":
            vote(o.args[0], True, 2)
            vote(o.defs[0], True)
            computed(*o.args)
        elif k == "zext" and fn.width(o.args[0]) > 1:
            vote(o.args[0], False, 1 if fn.width(o.args[0]) == 32 else 2)
            computed(*o.args)
        elif k in ("add", "sub"):
            computed(*o.args, *o.defs, sums=True)
            if fn.width(o.defs[0]) == 64:
                steps.append(o)
        elif k in ("mul", "neg", "not", "shl"):
            computed(*o.args, *o.defs, sums=k in ("mul", "neg"))
        elif k in ("and", "or", "xor"):
            if any(isinstance(a, Const) for a in o.args):
                for x in (*o.args, *o.defs):
                    if isinstance(x, int):
                        vote(x, False)
            computed(*o.args, *o.defs)

    def _split(self, a: Arg, w: int) -> int:
        """Into how many members a constant store goes: one, unless it lies across the natural alignment of its width."""
        x = self.address(a)
        if x.base is None or x.index is not None or w < 16:
            return 0
        n = 1
        while w // n > 8 and x.offset % (w // n // 8):
            n *= 2
        return n if n > 1 else 0

    def split(self, o: Op) -> int:
        return self._split(o.args[0], self.fn.width(o.args[1])) if isinstance(o.args[1], Const) else 0

    def _member_at(self, a: Arg, more: int, w: int) -> Var:
        x = self.address(a)
        assert isinstance(x.base, int)
        return self.member(self.pointer(self.of(x.base)), x.offset + more, w)

    def _step(self, o: Op) -> None:
        a, b = o.args
        if not isinstance(a, int) or not isinstance(b, Const):
            return
        p, r = self.of(a), self.of(o.defs[0])
        if p.kind != "pointer" and r.kind != "pointer":
            return
        if p is r:
            self.pointer(p).steps.add(abs(signed(b.value, 64)))

    def _flags(self) -> None:
        """Bytes that only ever hold 0 or 1 and that nothing is computed with."""
        made: dict[int, bool] = {}
        for b in self.fn.blocks:
            for p in b.phis:
                if p.region is None and self.fn.width(p.id) == 8:
                    for _k, a in p.args:
                        if isinstance(a, Const):
                            v = self.of(p.id)
                            made[v.id] = made.get(v.id, True) and a.value in (0, 1)
            for o in b.ops:
                for v in o.defs:
                    if self.fn.width(v) == 8:
                        x = self.of(v)
                        made[x.id] = made.get(x.id, True) and (o.kind == "zext" and self.fn.width(o.args[0]) == 1 or o.kind == "call")
            if b.term.kind == "return" and b.term.args and isinstance(b.term.args[0], Const) and b.term.args[0].width == 8 and self.sig.result is not None:
                x = self.find(self.slot(-1, -1, self.sig.result))
                made[x.id] = made.get(x.id, True) and b.term.args[0].value in (0, 1)
        for v in [*self.vars.values(), *self.params.values()]:
            v = self.find(v)
            v.flag = made.get(v.id, False) and not v.number and v.kind == ""

    # -- the answer -----------------------------------------------------------------------------
    def open_signs(self) -> list[int]:
        """Integer variables whose sign nothing decides, by id, in order of id."""
        out = set()
        for v in self._all():
            if v.kind == "" and v.width in (8, 16, 32, 64) and not v.flag and v.signed == v.unsigned:
                out.add(v.id)
        return sorted(out)

    def _all(self) -> Iterator[Var]:
        for v in (*self.vars.values(), *self.params.values(), *self.globals.values()):
            yield self.find(v)
        for p in self._pointees():
            for m in p.members.values():
                yield self.find(m)

    def _pointees(self) -> list[Pointee]:
        out: list[Pointee] = []
        seen: set[int] = set()
        work = [v.to for v in (*map(self.find, self.vars.values()), *map(self.find, self.params.values()), *map(self.find, self.globals.values())) if v.to is not None]
        while work:
            p = self.target(work.pop(0))
            if id(p) in seen:
                continue
            seen.add(id(p))
            out.append(p)
            work += [m.to for m in (self.find(p.members[k]) for k in sorted(p.members)) if m.to is not None]
        return out

    def is_scalar(self, p: Pointee) -> bool:
        """Whether it is one value and no class: a class is needed for what leads to itself."""
        p = self.target(p)
        at, seen = p, set()
        while set(at.members) == {0} and id(at) not in seen:
            seen.add(id(at))
            m = self.find(at.members[0])
            if m.kind != "pointer" or m.to is None:
                break
            at = self.target(m.to)
            if at is p:
                return False
        return set(p.members) == {0} and p.steps <= {self.find(p.members[0]).width // 8}

    def ctype(self, v: Var) -> CType:
        v = self.find(v)
        if v.kind == "float":
            return Float(v.width)
        if v.kind == "pointer":
            assert v.to is not None
            p = self.target(v.to)
            if not p.members:
                return Ptr(VOID)
            if self.is_scalar(p):
                return Ptr(self.ctype(p.members[0]))
            return Ptr(Named(self._number(p)))
        if v.width == 1 or v.flag:
            return BOOL
        if v.width not in (8, 16, 32, 64):
            raise NotReconstructed("VALUE_WIDTH")
        if v.signed == v.unsigned:
            # a signed type would say that sums do not overflow, and nothing supports that
            return Int(v.width, (not v.sum) != (v.id in self.flip))
        return Int(v.width, v.signed > v.unsigned)

    def _number(self, p: Pointee) -> int:
        p = self.target(p)
        if not p.number:
            p.number = len(self.layouts) + 1
            self.layouts[p.number] = p
        return p.number

    def layout(self, n: int) -> Layout:
        p = self.layouts[n]
        members = []
        end = 0
        for off in sorted(p.members):
            t = self.ctype(p.members[off])
            if off < 0:
                raise NotReconstructed("LAYOUT_CONFLICT")
            if off < end:
                continue        # it lies across the one before: not a member of the layout, as an access of another width (D-063)
            size = t.width // 8
            if off % size:
                raise NotReconstructed("MISALIGNED_MEMBER")
            end = off + size
            members.append(Member(off, t))
        size = min(p.steps) if p.steps else None
        if size is not None and (size < end or any(s % size for s in p.steps)):
            raise NotReconstructed("LAYOUT_CONFLICT")
        return Layout(n, tuple(members), size)

    def step(self, p: Pointee) -> int | None:
        """How many bytes one step of the pointer is, when anything says it."""
        p = self.target(p)
        if self.is_scalar(p):
            return self.find(p.members[0]).width // 8
        return min(p.steps) if p.steps else None


__all__ = ["Address", "BOOL", "Bool", "CType", "Float", "INT", "Int", "Layout", "Member", "Named", "Phi", "Pointee", "Ptr", "Types", "VOID", "Var", "Void", "signed"]
