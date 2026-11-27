# SPDX-License-Identifier: AGPL-3.0-or-later
"""P8: whole-program knowledge. Why a function has no signature, down to where the chain of callees without one starts
(D8-003); a function's interface read apart from whether its body can be written (D8-004); a signature read from call
sites when its own code gives none (D8-002, D8-005)."""
import hashlib

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

import asm as T  # noqa: E402
from asm import BASE, RVA, Asm, C, I, R, mem  # noqa: E402

from recon.adapters.x64_msvc import program as pg  # noqa: E402
from recon.adapters.x64_msvc.abi import CALLING, SOURCE  # noqa: E402
from recon.core.inference import lower as lw  # noqa: E402
from recon.core.inference import signature as sg  # noqa: E402
from recon.core.inference import evidence as ev  # noqa: E402
from recon.core.inference import callsites as cs  # noqa: E402
from recon.core.inference.explain import explain, through_tail  # noqa: E402
from recon.core.inference.signature import NotReconstructed, Signature, Slot  # noqa: E402
from recon.core import knowledge as kn  # noqa: E402
from recon.core.inference.whole import Program  # noqa: E402
from recon.core.ir import passes, validate  # noqa: E402


def program(*fns: Asm, declared=None, store=None, universe: bool = False) -> Program:
    """Functions at their own RVAs; an address none of them is at stands for a function whose normal form is refused."""
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
        return f"{at - BASE:x}:refused" if f is None else f"{f.rva:x}:" + hashlib.sha256(f.assemble()[0]).hexdigest()[:16]

    return Program(normal, SOURCE, CALLING, BASE, lambda at, n: None, lambda a, w: None, declared or (lambda at: None), store=store,
                   key=key, universe=(lambda: [BASE + r for r in code]) if universe else None)


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


# ------------------------------------------------------------------------------------ signatures from call sites

def site(set_=(), reads=(), left=()):
    return {"set": sorted([list(x) for x in set_]), "reads": sorted([list(x) for x in reads]), "left": sorted(left)}


def test_call_sites_agreeing_give_a_constrained_signature_with_their_widest_widths():
    s, status = ev.from_sites([site([("rcx", 64), ("rdx", 32)], [("rax", 32)]), site([("rcx", 0), ("rdx", 8)])], SOURCE)
    assert status == ev.CONSTRAINED
    assert s.params == (Slot("i", 64), Slot("i", 32)) and s.result == Slot("i", 32)
    assert ("sites", "2") in s.evidence and ("status", "constrained") in s.evidence


def test_a_position_before_one_that_is_set_is_passed_and_a_constant_fits_any_width():
    s, _ = ev.from_sites([site([("r8", 0)])], SOURCE)
    assert s.params == (Slot("i", 64), Slot("i", 64), Slot("i", 64)) and s.result is None
    s, _ = ev.from_sites([site([("xmm1", 32)], [("xmm0", 128)])], SOURCE)
    assert s.params == (Slot("i", 64), Slot("f", 32)) and s.result == Slot("f", 64)


def test_call_sites_that_disagree_contradict_and_give_no_signature():
    passes_two = site([("rcx", 64), ("rdx", 64)])
    assert ev.from_sites([passes_two, site([("rcx", 64)], left=["rdx", "xmm1"])], SOURCE) == (None, ev.CONTRADICTED)
    assert ev.from_sites([site([("rcx", 64)]), site([("xmm0", 64)])], SOURCE) == (None, ev.CONTRADICTED)
    assert ev.from_sites([site(reads=[("rax", 64)]), site(reads=[("xmm0", 64)])], SOURCE) == (None, ev.CONTRADICTED)
    # a caller that leaves a position no other caller sets says nothing against it
    s, status = ev.from_sites([site([("rcx", 64)]), site([("rcx", 64)], left=["rdx", "xmm1"])], SOURCE)
    assert status == ev.CONSTRAINED and len(s.params) == 1
    assert ev.from_sites([], SOURCE) == (None, "")


def test_a_call_site_says_which_argument_locations_an_earlier_call_left():
    callee = Asm(0x6000)(T.ret())
    g = Asm(0x3000)(T.sub_rsp(40))                     # g(): a(5, 7); b(3) with what a left in rdx
    g(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 5))(I.create_reg_i32(C.MOV_R32_IMM32, R.EDX, 7))
    g.branch(C.CALL_REL32_64, 0x5000)
    g(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 3)).branch(C.CALL_REL32_64, 0x6000)
    g(T.add_rsp(40))(T.ret())
    sites = cs.call_evidence(program(callee, g).normal(BASE + 0x3000), SOURCE)
    first, second = sites[str(BASE + 0x5000)][0], sites[str(BASE + 0x6000)][0]
    assert first["set"] == [["rcx", 0], ["rdx", 0]] and first["left"] == []    # entry values, passed on: neither
    assert second["set"] == [["rcx", 0]] and "rdx" in second["left"] and "r8" in second["left"]
    s, status = ev.from_sites([second], SOURCE)
    assert status == ev.CONSTRAINED and s.params == (Slot("i", 64),)


# ------------------------------------------------------------------------------------ in the worklist (whole.Program)

def indexed(*fns: Asm, store=None, declared=None) -> Program:
    """A program whose callers are indexed over exactly these functions."""
    p = program(*fns, declared=declared, store=store, universe=True)
    p.index_callers()
    return p


