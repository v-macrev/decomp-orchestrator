# SPDX-License-Identifier: AGPL-3.0-or-later
"""Control flow, data flow and the frame on synthetic functions, checked by hand-written expectations and by running
the function's semantics: what the analysis claims must hold on every executed path."""
import dataclasses
import random

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

import asm as A  # noqa: E402
from asm import BASE, RVA, Asm, C, I, R, mem  # noqa: E402

from recon.adapters.x64_msvc import program as pg  # noqa: E402
from recon.adapters.x64_msvc import unwind as uw  # noqa: E402
from recon.adapters.x64_msvc.abi import CALLING, WIDTHS  # noqa: E402
from recon.adapters.x64_msvc.unwind import UnwindCode, UnwindInfo  # noqa: E402
from recon.core import evaluate as ev  # noqa: E402
from recon.core.analysis import cfg as cf  # noqa: E402
from recon.core.sem import CallTo, Goto, Lifted  # noqa: E402


def run(code, **kw):
    return pg.analyse(code, RVA, BASE, None, **kw)


def ok(a: Asm, **kw) -> pg.Analysis:
    r = run(a.assemble()[0], **kw)
    assert isinstance(r, pg.Analysis), r
    return r


# ---------------------------------------------------------------- the execution oracle

STACK = 0x7000_0000
HEAP = 0x5000_0000


def execute(an: pg.Analysis, seed: int, steps: int = 400) -> int:
    """Run the semantics from a random state and check every claim of the analysis along the way. Returns the instructions executed."""
    r = random.Random(seed)
    memory: dict[int, int] = {}

    def read(a, n):
        return sum(memory.setdefault(a + k, r.getrandbits(8)) << (8 * k) for k in range(n))

    def write(a, n, v):
        x = r.getrandbits(8 * n) if v is ev.UNDEF else v
        for k in range(n):
            memory[a + k] = x >> (8 * k) & 255

    locs = {n: r.choice((0, 1, 5, r.getrandbits(w))) & ((1 << w) - 1) for n, w in WIDTHS.items()}
    locs["rsp"] = STACK
    for n in ("rcx", "rdx", "r8"):  # arguments the fixtures use as pointers
        locs[n] = HEAP + 0x1000 * r.randrange(1, 9)
    entry = dict(locs)
    m = ev.Machine(read, write, locs)
    by_rva = {i.rva: (b.index, i) for b in an.cfg.blocks for i in b.insns}
    last: dict[str, int] = {n: -1 for n in WIDTHS}
    at, block, n = an.insns[0].rva, 0, 0
    while n < steps:
        n += 1
        k, i = by_rva[at]
        if i.rva == an.cfg.blocks[k].start and n > 1:
            assert k == block or any(e.to == k for e in an.cfg.blocks[block].edges), "control took an edge the graph does not have"
        block = k
        f = an.frame
        if f is not None:
            assert (m.locs["rsp"] - STACK) == f.heights[i.rva]
            for (rva, name), c in f.constants.items():
                if rva == i.rva:
                    # flags and registers read by this instruction before it writes them
                    assert m.locs[name] in (c, ev.UNDEF) or _written_first(i, name)
        for (rva, name), defs in an.flow.use_def.items():
            if rva == i.rva:
                assert last[name] in defs, (hex(rva), name)
        # a location that is not live may be changed without any effect: checked through live-in of the block start
        out = ev.run(i, m)
        for s in i.stmts:
            if type(s).__name__ == "Put":
                last[s.loc.name] = i.rva
        if isinstance(i.terminator, CallTo):
            m.locs["rsp"] += 8  # the callee returns
            for name in CALLING.clobbered:
                m.locs[name] = r.getrandbits(WIDTHS[name])
                last[name] = i.rva
            sp = m.locs["rsp"]
            for a in range(sp, sp + 32):  # ... and may use its home space
                memory[a] = r.getrandbits(8)
            at = i.end
            continue
        if out.kind == "return" or out.target is not None and not an.rva <= out.target - BASE < an.rva + an.size:
            if f is not None:
                assert m.locs["rsp"] == STACK + (8 if out.kind == "return" else 0)
                assert all(m.locs[x] == entry[x] for x in CALLING.preserved)
            return n
        at = i.end if out.target is None else out.target - BASE
    return n


