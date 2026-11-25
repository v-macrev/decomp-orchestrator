# SPDX-License-Identifier: AGPL-3.0-or-later
"""The source-level tree: typed expressions and statements. It says what C++ the emitter writes, not how it is laid out.

Names of variables are numbers here; the emitter chooses the text. Two trees are the same candidate exactly when their
`data` is equal.
"""
from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Iterator, Union

from recon.core.canonical import digest
from recon.core.inference.types import CType


@dataclass(frozen=True, slots=True)
class Local:
    """A parameter or a local variable. Parameters have the numbers below the number of parameters."""

    id: int
    type: CType


@dataclass(frozen=True, slots=True)
class Num:
    """`value` is the bit pattern."""

    value: int
    type: CType


@dataclass(frozen=True, slots=True)
class Unary:
    op: str                      # - ~ !
    arg: "Expr"
    type: CType


@dataclass(frozen=True, slots=True)
class Binary:
    op: str
    left: "Expr"
    right: "Expr"
    type: CType


@dataclass(frozen=True, slots=True)
class Cast:
    """`implicit`: the language converts by itself where the expression stands."""

    arg: "Expr"
    type: CType
    implicit: bool = False


@dataclass(frozen=True, slots=True)
class Field:
    """base->member"""

    base: "Expr"
    offset: int
    type: CType


@dataclass(frozen=True, slots=True)
class Index:
    """base[index]; with no index, *base. As the base of a member: base[index].member (`member` is its offset)."""

    base: "Expr"
    index: "Expr | None"
    type: CType
    member: int | None = None


@dataclass(frozen=True, slots=True)
class AddressOf:
    arg: "Expr"
    type: CType


@dataclass(frozen=True, slots=True)
class Global:
    address: int
    type: CType


@dataclass(frozen=True, slots=True)
class Call:
    target: int
    args: tuple["Expr", ...]
    type: CType


@dataclass(frozen=True, slots=True)
class Choose:
    cond: "Expr"
    yes: "Expr"
    no: "Expr"
    type: CType


Expr = Union[Local, Num, Unary, Binary, Cast, Field, Index, AddressOf, Global, Call, Choose]


@dataclass(frozen=True, slots=True)
class Assign:
    to: Expr
    value: Expr


@dataclass(frozen=True, slots=True)
class Do:
    """An expression for its effect."""

    value: Expr


@dataclass(frozen=True, slots=True)
class If:
    cond: Expr
    then: tuple["Stmt", ...]
    other: tuple["Stmt", ...] = ()


@dataclass(frozen=True, slots=True)
class Loop:
    """`form`: "while" (cond before the body), "do" (after it) or "ever" (no cond)."""

    form: str
    cond: Expr | None
    body: tuple["Stmt", ...]


@dataclass(frozen=True, slots=True)
class Return:
    value: Expr | None


@dataclass(frozen=True, slots=True)
class Break:
    pass


@dataclass(frozen=True, slots=True)
class Continue:
    pass


@dataclass(frozen=True, slots=True)
class Goto:
    label: int


@dataclass(frozen=True, slots=True)
class Label:
    label: int


@dataclass(frozen=True, slots=True)
class Declare:
    var: Local
    value: Expr | None


Stmt = Union[Assign, Do, If, Loop, Return, Break, Continue, Goto, Label, Declare]


@dataclass(frozen=True)
class Body:
    """A function body with what it needs declared. Addresses are absolute."""

    params: tuple[Local, ...]
    result: CType
    stmts: tuple[Stmt, ...]
    assumptions: tuple[str, ...] = ()

    def digest(self) -> str:
        return digest([[data(p) for p in self.params], data(self.result), [data(s) for s in self.stmts]])


def data(x):
    """A tree as plain data, with the kind of each node."""
    if isinstance(x, tuple):
        return [data(y) for y in x]
    if hasattr(x, "__dataclass_fields__"):
        return [type(x).__name__, *(data(getattr(x, f.name)) for f in fields(x))]
    return x


def parts(x) -> tuple:
    """The expressions and statements directly inside a node."""
    out: list = []
    for f in fields(x):
        v = getattr(x, f.name)
        for y in v if isinstance(v, tuple) else (v,):
            if isinstance(y, NODES):
                out.append(y)
    return tuple(out)


def walk(x) -> Iterator:
    yield x
    for p in parts(x):
        yield from walk(p)


def rebuild(x, f):
    """The node with `f` applied to each node directly inside it."""
    new = {}
    for fl in fields(x):
        v = getattr(x, fl.name)
        if isinstance(v, tuple):
            new[fl.name] = tuple(f(y) if isinstance(y, NODES) else y for y in v)
        elif isinstance(v, NODES):
            new[fl.name] = f(v)
    if all(getattr(x, k) == v for k, v in new.items()):
        return x
    return type(x)(**{fl.name: new.get(fl.name, getattr(x, fl.name)) for fl in fields(x)})


EXPRS = (Local, Num, Unary, Binary, Cast, Field, Index, AddressOf, Global, Call, Choose)
STMTS = (Assign, Do, If, Loop, Return, Break, Continue, Goto, Label, Declare)
NODES = EXPRS + STMTS

__all__ = ["AddressOf", "Assign", "Binary", "Body", "Break", "Call", "Cast", "Choose", "Continue", "Declare", "Do", "EXPRS", "Expr", "Field", "Global", "Goto", "If", "Index",
           "Label", "Local", "Loop", "NODES", "Num", "Return", "STMTS", "Stmt", "Unary", "data", "parts", "rebuild", "walk"]
