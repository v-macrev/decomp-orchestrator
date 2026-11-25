# SPDX-License-Identifier: AGPL-3.0-or-later
"""Generated functions and the two executions that must agree: the lifted instructions and the IR made from them."""
from __future__ import annotations

import random

import asm as A
import iced_x86 as ix
from asm import BASE, RVA, Asm, C, I, R, mem

from recon.adapters.x64_msvc import program as pg
from recon.adapters.x64_msvc.abi import CALLING, WIDTHS
from recon.core import evaluate as ev
from recon.core.ir import build as ib
from recon.core.ir import interp
from recon.core.ir.model import Fn
from recon.core.sem import OPAQUE, CallTo, Let, Lifted

STACK = 0x7000_0008  # a return address has just been pushed
HEAP = 0x5000_0000
OUT = -1  # out of steps
#: parts of the frame that are no stack arguments, whatever lies above the home space: saved registers, the exception runtime's place
HIDDEN: list[tuple[int, int]] = []


def analysed(a: Asm) -> pg.Analysis:
    r = pg.analyse(a.assemble()[0], RVA, BASE, None)
    assert isinstance(r, pg.Analysis), r
    return r


def to_ir(a: Asm) -> Fn:
    an = analysed(a)
    fn = pg.to_ir(an, BASE)
    assert isinstance(fn, Fn), (fn, an.frame_refusal)
    return fn


def with_cleanups(an: pg.Analysis, states: tuple = ((-1, 0x9900), (0, 0), (1, 0x9940)), help: int | None = None) -> Fn:
    """The function as if exceptions out of its calls were cleaned up after: the calls take the states in turn."""
    ends = [i.end for i in an.insns if isinstance(i.terminator, CallTo)]
    eh = ib.Unwinding(states, tuple((r, k % (len(states) + 1) - 1) for k, r in enumerate(ends)), help)
    return ib.build(an.cfg, an.flow, an.frame, CALLING, WIDTHS, BASE, an.rva, eh)


def mix(*xs: int) -> int:
    h = 0x9E3779B97F4A7C15
    for x in xs:
        h = (h ^ (x & (2**64 - 1))) * 0xBF58476D1CE4E5B9 & (2**64 - 1)
        h ^= h >> 29
    return h


class Env:
    """One world, the same for every execution made from the same seed."""

    def __init__(self, seed: int) -> None:
        self.seed = seed
        self.memory: dict[int, object] = {}
        self.trace: list = []
        r = random.Random(seed)
        self.entry: dict[str, object] = {n: r.choice((0, 1, 5, r.getrandbits(w))) & ((1 << w) - 1) for n, w in WIDTHS.items()}
        self.entry["rsp"] = STACK
        for n in ("rcx", "rdx", "r8", "r9"):  # pointers that may well overlap
            self.entry[n] = HEAP + 0x100 * r.randrange(1, 4) + r.choice((0, 0, 4, 8))
        self.calls = 0

    def read(self, a: int, n: int):
        v = 0
        for k in range(n):
            x = self.memory.get(a + k)
            if x is None:
                x = mix(self.seed, a + k) & 255 if (a + k) % 8 < 1 or mix(self.seed, a) & 3 else 0
            if x is ev.UNDEF:
                return ev.UNDEF
            v |= x << 8 * k  # type: ignore[operator]
        return v

    def write(self, a: int, n: int, v) -> None:
        for k in range(n):
            self.memory[(a + k) & (2**64 - 1)] = ev.UNDEF if v is ev.UNDEF else v >> 8 * k & 255
        if not STACK - 0x10000 <= a < STACK + 40:
            self.trace.append(("write", a, n, v))

    def call(self, target, args: dict, sp: int) -> dict:
        self.calls += 1
        self.trace.append(("call", target, tuple(sorted(args.items(), key=lambda kv: kv[0])), tuple(self.read(a, 8) for a in (sp + 32, sp + 40) if not any(a - STACK < hi and lo < a - STACK + 8 for lo, hi in HIDDEN))))
        for k in range(32):  # the home space is the callee's, and so is everything below
            self.memory[sp + k] = mix(self.seed, 77, self.calls, k) & 255
        for k in range(16):
            a = HEAP + (mix(self.seed, 5, self.calls, k) & 0x3FF)
            self.memory[a] = mix(self.seed, 6, self.calls, k) & 255
        frames = [v for _n, v in sorted(args.items()) if isinstance(v, int) and sp + 32 <= v < STACK]
        for v in frames[:1]:  # a callee given a frame address may write through it
            for k in range(8):
                self.memory[v + k] = mix(self.seed, 8, self.calls, k) & 255
        return {n: mix(self.seed, self.calls, k) & ((1 << WIDTHS[n]) - 1) for k, n in enumerate(sorted(CALLING.clobbered))}

    def opaque(self, op: str, x: int) -> int:
        return mix(len(op), x) & 0xFFFFFFFF

    def final(self) -> dict:
        return {a: v for a, v in self.memory.items() if not STACK - 0x10000 <= a < STACK + 40}