def _written_first(i: Lifted, name: str) -> bool:
    for s in i.stmts:
        if type(s).__name__ == "Put" and s.loc.name == name:
            return True
        if type(s).__name__ == "Get" and s.loc.name == name:
            return False
    return False


# ---------------------------------------------------------------- fixtures

def saving_function() -> Asm:
    """push rbx; push rdi; sub rsp,28h; call; two arms; epilogue."""
    a = Asm()
    a(A.store(mem(R.RSP, 8), R.RSI))(A.push(R.RBX))(A.push(R.RDI))(A.sub_rsp(0x28))(A.mov_rr(R.RBX, R.RCX))(A.mov_rr(R.RSI, R.RDX))
    a.branch(C.CALL_REL32_64, 0x9000)
    a(A.mov_ri(R.RDI, 3))(I.create_reg_reg(C.TEST_RM64_R64, R.RAX, R.RAX)).branch(C.JE_REL32_64, "else")
    a(A.add_rr(R.RDI, R.RDI)).branch(C.JMP_REL32_64, "end")
    a.label("else")(A.store(mem(R.RBX, 16), R.RSI))
    a.label("end")(A.mov_rr(R.RAX, R.RDI))(A.load(R.RSI, mem(R.RSP, 0x40)))(A.add_rsp(0x28))(A.pop(R.RDI))(A.pop(R.RBX))(A.ret())
    return a


def loop_function() -> Asm:
    a = Asm()
    a(A.mov_ri(R.RAX, 0))(A.mov_ri(R.R9, 4))
    a.label("top")(A.add_rr(R.RAX, R.R9))(I.create_reg_i32(C.SUB_RM64_IMM32, R.R9, 1)).branch(C.JNE_REL32_64, "top")(A.ret())
    return a


def test_diamond_with_saves_calls_and_home_space():
    a = saving_function()
    _code, labels = a.assemble()
    an = ok(a)
    g, f = an.cfg, an.frame
    assert [b.end_kind for b in g.blocks] == [cf.BRANCH, cf.GOTO, cf.FALL, cf.RETURN]
    assert g.idom == [0, 0, 0, 0] and g.ipdom == [3, 3, 3, 4] and g.reducible and not g.loops
    assert f.saved == {"rbx": -8, "rdi": -16, "rsi": 8}
    assert f.depth == 0x38 and f.assumptions == ()
    assert list(f.calls.values()) == [("direct", BASE + 0x9000)]
    assert f.regions(CALLING)["saved"] == [-16, -8, 8]
    # rdi is 3 on one way into the join and 6 on the other: not a constant there, constant in the arm
    arm = next(i for i in an.insns if i.rva == g.blocks[1].start)
    assert f.constants[(arm.rva, "rdi")] == 3 and (labels["end"], "rdi") not in f.constants
    assert len(an.flow.use_def[(labels["end"], "rdi")]) == 2
    assert all(execute(an, s) > 0 for s in range(50))


def test_loop_is_found_and_settles():
    an = ok(loop_function())
    assert [(lp.header, lp.body) for lp in an.cfg.loops] == [(1, (1,))] and an.cfg.components == [[1]]
    use = an.flow.use_def[(an.cfg.blocks[1].start, "rax")]
    assert len(use) == 2  # the initial value and the loop's own
    assert "r9" in an.flow.live_in[1] and "r9" not in an.flow.live_out[1] - an.flow.live_in[1]
    assert (an.cfg.blocks[1].start, "r9") not in an.frame.constants
    assert execute(an, 1) == 15


def test_reading_back_an_instructions_own_write_is_not_a_use():
    from recon.core.analysis.dataflow import Abi, effect
    from recon.core.sem import Builder, Const, Loc

    b = Builder()
    b.put(Loc("x", 64), Const(1, 64))
    b.put(Loc("y", 64), b.get(Loc("x", 64)))
    none: frozenset[str] = frozenset()
    e = effect(Lifted(0, 1, "t", tuple(b.stmts)), Abi(none, none, none, none, "s", 8, 0))
    assert (e.uses, e.defs) == (none, {"x", "y"})


