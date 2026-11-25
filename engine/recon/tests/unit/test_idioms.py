# SPDX-License-Identifier: AGPL-3.0-or-later
"""Compiler-undo hypotheses: the theorems exhaustively at small widths, the recognisers on the sequences compilers emit, the proofs on
deliberately wrong hypotheses."""
import dataclasses
import random

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
pytest.importorskip("z3", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

import asm as A  # noqa: E402
import irlab as L  # noqa: E402
from asm import Asm, C, I, R, mem  # noqa: E402

from recon.adapters.x64_msvc.abi import CALLING  # noqa: E402
from recon.core.ir import idioms as id_  # noqa: E402
from recon.core.ir import passes as ps  # noqa: E402
from recon.core.ir import smt  # noqa: E402
from recon.core.ir import validate as va  # noqa: E402
from recon.core.ir.model import Const  # noqa: E402


def normal(a: Asm):
    return ps.normalise(L.to_ir(a), CALLING)


def found(fn, kind):
    return [h for h in id_.hypotheses(fn) if h.kind == kind]


# ---------------------------------------------------------------- theorems

@pytest.mark.parametrize("w", [4, 6])
def test_the_division_theorems_hold_for_every_input_at_small_widths(w):
    shown = 0
    for k in range(w - 1, 2 * w + 2):
        for m in range(-(1 << (w + 1)), (1 << (w + 1)) + 1):
            d = id_.unsigned_magic(m, k, w)
            if d is not None:
                shown += 1
                assert all(m * x >> k == x // d for x in range(1 << w)), (m, k)
            d = id_.signed_magic(m, k, w)
            if d is not None:
                shown += 1
                for x in range(-(1 << (w - 1)), 1 << (w - 1)):
                    q = m * x >> k
                    assert q + (q < 0) == (abs(x) // abs(d)) * (1 if (x < 0) == (d < 0) else -1), (m, k, x)
    assert shown > {4: 60, 6: 250}[w]


def test_the_theorems_find_no_divisor_for_a_wrong_multiplier():
    good = 0xAAAAAAAB
    assert id_.unsigned_magic(good, 33, 32) == 3
    assert id_.unsigned_magic(good + 1, 33, 32) is None and id_.unsigned_magic(good - 1, 33, 32) is None and id_.unsigned_magic(good, 32, 32) is None
    assert id_.signed_magic(0x55555556, 32, 32) == 3 and id_.signed_magic(0x55555555, 32, 32) is None
    assert id_.signed_magic(0x55555556 - (1 << 32), 32, 32) is None


# ---------------------------------------------------------------- division by a constant, as compilers spell it

def unsigned_code(d: int) -> Asm:
    """x / d for a 32-bit unsigned x in ecx."""
    w = 32
    a = Asm()
    for s in range(0, w):
        m = -(-(1 << (w + s)) // d)
        if m < 1 << w and id_.unsigned_magic(m, w + s, w) == d:
            a(I.create_reg_u32(C.MOV_R32_IMM32, R.EAX, m))(I.create_reg(C.MUL_RM32, R.ECX))
            if s:
                a(I.create_reg_i32(C.SHR_RM32_IMM8, R.EDX, s))
            return a(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.EDX))(A.ret())
    s = d.bit_length() - 1
    m = -(-(1 << (w + s + 1)) // d) - (1 << w)
    a(I.create_reg_u32(C.MOV_R32_IMM32, R.EAX, m))(I.create_reg(C.MUL_RM32, R.ECX))(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX))(I.create_reg_reg(C.SUB_R32_RM32, R.EAX, R.EDX))
    a(I.create_reg_i32(C.SHR_RM32_IMM8, R.EAX, 1))(I.create_reg_reg(C.ADD_R32_RM32, R.EAX, R.EDX))
    if s:
        a(I.create_reg_i32(C.SHR_RM32_IMM8, R.EAX, s))
    return a(A.ret())


def signed_code(d: int) -> Asm:
    """x / d for a 32-bit signed x in ecx."""
    w = 32
    for k in range(w, 2 * w):
        m = -(-((1 << k) + 1) // abs(d))
        if id_.signed_magic(m if d > 0 else -m, k, w) == d:
            break
    m = m if d > 0 else -m
    a = Asm()
    low = m & 0xFFFFFFFF
    a(I.create_reg_u32(C.MOV_R32_IMM32, R.EAX, low))(I.create_reg(C.IMUL_RM32, R.ECX))
    wrapped = low - (1 << 32) if low >> 31 else low
    if wrapped != m:
        a(I.create_reg_reg(C.ADD_R32_RM32 if m > 0 else C.SUB_R32_RM32, R.EDX, R.ECX))
    if k > w:
        a(I.create_reg_i32(C.SAR_RM32_IMM8, R.EDX, k - w))
    a(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.EDX))(I.create_reg_i32(C.SHR_RM32_IMM8, R.EAX, 31))(I.create_reg_reg(C.ADD_R32_RM32, R.EAX, R.EDX))
    return a(A.ret())


def run_eax(a: Asm, x: int) -> int:
    """The instructions' own result for ecx = x."""
    an = L.analysed(a)
    from recon.core import evaluate as ev

    e = L.Env(1)
    m = ev.Machine(e.read, e.write, {**e.entry, "rcx": x})
    for i in an.insns[:-1]:
        ev.run(i, m)
    return m.locs["rax"] & 0xFFFFFFFF


@pytest.mark.parametrize("d", [3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 25, 28, 60, 100, 125, 255, 641, 1000, 3600, 10007, 65537, 1000000007])
def test_unsigned_division_is_read_off_the_multiplication(d):
    a = unsigned_code(d)
    r = random.Random(d)
    for x in [0, 1, d - 1, d, d + 1, 2 * d - 1, 0xFFFFFFFF, 0x80000000, *(r.getrandbits(32) for _ in range(20))]:
        assert run_eax(a, x) == x // d
    fn = normal(a)
    hs = found(fn, "unsigned-division")
    assert len(hs) == 1 and dict(hs[0].detail)["divisor"] == d and "udiv" in str(hs[0].expr)
    out = id_.accept(fn, hs[0])
    assert va.problems(out, CALLING) == [] and any(o.kind == "udiv" for _b, o in out.ops()) and not any(o.kind == "mul" for _b, o in out.ops())
    for s in range(6):
        assert L.agree(L.run_ir(out, s), L.run_ir(fn, s))


@pytest.mark.parametrize("d", [3, 5, 6, 7, 9, 10, 11, 12, 13, 25, 60, 100, 125, 641, 1000, 3600, 10007, -3, -5, -7, -10, -125])
def test_signed_division_is_read_off_the_multiplication(d):
    a = signed_code(d)
    r = random.Random(d)
    for x in [0, 1, abs(d) - 1, abs(d), 0xFFFFFFFF, 0x80000000, 0x7FFFFFFF, *(r.getrandbits(32) for _ in range(20))]:
        sx = x - (1 << 32) if x >> 31 else x
        assert run_eax(a, x) == (abs(sx) // abs(d)) * (1 if (sx < 0) == (d < 0) else -1) & 0xFFFFFFFF
    fn = normal(a)
    hs = found(fn, "signed-division")
    assert len(hs) == 1 and dict(hs[0].detail)["divisor"] == d
    out = id_.accept(fn, hs[0])
    for s in range(6):
        assert L.agree(L.run_ir(out, s), L.run_ir(fn, s))


def test_a_near_miss_is_not_called_a_division():
    for m in (0x55555555, 0x55555557):
        a = Asm()
        a(I.create_reg_u32(C.MOV_R32_IMM32, R.EAX, m))(I.create_reg(C.IMUL_RM32, R.ECX))(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.EDX))
        a(I.create_reg_i32(C.SHR_RM32_IMM8, R.EAX, 31))(I.create_reg_reg(C.ADD_R32_RM32, R.EAX, R.EDX))(A.ret())
        assert not found(normal(a), "signed-division")
    b = Asm()  # the sign that is added is another value's
    b(I.create_reg_u32(C.MOV_R32_IMM32, R.EAX, 0x55555556))(I.create_reg(C.IMUL_RM32, R.ECX))(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.R8D))
    b(I.create_reg_i32(C.SHR_RM32_IMM8, R.EAX, 31))(I.create_reg_reg(C.ADD_R32_RM32, R.EAX, R.EDX))(A.ret())
    assert not found(normal(b), "signed-division")


def test_a_remainder_is_read_off_a_division():
    a = unsigned_code(10)
    a.items.pop()  # the return
    a(I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RAX, 0, R.RAX, 4)))(I.create_reg_reg(C.ADD_R32_RM32, R.EAX, R.EAX))(I.create_reg_reg(C.SUB_R32_RM32, R.ECX, R.EAX))
    a(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX))(A.ret())
    (h,) = found(normal(a), "unsigned-remainder")
    assert dict(h.detail)["divisor"] == 10 and h.expr[0] == "urem"