def run_lifted(an: pg.Analysis, seed: int, steps: int = 600):
    """(exit, trace, memory outside the frame) of the instructions themselves."""
    e = Env(seed)
    m = ev.Machine(e.read, e.write, dict(e.entry))
    at = {i.rva: i for i in an.insns}
    i = an.insns[0]
    for _ in range(steps):
        try:
            out = _step(i, m, e)
        except ev.Trapped as t:
            return ("trap", t.kind), e.trace, e.final()
        except ev.UndefinedControl:
            return ("undefined",), e.trace, e.final()
        if isinstance(i.terminator, CallTo):
            sp = m.locs["rsp"] + 8
            m.locs["rsp"] = sp
            m.locs.update(e.call(out.target, {n: m.locs[n] for n in CALLING.arguments}, sp))
            if i.end not in at:
                return ("unreachable",), e.trace, e.final()
            i = at[i.end]
            continue
        if out.kind == "return":
            return ("return", tuple(m.locs[n] for n in sorted(CALLING.results)), tuple(m.locs[n] for n in sorted(CALLING.preserved))), e.trace, e.final()
        to = i.end if out.target is None else out.target - BASE
        if to not in at:
            return ("tail", out.target, tuple(m.locs[n] for n in sorted(CALLING.arguments)), tuple(m.locs[n] for n in sorted(CALLING.preserved))), e.trace, e.final()
        i = at[to]
    return OUT, e.trace, e.final()


def _step(i: Lifted, m: ev.Machine, e: Env):
    """As `ev.run`, with opaque operations given a value."""
    if any(isinstance(s, Let) and s.op in OPAQUE for s in i.stmts):
        old = ev.apply
        ev.apply = lambda op, args, ws, out: e.opaque(op, args[0]) if op in OPAQUE else old(op, args, ws, out)  # type: ignore[assignment]
        try:
            return ev.run(i, m)
        finally:
            ev.apply = old
    return ev.run(i, m)


def run_ir(fn: Fn, seed: int, steps: int = 1200, cleanups: bool = False):
    """`cleanups`: also trace the parts of the frame that each call (or a cleanup after it) reads."""
    e = Env(seed)

    def sees(spans):
        if cleanups:
            e.trace.append(("frame", tuple((lo, tuple(e.read(STACK + k, 1) for k in range(lo, hi))) for lo, hi in sorted(spans))))
    w = interp.World(e.read, e.write, dict(e.entry), STACK, e.call, sees, e.opaque)
    try:
        x = interp.run(fn, w, steps)
    except ev.Trapped as t:
        return ("trap", t.kind), e.trace, e.final()
    except ev.UndefinedControl:
        return ("undefined",), e.trace, e.final()
    if x is None:
        return OUT, e.trace, e.final()
    if x.kind == "unreachable":
        return ("unreachable",), e.trace, e.final()
    vs = dict(x.values)
    kept = tuple(vs[n] for n in sorted(CALLING.preserved))
    if x.kind == "return":
        return ("return", tuple(vs[n] for n in sorted(CALLING.results)), kept), e.trace, e.final()
    return ("tail", x.target, tuple(vs[n] for n in sorted(CALLING.arguments)), kept), e.trace, e.final()


