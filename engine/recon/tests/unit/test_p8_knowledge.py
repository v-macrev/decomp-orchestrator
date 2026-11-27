# SPDX-License-Identifier: AGPL-3.0-or-later
"""P8: whole-program knowledge. Why a function has no signature, down to where the chain of callees without one starts
(D8-003); a function's interface read apart from whether its body can be written (D8-004)."""
import hashlib

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

import asm as T  # noqa: E402
from asm import BASE, RVA, Asm, C, I, R, mem  # noqa: E402

from recon.adapters.x64_msvc import program as pg  # noqa: E402
from recon.adapters.x64_msvc.abi import CALLING, SOURCE  # noqa: E402
from recon.core.inference import lower as lw  # noqa: E402
from recon.core.inference import signature as sg  # noqa: E402
from recon.core.inference.explain import explain, through_tail  # noqa: E402
from recon.core.inference.signature import NotReconstructed, Signature, Slot  # noqa: E402
from recon.core.inference.whole import Program  # noqa: E402
from recon.core.ir import passes, validate  # noqa: E402


def program(*fns: Asm, declared=None) -> Program:
    code = {f.rva: f for f in fns}

    def normal(at: int):
        f = code.get(at - BASE)
        if f is None:
            raise NotReconstructed("NO_SUCH_FUNCTION")
        a = pg.analyse(f.assemble()[0], f.rva, BASE, None)
        assert isinstance(a, pg.Analysis), a
        ir = pg.to_ir(a, BASE)
        if not hasattr(ir, "blocks"):          # refused on the way to the IR: its code, as an adapter gives it
            raise NotReconstructed(ir.code)
        return validate.require(validate.admit(passes.normalise(ir, CALLING), CALLING))

    def key(at: int):
        f = code.get(at - BASE)
        return None if f is None else f"{f.rva:x}:" + hashlib.sha256(f.assemble()[0]).hexdigest()[:16]

    return Program(normal, SOURCE, CALLING, BASE, lambda at, n: None, lambda a, w: None, declared or (lambda at: None), key=key)


def calls(rva: int, to: int) -> Asm:
    """f(a): return to(a) + 1"""
    a = Asm(rva)(T.sub_rsp(40))
    a.branch(C.CALL_REL32_64, to)
    return a(I.create_reg_i32(C.ADD_RM32_IMM8, R.EAX, 1))(T.add_rsp(40))(T.ret())


def forwards(rva: int, to: int) -> Asm:
    """f(a, b): return to(a, b), as one tail jump"""
    return Asm(rva).branch(C.JMP_REL32_64, to)


def test_a_chain_of_unknown_callees_is_explained_by_the_function_where_it_starts():
    p = program(calls(RVA, 0x2000), calls(0x2000, 0x3000))      # 0x3000 is no function the program has
    e = explain(p, BASE + RVA)
    assert e.state == "unknown" and e.walked == 3 and e.depth == 2
    assert [(r.at - BASE, r.reason) for r in e.roots] == [(0x3000, "normal:NO_SUCH_FUNCTION")]


def test_two_chains_to_one_root_name_it_once_and_a_declaration_ends_a_chain():
    top = Asm(RVA)(T.sub_rsp(40))                                # top(): to(5); return other(6)
    top(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 5)).branch(C.CALL_REL32_64, 0x2000)
    top(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 6)).branch(C.CALL_REL32_64, 0x2100)
    top(T.add_rsp(40))(T.ret())
    fns = (top, calls(0x2000, 0x3000), calls(0x2100, 0x3000))
    e = explain(program(*fns), BASE + RVA)
    assert [r.at - BASE for r in e.roots] == [0x3000] and e.walked == 4
    declared = Signature((Slot("i", 64),), Slot("i", 32), (("declared", "test"),))
    p = program(*fns, declared=lambda at: ("bottom", declared) if at == BASE + 0x3000 else None)
    assert explain(p, BASE + RVA).state == "known"
    assert explain(p, BASE + 0x3000).state == "declared"


def test_a_function_whose_own_reading_is_refused_is_a_root_with_that_code():
    # writes a preserved register without restoring it: the reading refuses it, whatever its callees
    bad = Asm(0x3000)(I.create_reg_i32(C.MOV_R32_IMM32, R.EBX, 1))(T.ret())
    e = explain(program(calls(RVA, 0x3000), bad), BASE + RVA)
    assert len(e.roots) == 1 and e.roots[0].at == BASE + 0x3000
    assert e.roots[0].reason.split(":")[0] in ("normal", "reading")


def test_a_forwarder_is_told_by_the_one_function_it_jumps_to():
    p = program(forwards(RVA, 0x2000), calls(0x2000, 0x3000))
    assert through_tail(p, BASE + RVA) == BASE + 0x2000
    assert through_tail(p, BASE + 0x2000) is None              # it calls: no forwarder
    e = explain(p, BASE + RVA)
    assert [r.at - BASE for r in e.roots] == [0x3000] and e.depth == 2


# ------------------------------------------------------------------------------------ the interface apart from the body

def local_in_memory(rva: int, to: int) -> Asm:
    """f(a): int x = a; to(&x); return x  (the address of a local leaves the function)"""
    a = Asm(rva)(T.sub_rsp(40))
    a(I.create_mem_reg(C.MOV_RM32_R32, mem(R.RSP, 32), R.ECX))(T.lea(R.RCX, mem(R.RSP, 32)))
    a.branch(C.CALL_REL32_64, to)
    return a(I.create_reg_mem(C.MOV_R32_RM32, R.EAX, mem(R.RSP, 32)))(T.add_rsp(40))(T.ret())


TAKES_A_POINTER = Signature((Slot("i", 64),), None, (("declared", "test"),))


def test_the_interface_of_a_function_whose_body_has_a_local_in_memory_is_still_read():
    p = program(local_in_memory(RVA, 0x3000), declared=lambda at: ("g", TAKES_A_POINTER) if at == BASE + 0x3000 else None)
    fn = p.normal(BASE + RVA)
    result = sg.results(fn, p.conv, p.callee)[0][0]
    with pytest.raises(NotReconstructed, match="LOCAL_IN_MEMORY"):     # the body cannot be written yet
        lw.lower(fn, p.conv, p.abi, p.callee, result)
    assert lw.interface(fn, p.conv, p.abi, p.callee, result) == (Slot("i", 32),)


def test_the_interface_is_refused_for_what_does_decide_the_parameters():
    p = program(local_in_memory(RVA, 0x3000))                            # the callee is unknown: so is what it consumes
    fn = p.normal(BASE + RVA)
    with pytest.raises(NotReconstructed, match="CALLEE_SIGNATURE_UNKNOWN"):
        lw.interface(fn, p.conv, p.abi, p.callee, None)