def test_liveness_at_exits_and_calls():
    a = Asm()
    a(A.mov_rr(R.R10, R.RCX))(A.mov_ri(R.RAX, 1))(A.ret())
    an = ok(a)
    assert "rax" in an.flow.live_out[0] and "r10" not in an.flow.live_out[0] and "rcx" in an.flow.live_in[0]
    assert "rax" not in an.flow.live_in[0] and "rbx" in an.flow.live_in[0]
    b = Asm()
    b(A.sub_rsp(0x28))(A.mov_rr(R.R8, R.R11)).branch(C.CALL_REL32_64, 0x9000)(A.add_rsp(0x28))(A.ret())
    assert {"rcx", "rdx", "r11"} <= ok(b).flow.live_in[0] and "r8" not in ok(b).flow.live_in[0]


def test_tail_calls_direct_conditional_and_through_a_pointer():
    a = Asm()
    a(I.create_reg_reg(C.TEST_RM64_R64, R.RCX, R.RCX)).branch(C.JE_REL32_64, 0x9000)(A.load(R.RAX, mem(R.RCX)))(I.create_mem(C.JMP_RM64, mem(R.RAX, 16)))
    an = ok(a)
    assert [(b.end_kind, b.leaves_to) for b in an.cfg.blocks] == [(cf.BRANCH, [0x9000]), (cf.TAIL_INDIRECT, [])]
    assert an.frame is not None and an.cfg.ipdom == [2, 2]
    assert CALLING.arguments <= an.flow.live_out[1] and CALLING.arguments <= an.flow.live_out[0] and "r10" not in an.flow.live_out[1]
    b = Asm()
    b(A.sub_rsp(0x28)).branch(C.JMP_REL32_64, 0x9000)
    assert ok(b).frame_refusal == "stack-not-balanced-at-exit"


def test_a_computed_jump_is_unresolved_never_a_tail_call():
    a = Asm()
    a(A.add_rr(R.RCX, R.RDX))(I.create_reg(C.JMP_RM64, R.RCX))
    assert ok(a).cfg.blocks[0].end_kind == cf.UNRESOLVED


def switch_function(compressed: bool, guard=C.JA_REL32_64, entry=None, index=R.ECX, second_way_in=False) -> Asm:
    a = Asm()
    if second_way_in:
        a(I.create_reg_reg(C.TEST_RM64_R64, R.R8, R.R8)).branch(C.JE_REL32_64, "dispatch")
    a(A.cmp32(R.ECX, 3)).branch(guard, "default").label("dispatch")
    a(I.create_reg_reg(C.MOVSXD_R64_RM32, R.RAX, index))(I.create_reg_mem(C.LEA_R64_M, R.RDX, ix_rip(BASE)))
    if compressed:
        a.lazy(lambda m: I.create_reg_mem(C.MOVZX_R32_RM8, R.EAX, A.mem(R.RDX, m["bytes"], R.RAX, 1)))
    a.lazy(lambda m: I.create_reg_mem(C.MOV_R32_RM32, R.ECX, A.mem(R.RDX, m["table"], R.RAX, 4)))
    a(A.add_rr(R.RCX, R.RDX))(I.create_reg(C.JMP_RM64, R.RCX))
    a.label("a")(A.mov_ri(R.RAX, 1))(A.ret()).label("b")(A.mov_ri(R.RAX, 2))(A.ret()).label("default")(A.mov_ri(R.RAX, 3))(A.ret())
    names = ["a", "b"] if compressed else ["a", "b", "a", "default"]
    a.label("table").data(lambda m: b"".join((entry if entry is not None else m.get(n, RVA)).to_bytes(4, "little") for n in names))
    if compressed:
        a.label("bytes").data(bytes([0, 1, 1, 0]))
    return a


def ix_rip(address):
    import iced_x86 as ix

    return ix.MemoryOperand(R.RIP, R.NONE, 1, address, 8)


@pytest.mark.parametrize("compressed", [False, True])
def test_a_bounded_switch_is_resolved(compressed):
    a = switch_function(compressed)
    _c, m = a.assemble()
    an = ok(a)
    (d,) = an.switches.values()
    assert d.bound == 3
    assert d.targets == ((m["a"], m["b"], m["b"], m["a"]) if compressed else (m["a"], m["b"], m["a"], m["default"]))
    sw = next(b for b in an.cfg.blocks if b.end_kind == cf.SWITCH)
    assert {an.cfg.blocks[e.to].start for e in sw.edges} == set(d.targets)
    assert an.frame is not None and sum(n for _r, n in d.tables) == (12 if compressed else 16)