# ---------------------------------------------------------------- the others

def one(*ins) -> Asm:
    a = Asm()
    for i in ins:
        a(i)
    return a(A.ret())


SAR31 = I.create_reg_i32(C.SAR_RM32_IMM8, R.EDX, 31)
CASES = [
    ("signed-division", one(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX), I.create(C.CDQ), I.create_reg_i32(C.AND_RM32_IMM8, R.EDX, 7), I.create_reg_reg(C.ADD_R32_RM32, R.EAX, R.EDX),
                            I.create_reg_i32(C.SAR_RM32_IMM8, R.EAX, 3)), ("division",)),
    ("signed-division", one(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX), I.create(C.CDQ), I.create_reg_reg(C.SUB_R32_RM32, R.EAX, R.EDX), I.create_reg_i32(C.SAR_RM32_IMM8, R.EAX, 1)), ("division",)),
    ("signed-remainder", one(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX), I.create(C.CDQ), I.create_reg_i32(C.AND_RM32_IMM8, R.EDX, 7), I.create_reg_reg(C.ADD_R32_RM32, R.EAX, R.EDX),
                             I.create_reg_i32(C.AND_RM32_IMM8, R.EAX, 7), I.create_reg_reg(C.SUB_R32_RM32, R.EAX, R.EDX)), ("remainder",)),
    ("shift-or-division", one(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX), I.create_reg_i32(C.SHR_RM32_IMM8, R.EAX, 5)), ("shift", "division")),
    ("mask-or-remainder", one(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX), I.create_reg_i32(C.AND_RM32_IMM8, R.EAX, 15)), ("mask", "remainder")),
    ("shift-or-multiplication", one(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX), I.create_reg_i32(C.SHL_RM32_IMM8, R.EAX, 5)), ("shift", "multiplication")),
    ("multiplication", one(A.lea(R.RAX, mem(R.RCX, 0, R.RCX, 4))), ("multiplication", "sum-of-shifts")),
    ("absolute-value", one(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX), I.create(C.CDQ), I.create_reg_reg(C.XOR_R32_RM32, R.EAX, R.EDX), I.create_reg_reg(C.SUB_R32_RM32, R.EAX, R.EDX)), ("abs", "conditional")),
    ("range-test", one(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX), I.create_reg_i32(C.SUB_RM32_IMM8, R.EAX, 48), I.create_reg_i32(C.CMP_RM32_IMM8, R.EAX, 9), I.create_reg(C.SETBE_RM8, R.AL),
                       I.create_reg_reg(C.MOVZX_R32_RM8, R.EAX, R.AL)), ("two-unsigned-comparisons", "one-comparison")),
    ("minimum", one(A.mov_rr(R.RAX, R.RDX), I.create_reg_reg(C.CMP_R64_RM64, R.RCX, R.RDX), I.create_reg_reg(C.CMOVL_R64_RM64, R.RAX, R.RCX)), ("minimum", "conditional", "branch")),
    ("minimum", one(I.create_reg_reg(C.MINSS_XMM_XMMM32, R.XMM0, R.XMM1)), ("minimum", "conditional", "branch")),
    # neg/sbb: -1 when ecx is not zero, then a constant chosen by it
    ("chosen-constant", one(I.create_reg(C.NEG_RM32, R.ECX), I.create_reg_reg(C.SBB_R32_RM32, R.EAX, R.EAX), I.create_reg_i32(C.AND_RM32_IMM8, R.EAX, 6), I.create_reg_i32(C.ADD_RM32_IMM8, R.EAX, 3)), ("conditional",)),
    ("masked-value", one(I.create_reg(C.NEG_RM32, R.ECX), I.create_reg_reg(C.SBB_R32_RM32, R.EAX, R.EAX), I.create_reg_reg(C.AND_R32_RM32, R.EAX, R.EDX)), ("conditional", "mask")),
]


