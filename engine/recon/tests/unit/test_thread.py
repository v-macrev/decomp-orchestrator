# SPDX-License-Identifier: AGPL-3.0-or-later
"""Thread-local variables (D-074): the reach through the thread block read as the variable, and the source that names it."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ix = pytest.importorskip("iced_x86")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import asm as T  # noqa: E402
from asm import BASE, Asm, C, I, R, mem  # noqa: E402
from test_knowledge import program  # noqa: E402

from recon.core.ir.model import Const  # noqa: E402
from recon.core.synthesis import candidates as cd  # noqa: E402
from recon.core.synthesis.thread import ThreadLocals, thread_locals  # noqa: E402

INDEX, START = BASE + 0x9000, BASE + 0xA000
TLS = ThreadLocals("gs_base", 0x58, INDEX, START, START + 0x100)


def gs(disp: int):
    return ix.MemoryOperand(R.NONE, R.NONE, 1, disp, 4, False, R.GS)


def reach(a: Asm, offset: int) -> Asm:
    """rax = the address of the thread-local variable at `offset`, as a compiler reaches it (the offset in a register)."""
    a(I.create_reg_mem(C.MOV_R32_RM32, R.ECX, mem(R.RIP, INDEX)))(I.create_reg_mem(C.MOV_R64_RM64, R.RAX, gs(0x58)))
    a(I.create_reg_i32(C.MOV_R32_IMM32, R.EDX, offset))(I.create_reg_mem(C.MOV_R64_RM64, R.RAX, mem(R.RAX, index=R.RCX, scale=8)))
    return a


def reader() -> Asm:
    """f(): return tls + 1, tls a thread-local int at offset 0x10."""
    a = reach(Asm(0x3000), 0x10)
    return a(I.create_reg_mem(C.MOV_R32_RM32, R.EAX, mem(R.RDX, index=R.RAX)))(I.create_reg_i32(C.ADD_RM32_IMM8, R.EAX, 1))(T.ret())


def test_a_reach_through_the_thread_block_is_the_variable_s_place_in_the_template():
    p = program(reader())
    fn = thread_locals(p.normal(BASE + 0x3000), TLS)
    gs_base = dict(fn.params)["gs_base"]
    assert all(gs_base not in o.args for _b, o in fn.ops())
    assert [o.args[0] for _b, o in fn.ops() if o.kind == "load"] == [Const(START + 0x10, 64)]
    assert fn.history[-1] == "thread-locals"


def test_without_the_image_s_facts_nothing_is_read_as_thread_local():
    fn = program(reader()).normal(BASE + 0x3000)
    assert thread_locals(fn, None) is fn
    other = ThreadLocals("gs_base", 0x58, INDEX + 8, START, START + 0x100)   # another index: not this module's reach
    assert thread_locals(fn, other) is fn


def test_a_module_block_handed_on_is_the_template_s_start():
    """f(): g(block): the block itself leaves; place for place it is the template, so what leaves is its start."""
    a = reach(Asm(0x3000), 0x10)
    a(T.sub_rsp(40))(T.mov_rr(R.RCX, R.RAX))
    a.branch(C.CALL_REL32_64, 0x6000)
    a(T.add_rsp(40))(T.ret())
    g = Asm(0x6000)(T.ret())
    fn = thread_locals(program(a, g).normal(BASE + 0x3000), TLS)
    (call,) = [o for _b, o in fn.ops() if o.kind == "call"]
    assert Const(START, 64) in call.args and all(dict(fn.params)["gs_base"] not in o.args for _b, o in fn.ops())


def test_the_source_names_the_variable_thread_local_and_does_what_the_function_does():
    p = program(reader())
    p.thread = TLS
    g = cd.Generator(p, BASE + 0x3000)
    c = g.make(cd.Choice(), set())
    assert c is not None and c.verdict.agree, c and c.verdict
    assert "extern thread_local unsigned int" in c.unit.text and c.signature.params == ()


def test_a_member_function_reads_and_writes_the_variable_through_a_thread_local_placeholder():
    from recon.core.emitter.member import Declared, member_form, thread_placeholder
    p = program(reader())
    p.thread = TLS
    c = cd.Generator(p, BASE + 0x3000).make(cd.Choice(), set())
    u = member_form(c.body, c.types, BASE, 0x3000, Declared("Box", "Get", ()), thread_local=TLS.holds)
    name = thread_placeholder(0xA010)
    assert f"extern thread_local unsigned int {name};" in u.prototypes and f"return {name} + 1;" in u.definition
    assert (name, 0xA010) in u.data


def test_the_verifier_places_a_thread_local_variable_by_its_offset_in_the_template(monkeypatch, tmp_path):
    import json

    from recon.adapters.skyrim import verify as V
    seen = {}

    class Engine:
        @staticmethod
        def compare(task, manifest, recipe, record, obj, image, smap, diagnostics=None):
            seen.update(json.loads(smap))
            return {"result": "pass", "reason": V.PASS}

    monkeypatch.setattr(V.Verifier, "_engine", lambda self: Engine)
    monkeypatch.setattr(V, "reason_codes", lambda worktree: frozenset({V.PASS}))
    v = V.Verifier(tmp_path, "build", b"image", b"recipe")
    v.verify(0x3000, 16, "f", b"src", b"obj", {"g": (0x5000, 4)}, thread={"t": 0x10})
    assert seen["symbols"] == {"g": {"rva": 0x5000, "size": 4}, "t": {"kind": "thread-local", "tls_offset": 0x10, "size": None}}


def test_the_ranking_counts_a_section_relative_field_right_when_it_holds_the_variable_s_offset():
    from recon.adapters.x64_msvc import batch, coff
    code = bytes((0xBA, 0, 0, 0, 0, 0xC3))                    # mov edx, offset@SECREL; ret
    f = coff.Function("f", code, (coff.Reloc(1, coff.SECREL, "t", None),), ())
    target = bytes((0xBA, 0x10, 0, 0, 0, 0xC3))
    assert batch.distance(f, target, 0x3000, lambda r: 0x10).total == 0
    assert batch.distance(f, target, 0x3000, lambda r: 0x18).references == 1


def test_a_storage_array_kept_across_a_branch_is_reached_through_the_same_way():
    """f(x): the array read on either way of a branch, the variable reached after they meet."""
    a = Asm(0x3000)(I.create_reg_reg(C.TEST_RM32_R32, R.ECX, R.ECX))
    a.branch(C.JE_REL32_64, "other")
    a(I.create_reg_mem(C.MOV_R64_RM64, R.RAX, gs(0x58)))(I.create_reg_i32(C.MOV_R32_IMM32, R.R9D, 1))
    a.branch(C.JMP_REL32_64, "meet")
    a.label("other")(I.create_reg_mem(C.MOV_R64_RM64, R.RAX, gs(0x58)))(I.create_reg_i32(C.MOV_R32_IMM32, R.R9D, 2))
    a.label("meet")(I.create_reg_mem(C.MOV_R32_RM32, R.ECX, mem(R.RIP, INDEX)))(I.create_reg_i32(C.MOV_R32_IMM32, R.EDX, 0x20))
    a(I.create_reg_mem(C.MOV_R64_RM64, R.RAX, mem(R.RAX, index=R.RCX, scale=8)))(I.create_mem_reg(C.MOV_RM32_R32, mem(R.RDX, index=R.RAX), R.R9D))
    a(T.ret())
    fn = thread_locals(program(a).normal(BASE + 0x3000), TLS)
    gs_base = dict(fn.params)["gs_base"]
    assert all(gs_base not in o.args for _b, o in fn.ops()) and all(gs_base not in [v for _k, v in p.args] for b in fn.blocks for p in b.phis)
    assert [o.args[0] for _b, o in fn.ops() if o.kind == "store"] == [Const(START + 0x20, 64)]