def refines(got, want) -> bool:
    """`got` is `want`, except that where `want` is undefined anything may be."""
    if want is ev.UNDEF:
        return True
    if isinstance(want, (tuple, list)):
        return isinstance(got, (tuple, list)) and len(got) == len(want) and all(map(refines, got, want))
    if isinstance(want, dict):
        return all(refines(got.get(k, ev.UNDEF), v) for k, v in want.items())
    return got == want


def agree(got, want) -> bool:
    if want[0] == OUT or got[0] == OUT:  # compare what both did before one ran out
        n = min(len(got[1]), len(want[1]))
        return refines(got[1][:n], want[1][:n])
    if want[0] == ("undefined",):
        return refines(got[1][:len(want[1])], want[1])
    return refines(got[0], want[0]) and refines(got[1], want[1]) and refines(got[2], want[2])


# ---------------------------------------------------------------------------------------- generated functions

GP = [R.RAX, R.RCX, R.RDX, R.R8, R.R9, R.R10, R.R11]
X = [R.XMM0, R.XMM1, R.XMM2, R.XMM3, R.XMM4]


def low(r: int, w: int) -> int:
    """The register of width `w` inside a 64-bit one."""
    full = ix.RegisterExt.number(r)
    return {32: R.EAX, 16: R.AX}[w] + full