@pytest.mark.parametrize("a", [
    switch_function(False, guard=C.JNE_REL32_64), switch_function(False, entry=RVA + 1),
    switch_function(False, index=R.EDX), switch_function(True, index=R.EDX), switch_function(False, second_way_in=True)])
def test_a_switch_without_its_evidence_stays_unresolved(a):
    r = run(a.assemble()[0])
    assert isinstance(r, pg.Analysis) and not r.switches
    assert any(b.end_kind == cf.UNRESOLVED for b in r.cfg.blocks)


def test_a_jae_guard_lets_one_less_through():
    an = ok(switch_function(False, guard=C.JAE_REL32_64))
    assert [d.bound for d in an.switches.values()] == [2]


# ---------------------------------------------------------------- refusals

def test_branch_into_an_instruction_is_conflicting_evidence():
    a = Asm()
    a(A.mov_ri(R.RAX, 1)).branch(C.JMP_REL32_64, RVA + 1)
    assert run(a.assemble()[0]) == pg.Refusal("cfg", pg.CONFLICT, "target-inside-instruction")


def test_falling_off_the_end_is_an_error_but_a_final_call_does_not_return():
    a = Asm()
    a(A.mov_ri(R.RAX, 1))
    assert run(a.assemble()[0]) == pg.Refusal("cfg", pg.CONFLICT, "falls-off-the-end")
    b = Asm()
    b(A.sub_rsp(0x28)).branch(C.CALL_REL32_64, 0x9000)
    assert [x.end_kind for x in ok(b).cfg.blocks] == [cf.NORETURN]
    b(I.create(C.NOPD))
    assert [x.end_kind for x in ok(b).cfg.blocks] == [cf.NORETURN]  # only padding follows
    b(A.mov_ri(R.RAX, 1))
    assert run(b.assemble()[0]).detail == "falls-off-the-end"


def test_an_unsupported_instruction_is_a_structured_refusal_with_every_missing_form():
    a = Asm()
    a(I.create_reg_reg(C.ADDPS_XMM_XMMM128, R.XMM0, R.XMM1))(I.create(C.CPUID))(A.ret())
    r = run(a.assemble()[0])
    assert (r.stage, r.code) == ("lift", "UNSUPPORTED_INSTRUCTION")
    assert r.missing == (("ADDPS_XMM_XMMM128", "not-in-subset"), ("CPUID", "not-in-subset"))


def test_a_form_that_is_not_validated_is_refused():
    r = pg.analyse(saving_function().assemble()[0], RVA, BASE, frozenset())
    assert r.code == pg.UNSUPPORTED and {w for _f, w in r.missing} == {"form-not-validated"}


@pytest.mark.parametrize("build,why", [
    (lambda a: a(A.sub_rsp(0x28))(A.ret()), "stack-not-balanced-at-exit"),
    # only the low half of the stack pointer comes back, as it is or after a whole-width addition
    (lambda a: a(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ESP))(A.mov_rr(R.RSP, R.RAX))(A.ret()), "stack-pointer-unknown"),
    (lambda a: a(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ESP))(A.add_ri(R.RAX, 8))(A.mov_rr(R.RSP, R.RAX))(A.sub_rsp(8))(A.ret()), "stack-pointer-unknown"),
    (lambda a: a(A.mov_ri(R.RBX, 1))(A.ret()), "preserved-register-not-restored"),
    (lambda a: a(I.create_reg_i32(C.AND_RM64_IMM8, R.RSP, -16))(A.ret()), "stack-pointer-unknown"),
    (lambda a: a(A.push(R.RBX))(A.push(R.RDI))(A.mov_ri(R.RBX, 1))(A.mov_ri(R.RDI, 1))(A.pop(R.RBX))(A.pop(R.RDI))(A.ret()), "preserved-register-not-restored"),
    (lambda a: a(I.create_reg_reg(C.TEST_RM64_R64, R.RCX, R.RCX)).branch(C.JE_REL32_64, "x")(A.push(R.RAX)).label("x")(A.ret()), "stack-pointer-unknown"),
    # the saved register's slot is overwritten
    (lambda a: a(A.push(R.RBX))(A.mov_ri(R.RBX, 1))(A.store(mem(R.RSP), R.RAX))(A.pop(R.RBX))(A.ret()), "preserved-register-not-restored"),
    # ... by half
    (lambda a: a(A.push(R.RBX))(A.mov_ri(R.RBX, 1))(I.create_mem_reg(C.MOV_RM32_R32, mem(R.RSP, 4), R.EAX))(A.pop(R.RBX))(A.ret()), "preserved-register-not-restored"),
    # ... kept only in the callee's home space across a call
    (lambda a: a(A.sub_rsp(0x28))(A.store(mem(R.RSP, 8), R.RBX))(A.mov_ri(R.RBX, 1)).branch(C.CALL_REL32_64, 0x9000)(A.load(R.RBX, mem(R.RSP, 8)))(A.add_rsp(0x28))(A.ret()), "preserved-register-not-restored"),
    # ... below the stack pointer across a call
    (lambda a: a(A.sub_rsp(0x28))(A.store(mem(R.RSP, -32), R.RBX))(A.mov_ri(R.RBX, 1)).branch(C.CALL_REL32_64, 0x9000)(A.load(R.RBX, mem(R.RSP, -32)))(A.add_rsp(0x28))(A.ret()), "preserved-register-not-restored"),
])
def test_frames_that_cannot_be_shown_to_hold_are_refused(build, why):
    a = Asm()
    build(a)
    assert ok(a).frame_refusal == why


