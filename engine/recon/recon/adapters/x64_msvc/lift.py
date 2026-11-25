# SPDX-License-Identifier: AGPL-3.0-or-later
"""Lifting of the general-purpose integer subset of x86-64 to `recon.core.sem`.

Every register alias, implicit operand and flag is explicit. Flags the architecture leaves undefined become
`undef`. An instruction outside the subset, or a form that has not passed the execution-based differential
tests (`lift_coverage.json`), is refused with a reason; it is never approximated.

Addresses are virtual addresses (image base + RVA), as the instruction stream itself computes them.
"""
from __future__ import annotations

from typing import Callable

from recon.adapters.x64_msvc.decode import _iced, mnemonic_name
from recon.core.sem import Atom, Builder, Const, Lifted, Loc, Unsupported, Val

GPR = ("rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15")
FLAGS = ("cf", "pf", "af", "zf", "sf", "of", "df")
REG = {n: Loc(n, 64) for n in GPR}
FLAG = {n: Loc(n, 1) for n in FLAGS}
HIGH_BYTE = {"AH": "rax", "CH": "rcx", "DH": "rdx", "BH": "rbx"}

# reasons
NOT_IN_SUBSET = "not-in-subset"
NOT_GP = "operand-not-general-purpose"
SEGMENT = "segment-override"
ADDRESS_SIZE = "address-size-override"
OPERAND_SIZE = "operand-size"
PREFIX = "prefix-not-modelled"
UNVALIDATED = "form-not-validated"


