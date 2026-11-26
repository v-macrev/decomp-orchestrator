# SPDX-License-Identifier: AGPL-3.0-or-later
"""A body as a member function of a class the project declares.

`this` is the first parameter when it points to the class whose members the body reads, or when the body does not use
the first parameter at all; a first parameter used as a plain value makes the function a static member. Members are named
as the declarations name them. The declarations are data handed in (offsets, names, types), read by an adapter from the
project's own headers: nothing here knows a compiler or a project.

What the declarations do not give is refused with a fixed code: a member read at an offset where no member of that type
starts (or no element of an array of that type), a second class, a class by value, a global, and a callee the project
names (by a record or a declaration) without the unit declaring it. A callee the project has not named yet is called by
the project's placeholder for it, `Function<rva>` (an honest name for open work, its rule R7), declared by a prototype the
unit carries after its includes; the project binds such a reference by the target's own field, as the comparator checks.
The tree is the candidate's own; only the names and the form of the function change, so its meaning is the one that was
checked.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from recon.core.emitter.cpp import POSTFIX, Emitter, type_name
from recon.core.inference import types as ty
from recon.core.inference.signature import NotReconstructed
from recon.core.structuring import ast as A


@dataclass(frozen=True)
class Member:
    """A declared data member: where it starts, its name, its type (an array's element type) and how many elements."""

    offset: int
    name: str
    type: ty.CType
    count: int = 0               # 0: not an array


@dataclass(frozen=True)
class Declared:
    cls: str                     # as the header spells it
    method: str
    members: tuple[Member, ...]


@dataclass(frozen=True)
class MemberUnit:
    definition: str              # the out-of-line definition, ending with a newline
    declaration: str             # the declaration inside the class, `static` when there is no `this`; no semicolon
    form: str                    # "this", "this_unused" or "static"
    lines: int
    #: prototypes of the placeholder callees, one per line, for the unit to carry after its includes ("" when none)
    prototypes: str = ""
    #: (placeholder, RVA) of each callee it calls
    callees: tuple[tuple[str, int], ...] = ()


FORMS = ("this", "this_unused", "static")


def _classes(t: ty.CType) -> set[int]:
    while isinstance(t, ty.Ptr):
        t = t.to
    return {t.number} if isinstance(t, ty.Named) else set()


def placeholder(rva: int) -> str:
    """The project's placeholder name of the function at `rva` that it has not named."""
    return f"Function{rva:x}"


class MemberEmitter(Emitter):
    def __init__(self, types: ty.Types, image_base: int, rva: int, d: Declared, cls: int | None, this: int | None,
                 unnamed: Callable[[int], bool] = lambda at: False) -> None:
        """`unnamed(address)`: whether the project has not named the function there, so that it is called by placeholder."""
        super().__init__(types, image_base, rva, name=f"{d.cls}::{d.method}")
        self.d, self.k, self.this = d, cls, this
        self.unnamed = unnamed

    def type_name(self, t: ty.CType) -> str:
        if isinstance(t, ty.Ptr):
            return self.type_name(t.to) + "*"
        if isinstance(t, ty.Named):
            if t.number != self.k:
                raise NotReconstructed("CLASS_NOT_DECLARED")
            return self.d.cls
        return type_name(t)

    def name_locals(self, body: A.Body) -> None:
        super().name_locals(body)
        if self.this is not None:
            self.locals[self.this] = "this"

    def callee(self, at: int) -> str:
        if at not in self.callees:
            if at == self.own or not self.unnamed(at):
                raise NotReconstructed("CALLEE_NOT_DECLARED")
            self.callees[at] = placeholder(at - self.base)
        return self.callees[at]

    def field(self, base: str, off: int, t: ty.CType) -> str:
        for m in self.d.members:
            if m.type != t:
                continue
            if not m.count:
                if m.offset == off:
                    return f"{base}->{m.name}"
                continue
            size = m.type.width // 8
            if size and m.offset <= off < m.offset + m.count * size and (off - m.offset) % size == 0:
                return f"{base}->{m.name}[{(off - m.offset) // size}]"
        raise NotReconstructed("MEMBER_NOT_DECLARED")

    def _e(self, x: A.Expr) -> tuple[str, int]:
        if isinstance(x, A.Global):
            raise NotReconstructed("GLOBAL_NOT_DECLARED")
        if isinstance(x, A.Field):
            b = x.base.type
            if not (isinstance(b, ty.Ptr) and isinstance(b.to, ty.Named) and b.to.number == self.k):
                raise NotReconstructed("CLASS_NOT_DECLARED")
            return self.field(self.e(x.base, POSTFIX), x.offset, x.type), POSTFIX
        if isinstance(x, A.Index) and x.member is not None:
            raise NotReconstructed("ARRAY_OF_CLASS")
        return super()._e(x)

    def member_unit(self, body: A.Body, rva: int, form: str) -> MemberUnit:
        self.own = self.base + rva
        for t in [body.result, *(p.type for p in body.params)] + [x.type for s in body.stmts for x in A.walk(s) if isinstance(x, A.EXPRS)]:
            if isinstance(t, ty.Named):
                raise NotReconstructed("CLASS_BY_VALUE")
            if _classes(t) - {self.k}:
                raise NotReconstructed("CLASS_NOT_DECLARED")
        self.name_locals(body)
        lines: list[str] = []
        self.stmts(body.stmts[:-1] if body.stmts and body.stmts[-1] == A.Return(None) else body.stmts, 1, lines)
        params = body.params if form == "static" else body.params[1:]
        ps = ", ".join(f"{self.type_name(p.type)} {self.local(p)}" for p in params)
        rt = self.type_name(body.result)
        definition = "\n".join([f"{rt} {self.d.cls}::{self.d.method}({ps})", "{", *lines, "}"]) + "\n"
        protos = []
        for at, name in sorted(self.callees.items()):
            s = self.t.callees[at]
            args = [self.type_name(self.t.ctype(self.t.slot(at, k, q))) for k, q in enumerate(s.params)]
            r = "void" if s.result is None else self.type_name(self.t.ctype(self.t.slot(at, -1, s.result)))
            protos.append(f"{r} {name}({', '.join(f'{a} arg{k + 1}' for k, a in enumerate(args))});")
        return MemberUnit(definition, f"{'static ' if form == 'static' else ''}{rt} {self.d.method}({ps})", form, len(lines),
                          "".join(x + "\n" for x in protos), tuple((n, a - self.base) for a, n in sorted(self.callees.items())))


def member_form(body: A.Body, types: ty.Types, image_base: int, rva: int, d: Declared,
                unnamed: Callable[[int], bool] = lambda at: False) -> MemberUnit:
    """The body as `d.cls::d.method`, or NotReconstructed with the reason. `unnamed(address)`: as `MemberEmitter`'s."""
    p0 = body.params[0] if body.params else None
    used = p0 is not None and any(isinstance(x, A.Local) and x.id == p0.id for s in body.stmts for x in A.walk(s))
    if not used:
        form, cls, this = "this_unused", None, None
    elif isinstance(p0.type, ty.Ptr) and isinstance(p0.type.to, ty.Named):
        form, cls, this = "this", p0.type.to.number, p0.id
    else:
        form, cls, this = "static", None, None
    return MemberEmitter(types, image_base, rva, d, cls, this, unnamed).member_unit(body, rva, form)


__all__ = ["FORMS", "Declared", "Member", "MemberEmitter", "MemberUnit", "member_form", "placeholder"]