def test_a_narrow_part_of_a_value_is_not_taken_for_more():
    a = Asm()
    a(I.create_reg_reg(C.MOVZX_R32_RM8, R.EAX, R.CL))(I.create_reg_reg(C.MOV_R32_RM32, R.EDX, R.EAX))(I.create_reg_reg(C.MOV_R32_RM32, R.R8D, R.ECX))
    a(I.create_reg_reg(C.SUB_R32_RM32, R.EDX, R.R8D))(A.mov_rr(R.R9, R.RDX))(A.ret())
    assert not any(n == "rdx" for (_r, n) in ok(a).frame.constants)
    b = Asm()
    b(I.create_reg_reg(C.MOV_R32_RM32, R.EDX, R.ECX))(I.create_reg_reg(C.MOV_R32_RM32, R.R8D, R.ECX))(I.create_reg_reg(C.SUB_R32_RM32, R.EDX, R.R8D))(A.mov_rr(R.R9, R.RDX))(A.ret())
    assert [c for (_r, n), c in ok(b).frame.constants.items() if n == "rdx"] == [0]


def test_frame_addresses_that_leave_are_tracked_and_the_assumption_is_stated():
    a = Asm()
    a(A.push(R.RBX))(A.sub_rsp(0x40))(A.lea(R.RCX, mem(R.RSP, 0x28))).branch(C.CALL_REL32_64, 0x9000)
    a(A.mov_ri(R.RAX, 5))(A.store(mem(R.RSP, 0x30), R.RAX))(A.store(mem(R.R11), R.RAX))(A.load(R.R10, mem(R.RSP, 0x30)))(A.lea(R.R9, mem(R.R10)))
    a(A.add_rsp(0x40))(A.pop(R.RBX))(A.ret())
    f = ok(a).frame
    assert f.address_taken == [-0x48 + 0x28] and f.assumptions == ("indexed-and-escaped-stores-miss-saved-registers",)
    assert not any(n == "r10" for (_r, n) in f.constants)  # the unknown store may have changed the local


def test_an_indexed_store_into_the_frame_makes_locals_unknown():
    a = Asm()
    a(A.sub_rsp(0x48))(A.mov_ri(R.RAX, 5))(A.store(mem(R.RSP, 0x20), R.RAX))(A.lea(R.RDX, mem(R.RSP, 0x20)))(A.store(mem(R.RDX, 0, R.RCX, 8), R.R8))
    a(A.load(R.R10, mem(R.RSP, 0x20)))(A.lea(R.R9, mem(R.R10)))(A.add_rsp(0x48))(A.ret())
    f = ok(a).frame
    assert len(f.indexed) == 1 and not any(n == "r10" for (_r, n) in f.constants)
    b = Asm()
    b(A.sub_rsp(0x48))(A.mov_ri(R.RAX, 5))(A.store(mem(R.RSP, 0x20), R.RAX))(A.store(mem(R.RDX, 0, R.RCX, 8), R.R8))
    b(A.load(R.R10, mem(R.RSP, 0x20)))(A.lea(R.R9, mem(R.R10)))(A.add_rsp(0x48))(A.ret())
    assert [c for (_r, n), c in ok(b).frame.constants.items() if n == "r10"] == [5]