class _Refuse(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason


class _Regs:
    """iced register id -> (full register name, bit offset, width), built once."""

    def __init__(self, ix) -> None:
        self.map: dict[int, tuple[str, int, int]] = {}
        names = {v: k for k, v in vars(ix.Register).items() if isinstance(v, int) and not k.startswith("_")}
        for v, name in names.items():
            if not ix.RegisterExt.is_gpr(v):
                continue
            if name in HIGH_BYTE:
                self.map[v] = (HIGH_BYTE[name], 8, 8)
            else:
                self.map[v] = (GPR[ix.RegisterExt.number(ix.RegisterExt.full_register(v))], 0, ix.RegisterExt.size(v) * 8)


_regs: _Regs | None = None
_codes: dict[int, str] | None = None


def _tables(ix):
    global _regs, _codes
    if _regs is None:
        _regs = _Regs(ix)
        _codes = {v: k for k, v in vars(ix.Code).items() if isinstance(v, int) and not k.startswith("_")}
    return _regs.map, _codes


class L:
    """One instruction being lifted."""

    def __init__(self, ix, ins) -> None:
        self.ix, self.ins = ix, ins
        self.b = Builder()
        self.regs, codes = _tables(ix)
        self.code = codes[ins.code]
        self.m = mnemonic_name(ix, ins.mnemonic)
        self.n = ins.op_count
        self.lock = ins.has_lock_prefix
        self._ea: Val | Const | None = None

    # -- registers and memory -------------------------------------------------------------------
    def c(self, v: int, w: int) -> Const:
        return self.b.const(v, w)

    def flag(self, n: str) -> Val:
        return self.b.get(FLAG[n])

    def setf(self, n: str, v: Atom) -> None:
        self.b.put(FLAG[n], v)

    def undef_flags(self, *names: str) -> None:
        for n in names:
            self.setf(n, self.b.undef(1))

    def read_loc(self, spec: tuple[str, int, int]) -> Val:
        name, off, w = spec
        v = self.b.get(REG[name])
        if off:
            v = self.b.op("lshr", v, self.c(off, 64))
        return v if w == 64 else self.b.op("trunc", v, width=w)

    def write_loc(self, spec: tuple[str, int, int], v: Atom) -> None:
        name, off, w = spec
        b = self.b
        if v.width != w:
            raise AssertionError("width")
        if w == 64:
            b.put(REG[name], v)
        elif w == 32:
            b.put(REG[name], b.op("zext", v, width=64))
        else:
            old = b.get(REG[name])
            keep = b.op("and", old, self.c(~(((1 << w) - 1) << off), 64))
            ins = b.op("zext", v, width=64)
            if off:
                ins = b.op("shl", ins, self.c(off, 64))
            b.put(REG[name], b.op("or", keep, ins))

    def reg(self, name: str, w: int = 64) -> Val:
        return self.read_loc((name, 0, w))

    def setreg(self, name: str, v: Atom) -> None:
        self.write_loc((name, 0, v.width), v)

    def is_mem(self, i: int) -> bool:
        return self.ins.op_kind(i) == self.ix.OpKind.MEMORY

    def spec(self, i: int) -> tuple[str, int, int]:
        r = self.regs.get(self.ins.op_register(i))
        if r is None:
            raise _Refuse(NOT_GP)
        return r

    def ea(self) -> Val | Const:
        """The effective address, computed once, before any write of the instruction."""
        if self._ea is not None:
            return self._ea
        ins, b = self.ins, self.b
        if ins.is_ip_rel_memory_operand:
            if ins.memory_base != self.ix.Register.RIP:
                raise _Refuse(ADDRESS_SIZE)
            self._ea = self.c(ins.ip_rel_memory_address, 64)
            return self._ea
        acc: Val | Const | None = None
        for r, scale in ((ins.memory_base, 1), (ins.memory_index, ins.memory_index_scale)):
            if r == self.ix.Register.NONE:
                continue
            sp = self.regs.get(r)
            if sp is None:
                raise _Refuse(NOT_GP)
            if sp[2] != 64:
                raise _Refuse(ADDRESS_SIZE)
            v = b.get(REG[sp[0]])
            if scale > 1:
                v = b.op("shl", v, self.c(scale.bit_length() - 1, 64))
            acc = v if acc is None else b.op("add", acc, v)
        d = self.c(ins.memory_displacement, 64)
        if acc is None:
            acc = d
        elif d.value:
            acc = b.op("add", acc, d)
        self._ea = acc
        return acc

    def width(self, i: int) -> int:
        k, K = self.ins.op_kind(i), self.ix.OpKind
        if k == K.REGISTER:
            return self.spec(i)[2]
        if k == K.MEMORY:
            return self.ix.MemorySizeExt.size(self.ins.memory_size) * 8
        raise AssertionError("immediate operands have no width of their own")

    def rd(self, i: int, w: int | None = None) -> Atom:
        k, K = self.ins.op_kind(i), self.ix.OpKind
        if k == K.REGISTER:
            return self.read_loc(self.spec(i))
        if k == K.MEMORY:
            return self.b.load(self.ea(), self.width(i), atomic=self.lock)
        if w is None:
            raise AssertionError("an immediate needs the width it is used at")
        return self.c(self.ins.immediate(i), w)

    def wr(self, i: int, v: Atom) -> None:
        if self.is_mem(i):
            self.b.store(self.ea(), v, atomic=self.lock)
        else:
            self.write_loc(self.spec(i), v)

    # -- flags ----------------------------------------------------------------------------------
    def msb(self, v: Atom) -> Val:
        return self.b.op("slt", v, self.c(0, v.width))

    def bit(self, v: Atom, n: int) -> Val:
        return self.b.op("trunc", self.b.op("lshr", v, self.c(n, v.width)), width=1) if v.width > 1 else v

    def szp(self, r: Atom) -> dict[str, Val]:
        b = self.b
        low = r if r.width == 8 else b.op("trunc", r, width=8)
        odd = b.op("trunc", b.op("popcount", low), width=1)
        return {"sf": self.msb(r), "zf": b.op("eq", r, self.c(0, r.width)), "pf": b.op("not", odd)}

    def put_flags(self, fl: dict[str, Atom]) -> None:
        for n in FLAGS:
            if n in fl:
                self.setf(n, fl[n])

    def logic_flags(self, r: Atom) -> None:
        z = self.c(0, 1)
        self.put_flags({**self.szp(r), "cf": z, "of": z, "af": self.b.undef(1)})

    def add_core(self, x: Atom, y: Atom, carry: Atom | None) -> tuple[Val, dict[str, Atom]]:
        b, w = self.b, x.width
        wide = b.op("add", b.op("zext", x, width=w + 1), b.op("zext", y, width=w + 1))
        if carry is not None:
            wide = b.op("add", wide, b.op("zext", carry, width=w + 1))
        r = b.op("trunc", wide, width=w)
        of = self.msb(b.op("and", b.op("xor", x, r), b.op("xor", y, r)))
        af = self.bit(b.op("xor", b.op("xor", x, y), r), 4)
        return r, {**self.szp(r), "cf": self.bit(wide, w), "of": of, "af": af}

    def sub_core(self, x: Atom, y: Atom, borrow: Atom | None) -> tuple[Val, dict[str, Atom]]:
        b, w = self.b, x.width
        wide = b.op("sub", b.op("zext", x, width=w + 1), b.op("zext", y, width=w + 1))
        if borrow is not None:
            wide = b.op("sub", wide, b.op("zext", borrow, width=w + 1))
        r = b.op("trunc", wide, width=w)
        of = self.msb(b.op("and", b.op("xor", x, y), b.op("xor", x, r)))
        af = self.bit(b.op("xor", b.op("xor", x, y), r), 4)
        return r, {**self.szp(r), "cf": self.bit(wide, w), "of": of, "af": af}

    def cond(self) -> Val:
        C, b = self.ix.ConditionCode, self.b
        cc = self.ins.condition_code
        base = {C.O: C.O, C.NO: C.O, C.B: C.B, C.AE: C.B, C.E: C.E, C.NE: C.E, C.BE: C.BE, C.A: C.BE, C.S: C.S, C.NS: C.S,
                C.P: C.P, C.NP: C.P, C.L: C.L, C.GE: C.L, C.LE: C.LE, C.G: C.LE}[cc]
        v = {C.O: lambda: self.flag("of"), C.B: lambda: self.flag("cf"), C.E: lambda: self.flag("zf"), C.S: lambda: self.flag("sf"),
             C.P: lambda: self.flag("pf"), C.BE: lambda: b.op("or", self.flag("cf"), self.flag("zf")),
             C.L: lambda: b.op("xor", self.flag("sf"), self.flag("of")),
             C.LE: lambda: b.op("or", self.flag("zf"), b.op("xor", self.flag("sf"), self.flag("of")))}[base]()
        return v if cc == base else b.op("not", v)

    # -- stack ----------------------------------------------------------------------------------
    def push(self, v: Atom) -> None:
        sp = self.b.op("sub", self.reg("rsp"), self.c(8, 64))
        self.b.store(sp, v)
        self.b.put(REG["rsp"], sp)

    def pop(self) -> Val:
        sp = self.reg("rsp")
        v = self.b.load(sp, 64)
        self.b.put(REG["rsp"], self.b.op("add", sp, self.c(8, 64)))
        return v

    @property
    def next(self) -> Const:
        return self.c(self.ins.next_ip, 64)

    @property
    def target(self) -> Const:
        return self.c(self.ins.near_branch_target, 64)


# ---------------------------------------------------------------------------------------- handlers

def _binary(l: L) -> tuple[Atom, Atom]:
    w = l.width(0)
    return l.rd(0), l.rd(1, w)


def h_mov(l: L) -> None:
    l.wr(0, l.rd(1, l.width(0)))


def h_ext(kind: str) -> Callable[[L], None]:
    def f(l: L) -> None:
        v, w = l.rd(1), l.width(0)
        l.wr(0, v if v.width == w else l.b.op(kind, v, width=w))
    return f


def h_lea(l: L) -> None:
    v, w = l.ea(), l.width(0)
    l.wr(0, v if w == 64 else l.b.op("trunc", v, width=w))


def h_addlike(sub: bool, carry: bool, write: bool) -> Callable[[L], None]:
    def f(l: L) -> None:
        x, y = _binary(l)
        cin = l.flag("cf") if carry else None
        r, fl = (l.sub_core if sub else l.add_core)(x, y, cin)
        if write:
            l.wr(0, r)
        l.put_flags(fl)
    return f


def h_logic(op: str, write: bool = True) -> Callable[[L], None]:
    def f(l: L) -> None:
        x, y = _binary(l)
        r = l.b.op(op, x, y)
        if write:
            l.wr(0, r)
        l.logic_flags(r)
    return f


def h_incdec(sub: bool) -> Callable[[L], None]:
    def f(l: L) -> None:
        x = l.rd(0)
        r, fl = (l.sub_core if sub else l.add_core)(x, l.c(1, x.width), None)
        fl.pop("cf")
        l.wr(0, r)
        l.put_flags(fl)
    return f


def h_neg(l: L) -> None:
    x = l.rd(0)
    r, fl = l.sub_core(l.c(0, x.width), x, None)
    l.wr(0, r)
    l.put_flags(fl)


def h_not(l: L) -> None:
    l.wr(0, l.b.op("not", l.rd(0)))


def _count(l: L, i: int, w: int) -> Atom:
    """The shift count masked to 5 bits (6 for 64-bit operands), 8 bits wide."""
    v = l.rd(i, 8)
    return l.b.op("and", v, l.c(63 if w == 64 else 31, 8))


def _when(l: L, cond: Atom, new: dict[str, Atom]) -> None:
    """Write flags only where `cond` holds; otherwise they keep their value."""
    for n in FLAGS:
        if n in new:
            l.setf(n, l.b.op("ite", cond, new[n], l.flag(n)))


def h_shift(op: str) -> Callable[[L], None]:
    def f(l: L) -> None:
        b = l.b
        x = l.rd(0)
        w = x.width
        n = _count(l, 1, w)
        r = b.op(op, x, n)
        nz = b.op("ne", n, l.c(0, 8))
        one = b.op("eq", n, l.c(1, 8))
        nm1 = b.op("sub", n, l.c(1, 8))
        if op == "shl":
            # last bit out is bit (w - n) of x
            out = b.op("trunc", b.op("lshr", x, b.op("sub", l.c(w, 8), n)), width=1)
            ofv = b.op("xor", l.msb(r), out)
        else:
            out = b.op("trunc", b.op(op, x, nm1), width=1)
            ofv = l.msb(x) if op == "lshr" else l.c(0, 1)
        if op == "ashr":
            cf: Atom = out
        else:
            # the carry of a logical shift by the operand's width or more (8 and 16 bits only) is undefined
            cf = b.op("ite", b.op("ult", n, l.c(w, 8)), out, b.undef(1))
        of = b.op("ite", one, ofv, b.undef(1))
        l.wr(0, r)
        _when(l, nz, {**l.szp(r), "cf": cf, "of": of, "af": b.undef(1)})
    return f


def h_rotate(left: bool) -> Callable[[L], None]:
    def f(l: L) -> None:
        b = l.b
        x = l.rd(0)
        w = x.width
        n = _count(l, 1, w)
        k = b.op("and", n, l.c(w - 1, 8))
        back = b.op("and", b.op("sub", l.c(0, 8), k), l.c(w - 1, 8))
        r = b.op("or", b.op("shl", x, k if left else back), b.op("lshr", x, back if left else k))
        r = b.op("ite", b.op("eq", k, l.c(0, 8)), x, r)
        nz = b.op("ne", n, l.c(0, 8))
        top = l.msb(r)
        cf = l.bit(r, 0) if left else top
        ofv = b.op("xor", top, cf) if left else b.op("xor", top, l.bit(r, w - 2))
        of = b.op("ite", b.op("eq", n, l.c(1, 8)), ofv, b.undef(1))
        l.wr(0, r)
        _when(l, nz, {"cf": cf, "of": of})
    return f


def h_rotate_carry(left: bool) -> Callable[[L], None]:
    def f(l: L) -> None:
        b = l.b
        x = l.rd(0)
        w = x.width
        n = _count(l, 1, w)
        k = b.op("urem", n, l.c(w + 1, 8)) if w < 32 else n
        wide = b.op("cat", l.flag("cf"), x)  # w + 1 bits, the carry on top
        back = b.op("sub", l.c(w + 1, 8), k)
        rot = b.op("or", b.op("shl", wide, k if left else back), b.op("lshr", wide, back if left else k))
        rot = b.op("ite", b.op("eq", k, l.c(0, 8)), wide, rot)
        r = b.op("trunc", rot, width=w)
        cf = l.bit(rot, w)
        top = l.msb(r)
        ofv = b.op("xor", top, cf) if left else b.op("xor", top, l.bit(r, w - 2))
        of = b.op("ite", b.op("eq", n, l.c(1, 8)), ofv, b.undef(1))
        l.wr(0, r)
        _when(l, b.op("ne", n, l.c(0, 8)), {"cf": cf, "of": of})
    return f


def h_double_shift(left: bool) -> Callable[[L], None]:
    def f(l: L) -> None:
        b = l.b
        x, y = l.rd(0), l.rd(1)
        w = x.width
        n = _count(l, 2, w)
        nz = b.op("ne", n, l.c(0, 8))
        wide = b.op("cat", x, y) if left else b.op("cat", y, x)
        if left:
            r = b.op("trunc", b.op("lshr", b.op("shl", wide, n), l.c(w, 2 * w)), width=w)
            out = b.op("trunc", b.op("lshr", x, b.op("sub", l.c(w, 8), n)), width=1)
        else:
            r = b.op("trunc", b.op("lshr", wide, n), width=w)
            out = b.op("trunc", b.op("lshr", x, b.op("sub", n, l.c(1, 8))), width=1)
        if w == 16:
            ok = b.op("ule", n, l.c(16, 8))  # a count above the operand's width leaves everything undefined
            r = b.op("ite", ok, r, b.undef(w))
            out = b.op("ite", ok, out, b.undef(1))
        of = b.op("ite", b.op("eq", n, l.c(1, 8)), b.op("xor", l.msb(r), l.msb(x)), b.undef(1))
        fl = {**l.szp(r), "cf": out, "of": of, "af": b.undef(1)}
        l.wr(0, b.op("ite", nz, r, x))
        _when(l, nz, fl)
    return f


def _acc(l: L, w: int) -> tuple[Val, str]:
    return l.reg("rax", w), "rdx"


def h_mul(signed: bool) -> Callable[[L], None]:
    def f(l: L) -> None:
        b = l.b
        ext = "sext" if signed else "zext"
        if l.n == 1:
            y = l.rd(0)
            w = y.width
            x = l.reg("rax", w)
            p = b.op("mul", b.op(ext, x, width=2 * w), b.op(ext, y, width=2 * w))
            lo, hi = b.op("trunc", p, width=w), b.op("trunc", b.op("lshr", p, l.c(w, 2 * w)), width=w)
            if w == 8:
                l.setreg("rax", p)
            else:
                l.setreg("rax", lo)
                l.setreg("rdx", hi)
        else:
            w = l.width(0)
            x, y = (l.rd(0), l.rd(1)) if l.n == 2 else (l.rd(1), l.rd(2, w))
            p = b.op("mul", b.op("sext", x, width=2 * w), b.op("sext", y, width=2 * w))
            lo = b.op("trunc", p, width=w)
            l.wr(0, lo)
        over = b.op("ne", p, b.op(ext, lo, width=2 * w))
        l.setf("cf", over)
        l.setf("of", over)
        l.undef_flags("sf", "zf", "af", "pf")
    return f


def h_div(signed: bool) -> Callable[[L], None]:
    def f(l: L) -> None:
        b = l.b
        y = l.rd(0)
        w = y.width
        n = l.reg("rax", 16) if w == 8 else b.op("cat", l.reg("rdx", w), l.reg("rax", w))
        d = b.op("sext" if signed else "zext", y, width=2 * w)
        l.b.trap("divide-error", b.op("eq", y, l.c(0, w)))
        q = b.op("sdiv" if signed else "udiv", n, d)
        r = b.op("srem" if signed else "urem", n, d)
        ql = b.op("trunc", q, width=w)
        l.b.trap("divide-error", b.op("ne", q, b.op("sext" if signed else "zext", ql, width=2 * w)))
        rl = b.op("trunc", r, width=w)
        if w == 8:
            l.setreg("rax", b.op("cat", rl, ql))
        else:
            l.setreg("rax", ql)
            l.setreg("rdx", rl)
        l.undef_flags("cf", "of", "sf", "zf", "af", "pf")
    return f


def h_convert(src: int, dst: int) -> Callable[[L], None]:
    """CBW, CWDE, CDQE: sign-extend the accumulator in place."""
    def f(l: L) -> None:
        l.setreg("rax", l.b.op("sext", l.reg("rax", src), width=dst))
    return f


def h_spread(w: int) -> Callable[[L], None]:
    """CWD, CDQ, CQO: the accumulator's sign in the data register."""
    def f(l: L) -> None:
        l.setreg("rdx", l.b.op("ashr", l.reg("rax", w), l.c(w - 1, 8)))
    return f


def h_setcc(l: L) -> None:
    l.wr(0, l.b.op("zext", l.cond(), width=8))


def h_cmovcc(l: L) -> None:
    new = l.rd(1)  # a memory source is read whether or not the condition holds
    old = l.rd(0)
    l.wr(0, l.b.op("ite", l.cond(), new, old))


def h_jcc(l: L) -> None:
    if not l.code.endswith("_64"):
        raise _Refuse(OPERAND_SIZE)
    l.b.branch(l.cond(), l.target, l.next)


def h_jrcxz(l: L) -> None:
    if l.code != "JRCXZ_REL8_64":
        raise _Refuse(ADDRESS_SIZE)
    l.b.branch(l.b.op("eq", l.reg("rcx"), l.c(0, 64)), l.target, l.next)


def h_jmp(l: L) -> None:
    if l.code in ("JMP_REL8_64", "JMP_REL32_64"):
        l.b.goto(l.target)
    elif l.code == "JMP_RM64":
        l.b.goto(l.rd(0))
    else:
        raise _Refuse(OPERAND_SIZE)


def h_call(l: L) -> None:
    if l.code == "CALL_REL32_64":
        t: Atom = l.target
    elif l.code == "CALL_RM64":
        t = l.rd(0)
    else:
        raise _Refuse(OPERAND_SIZE)
    l.push(l.next)
    l.b.call(t, l.next)


def h_ret(l: L) -> None:
    if l.code not in ("RETNQ", "RETNQ_IMM16"):
        raise _Refuse(OPERAND_SIZE)
    t = l.pop()
    if l.n:
        l.b.put(REG["rsp"], l.b.op("add", l.reg("rsp"), l.c(l.ins.immediate(0), 64)))
    l.b.ret(t)


def h_push(l: L) -> None:
    if l.code in ("PUSH_R64", "PUSH_RM64"):
        l.push(l.rd(0))
    elif l.code in ("PUSHQ_IMM8", "PUSHQ_IMM32"):
        l.push(l.c(l.ins.immediate(0), 64))
    else:
        raise _Refuse(OPERAND_SIZE)


def h_pop(l: L) -> None:
    if l.code not in ("POP_R64", "POP_RM64"):
        raise _Refuse(OPERAND_SIZE)
    v = l.pop()  # the stack pointer is raised before a memory destination's address is formed
    l.wr(0, v)


def h_leave(l: L) -> None:
    if l.code != "LEAVEQ":
        raise _Refuse(OPERAND_SIZE)
    l.b.put(REG["rsp"], l.reg("rbp"))
    v = l.pop()
    l.b.put(REG["rbp"], v)


def h_xchg(l: L) -> None:
    if l.is_mem(0) or l.is_mem(1):
        l.lock = True  # an exchange with memory is atomic with or without the prefix
    x, y = l.rd(0), l.rd(1)
    l.wr(0, y)
    l.wr(1, x)


def h_xadd(l: L) -> None:
    x, y = l.rd(0), l.rd(1)
    r, fl = l.add_core(x, y, None)
    l.wr(1, x)
    l.wr(0, r)
    l.put_flags(fl)


def h_cmpxchg(l: L) -> None:
    b = l.b
    dest, src = l.rd(0), l.rd(1)
    w = dest.width
    acc = l.reg("rax", w)
    _r, fl = l.sub_core(acc, dest, None)
    same = b.op("eq", acc, dest)
    full = b.get(REG["rax"])
    # the accumulator is written only when the comparison fails
    if w == 64:
        new_acc: Atom = dest
    elif w == 32:
        new_acc = b.op("zext", dest, width=64)
    else:
        new_acc = b.op("or", b.op("and", full, l.c(~((1 << w) - 1), 64)), b.op("zext", dest, width=64))
    if not l.is_mem(0) and w == 32:
        # a 32-bit register destination: its upper half is cleared when written and kept otherwise
        name = l.spec(0)[0]
        old = b.get(REG[name])
        b.put(REG["rax"], b.op("ite", same, full, new_acc))
        if name != "rax":
            b.put(REG[name], b.op("ite", same, b.op("zext", src, width=64), old))
        else:
            b.put(REG["rax"], b.op("zext", src, width=64))
    else:
        l.wr(0, b.op("ite", same, src, dest))
        if l.is_mem(0) or l.spec(0)[0] != "rax" or l.spec(0)[1]:
            cur = b.get(REG["rax"])
            if w < 32:
                new_acc = b.op("or", b.op("and", cur, l.c(~((1 << w) - 1), 64)), b.op("zext", dest, width=64))
            b.put(REG["rax"], b.op("ite", same, cur, new_acc))
    l.put_flags(fl)


def h_bswap(l: L) -> None:
    x = l.rd(0)
    if x.width == 16:
        raise _Refuse(OPERAND_SIZE)
    b, n = l.b, x.width // 8
    acc: Atom | None = None
    for k in range(n):  # byte k of the source becomes byte n-1-k
        byte = b.op("trunc", b.op("lshr", x, l.c(8 * k, 8)), width=8)
        acc = byte if acc is None else b.op("cat", acc, byte)
    assert acc is not None
    l.wr(0, acc)


def h_bt(op: str | None) -> Callable[[L], None]:
    def f(l: L) -> None:
        b = l.b
        w = l.width(0)
        imm = l.ins.op_kind(1) != l.ix.OpKind.REGISTER
        off = l.rd(1, w)
        n = b.op("and", off, l.c(w - 1, w))
        if l.is_mem(0) and not imm:
            # a register offset addresses a bit string: the word is found from the signed offset
            words = b.op("ashr", off, l.c(w.bit_length() - 1, 8))
            words = words if w == 64 else b.op("sext", words, width=64)
            l._ea = b.op("add", l.ea(), b.op("shl", words, l.c((w // 8).bit_length() - 1, 8)))
        x = l.rd(0)
        cf = b.op("trunc", b.op("lshr", x, n), width=1)
        if op:
            mask = b.op("shl", l.c(1, w), n)
            r = {"or": lambda: b.op("or", x, mask), "xor": lambda: b.op("xor", x, mask), "clear": lambda: b.op("and", x, b.op("not", mask))}[op]()
            l.wr(0, r)
        l.setf("cf", cf)
        l.undef_flags("of", "sf", "af", "pf")  # ZF is unaffected
    return f


def h_bitscan(reverse: bool) -> Callable[[L], None]:
    def f(l: L) -> None:
        b = l.b
        x = l.rd(1)
        w = x.width
        zero = b.op("eq", x, l.c(0, w))
        idx = b.op("sub", l.c(w - 1, w), b.op("clz", x)) if reverse else b.op("ctz", x)
        l.wr(0, b.op("ite", zero, b.undef(w), idx))
        l.setf("zf", zero)
        l.undef_flags("cf", "of", "sf", "af", "pf")
    return f


def h_popcnt(l: L) -> None:
    x = l.rd(1)
    z = l.c(0, 1)
    l.wr(0, l.b.op("popcount", x))
    l.put_flags({"zf": l.b.op("eq", x, l.c(0, x.width)), "cf": z, "of": z, "sf": z, "af": z, "pf": z})


def h_countzeros(op: str) -> Callable[[L], None]:
    def f(l: L) -> None:
        b = l.b
        x = l.rd(1)
        r = b.op(op, x)
        l.wr(0, r)
        l.put_flags({"cf": b.op("eq", x, l.c(0, x.width)), "zf": b.op("eq", r, l.c(0, x.width))})
        l.undef_flags("of", "sf", "af", "pf")
    return f


def h_flagop(name: str, value: int | None) -> Callable[[L], None]:
    def f(l: L) -> None:
        l.setf(name, l.b.op("not", l.flag(name)) if value is None else l.c(value, 1))
    return f


def h_lahf(l: L) -> None:
    b = l.b
    one = l.c(1, 1)
    z = l.c(0, 1)
    acc: Atom = l.flag("sf")  # SF ZF 0 AF 0 PF 1 CF, most significant first
    for v in (l.flag("zf"), z, l.flag("af"), z, l.flag("pf"), one, l.flag("cf")):
        acc = b.op("cat", acc, v)
    l.write_loc(("rax", 8, 8), acc)


def h_sahf(l: L) -> None:
    v = l.read_loc(("rax", 8, 8))
    for n, k in (("sf", 7), ("zf", 6), ("af", 4), ("pf", 2), ("cf", 0)):
        l.setf(n, l.bit(v, k))


def h_nop(_l: L) -> None:
    pass


def h_trap(kind: str) -> Callable[[L], None]:
    def f(l: L) -> None:
        l.b.trap(kind, l.c(1, 1))
    return f


def h_fence(kind: str) -> Callable[[L], None]:
    def f(l: L) -> None:
        l.b.fence(kind)
    return f


def _string(l: L, uses: str) -> None:
    ins, K = l.ins, l.ix.OpKind
    for i in range(l.n):
        if ins.op_kind(i) in (K.MEMORY_SEG_SI, K.MEMORY_SEG_ESI, K.MEMORY_SEG_DI, K.MEMORY_SEG_EDI, K.MEMORY_ESDI, K.MEMORY_ESEDI):
            raise _Refuse(ADDRESS_SIZE)
    if ins.has_repne_prefix or (ins.has_rep_prefix and uses == "lods"):
        raise _Refuse(PREFIX)


def _advance(l: L, reg: str, total: Val | Const, back: Atom) -> None:
    b = l.b
    v = l.reg(reg)
    b.put(REG[reg], b.op("ite", back, b.op("sub", v, total), b.op("add", v, total)))


def _total(l: L, n: Atom, size: int) -> Atom:
    return n if size == 1 else l.b.op("shl", n, l.c(size.bit_length() - 1, 8))


def h_movs(size: int) -> Callable[[L], None]:
    def f(l: L) -> None:
        _string(l, "movs")
        back = l.flag("df")
        n: Atom = l.reg("rcx") if l.ins.has_rep_prefix else l.c(1, 64)
        l.b.block_copy(l.reg("rdi"), l.reg("rsi"), n, size, back)
        t = _total(l, n, size)
        _advance(l, "rsi", t, back)
        _advance(l, "rdi", t, back)
        if l.ins.has_rep_prefix:
            l.b.put(REG["rcx"], l.c(0, 64))
    return f


def h_stos(size: int) -> Callable[[L], None]:
    def f(l: L) -> None:
        _string(l, "stos")
        back = l.flag("df")
        n: Atom = l.reg("rcx") if l.ins.has_rep_prefix else l.c(1, 64)
        l.b.block_fill(l.reg("rdi"), l.reg("rax", size * 8), n, back)
        _advance(l, "rdi", _total(l, n, size), back)
        if l.ins.has_rep_prefix:
            l.b.put(REG["rcx"], l.c(0, 64))
    return f


def h_lods(size: int) -> Callable[[L], None]:
    def f(l: L) -> None:
        _string(l, "lods")
        back = l.flag("df")
        si = l.reg("rsi")
        l.setreg("rax", l.b.load(si, size * 8))
        _advance(l, "rsi", l.c(size, 64), back)
    return f


HANDLERS: dict[str, Callable[[L], None]] = {
    "MOV": h_mov, "MOVZX": h_ext("zext"), "MOVSX": h_ext("sext"), "MOVSXD": h_ext("sext"), "LEA": h_lea,
    "ADD": h_addlike(False, False, True), "ADC": h_addlike(False, True, True), "SUB": h_addlike(True, False, True), "SBB": h_addlike(True, True, True),
    "CMP": h_addlike(True, False, False), "AND": h_logic("and"), "OR": h_logic("or"), "XOR": h_logic("xor"), "TEST": h_logic("and", write=False),
    "INC": h_incdec(False), "DEC": h_incdec(True), "NEG": h_neg, "NOT": h_not,
    "SHL": h_shift("shl"), "SAL": h_shift("shl"), "SHR": h_shift("lshr"), "SAR": h_shift("ashr"),
    "ROL": h_rotate(True), "ROR": h_rotate(False), "RCL": h_rotate_carry(True), "RCR": h_rotate_carry(False),
    "SHLD": h_double_shift(True), "SHRD": h_double_shift(False),
    "MUL": h_mul(False), "IMUL": h_mul(True), "DIV": h_div(False), "IDIV": h_div(True),
    "CBW": h_convert(8, 16), "CWDE": h_convert(16, 32), "CDQE": h_convert(32, 64), "CWD": h_spread(16), "CDQ": h_spread(32), "CQO": h_spread(64),
    "JMP": h_jmp, "CALL": h_call, "RET": h_ret, "PUSH": h_push, "POP": h_pop, "LEAVE": h_leave, "JRCXZ": h_jrcxz,
    "XCHG": h_xchg, "XADD": h_xadd, "CMPXCHG": h_cmpxchg, "BSWAP": h_bswap,
    "BT": h_bt(None), "BTS": h_bt("or"), "BTR": h_bt("clear"), "BTC": h_bt("xor"), "BSF": h_bitscan(False), "BSR": h_bitscan(True),
    "POPCNT": h_popcnt, "LZCNT": h_countzeros("clz"), "TZCNT": h_countzeros("ctz"),
    "CLC": h_flagop("cf", 0), "STC": h_flagop("cf", 1), "CMC": h_flagop("cf", None), "CLD": h_flagop("df", 0), "STD": h_flagop("df", 1),
    "LAHF": h_lahf, "SAHF": h_sahf, "NOP": h_nop, "PAUSE": h_fence("spin-hint"), "MFENCE": h_fence("full"), "LFENCE": h_fence("load"), "SFENCE": h_fence("store"),
    "INT3": h_trap("breakpoint"), "UD2": h_trap("invalid-opcode"),
    "MOVSB": h_movs(1), "MOVSW": h_movs(2), "MOVSD": h_movs(4), "MOVSQ": h_movs(8),
    "STOSB": h_stos(1), "STOSW": h_stos(2), "STOSD": h_stos(4), "STOSQ": h_stos(8),
    "LODSB": h_lods(1), "LODSW": h_lods(2), "LODSD": h_lods(4), "LODSQ": h_lods(8),
}
for _cc in ("O", "NO", "B", "AE", "E", "NE", "BE", "A", "S", "NS", "P", "NP", "L", "GE", "LE", "G"):
    HANDLERS["J" + _cc], HANDLERS["SET" + _cc], HANDLERS["CMOV" + _cc] = h_jcc, h_setcc, h_cmovcc

STRING = frozenset(n for n in HANDLERS if n[:4] in ("MOVS", "STOS", "LODS") and n not in ("MOVSX", "MOVSXD"))
# mnemonics iced shares between a string form and a vector form: only the string codes are the subset
SHARED = {"MOVSD": "MOVSD_M32_M32"}


def form_of(ix, ins) -> str:
    """The name of the instruction's form: iced's code (opcode, operand kinds and sizes), register or memory, and prefixes that matter."""
    _r, codes = _tables(ix)
    f = codes[ins.code]
    if any(ins.op_kind(i) == ix.OpKind.MEMORY for i in range(ins.op_count)):
        f += ":mem"
    if ins.has_lock_prefix:
        f += ":lock"
    if ins.has_rep_prefix or ins.has_repe_prefix:
        f += ":rep"
    if ins.has_repne_prefix:
        f += ":repne"
    return f


def lift(ins, image_base: int = 0, validated: frozenset[str] | None = None) -> Lifted | Unsupported:
    """The semantics of one decoded iced instruction, or a structured refusal. With `validated`, a form that is not in it is refused."""
    ix = _iced()
    rva = ins.ip - image_base
    form = form_of(ix, ins)
    m = mnemonic_name(ix, ins.mnemonic)
    h = HANDLERS.get(m)
    _r, codes = _tables(ix)
    if h is None or (m in SHARED and codes[ins.code] != SHARED[m]):
        return Unsupported(rva, form, NOT_IN_SUBSET)
    mem_seg = any(ins.op_kind(i) == ix.OpKind.MEMORY for i in range(ins.op_count))
    if ins.segment_prefix in (ix.Register.FS, ix.Register.GS) and (mem_seg or m in STRING):
        if m not in ("LEA", "NOP"):
            return Unsupported(rva, form, SEGMENT)
    rep = ins.has_rep_prefix or ins.has_repe_prefix
    if (ins.has_repne_prefix or rep) and m not in STRING and not (m == "RET" and rep):
        return Unsupported(rva, form, PREFIX)
    l = L(ix, ins)
    try:
        h(l)
    except _Refuse as e:
        return Unsupported(rva, form, e.reason)
    if validated is not None and form not in validated:
        return Unsupported(rva, form, UNVALIDATED)
    return Lifted(rva, ins.len, form, tuple(l.b.stmts))