def sets_and_reads(rva: int, to: int, value: int = 5) -> Asm:
    """f(): return to(value) + 1"""
    a = Asm(rva)(T.sub_rsp(40))(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, value))
    a.branch(C.CALL_REL32_64, to)
    return a(I.create_reg_i32(C.ADD_RM32_IMM8, R.EAX, 1))(T.add_rsp(40))(T.ret())


def test_a_callee_whose_body_has_a_local_in_memory_has_a_signature_and_so_do_its_callers():
    declared = lambda at: ("g", TAKES_A_POINTER) if at == BASE + 0x3000 else None  # noqa: E731
    p = program(local_in_memory(0x2000, 0x3000), calls(RVA, 0x2000), declared=declared)
    s = p.signature(BASE + 0x2000)
    assert s is not None and s.params == (Slot("i", 32),)
    assert p.signature(BASE + RVA) is not None


def test_a_function_its_own_code_cannot_read_is_read_from_its_callers_and_the_chain_above_it_is_unblocked():
    # 0x5000 is no function the program can read; two callers agree on one argument and read an integer result
    fns = (sets_and_reads(0x2000, 0x5000, 5), sets_and_reads(0x2100, 0x5000, 6), calls(RVA, 0x2000))
    p = indexed(*fns)
    s = p.signature(BASE + 0x5000)
    assert s is not None and s.params == (Slot("i", 64),) and s.result == Slot("i", 32)
    assert ("status", ev.CONSTRAINED) in s.evidence and ("sites", "2") in s.evidence
    assert p.signature(BASE + 0x2000) is not None and p.signature(BASE + RVA) is not None
    assert p.stats["signature_from_sites"] >= 1
    assert explain(p, BASE + RVA).state == "known"


def test_callers_that_contradict_each_other_leave_the_function_unknown_and_block_what_needs_it():
    two = Asm(0x2100)(T.sub_rsp(40))                     # passes two arguments
    two(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 5))(I.create_reg_i32(C.MOV_R32_IMM32, R.EDX, 7))
    two.branch(C.CALL_REL32_64, 0x5000)
    two(T.add_rsp(40))(T.ret())
    one = Asm(0x2200)(T.sub_rsp(40))                     # passes one; rdx holds what an earlier call left there
    one(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 5)).branch(C.CALL_REL32_64, 0x6000)
    one(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 3)).branch(C.CALL_REL32_64, 0x5000)
    one(T.add_rsp(40))(T.ret())
    leaf = Asm(0x6000)(T.ret())
    p = indexed(two, one, leaf)
    assert p.signature(BASE + 0x5000) is None
    assert p.stats["signature_contradicted"] == 1
    assert p.signature(BASE + 0x2100) is None


def test_a_signature_read_from_callers_is_read_again_exactly_when_a_caller_changes():
    store = kn.MemoryStore()
    fns = [sets_and_reads(0x2000, 0x5000, 5), sets_and_reads(0x2100, 0x5000, 6), Asm(0x7000)(T.ret())]
    everything = [BASE + 0x2000, BASE + 0x2100, BASE + 0x5000, BASE + 0x7000]
    p = indexed(*fns, store=store)
    first = [p.signature(a) for a in everything]
    assert first[2] is not None
    q = indexed(*fns, store=store)
    assert [q.signature(a) for a in everything] == first
    assert q.stats["signature_computed"] == 0 and q.stats["evidence_computed"] == 0
    changed = [sets_and_reads(0x2000, 0x5000, 9), *fns[1:]]
    r = indexed(*changed, store=store)
    assert r.signature(BASE + 0x5000) == first[2]
    for a in everything:
        r.signature(a)
    # the changed caller's evidence is read again, the other's is not; the functions that take the callee's key (both
    # callers) are solved again, and the one that has nothing to do with it is not
    assert r.stats["evidence_computed"] == 1 and r.stats["evidence_loaded"] == 1
    assert r.stats["signature_computed"] == 2


@pytest.mark.parametrize("indexed_first", [True, False])
def test_a_filed_component_is_read_back_only_by_a_program_with_the_same_index_of_callers(indexed_first):
    store = kn.MemoryStore()
    fns = (sets_and_reads(0x2000, 0x5000, 5), sets_and_reads(0x2100, 0x5000, 6), calls(RVA, 0x2000))
    runs = [lambda: indexed(*fns, store=store), lambda: program(*fns, store=store)]
    if not indexed_first:
        runs.reverse()
    got = {}
    for run in runs:
        p = run()
        got[p.callers(BASE + RVA) is not None] = (p.signature(BASE + RVA), p.signature(BASE + 0x5000))
    assert got[True][0] is not None and got[True][1] is not None
    assert got[False] == (None, None)
def test_signatures_read_from_callers_do_not_depend_on_the_order_of_work():
    fns = [sets_and_reads(0x2000, 0x5000, 5), sets_and_reads(0x2100, 0x5000, 6), calls(RVA, 0x2000), calls(0x2300, 0x2100)]
    orders = (fns, list(reversed(fns)))
    got = []
    for order in orders:
        p = indexed(*order)
        got.append([p.signature(BASE + f.rva) for f in sorted(fns, key=lambda f: f.rva)] + [p.signature(BASE + 0x5000)])
    assert got[0] == got[1]