# ---------------------------------------------------------------- unwind data

def info(*codes, chained=None):
    return UnwindInfo(1, 0, 0, len(codes), chained, None, None, None, tuple(codes))


def unwind_of_saving_function(a: Asm):
    an = ok(a)
    r = [i.rva - RVA for i in an.insns]
    return [UnwindCode(r[4], 0x28), UnwindCode(r[4], register="rsi", slot=0x40), UnwindCode(r[3], 8, "rdi", push=True), UnwindCode(r[2], 8, "rbx", push=True)]


def test_the_frame_agrees_with_unwind_codes():
    a = saving_function()
    codes = unwind_of_saving_function(a)
    an = ok(a, unwind_entries=[(RVA, RVA + 0x100, info(*codes))])
    assert (an.unwind_checked, an.unwind_conflicts) == (6, ())


@pytest.mark.parametrize("change,conflict", [
    (lambda c: [dataclasses.replace(c[0], alloc=0x20)] + c[1:], "height-after-prologue-step"),
    (lambda c: [c[0], dataclasses.replace(c[1], slot=0x48)] + c[2:], "saved-register-slot"),
    (lambda c: [c[0]] + c[2:], "saved-register-not-in-unwind-data"),
    (lambda c: c[:2] + [dataclasses.replace(c[2], register="rbx"), dataclasses.replace(c[3], register="rdi")], "saved-register-slot"),
])
def test_a_disagreement_with_unwind_codes_is_reported(change, conflict):
    a = saving_function()
    an = ok(a, unwind_entries=[(RVA, RVA + 0x100, info(*change(unwind_of_saving_function(a))))])
    assert conflict in an.unwind_conflicts


def test_a_leaf_needs_no_unwind_data_and_a_frame_does():
    assert ok(loop_function(), unwind_entries=[]).unwind_conflicts == ()
    assert ok(saving_function(), unwind_entries=[]).unwind_conflicts == ("leaf-with-a-frame",)


def test_unwind_codes_are_decoded():
    # offset, operation | info << 4
    raw = bytes([20, 0x04 | 6 << 4, 8, 0, 15, 0x01, 0x20, 0, 10, 0x02 | 4 << 4, 8, 0x03 | 2 << 4, 6, 0x08 | 7 << 4, 2, 0, 4, 0x00 | 3 << 4])
    assert uw._codes(raw, len(raw) // 2) == (
        UnwindCode(20, register="rsi", slot=64), UnwindCode(15, 0x100), UnwindCode(10, 40), UnwindCode(8, sets_frame=True),
        UnwindCode(6, vector=True, slot=32), UnwindCode(4, 8, "rbx", push=True))
    assert uw._codes(bytes([1, 0x01]), 1) is None  # runs past the table
    assert uw._codes(bytes([1, 0x0A]), 1) is None  # a machine frame


# ---------------------------------------------------------------- generated programs

