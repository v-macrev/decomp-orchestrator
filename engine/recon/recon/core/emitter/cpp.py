# SPDX-License-Identifier: AGPL-3.0-or-later
"""C++ text of a body and of what it needs declared. A pure function of the tree: the same tree gives the same bytes.

Names are neutral and stable: a class is named by its number, a member by its offset, a callee and a global by their
address, a local by its role. Nothing is named after what it might mean.
"""
from __future__ import annotations

import math
import struct
from dataclasses import dataclass

from recon.core.inference import types as ty
from recon.core.inference.signature import NotReconstructed
from recon.core.structuring import ast as A

INTS = {(8, True): "signed char", (8, False): "unsigned char", (16, True): "short", (16, False): "unsigned short",
        (32, True): "int", (32, False): "unsigned int", (64, True): "long long", (64, False): "unsigned long long"}
LEVEL = {"*": 13, "/": 13, "%": 13, "+": 12, "-": 12, "<<": 11, ">>": 11, "<": 10, "<=": 10, ">": 10, ">=": 10, "==": 9, "!=": 9, "&": 8, "^": 7, "|": 6, "&&": 5, "||": 4}
UNARY, POSTFIX, PRIMARY, CHOOSE, ASSIGN = 14, 15, 16, 3, 2
MAX_LAYOUT = 1 << 16


@dataclass(frozen=True)
class Unit:
    """What one function needs: its text, and the names it gave to addresses."""

    text: str
    name: str
    callees: tuple[tuple[str, int], ...]      # (declared name, absolute address)
    globals: tuple[tuple[str, int], ...]
    lines: int


def type_name(t: ty.CType) -> str:
    if isinstance(t, ty.Int):
        return INTS[t.width, t.signed]
    if isinstance(t, ty.Float):
        return "float" if t.width == 32 else "double"
    if isinstance(t, ty.Bool):
        return "bool"
    if isinstance(t, ty.Ptr):
        return type_name(t.to) + "*"
    if isinstance(t, ty.Named):
        return f"Class{t.number}"
    return "void"


def float_text(bits: int, w: int) -> str:
    v = struct.unpack("<f", struct.pack("<I", bits))[0] if w == 32 else struct.unpack("<d", struct.pack("<Q", bits))[0]
    if math.isnan(v) or math.isinf(v):
        raise NotReconstructed("FLOAT_LITERAL")
    if w == 64:
        return repr(v)
    for digits in range(1, 10):
        s = f"{v:.{digits}g}"
        try:
            if struct.unpack("<f", struct.pack("<f", float(s)))[0] == v:
                break
        except OverflowError:       # rounded up beyond the largest
            pass
    if "e" not in s and "." not in s:
        s += ".0"
    return s + "f"