@pytest.mark.parametrize("kind,code,readings", CASES)
def test_recognised_with_every_reading_and_proved(kind, code, readings):
    fn = normal(code)
    hs = found(fn, kind)
    assert hs and hs[0].readings == readings
    for h in hs:
        if h.expr is not None and h.proof != "structure":
            out = id_.accept(fn, h)
            assert va.problems(out, CALLING) == []
            assert smt.equivalent(fn, out) in ("proved", "unknown")
            for s in range(8):
                assert L.agree(L.run_ir(out, s), L.run_ir(fn, s))


def test_a_wrong_hypothesis_is_not_proved():
    fn = normal(CASES[0][1])
    (h,) = found(fn, "signed-division")
    wrong = dataclasses.replace(h, expr=("sdiv", (h.expr[1][0], Const(4, 32)), 32))
    assert not id_.verify(fn, wrong)
    with pytest.raises(ValueError):
        id_.accept(fn, wrong)
    u = normal(unsigned_code(7))
    (g,) = found(u, "unsigned-division")
    lie = dataclasses.replace(g, detail=tuple((k, 8 if k == "divisor" else v) for k, v in g.detail))
    assert not id_.verify(u, lie)
    # consistent in itself, but not what the operations are
    for d in (5, 8):
        for numbers in ({"divisor": d}, {"divisor": d, "multiplier": -(-(1 << 34) // d), "shift": 34}):
            other = dataclasses.replace(g, expr=("udiv", (g.expr[1][0], Const(d, 32)), 32), detail=tuple((k, numbers.get(k, v)) for k, v in g.detail))
            assert not id_.verify(u, other), (d, numbers)


def test_adjacent_constant_stores_and_block_operations():
    a = Asm()
    for off in (0, 8, 16, 24):
        a(I.create_mem_i32(C.MOV_RM64_IMM32, mem(R.RCX, off), 0))
    a(A.ret())
    (h,) = found(normal(a), "fill")
    assert dict(h.detail) == {"bytes": 32, "byte": 0} and "memset" in h.readings
    b = Asm()
    for off in (0, 8, 24):
        b(I.create_mem_i32(C.MOV_RM64_IMM32, mem(R.RCX, off), 0))
    b(A.ret())
    assert not found(normal(b), "fill")
    c = Asm()
    c(A.push(R.RDI))(A.mov_rr(R.RDI, R.RCX))(I.create_reg_u32(C.MOV_R32_IMM32, R.ECX, 64))(I.create_reg_reg(C.XOR_R32_RM32, R.EAX, R.EAX))(I.create_rep_stosb(64))(A.pop(R.RDI))(A.ret())
    (h,) = found(normal(c), "fill")
    assert h.readings == ("memset", "fill-loop")


def rotated(same_guard: bool) -> Asm:
    a = Asm()
    a(A.mov_ri(R.RAX, 0))(I.create_reg_reg(C.TEST_RM64_R64, R.RCX if same_guard else R.R8, R.RCX if same_guard else R.R8)).branch(C.JE_REL32_64, "end")
    a.label("top")(A.add_rr(R.RAX, R.RCX))(I.create_reg_i32(C.SUB_RM64_IMM8, R.RCX, 1)).branch(C.JNE_REL32_64, "top")
    return a.label("end")(A.ret())


def test_a_rotated_loop_needs_the_same_test_in_its_guard():
    assert found(normal(rotated(True)), "rotated-loop")
    assert not found(normal(rotated(False)), "rotated-loop")


def test_hypotheses_never_change_the_function_and_come_in_a_fixed_order():
    for seed in range(25):
        fn = normal(L.program(seed))
        before = fn.digest()
        a = [h.to_data() for h in id_.hypotheses(fn)]
        assert fn.digest() == before and a == [h.to_data() for h in id_.hypotheses(fn)]


def test_a_quotient_whose_upper_bits_were_cut_off_is_not_a_quotient():
    fn = normal(unsigned_code(3))
    assert found(fn, "unsigned-division")
    moved = {32: 20, 1: 13}  # (the low 32 bits of product >> 20) >> 13: the same shift in all, but the product has bits above

    def shifted(o):
        if o.kind != "lshr":
            return o
        return dataclasses.replace(o, args=(o.args[0], Const(moved.pop(o.args[1].value), o.args[1].width)))
    cut = dataclasses.replace(fn, blocks=tuple(dataclasses.replace(b, ops=tuple(shifted(o) for o in b.ops)) for b in fn.blocks))
    assert not moved and va.problems(cut, CALLING) == []
    assert not found(cut, "unsigned-division")
    assert not all(L.agree(L.run_ir(cut, s), L.run_ir(fn, s)) for s in range(8))


def test_a_signed_quotient_needs_the_sign_shifted_in():
    fn = normal(signed_code(6))
    assert found(fn, "signed-division")

    def changed(o):
        if o.kind == "mul":
            return dataclasses.replace(o, args=(o.args[0], Const(2 * o.args[1].value, o.args[1].width)))
        if o.kind in ("lshr", "ashr") and o.args[1].value == 32:
            return dataclasses.replace(o, kind="lshr", args=(o.args[0], Const(33, o.args[1].width)))
        return o
    cut = dataclasses.replace(fn, blocks=tuple(dataclasses.replace(b, ops=tuple(changed(o) for o in b.ops)) for b in fn.blocks))
    assert va.problems(cut, CALLING) == [] and cut.blocks != fn.blocks
    assert not found(cut, "signed-division")  # a negative quotient would lose its sign


def test_a_product_of_two_registers_is_as_wide_as_what_is_used_of_it():
    a = Asm()  # the form that leaves a 128-bit product, of which only the lower half is ever read
    a(I.create_reg_reg(C.MOV_R32_RM32, R.ECX, R.ECX))(I.create_reg_u32(C.MOV_R32_IMM32, R.EAX, 0xAAAAAAAB))(I.create_reg_reg(C.IMUL_R64_RM64, R.RAX, R.RCX))
    a(I.create_reg_i32(C.SHR_RM64_IMM8, R.RAX, 33))(A.ret())
    fn = normal(a)
    assert {fn.width(o.defs[0]) for _b, o in fn.ops() if o.pure} <= {32, 64}
    (h,) = found(fn, "unsigned-division")
    assert dict(h.detail)["divisor"] == 3
    assert run_eax(a, 0xFFFFFFFF) == 0xFFFFFFFF // 3