def random_program(seed: int) -> Asm:
    """A function with saves, locals, branches forward and bounded loops, calls; always balanced."""
    r = random.Random(seed)
    a = Asm()
    saves = r.sample([R.RBX, R.RDI, R.RSI, R.R14], r.randrange(0, 4))
    frame = 8 * r.randrange(4, 12)
    for s in saves:
        a(A.push(s))
    a(A.sub_rsp(frame + 32))
    regs = [R.RAX, R.RCX, R.RDX, R.R8, R.R9, R.R10, R.R11] + saves
    n = r.randrange(2, 7)
    for k in range(n):
        a.label(f"L{k}")
        for _ in range(r.randrange(1, 6)):
            x, y = r.choice(regs), r.choice(regs)
            slot = mem(R.RSP, 32 + 8 * r.randrange(frame // 8))
            a(r.choice((lambda: A.mov_rr(x, y), lambda: A.add_rr(x, y), lambda: A.mov_ri(x, r.randrange(9)), lambda: A.store(slot, x), lambda: A.load(x, slot),
                        lambda: A.add_ri(x, r.randrange(5)), lambda: I.create_reg_reg(C.XOR_R32_RM32, R.EAX, R.EAX), lambda: I.create_reg(C.SETE_RM8, R.AL)))())
        if r.random() < 0.3:
            a.branch(C.CALL_REL32_64, 0x9000)
        kind = r.random()
        a(I.create_reg_reg(C.CMP_R64_RM64, r.choice(regs), r.choice(regs)))
        if kind < 0.5:
            a.branch(r.choice((C.JE_REL32_64, C.JB_REL32_64, C.JG_REL32_64)), f"L{r.randrange(0, n)}" if r.random() < 0.3 else f"L{r.randrange(k + 1, n + 1)}")
        elif kind < 0.65:
            a.branch(C.JMP_REL32_64, f"L{r.randrange(k + 1, n + 1)}")
    a.label(f"L{n}")(A.add_rsp(frame + 32))
    for s in reversed(saves):
        a(A.pop(s))
    a(A.ret())
    return a


def test_claims_hold_on_every_executed_path_of_generated_programs():
    executed = calls = loops = 0
    for seed in range(250):
        an = ok(random_program(seed))
        assert an.frame is not None, an.frame_refusal
        loops += bool(an.cfg.loops)
        calls += bool(an.frame.calls)
        for s in range(4):
            executed += execute(an, s)
    assert executed > 20_000 and calls > 100 and loops > 30


def test_dead_locations_do_not_matter():
    """Changing a location that is not live into the entry block changes nothing the function hands back."""
    for seed in range(60):
        an = ok(random_program(seed))
        dead = sorted(set(WIDTHS) - an.flow.live_in[0])
        assert dead
        r = random.Random(seed)
        base = {n: r.getrandbits(w) for n, w in WIDTHS.items()} | {"rsp": STACK}
        results = []
        for k in range(2):
            locs = dict(base) if k == 0 else base | {n: r.getrandbits(WIDTHS[n]) for n in dead}
            results.append(outcome(an, locs, seed))
        assert results[0] == results[1]


def outcome(an: pg.Analysis, locs: dict, seed: int):
    memory: dict[int, int] = {}

    def read(a, n):
        return sum(memory.get(a + k, (a + k) * 31 & 255) << (8 * k) for k in range(n))

    def write(a, n, v):
        for k in range(n):
            memory[a + k] = 0 if v is ev.UNDEF else v >> (8 * k) & 255

    m = ev.Machine(read, write, locs)
    at = {i.rva: i for i in an.insns}
    i, seen = an.insns[0], []
    for step in range(300):
        out = ev.run(i, m)
        if out.kind == "return":
            break
        if out.kind == "call":
            # a callee sees its arguments, and returns the same whatever else it was given
            seen.append([m.locs[n] for n in sorted(CALLING.arguments)])
            m.locs["rsp"] += 8
            m.locs.update({n: (step * 7 + k) & ((1 << WIDTHS[n]) - 1) for k, n in enumerate(sorted(CALLING.clobbered))})
        i = at[i.end if out.target is None or out.kind == "call" else out.target - BASE]
    return m.locs["rax"], m.locs["rsp"], [m.locs[n] for n in sorted(CALLING.preserved)], seen, sorted((a, v) for a, v in memory.items() if a >= STACK + 40)


def test_results_are_reproducible():
    for seed in (0, 1, 2, 3):
        a = random_program(seed)
        assert ok(a).digest() == ok(a).digest()
    import subprocess
    import sys

    code = saving_function().assemble()[0]
    child = ("import sys; from recon.adapters.x64_msvc import program as p; "
             "print(p.analyse(bytes.fromhex(sys.argv[1]), %d, %d, None).digest())" % (RVA, BASE))
    got = {subprocess.run([sys.executable, "-B", "-c", child, code.hex()], capture_output=True, text=True, check=True, cwd=str(pg.__file__).split("recon" + __import__("os").sep + "adapters")[0],
                          env={**__import__("os").environ, "PYTHONHASHSEED": h}).stdout.strip() for h in ("0", "1", "77")}
    assert got == {ok(saving_function()).digest()}


def test_an_indirect_jump_in_a_function_with_a_table_is_never_called_a_tail_call():
    a = switch_function(False, guard=C.JNE_REL32_64)
    r = run(a.assemble()[0])
    assert all(b.end_kind != cf.TAIL_INDIRECT for b in r.cfg.blocks)
    assert any(isinstance(i.terminator, Goto) for i in r.insns)