class Emitter:
    def __init__(self, types: ty.Types, image_base: int, rva: int, name: str | None = None, prefix: str = "") -> None:
        self.t = types
        self.base = image_base
        self.name = name or f"Function{rva:X}"
        self.prefix = prefix
        self.callees: dict[int, str] = {}
        self.globals: dict[int, tuple[str, ty.CType]] = {}
        self.locals: dict[int, str] = {}
        self.used: set[int] = set()

    # -- names ----------------------------------------------------------------------------------
    def local(self, v: A.Local) -> str:
        return self.locals[v.id]

    def name_locals(self, body: A.Body) -> None:
        for k, p in enumerate(body.params):
            self.locals[p.id] = f"arg{k + 1}"
        count: dict[str, int] = {}
        order: list[A.Local] = []
        for s in body.stmts:
            for x in A.walk(s):
                if isinstance(x, A.Local) and x.id not in self.locals and x not in order:
                    order.append(x)
        stepped = {s.to.id for x in body.stmts for s in A.walk(x) if isinstance(s, A.Assign) and isinstance(s.to, A.Local) and isinstance(s.value, A.Binary) and s.value.op in "+-" and s.value.left == s.to and isinstance(s.value.right, A.Num)}
        returned = {s.value.id for x in body.stmts for s in A.walk(x) if isinstance(s, A.Return) and isinstance(s.value, A.Local)}
        for x in order:
            if isinstance(x.type, ty.Ptr):
                role = "entry"
            elif x.id in returned:
                role = "result"
            elif x.id in stepped:
                role = "index"
            else:
                role = "value"
            count[role] = count.get(role, 0) + 1
            self.locals[x.id] = role if count[role] == 1 else f"{role}{count[role]}"

    def callee(self, at: int) -> str:
        return self.callees.setdefault(at, f"{self.prefix}Function{at - self.base:X}" if at != self.own else self.name)

    def member(self, off: int) -> str:
        return f"member{off:X}"

    # -- expressions ----------------------------------------------------------------------------
    def e(self, x: A.Expr, level: int = 0) -> str:
        s, mine = self._e(x)
        return f"({s})" if mine < level else s

    def _e(self, x: A.Expr) -> tuple[str, int]:
        if isinstance(x, A.Local):
            return self.local(x), PRIMARY
        if isinstance(x, A.Num):
            return self.num(x)
        if isinstance(x, A.Unary):
            return x.op + self.e(x.arg, UNARY + (isinstance(x.arg, A.Unary) and x.arg.op == x.op)), UNARY
        if isinstance(x, A.Binary):
            n = LEVEL[x.op]
            left, right = x.left, x.right
            force = {"&", "|", "^", "<<", ">>", "&&", "||"}

            def side(y: A.Expr, more: int) -> str:
                inner = y
                while isinstance(inner, A.Cast) and inner.implicit:
                    inner = inner.arg
                mixed = isinstance(inner, A.Binary) and inner.op != x.op and (x.op in force - {"&&", "||"} or inner.op in force or x.op == "||")
                return f"({self.e(y)})" if mixed else self.e(y, n + more)
            if x.op in ("<<", ">>") and isinstance(left, A.Num) and isinstance(left.type, ty.Int):
                # the shift happens in the type of its left side, which nothing else says
                t = left.type
                first = f"{ty.signed(left.value, t.width) if t.signed else left.value}" + ("" if t.signed else "u") + ("ll" if t.width == 64 else "")
                return f"{first if left.value >> (t.width - 1) == 0 else self.e(left, n)} {x.op} {side(right, 1)}", n
            return f"{side(left, 0)} {x.op} {self.mask(right, x.op) or side(right, 1)}", n
        if isinstance(x, A.Cast):
            if x.implicit:
                return self._e(x.arg)
            return f"static_cast<{type_name(x.type)}>({self.e(x.arg)})", POSTFIX
        if isinstance(x, A.Field):
            return f"{self.e(x.base, POSTFIX)}->{self.member(x.offset)}", POSTFIX
        if isinstance(x, A.Index):
            if x.index is None:
                return f"*{self.e(x.base, UNARY)}", UNARY
            s = f"{self.e(x.base, POSTFIX)}[{self.e(x.index)}]"
            return (s if x.member is None else f"{s}.{self.member(x.member)}"), POSTFIX
        if isinstance(x, A.AddressOf):
            return f"&{self.e(x.arg, UNARY)}", UNARY
        if isinstance(x, A.Global):
            name = f"g_data{x.address - self.base:X}"
            if x.address in self.globals and self.globals[x.address][1] != x.type:
                raise NotReconstructed("LAYOUT_CONFLICT")
            self.globals[x.address] = (name, x.type)
            return name, PRIMARY
        if isinstance(x, A.Call):
            return f"{self.callee(x.target)}({', '.join(self.e(a, ASSIGN) for a in x.args)})", POSTFIX
        if isinstance(x, A.Choose):
            return f"{self.e(x.cond, CHOOSE + 1)} ? {self.e(x.yes, CHOOSE)} : {self.e(x.no, CHOOSE)}", CHOOSE
        raise AssertionError(x)

    def mask(self, x: A.Expr, op: str) -> str | None:
        if op in ("&", "|", "^") and isinstance(x, A.Num) and isinstance(x.type, ty.Int) and x.value > 9:
            return f"0x{x.value:X}" + ("ull" if x.value >> 63 else "")
        return None

    def num(self, x: A.Num) -> tuple[str, int]:
        t = x.type
        if isinstance(t, ty.Bool):
            return ("true" if x.value else "false"), PRIMARY
        if isinstance(t, ty.Float):
            s = float_text(x.value, t.width)
            return s, UNARY if s[0] == "-" else PRIMARY
        if isinstance(t, ty.Ptr):
            if x.value:
                raise NotReconstructed("ADDRESS_CONSTANT")
            return "nullptr", PRIMARY
        if not isinstance(t, ty.Int):
            raise NotReconstructed("CONSTANT_TYPE")
        v = ty.signed(x.value, t.width) if t.signed else x.value
        if t.signed and v == -(1 << (t.width - 1)) and t.width >= 32:
            return f"({v + 1}{'ll' if t.width == 64 else ''} - 1)", PRIMARY
        if t.signed:                # a literal of 2147483648 without a suffix is unsigned for this compiler, and so is its negative
            tail = "ll" if abs(v) > 0x7FFFFFFF else ""
        else:
            tail = "ull" if v >> 63 else "ll" if v >> 32 else "u" if v > 0x7FFFFFFF else ""
        return f"{v}{tail}", UNARY if v < 0 else PRIMARY

    # -- statements -----------------------------------------------------------------------------
    def stmts(self, body: tuple[A.Stmt, ...], depth: int, out: list[str]) -> None:
        pad = "    " * depth
        for s in body:
            if isinstance(s, A.Assign):
                out.append(pad + self.assign(s) + ";")
            elif isinstance(s, A.Declare):
                head = f"{type_name(s.var.type)} {self.local(s.var)}"
                out.append(pad + (f"{head} = {self.e(s.value, ASSIGN)};" if s.value is not None else f"{head};"))
            elif isinstance(s, A.Do):
                out.append(f"{pad}{self.e(s.value)};")
            elif isinstance(s, A.Return):
                out.append(f"{pad}return {self.e(s.value)};" if s.value is not None else f"{pad}return;")
            elif isinstance(s, A.Break):
                out.append(pad + "break;")
            elif isinstance(s, A.Continue):
                out.append(pad + "continue;")
            elif isinstance(s, A.Goto):
                out.append(f"{pad}goto label{s.label};")
            elif isinstance(s, A.Label):
                out.append(f"{pad}label{s.label}:;")
            elif isinstance(s, A.If):
                out.append(f"{pad}if ({self.e(s.cond)}) {{")
                self.stmts(s.then, depth + 1, out)
                other = s.other
                while len(other) == 1 and isinstance(other[0], A.If):
                    out.append(f"{pad}}} else if ({self.e(other[0].cond)}) {{")
                    self.stmts(other[0].then, depth + 1, out)
                    other = other[0].other
                if other:
                    out.append(pad + "} else {")
                    self.stmts(other, depth + 1, out)
                out.append(pad + "}")
            elif isinstance(s, A.Loop):
                if s.form == "do":
                    out.append(pad + "do {")
                elif s.form == "while":
                    out.append(f"{pad}while ({self.e(s.cond)}) {{")  # type: ignore[arg-type]
                else:
                    out.append(pad + "for (;;) {")
                self.stmts(s.body, depth + 1, out)
                out.append(f"{pad}}} while ({self.e(s.cond)});" if s.form == "do" else pad + "}")  # type: ignore[arg-type]

    def assign(self, s: A.Assign) -> str:
        to = self.e(s.to)
        v = s.value
        if isinstance(v, A.Binary) and v.left == s.to and v.op in ("+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"):
            if v.op in "+-" and isinstance(v.right, A.Num) and v.right.value == 1 and not isinstance(v.type, ty.Float):
                return f"{v.op * 2}{to}"
            return f"{to} {v.op}= {self.mask(v.right, v.op) or self.e(v.right, ASSIGN)}"
        return f"{to} = {self.e(v, ASSIGN)}"

    # -- the unit -------------------------------------------------------------------------------
    own: int = -1

    def layouts(self, roots: list[ty.CType]) -> list[str]:
        """Class definitions, each before it is used by value; members are pointers, so a forward declaration is enough otherwise."""
        seen: dict[int, ty.Layout] = {}
        work = list(roots)
        while work:
            t = work.pop(0)
            while isinstance(t, ty.Ptr):
                t = t.to
            if isinstance(t, ty.Named) and t.number not in seen:
                seen[t.number] = self.t.layout(t.number)
                work += [m.type for m in seen[t.number].members]
        out: list[str] = []
        for n in sorted(seen):
            out.append(f"struct Class{n};")
        for n in sorted(seen):
            out += ["", f"struct Class{n} {{"]
            at = 0
            lay = seen[n]
            for m in lay.members:
                if m.offset > MAX_LAYOUT:
                    raise NotReconstructed("LAYOUT_SIZE")
                if m.offset > at:
                    natural = -(-at // (m.type.width // 8)) * (m.type.width // 8)
                    if natural != m.offset:
                        out.append(f"    unsigned char unknown{at:X}[0x{m.offset - at:X}];")
                out.append(f"    {type_name(m.type)} {self.member(m.offset)};")
                at = m.offset + m.type.width // 8
            if lay.size is not None and lay.size > at:
                align = max((m.type.width // 8 for m in lay.members), default=1)
                if -(-at // align) * align != lay.size:
                    out.append(f"    unsigned char unknown{at:X}[0x{lay.size - at:X}];")
            out.append("};")
        return out

    def unit(self, body: A.Body, rva: int) -> Unit:
        self.own = self.base + rva
        self.name_locals(body)
        lines: list[str] = []
        self.stmts(body.stmts[:-1] if body.stmts and body.stmts[-1] == A.Return(None) else body.stmts, 1, lines)
        head = f"{type_name(body.result)} {self.name}({', '.join(f'{type_name(p.type)} {self.local(p)}' for p in body.params)})"
        roots: list[ty.CType] = [body.result, *(p.type for p in body.params)]
        decls: list[str] = []
        for at, name in sorted(self.callees.items()):
            if at == self.own:
                continue
            s = self.t.callees[at]
            ps = [self.t.ctype(self.t.slot(at, k, p)) for k, p in enumerate(s.params)]
            r = ty.VOID if s.result is None else self.t.ctype(self.t.slot(at, -1, s.result))
            roots += [r, *ps]
            decls.append(f"{type_name(r)} {name}({', '.join(type_name(p) + f' arg{k + 1}' for k, p in enumerate(ps))});")
        for at, (name, t) in sorted(self.globals.items()):
            roots.append(t)
            decls.append(f"extern {type_name(t)} {name};")
        for s in body.stmts:
            for x in A.walk(s):
                if isinstance(x, A.EXPRS):
                    roots.append(x.type)
        text = self.layouts(roots)
        if text:
            text.append("")
        text += decls
        if decls:
            text.append("")
        text += [head, "{", *lines, "}"]
        return Unit("\n".join(text) + "\n", self.name, tuple((n, a) for a, n in sorted(self.callees.items()) if a != self.own),
                    tuple((n, a) for a, (n, _t) in sorted(self.globals.items())), len(lines))


__all__ = ["Emitter", "Unit", "float_text", "type_name"]
