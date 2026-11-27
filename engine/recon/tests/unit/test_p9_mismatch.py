# SPDX-License-Identifier: AGPL-3.0-or-later
"""The mismatch classifier: one hand-assembled pair per kind, and what it must not confuse.

Every stream here is original, written for the test; none is read from an image."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

ix = pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from asm import C, I, R, Asm, add_rsp, mem, mov_rr, pop, push, ret, sub_rsp  # noqa: E402

from recon.adapters.x64_msvc.mismatch import compare, decode  # noqa: E402
from recon.core.synthesis import kinds as K  # noqa: E402

RVA = 0x1000
CALLEE = 0x5000


def code(*build) -> bytes:
    a = Asm(RVA)
    for b in build:
        if isinstance(b, tuple) and b[0] == "label":
            a.label(b[1])
        elif isinstance(b, tuple) and b[0] == "branch":
            a.branch(b[1], b[2])
        else:
            a(b)
    return a.assemble()[0]


def lab(n):
    return ("label", n)


def br(c, n):
    return ("branch", c, n)


def kind(cand: bytes, target: bytes, refs=None):
    return compare(decode(cand, refs or {}, None), decode(target, {}, RVA))


def as_object(target_like: bytes, meanings: list) -> tuple[bytes, dict]:
    """A candidate as an object holds it: the fields of its calls and jumps out of the code zero, what each means (in
    order) in `refs`."""
    fields = {}
    for i in ix.Decoder(64, target_like, ip=RVA):
        if (i.is_call_near or i.is_jmp_near) and not RVA <= i.near_branch_target < RVA + len(target_like):
            fields[i.ip - RVA + i.len - 4] = meanings[len(fields)]
    b = bytearray(target_like)
    for o in fields:
        b[o:o + 4] = b"\0\0\0\0"
    return bytes(b), dict(fields)


def test_size_only_padding_and_encoding():
    body = [mov_rr(R.RAX, R.RCX), ret()]
    assert kind(code(*body), code(*body, I.create(C.INT3), I.create(C.INT3))).kind == K.SIZE_ONLY
    short = code(I.create_reg_i32(C.ADD_RM64_IMM8, R.RSP, 0x28), ret())
    long_ = code(I.create_reg_i32(C.ADD_RM64_IMM32, R.RSP, 0x28), ret())
    m = kind(short, long_)
    assert m.kind == K.SIZE_ONLY and m.whole


def test_register_assignment_is_a_consistent_renaming():
    def f(r):
        return code(push(r), sub_rsp(0x20), mov_rr(r, R.RCX), br(C.CALL_REL32_64, CALLEE), mov_rr(R.RAX, r), add_rsp(0x20), pop(r), ret())
    cand, refs = as_object(f(R.RBX), [CALLEE])
    m = kind(cand, f(R.RDI), refs)
    assert m.kind == K.REGISTERS and m.whole


def test_branch_polarity_arms_exchanged():
    one = I.create_reg_i32(C.MOV_R32_IMM32, R.EAX, 1)
    zero = I.create_reg_reg(C.XOR_R32_RM32, R.EAX, R.EAX)
    test = I.create_reg_reg(C.TEST_RM32_R32, R.ECX, R.ECX)
    cand = code(test, br(C.JE_REL32_64, "z"), one, ret(), lab("z"), zero, ret())
    target = code(test, br(C.JNE_REL32_64, "nz"), zero, ret(), lab("nz"), one, ret())
    m = kind(cand, target)
    assert m.kind == K.POLARITY and m.whole


def test_block_order_same_blocks_same_conditions():
    a = I.create_reg_i32(C.ADD_RM32_IMM8, R.ECX, 1)
    b = I.create_reg_i32(C.SUB_RM32_IMM8, R.ECX, 1)
    test = I.create_reg_reg(C.TEST_RM32_R32, R.EDX, R.EDX)
    fin = I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX)
    cand = code(test, br(C.JE_REL32_64, "b"), a, br(C.JMP_REL32_64, "end"), lab("b"), b, lab("end"), fin, ret())
    target = code(test, br(C.JE_REL32_64, "b"), a, lab("end"), fin, ret(), lab("b"), b, br(C.JMP_REL32_64, "end"))
    m = kind(cand, target)
    assert m.kind == K.BLOCKS and m.whole


def test_stack_layout_offsets_and_frame_size():
    def f(n):
        return code(sub_rsp(n), I.create_mem_reg(C.MOV_RM64_R64, mem(R.RSP, n - 8), R.RCX), I.create_reg_mem(C.MOV_R64_RM64, R.RAX, mem(R.RSP, n - 8)),
                    add_rsp(n), ret())
    m = kind(f(0x28), f(0x38))
    assert m.kind == K.STACK and m.whole


def test_unwind_saved_register_set():
    body = [mov_rr(R.RBX, R.RCX), br(C.CALL_REL32_64, CALLEE), mov_rr(R.RAX, R.RBX)]
    cand_full = code(push(R.RBX), sub_rsp(0x20), *body, add_rsp(0x20), pop(R.RBX), ret())
    target = code(push(R.RBX), push(R.RSI), sub_rsp(0x28), *body, add_rsp(0x28), pop(R.RSI), pop(R.RBX), ret())
    cand, refs = as_object(cand_full, [CALLEE])
    assert kind(cand, target, refs).kind == K.UNWIND


def test_extension_signedness():
    load_z = I.create_reg_mem(C.MOVZX_R32_RM8, R.EAX, mem(R.RCX, 8))
    load_s = I.create_reg_mem(C.MOVSX_R32_RM8, R.EAX, mem(R.RCX, 8))
    assert kind(code(load_z, ret()), code(load_s, ret())).kind == K.EXTENSION
    shr = I.create_reg_i32(C.SHR_RM32_IMM8, R.EAX, 3)
    sar = I.create_reg_i32(C.SAR_RM32_IMM8, R.EAX, 3)
    assert kind(code(mov_rr(R.RAX, R.RCX), shr, ret()), code(mov_rr(R.RAX, R.RCX), sar, ret())).kind == K.EXTENSION
    cmp = I.create_reg_reg(C.CMP_RM32_R32, R.ECX, R.EDX)
    one = I.create_reg_i32(C.MOV_R32_IMM32, R.EAX, 1)
    zero = I.create_reg_reg(C.XOR_R32_RM32, R.EAX, R.EAX)
    signed = code(cmp, br(C.JL_REL32_64, "x"), zero, ret(), lab("x"), one, ret())
    unsigned = code(cmp, br(C.JB_REL32_64, "x"), zero, ret(), lab("x"), one, ret())
    assert kind(signed, unsigned).kind == K.EXTENSION


def test_constant_materialisation():
    zero = I.create_reg_reg(C.XOR_R32_RM32, R.EAX, R.EAX)
    imm = I.create_reg_i32(C.MOV_R32_IMM32, R.EAX, 0)
    store = I.create_mem_reg(C.MOV_RM32_R32, mem(R.RCX, 0x10), R.EAX)
    assert kind(code(zero, store, ret()), code(imm, store, ret())).kind == K.CONSTANT
    assert kind(code(I.create_mem_i32(C.MOV_RM32_IMM32, mem(R.RCX, 0x10), 0), ret()), code(zero, store, ret())).kind == K.CONSTANT


def test_call_or_relocation():
    f = code(sub_rsp(0x28), br(C.CALL_REL32_64, CALLEE), add_rsp(0x28), ret())
    cand, refs = as_object(f, [CALLEE + 0x40])
    m = kind(cand, f, refs)
    assert m.kind == K.CALL and m.whole
    # an unnamed reference is the comparator's question, never counted as wrong
    cand, refs = as_object(f, [None])
    assert kind(cand, f, refs).kind == K.SIZE_ONLY
    # a call and a return where the target jumps
    tail = code(br(C.JMP_REL32_64, CALLEE))
    cand, refs = as_object(f, [CALLEE])
    assert kind(cand, tail, refs).kind in (K.CALL, K.UNWIND)


def test_instruction_selection():
    lea = I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RCX, 0, R.RCX, 1))
    imul = I.create_reg_reg_i32(C.IMUL_R32_RM32_IMM8, R.EAX, R.ECX, 2)
    assert kind(code(lea, ret()), code(imul, ret())).kind == K.SELECTION


def test_every_kind_has_a_case_here():
    names = {n for n in globals() if n.startswith("test_")}
    for k in K.KINDS:
        assert any(k.split("-")[0].replace("-", "_") in n for n in names), k


def test_codes_and_names():
    assert K.code(K.BLOCKS) == "MISMATCH_BLOCK_ORDER" and K.name(K.BLOCKS) == "MISMATCH(block-order)"
    assert K.kind_of("MISMATCH_CONSTANT_MATERIALISATION") == K.CONSTANT and K.kind_of("NO_MATCH") is None
    assert len(set(K.CODES)) == len(K.KINDS)


def test_same_kind_under_any_hash_seed():
    """The kind and its counts do not depend on PYTHONHASHSEED."""
    prog = ("import sys; sys.path[:0]=[%r, %r]; import test_p9_mismatch as t; import json;"
            "ms=[t.kind(t.code(t.I.create_reg_mem(t.C.MOVZX_R32_RM8, t.R.EAX, t.mem(t.R.RCX, 8)), t.ret()),"
            "t.code(t.I.create_reg_reg(t.C.XOR_R32_RM32, t.R.EAX, t.R.EAX), t.ret()))];"
            "print(json.dumps([[m.kind, m.counts] for m in ms]))") % (str(Path(__file__).parent), str(Path(__file__).resolve().parents[2]))
    outs = {subprocess.run([sys.executable, "-c", prog], env={**os.environ, "PYTHONHASHSEED": s}, capture_output=True, text=True,
                           check=True).stdout for s in ("0", "1", "4242")}
    assert len(outs) == 1