def program(seed: int, *, escapes: bool = True, vectors: bool = True, calls: bool = True) -> Asm:
    """A balanced function: saves, locals of several sizes, arguments used as pointers, loops, calls, and now and then a frame address that leaves."""
    r = random.Random(seed)
    a = Asm()
    saves = r.sample([R.RBX, R.RDI, R.RSI, R.R14], r.randrange(0, 4))
    frame = 8 * r.randrange(6, 14)
    if r.random() < 0.3 and saves:
        a(A.store(mem(R.RSP, 8), R.R12))
    xsave = vectors and r.random() < 0.3
    for s in saves:
        a(A.push(s))
    room = frame + 32 + 16 * xsave
    room += (8 - (8 * len(saves) + room)) % 16  # aligned for the saves of vector registers
    a(A.sub_rsp(room))
    if xsave:
        a(I.create_mem_reg(C.MOVAPS_XMMM128_XMM, mem(R.RSP, room - 16), R.XMM7))
        a(I.create_reg_reg(C.MOVAPS_XMM_XMMM128, R.XMM7, R.XMM1))
    regs = GP + saves
    leak = escapes and r.random() < 0.25
    n = r.randrange(2, 7)

    def slot(size=8):
        return mem(R.RSP, 32 + size * r.randrange(frame // size))

    def heap():
        return mem(r.choice((R.RCX, R.RDX, R.R8)), r.choice((0, 0, 8, 16, 4, 20, -8)))

    def one():
        x, y = r.choice(regs), r.choice(regs)
        k = r.randrange(26 if vectors else 18)
        if k == 0:
            return A.mov_rr(x, y)
        if k == 1:
            return A.add_rr(x, y)
        if k == 2:
            return A.mov_ri(x, r.choice((0, 1, 3, -1, 0x7FFFFFFF)))
        if k == 3:
            return A.store(slot(), x)
        if k == 4:
            return A.load(x, slot())
        if k == 5:
            return I.create_mem_reg(C.MOV_RM32_R32, slot(4), low(x, 32))
        if k == 6:
            return I.create_reg_mem(C.MOVZX_R32_RM8, low(x, 32), slot(1))
        if k == 7:
            return A.store(heap(), x)
        if k in (8, 9):
            return A.load(x, heap())
        if k == 10:
            return I.create_mem_reg(C.MOV_RM32_R32, heap(), low(x, 32))
        if k == 11:
            return I.create_reg_reg(C.IMUL_R32_RM32, low(x, 32), low(y, 32))
        if k == 12:
            return I.create_reg_i32(C.SAR_RM64_IMM8, x, r.randrange(1, 60))
        if k == 13:
            return I.create_reg_reg(C.MOV_R16_RM16, low(x, 16), low(y, 16))
        if k == 14:
            return A.lea(x, mem(y, 5, r.choice(regs), 4))
        if k == 15:
            return I.create_reg(C.SETE_RM8, r.choice((R.AL, R.CL, R.DL)))
        if k == 16:
            return I.create_reg_reg(C.CMOVL_R64_RM64, x, y)
        if k == 17:
            return A.lea(x, slot()) if leak else I.create_reg_reg(C.XOR_R32_RM32, low(x, 32), low(x, 32))
        u, v = r.choice(X), r.choice(X)
        if k == 18:
            return I.create_reg_mem(C.MOVSS_XMM_XMMM32, u, heap())
        if k == 19:
            return I.create_reg_reg(r.choice((C.ADDSS_XMM_XMMM32, C.MULSS_XMM_XMMM32, C.SUBSD_XMM_XMMM64, C.ADDPS_XMM_XMMM128, C.SQRTSS_XMM_XMMM32)), u, v)
        if k == 20:
            return I.create_mem_reg(C.MOVSS_XMMM32_XMM, r.choice((slot(4), heap())), u)
        if k == 21:
            return I.create_reg_reg(C.CVTSI2SS_XMM_RM32, u, low(x, 32))
        if k == 22:
            return I.create_reg_reg(C.COMISS_XMM_XMMM32, u, v)
        if k == 23:
            return I.create_reg_reg(C.CVTTSS2SI_R32_XMMM32, low(x, 32), u)
        if k == 24:
            return I.create_mem_reg(C.MOVUPS_XMMM128_XMM, r.choice((mem(R.RSP, 32 + 8 * r.randrange(frame // 8 - 1)), heap())), u)
        return I.create_reg_reg(r.choice((C.XORPS_XMM_XMMM128, C.UNPCKLPS_XMM_XMMM128, C.RSQRTSS_XMM_XMMM32)), u, v)

    for k in range(n):
        a.label(f"L{k}")
        for _ in range(r.randrange(1, 7)):
            a(one())
        if calls and r.random() < 0.3:
            a.branch(C.CALL_REL32_64, 0x9000)
        kind = r.random()
        a(I.create_reg_reg(C.CMP_R64_RM64, r.choice(regs), r.choice(regs)))
        if r.random() < 0.3:
            a(I.create_reg_i32(C.TEST_RM32_IMM32, low(r.choice(regs), 32), r.choice((1, 3, 0x80))))
        if kind < 0.5:
            jcc = r.choice((C.JE_REL32_64, C.JB_REL32_64, C.JG_REL32_64, C.JLE_REL32_64, C.JS_REL32_64, C.JA_REL32_64))
            a.branch(jcc, f"L{r.randrange(0, n)}" if r.random() < 0.3 else f"L{r.randrange(k + 1, n + 1)}")
        elif kind < 0.65:
            a.branch(C.JMP_REL32_64, f"L{r.randrange(k + 1, n + 1)}")
    a.label(f"L{n}")
    if xsave:
        a(I.create_reg_mem(C.MOVAPS_XMM_XMMM128, R.XMM7, mem(R.RSP, room - 16)))
    a(A.add_rsp(room))
    for s in reversed(saves):
        a(A.pop(s))
    a(A.ret())
    return a
