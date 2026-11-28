# SPDX-License-Identifier: AGPL-3.0-or-later
"""The IR: that it means what the instructions mean, that the validator rejects what is wrong, that every transformation passes its
SMT check on small functions and execution on larger ones, and that nothing unvalidated gets into reconstruction."""
import dataclasses
import json
import random
import struct

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
pytest.importorskip("z3", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

import asm as A  # noqa: E402
import irlab as L  # noqa: E402
from asm import BASE, Asm, C, I, R, mem  # noqa: E402

from recon.adapters.x64_msvc import eh  # noqa: E402
from recon.adapters.x64_msvc import program as pg  # noqa: E402
from recon.adapters.x64_msvc.abi import CALLING  # noqa: E402
from recon.adapters.x64_msvc.unwind import UnwindCode, UnwindInfo  # noqa: E402
from recon.core import evaluate as ev  # noqa: E402
from recon.core import sem  # noqa: E402
from recon.core.ir import build, effects, rules, smt  # noqa: E402
from recon.core.ir import passes as ps  # noqa: E402
from recon.core.ir import validate as va  # noqa: E402
from recon.core.ir.interp import ClaimBroken  # noqa: E402
from recon.core.ir.model import Block, Const, Fn, Mem, Observation, Op, Phi, Region, Term  # noqa: E402

# ---------------------------------------------------------------- the IR means what the instructions mean


def compare(an, fn, seeds) -> int:
    n = 0
    for s in seeds:
        assert L.agree(L.run_ir(fn, s), L.run_lifted(an, s)), s
        n += 1
    return n


def test_generated_functions_mean_the_same_as_their_instructions_before_and_after_every_transformation():
    runs = opened = calls = loops = rejected = 0
    for seed in range(220):
        an = L.analysed(L.program(seed))
        if an.frame is None:
            rejected += 1
            continue
        fn = pg.to_ir(an, BASE)
        assert va.problems(fn, CALLING) == []
        out = fn
        for name in (*ps.NORMAL, *ps.NORMAL, "polarity", "straighten"):
            out = ps.apply(ps.PASSES[name], out, CALLING)
            runs += compare(an, out, range(2))
        runs += compare(an, fn, range(4)) + compare(an, ps.normalise(fn, CALLING), range(4))
        opened += any(r.name == "open-frame" for r in fn.regions)
        calls += any(o.kind == "call" for _b, o in fn.ops())
        loops += bool(an.cfg.loops)
    assert runs > 6000 and opened > 20 and calls > 80 and loops > 40 and rejected < 5


def test_saves_are_gone_from_the_normal_form_and_every_exit_gives_the_registers_back():
    admitted = 0
    for seed in range(120):
        an = L.analysed(L.program(seed, escapes=False))
        if an.frame is None:
            continue
        fn = ps.normalise(pg.to_ir(an, BASE), CALLING)
        assert va.problems(fn, CALLING, restored=True) == []
        assert not any(r.keeps for r in fn.regions)
        admitted += va.require(va.admit(fn, CALLING)) is fn
    assert admitted > 100


def test_flag_computations_become_comparisons():
    for jcc, kind in ((C.JL_REL32_64, "slt"), (C.JB_REL32_64, "ult"), (C.JE_REL32_64, "eq"), (C.JLE_REL32_64, "sle"), (C.JBE_REL32_64, "ule"), (C.JG_REL32_64, "sle"), (C.JAE_REL32_64, "ult")):
        for cmp in (I.create_reg_reg(C.CMP_R32_RM32, R.ECX, R.EDX), I.create_reg_i32(C.CMP_RM32_IMM8, R.ECX, 5)):
            a = Asm()
            a(cmp).branch(jcc, "x")(A.mov_ri(R.RAX, 1))(A.ret()).label("x")(A.mov_ri(R.RAX, 2))(A.ret())
            fn = ps.normalise(L.to_ir(a), CALLING)
            (t,) = [b.term for b in fn.blocks if b.term.kind == "branch"]
            o = fn.defining()[t.args[0]][1]
            assert o.kind in (kind, {"sle": "slt", "ult": "ule", "ule": "ult", "slt": "sle", "eq": "ne"}[kind]) and len([x for _b, x in fn.ops() if x.pure]) <= 3
    for jcc, kind in ((C.JA_REL32_64, "flt"), (C.JAE_REL32_64, "fle"), (C.JB_REL32_64, "fle")):
        a = Asm()
        a(I.create_reg_reg(C.COMISS_XMM_XMMM32, R.XMM0, R.XMM1)).branch(jcc, "x")(A.mov_ri(R.RAX, 1))(A.ret()).label("x")(A.mov_ri(R.RAX, 2))(A.ret())
        fn = ps.normalise(L.to_ir(a), CALLING)
        (t,) = [b.term for b in fn.blocks if b.term.kind == "branch"]
        o = fn.defining()[t.args[0]][1]
        o = fn.defining()[o.args[0]][1] if o.kind == "not" else o
        assert o.kind == kind


def test_calls_carry_the_convention_and_stack_arguments():
    a = Asm()
    a(A.sub_rsp(0x38))(A.store(mem(R.RSP, 0x20), R.RDX))(A.mov_rr(R.RCX, R.R8)).branch(C.CALL_REL32_64, 0x9000)(A.add_rr(R.RAX, R.RAX))(A.add_rsp(0x38))(A.ret())
    fn = ps.normalise(L.to_ir(a), CALLING)
    (call,) = [o for _b, o in fn.ops() if o.kind == "call"]
    assert call.args[0] == Const(BASE + 0x9000, 64) and call.attr("args") == tuple(sorted(CALLING.arguments)) and call.attr("defs") == ("rax", "xmm0")
    (slot,) = [r for r in fn.regions if r.private]
    assert (slot.lo, slot.hi) == (-0x18, -0x10)
    assert [m.after for m in call.mem if m.region == slot.name] == [None]  # a stack argument: read, so its store stays
    assert any(o.kind == "store" and o.attr("region") == slot.name for _b, o in fn.ops())
    kinds = {o.kind for o in fn.observations}
    assert {"stack-adjust", "return-address", "copy"} <= kinds


def test_switches_tail_calls_and_ends_are_terminators():
    from test_analysis import switch_function

    fn = L.to_ir(switch_function(False))
    (t,) = [b.term for b in fn.blocks if b.term.kind == "switch"]
    assert len(t.targets) == len(t.attr("cases")) == 3
    a = Asm()
    a(I.create_reg_reg(C.TEST_RM64_R64, R.RCX, R.RCX)).branch(C.JE_REL32_64, 0x9000)(A.load(R.RAX, mem(R.RCX)))(I.create_mem(C.JMP_RM64, mem(R.RAX, 16)))
    fn = L.to_ir(a)
    assert sorted(b.term.kind for b in fn.blocks) == ["branch", "goto", "tail", "tail"]
    b = Asm()
    b(A.sub_rsp(0x28)).branch(C.CALL_REL32_64, 0x9000)
    assert L.to_ir(b).blocks[-1].term.kind == "unreachable"
    c = Asm()
    c(I.create(C.INT3))
    assert [o.kind for _b, o in L.to_ir(c).ops()] == ["trap"]


def test_what_cannot_be_represented_is_refused():
    a = Asm()
    a(A.add_rr(R.RCX, R.RDX))(I.create_reg(C.JMP_RM64, R.RCX))
    an = L.analysed(a)
    assert pg.to_ir(an, BASE) == pg.Refusal("ir", "NOT_REPRESENTED", "unresolved-jump")
    b = Asm()
    b(A.sub_rsp(0x28))(A.ret())
    assert pg.to_ir(L.analysed(b), BASE).detail == "stack-not-balanced-at-exit"
    c = Asm()
    c(A.ret())
    handler = UnwindInfo(1, 1, 0, 0, None, 0x9000, 0x9100, None, ())
    assert pg.to_ir(L.analysed(c), BASE, [(L.RVA, L.RVA + 1, handler)]).detail == "exception-edges-not-represented"


# ---------------------------------------------------------------- exceptions

IMAGE_AT = 0x20000


def eh_image(states=((-1, 0x9900), (0, 0)), ip=((L.RVA, -1), (L.RVA + 20, 1)), magic=0x19930522, tries=0, help_=0x28, spec=0, flags=1, cut=0):
    """A reader over made-up exception data: handler data, FuncInfo, unwind map, ip map."""
    info = IMAGE_AT + 0x10
    blob = struct.pack("<I", info) + b"\0" * 12
    blob += struct.pack("<IiIIIIIiII", magic, len(states), IMAGE_AT + 0x100, tries, 0, len(ip), IMAGE_AT + 0x200, help_, spec, flags)
    blob = blob.ljust(0x100, b"\0") + b"".join(struct.pack("<iI", *s) for s in states)
    blob = blob.ljust(0x200, b"\0") + b"".join(struct.pack("<Ii", *x) for x in ip)
    blob = blob[:len(blob) - cut]

    def read(rva, n):
        if not 0 <= rva - IMAGE_AT <= len(blob) - n:
            raise ValueError("outside")
        return blob[rva - IMAGE_AT : rva - IMAGE_AT + n]
    return read


HANDLED = UnwindInfo(1, 3, 0, 1, None, 0x9000, IMAGE_AT, None, (UnwindCode(4, 0x48),))


def test_the_state_of_a_call_is_the_one_its_return_address_is_in():
    u = eh.unwinding(eh_image(), [(L.RVA, L.RVA + 64, HANDLED)], L.RVA, [L.RVA + 19, L.RVA + 20, L.RVA + 33])
    assert u == build.Unwinding(((-1, 0x9900), (0, 0)), ((L.RVA + 19, -1), (L.RVA + 20, 1), (L.RVA + 33, 1)), 0x28 - 0x48)
    assert eh.unwinding(eh_image(), [], L.RVA, []) is None


@pytest.mark.parametrize("change,why", [
    ({"magic": 0x19930521}, eh.NOT_UNDERSTOOD), ({"tries": 1}, "catch-blocks-not-represented"), ({"flags": 0}, "asynchronous-exceptions-not-represented"),
    ({"spec": 4}, "exception-specification-not-represented"), ({"flags": 9}, "exception-specification-not-represented"),
    ({"states": ((0, 1),)}, eh.MALFORMED), ({"states": ((-2, 1),)}, eh.MALFORMED), ({"ip": ((L.RVA, 5),)}, eh.MALFORMED), ({"ip": ((L.RVA, 0), (L.RVA, 1))}, eh.MALFORMED), ({"cut": 4}, eh.MALFORMED)])
def test_exception_data_that_is_not_understood_is_refused(change, why):
    with pytest.raises(eh.EhError) as e:
        eh.unwinding(eh_image(**change), [(L.RVA, L.RVA + 64, HANDLED)], L.RVA, [])
    assert e.value.reason == why
    a = Asm()
    a(A.sub_rsp(0x48))(A.add_rsp(0x48))(A.ret())
    assert pg.to_ir(L.analysed(a), BASE, [(L.RVA, L.RVA + 64, HANDLED)], eh_image(**change)).detail == why


def cleaning() -> Asm:
    """Two values in the function's own home space, where no callee looks, a call in a state, the runtime's own slot."""
    a = Asm()
    a(A.sub_rsp(0x48))(I.create_mem_i32(C.MOV_RM64_IMM32, mem(R.RSP, 0x28), -2))(A.store(mem(R.RSP, 0x50), R.RCX))(A.store(mem(R.RSP, 0x58), R.RDX))
    a.branch(C.CALL_REL32_64, 0x9000)(A.load(R.RAX, mem(R.RSP, 0x50)))(A.add_rsp(0x48))(A.ret())
    return a


def test_a_call_whose_exception_is_cleaned_up_after_reads_the_frame():
    an = L.analysed(cleaning())
    plain = ps.normalise(pg.to_ir(an, BASE), CALLING)
    assert [o.kind for _b, o in plain.ops()].count("store") == 1  # without cleanups nothing reads the home space; the other may be an argument
    fn = pg.to_ir(an, BASE, [(L.RVA, L.RVA + 64, HANDLED)], eh_image(ip=((L.RVA, 0),)))
    assert fn.unwind == ((-1, 0x9900), (0, 0)) and fn.cleanups(1) == (0x9900,) and fn.cleanups(-1) == ()
    assert [o.kind for o in fn.observations].count("unwind-help") == 1
    out = ps.normalise(fn, CALLING)
    assert effects.effects(out).cleaned_up_after == 1 and not effects.effects(out).noexcept
    assert [o.kind for _b, o in out.ops() if not o.pure and o.kind != "frame"] == ["store", "store", "call"]  # the load after it is the stored value all the same
    assert va.require(va.admit(out, CALLING)) is out and Fn.from_data(json.loads(out.to_bytes())) == out
    # in a state without a cleanup nothing is read
    idle = ps.normalise(pg.to_ir(an, BASE, [(L.RVA, L.RVA + 64, HANDLED)], eh_image(states=((-1, 0),), ip=((L.RVA, 0),))), CALLING)
    assert not any(o.kind == "store" for _b, o in idle.ops())
    assert len({x.semantic_digest() for x in (out, idle, plain)}) == 3


def test_the_runtime_slot_may_not_be_used_for_anything_else():
    a = Asm()
    a(A.sub_rsp(0x48))(I.create_mem_i32(C.MOV_RM64_IMM32, mem(R.RSP, 0x28), -2)).branch(C.CALL_REL32_64, 0x9000)(I.create_reg_mem(C.MOV_R32_RM32, R.EAX, mem(R.RSP, 0x2C)))(A.add_rsp(0x48))(A.ret())
    r = pg.to_ir(L.analysed(a), BASE, [(L.RVA, L.RVA + 64, HANDLED)], eh_image())
    assert r.detail == "exception-runtime-slot-is-also-used"
    # any other value is the function's own store, not the runtime's initialisation
    for first, want in ((-2, "exception-runtime-slot-is-also-used"), (5, None)):
        b = Asm()
        b(A.sub_rsp(0x48))(I.create_mem_i32(C.MOV_RM64_IMM32, mem(R.RSP, 0x28), first))(I.create_mem_i32(C.MOV_RM64_IMM32, mem(R.RSP, 0x28), 5)).branch(C.CALL_REL32_64, 0x9000)(A.add_rsp(0x48))(A.ret())
        r = pg.to_ir(L.analysed(b), BASE, [(L.RVA, L.RVA + 64, HANDLED)], eh_image())
        assert r.detail == want if want else [o.kind for _b, o in r.ops()].count("store") == 2


def test_exception_states_are_validated():
    fn = pg.to_ir(L.analysed(cleaning()), BASE, [(L.RVA, L.RVA + 64, HANDLED)], eh_image(ip=((L.RVA, 0),)))
    assert va.problems(fn, CALLING) == []
    call = where(fn, "call")[2]
    for s in (7, -2, None):
        bad = with_op(fn, "call", attrs=tuple((k, v) for k, v in call.attrs if k != "state") + ((("state", s),) if s is not None else ()))
        assert "call-state" in va.problems(bad, CALLING)
    assert "call-state" in va.problems(dataclasses.replace(fn, unwind=()), CALLING)
    assert "unwind-table" in va.problems(dataclasses.replace(fn, unwind=((0, 0x9900), (0, 0))), CALLING)
    assert "memory-operands" in va.problems(dataclasses.replace(fn, unwind=((-1, 0), (0, 0))), CALLING)  # reads the frame for no cleanup


def test_what_a_cleanup_reads_survives_every_transformation():
    seen = 0
    for seed in range(120):
        an = L.analysed(L.program(seed))
        if an.frame is None:
            continue
        fn = L.with_cleanups(an)
        out = ps.normalise(fn, CALLING)
        for s in range(3):
            x, y = L.run_ir(fn, s, cleanups=True), L.run_ir(out, s, cleanups=True)
            assert L.agree(y, x), (seed, s)
            assert L.agree(L.run_ir(out, s), L.run_lifted(an, s))
            seen += sum(1 for t in x[1] if t[0] == "frame" and t[1])
    assert seen > 200


# ---------------------------------------------------------------- serialisation

def test_serialisation_is_canonical_and_round_trips():
    for seed in range(40):
        an = L.analysed(L.program(seed))
        if an.frame is None:
            continue
        for fn in (pg.to_ir(an, BASE), ps.normalise(pg.to_ir(an, BASE), CALLING)):
            again = Fn.from_data(json.loads(fn.to_bytes()))
            assert again == fn and again.to_bytes() == fn.to_bytes() and again.digest() == fn.digest() and again.semantic_digest() == fn.semantic_digest()
    d = fn.to_data()
    d["version"] = 0
    with pytest.raises(ValueError):
        Fn.from_data(d)


def test_the_semantic_digest_ignores_order_registers_and_value_numbers_and_nothing_else():
    def f(*ins):
        a = Asm()
        for i in ins:
            a(i)
        return ps.normalise(L.to_ir(a(A.ret())), CALLING)
    x = f(A.load(R.R10, mem(R.RCX)), A.load(R.R11, mem(R.RDX)), A.add_rr(R.R10, R.R11), A.mov_rr(R.RAX, R.R10))
    y = f(A.load(R.R9, mem(R.RDX)), A.load(R.R8, mem(R.RCX)), A.mov_rr(R.RAX, R.R8), A.add_rr(R.RAX, R.R9))
    assert x.semantic_digest() == y.semantic_digest() and x.digest() != y.digest()
    other = f(A.load(R.R10, mem(R.RCX)), A.load(R.R11, mem(R.RDX, 8)), A.add_rr(R.R10, R.R11), A.mov_rr(R.RAX, R.R10))
    assert x.semantic_digest() != other.semantic_digest()
    # the order of two stores that may overlap is meaning
    s1 = f(A.store(mem(R.RCX), R.R8), A.store(mem(R.RDX), R.R9))
    s2 = f(A.store(mem(R.RDX), R.R9), A.store(mem(R.RCX), R.R8))
    assert s1.semantic_digest() != s2.semantic_digest()
    # where a spilled local lies is not
    k1 = f(A.sub_rsp(0x48), A.store(mem(R.RSP, 0x20), R.RCX), A.store(mem(R.RSP, 0x2A), R.RDX), A.load(R.RAX, mem(R.RSP, 0x24)), A.add_rsp(0x48))
    k2 = f(A.sub_rsp(0x48), A.store(mem(R.RSP, 0x30), R.RCX), A.store(mem(R.RSP, 0x3A), R.RDX), A.load(R.RAX, mem(R.RSP, 0x34)), A.add_rsp(0x48))
    assert k1.semantic_digest() == k2.semantic_digest()


def test_results_do_not_depend_on_the_hash_seed():
    import os
    import subprocess
    import sys

    child = ("import sys; sys.path[:0]=['tests']; import irlab as L; from recon.core.ir import passes as p, idioms as i; from recon.adapters.x64_msvc.abi import CALLING\n"
             "for s in (1,5,9,14):\n fn=p.normalise(L.to_ir(L.program(s)),CALLING); print(fn.digest(), fn.semantic_digest(), [h.to_data() for h in i.hypotheses(fn)])")
    root = str(pg.__file__).split("recon" + os.sep + "adapters")[0]
    got = {subprocess.run([sys.executable, "-B", "-c", child], capture_output=True, text=True, check=True, cwd=root, env={**os.environ, "PYTHONHASHSEED": h}).stdout for h in ("0", "1", "77")}
    assert len(got) == 1


# ---------------------------------------------------------------- the validator

def sample() -> Fn:
    """A loop, a call, a private slot that stays, a branch and two exits."""
    a = Asm()
    a(A.push(R.RBX))(A.sub_rsp(0x30))(A.mov_rr(R.RBX, R.RCX))(A.store(mem(R.RSP, 0x28), R.RDX)).branch(C.CALL_REL32_64, 0x9000)
    a.label("top")(A.load(R.R8, mem(R.RBX, 8)))(A.add_rr(R.RAX, R.R8))(A.store(mem(R.RBX, 16), R.RAX))(I.create_reg_i32(C.SUB_RM64_IMM8, R.RBX, 1)).branch(C.JNE_REL32_64, "top")
    a(I.create_reg_mem(C.ADD_R64_RM64, R.RAX, mem(R.RSP, 0x28)))(A.add_rsp(0x30))(A.pop(R.RBX))(A.ret())
    return L.to_ir(a)


def with_block(fn, k, **kw):
    return dataclasses.replace(fn, blocks=tuple(dataclasses.replace(b, **kw) if b.id == k else b for b in fn.blocks))


def where(fn, kind):
    return next((b, n, o) for b in fn.blocks for n, o in enumerate(b.ops) if o.kind == kind)


def with_op(fn, which, /, **kw):
    b, n, o = where(fn, which)
    return with_block(fn, b.id, ops=b.ops[:n] + (dataclasses.replace(o, **kw),) + b.ops[n + 1:])


def without(fn, kind):
    b, n, _o = where(fn, kind)
    return with_block(fn, b.id, ops=b.ops[:n] + b.ops[n + 1:])


def moved_to_the_front(fn):
    b = next(b for b in fn.blocks if any(x.kind == "load" for x in b.ops))
    return with_block(fn, b.id, ops=b.ops[::-1])


def loop_block(fn):
    return next(b for b in fn.blocks if any(p.region is None for p in b.phis))


def change_term(fn, which, /, **kw):
    b = next(b for b in fn.blocks if b.term.kind == which)
    return with_block(fn, b.id, term=dataclasses.replace(b.term, **kw))


def phi_change(fn, f, token=False):
    b = next(b for b in fn.blocks if any((p.region is not None) == token for p in b.phis))
    k = next(n for n, p in enumerate(b.phis) if (p.region is not None) == token)
    return with_block(fn, b.id, phis=b.phis[:k] + (f(b.phis[k]),) + b.phis[k + 1:])


def call_op(fn):
    return where(fn, "call")[2]


def store_op(fn):
    return where(fn, "store")[2]


def extra_type(fn):
    return dataclasses.replace(fn, types={**fn.types, 99999: 64})


def narrow_phi(fn):
    b = loop_block(fn)
    p = next(p for p in b.phis if p.region is None)
    return dataclasses.replace(fn, types={**fn.types, p.id: 32})


def a_store_names(fn, region_changes):
    o = next(x for _b, x in fn.ops() if x.kind == "store" and x.attr("region").startswith("param") or x.kind == "store" and x.attr("region") == "other")
    b = next(b for b in fn.blocks if o in b.ops)
    n = b.ops.index(o)
    return with_block(fn, b.id, ops=b.ops[:n] + (dataclasses.replace(o, mem=region_changes(o.mem)),) + b.ops[n + 1:])


BROKEN = [
    ("version", lambda f: dataclasses.replace(f, version=0)),
    ("block-numbering", lambda f: dataclasses.replace(f, blocks=f.blocks[1:])),
    ("block-numbering", lambda f: dataclasses.replace(f, blocks=())),
    ("terminator-kind", lambda f: change_term(f, "return", kind="jump-somewhere")),
    ("terminator-shape", lambda f: change_term(f, "branch", targets=(1,))),
    ("terminator-shape", lambda f: change_term(f, "return", args=())),
    ("target", lambda f: change_term(f, "goto", targets=(77,))),
    ("branch-to-one-block", lambda f: change_term(f, "branch", targets=(2, 2))),
    ("arity", lambda f: with_op(f, "add", args=where(f, "add")[2].args[:1])),
    ("arity", lambda f: with_op(f, "load", defs=())),
    ("operation", lambda f: with_op(f, "add", kind="frobnicate")),
    ("call-shape", lambda f: with_op(f, "call", args=call_op(f).args[:-1])),
    ("call-convention", lambda f: with_op(f, "call", attrs=tuple((k, ("rbx",) if k == "defs" else v) for k, v in call_op(f).attrs), defs=call_op(f).defs[:1])),
    ("memory-on-a-pure-operation", lambda f: with_op(f, "add", mem=store_op(f).mem)),
    ("unreachable-block", lambda f: dataclasses.replace(f, blocks=f.blocks + (Block(len(f.blocks), -1, (), (), Term("unreachable")),))),
    ("entry-block", lambda f: change_term(f, "branch", targets=(0, f.blocks[-1].id))),
    ("region-names", lambda f: dataclasses.replace(f, regions=f.regions + f.regions[:1])),
    ("phi-predecessors", lambda f: phi_change(f, lambda p: dataclasses.replace(p, args=p.args[:1]))),
    ("terminator-changes-memory", lambda f: change_term(f, "return", mem=tuple(Mem(m.region, m.before, 500 + k) for k, m in enumerate(next(b for b in f.blocks if b.term.kind == "return").term.mem)))),
    ("value-defined-twice", lambda f: with_op(f, "add", defs=where(f, "load")[2].defs)),
    ("value-without-definition", extra_type),
    ("use-of-nothing", lambda f: with_op(f, "add", args=(88888, 88889))),
    ("use-not-dominated", moved_to_the_front),
    ("phi-argument-not-dominated", lambda f: phi_change(f, lambda p: dataclasses.replace(p, args=tuple((k, p.args[-1][1]) for k, _a in p.args)))),
    ("type", lambda f: dataclasses.replace(f, types={**f.types, where(f, "load")[2].defs[0]: 0})),
    ("type", lambda f: dataclasses.replace(f, types={**f.types, where(f, "load")[2].defs[0]: "nowhere"})),
    ("entry-type", lambda f: dataclasses.replace(f, types={**f.types, f.tokens[0][1]: 64})),
    ("phi-type", narrow_phi),
    ("phi-type", lambda f: phi_change(f, lambda p: dataclasses.replace(p, args=tuple((k, f.params[0][1]) for k, _a in p.args)), token=True)),
    ("token-used-as-value", lambda f: with_op(f, "add", args=(f.tokens[0][1], f.tokens[0][1]))),
    ("operation-type", lambda f: with_op(f, "add", args=(where(f, "add")[2].args[0], Const(1, 32)))),
    ("operation-type", lambda f: dataclasses.replace(f, types={**f.types, where(f, "add")[2].defs[0]: 32})),
    ("memory-type", lambda f: with_op(f, "store", args=(store_op(f).args[0], Const(1, 1)))),
    ("memory-type", lambda f: with_op(f, "store", args=(Const(8, 32), store_op(f).args[1]))),
    ("terminator-type", lambda f: change_term(f, "branch", args=(Const(1, 8),))),
    ("token-type", lambda f: a_store_names(f, lambda ms: (dataclasses.replace(ms[0], region="other" if ms[0].region != "other" else f.regions[0].name), *ms[1:]))),
    ("regions", lambda f: dataclasses.replace(f, regions=tuple(dataclasses.replace(r, base="elsewhere") if r.private else r for r in f.regions))),
    ("regions", lambda f: dataclasses.replace(f, regions=tuple(dataclasses.replace(r, keeps=True) if r.name == "other" else r for r in f.regions))),
    ("regions-overlap", lambda f: overlapping(f)),
    ("private-region-escapes", lambda f: leaking(f)),
    ("memory-operands", lambda f: with_op(f, "load", mem=())),
    ("memory-operands", lambda f: with_op(f, "load", mem=where(f, "load")[2].mem + (Mem(f.tokens[0][0], f.tokens[0][1], None),))),
    ("memory-operands", lambda f: with_op(f, "store", mem=store_op(f).mem + (Mem(f.tokens[-1][0], f.tokens[-1][1], None),))),
    ("memory-region", lambda f: with_op(f, "load", attrs=(("region", f.regions[0].name if where(f, "load")[2].attr("region") != f.regions[0].name else "other"),))),
    ("stale-token", lambda f: stale(f)),
    ("stale-token", lambda f: phi_change(f, lambda p: dataclasses.replace(p, args=tuple((k, dict(f.tokens)[p.region]) for k, _a in p.args)), token=True)),
    ("exit-memory", lambda f: change_term(f, "return", mem=())),
    ("exit-memory", lambda f: change_term(f, "branch", mem=next(b for b in f.blocks if b.term.kind == "return").term.mem[:1])),
    ("instruction-not-covered", lambda f: dataclasses.replace(f, observations=f.observations[1:])),
    ("instruction-not-covered", lambda f: dataclasses.replace(f, insns=f.insns + (f.insns[-1] + 1,))),
    ("instruction-unknown", lambda f: dataclasses.replace(f, insns=f.insns[1:])),
    ("observation-kind", lambda f: dataclasses.replace(f, observations=f.observations + (Observation(f.insns[0], "looked-fine"),))),
    ("effect-without-an-instruction", lambda f: with_op(f, "store", at=())),
    ("return-convention", lambda f: change_term(f, "return", attrs=tuple((k, v[::-1][1:] + ("zmm9",) if k == "results" else v) for k, v in next(b for b in f.blocks if b.term.kind == "return").term.attrs))),
    ("assumptions", lambda f: dataclasses.replace(f, assumptions=("",))),
]


def overlapping(f):
    r = next(r for r in f.regions if r.private)
    q = Region("copy", r.base, r.lo + 1, r.hi + 1, True)
    v = max(f.types) + 1
    return dataclasses.replace(f, regions=f.regions + (q,), tokens=f.tokens + (("copy", v),), types={**f.types, v: "copy"})


def leaking(f):
    """The address of a private slot is handed to the call."""
    b, n, o = where(f, "call")
    slot = next(x.defs[0] for _b, x in f.ops() if x.kind == "frame")
    return with_op(f, "call", args=(o.args[0], slot, *o.args[2:]))


def stale(f):
    """A second store reads the token the first one has used up."""
    b, n, o = next((b, n, o) for b in f.blocks for n, o in enumerate(b.ops) if o.kind == "store" and b.id != 0 and n and any(x.kind == "call" for x in b.ops[n:]))
    call = next(x for x in b.ops[n:] if x.kind == "call")
    k = b.ops.index(call)
    entry = dict(f.tokens)
    return with_block(f, b.id, ops=b.ops[:k] + (dataclasses.replace(call, mem=tuple(Mem(m.region, entry[m.region], m.after) for m in call.mem)),) + b.ops[k + 1:])


def test_the_sample_is_valid():
    f = sample()
    assert va.problems(f, CALLING) == [] and any(b.term.kind == "branch" for b in f.blocks) and any(r.private for r in f.regions)


@pytest.mark.parametrize("code,breaks", BROKEN, ids=[f"{k}-{c}" for k, (c, _f) in enumerate(BROKEN)])
def test_the_validator_rejects(code, breaks):
    f = breaks(sample())
    assert code in va.problems(f, CALLING)
    with pytest.raises(va.InvalidIr):
        va.admit(f, CALLING)
    if code not in ("version", "block-numbering"):
        with pytest.raises(va.InvalidIr):
            ps.apply(ps.PASSES["dead"], f, CALLING)


def test_every_code_the_validator_knows_is_exercised():
    import inspect
    import re

    known = set(re.findall(r'out\.add\("([a-z-]+)"\)', inspect.getsource(va)))
    # these need a shape the sample does not have; they are exercised on their own
    special = {"switch-cases", "access-crosses-a-private-region", "frame-access-without-a-region", "register-not-given-back", "tail-convention", "unwind-table", "call-state"}
    assert known - special <= {c for c, _f in BROKEN}, known - special - {c for c, _f in BROKEN}


def test_the_remaining_codes():
    from test_analysis import switch_function

    f = L.to_ir(switch_function(False))
    t = next(b.term for b in f.blocks if b.term.kind == "switch")
    assert "switch-cases" in va.problems(change_term(f, "switch", attrs=(("cases", t.attr("cases")[1:]),)), CALLING)
    a = Asm()
    a(A.load(R.RAX, mem(R.RCX))).branch(C.JMP_REL32_64, 0x9000)
    g = L.to_ir(a)
    t = next(b.term for b in g.blocks if b.term.kind == "tail")
    assert "tail-convention" in va.problems(change_term(g, "tail", attrs=tuple((k, tuple(x + "?" for x in v)) for k, v in t.attrs)), CALLING)
    s = sample()
    r = next(r for r in s.regions if r.private and not r.keeps)
    assert "access-crosses-a-private-region" in va.problems(dataclasses.replace(s, regions=tuple(dataclasses.replace(q, hi=q.hi - 2) if q is r else q for q in s.regions)), CALLING)
    b, n, o = where(s, "frame")
    far = with_op(s, "frame", attrs=(("off", -0x1000),))
    assert "frame-access-without-a-region" in va.problems(far, CALLING) or "access-crosses-a-private-region" in va.problems(far, CALLING)
    assert va.problems(s, CALLING) == [] and "register-not-given-back" in va.problems(s, CALLING, restored=True)  # saves are still loads here
    n = ps.normalise(s, CALLING)
    assert va.problems(n, CALLING, restored=True) == []


def test_nothing_unvalidated_gets_into_reconstruction():
    good = va.admit(ps.normalise(sample(), CALLING), CALLING)
    assert va.require(good) is good.fn
    with pytest.raises(va.InvalidIr):
        va.Admitted(good.fn, object())
    for x in (good.fn, None, object()):
        with pytest.raises(va.InvalidIr):
            va.require(x)
    forged = va.admit(good.fn, CALLING)
    forged.fn = dataclasses.replace(good.fn, observations=())
    with pytest.raises(va.InvalidIr):
        va.require(forged)


def test_random_damage_is_noticed_or_changes_nothing():
    """One argument of one operation replaced at random: the validator rejects it, or it is another valid function (with other meaning)."""
    r = random.Random(7)
    rejected = 0
    for seed in range(60):
        an = L.analysed(L.program(seed))
        if an.frame is None:
            continue
        fn = pg.to_ir(an, BASE)
        b = r.choice([b for b in fn.blocks if any(o.args for o in b.ops)])
        n = r.choice([n for n, o in enumerate(b.ops) if o.args])
        o = b.ops[n]
        k = r.randrange(len(o.args))
        bad = with_block(fn, b.id, ops=b.ops[:n] + (dataclasses.replace(o, args=o.args[:k] + (r.choice(sorted(fn.types)),) + o.args[k + 1:]),) + b.ops[n + 1:])
        found = va.problems(bad, CALLING)
        rejected += bool(found)
        if not found:  # then it must at least run
            try:
                L.run_ir(bad, 0)
            except ClaimBroken:
                raise
    assert rejected > 25


# ---------------------------------------------------------------- SMT

def test_every_rewrite_rule_is_proved():
    assert len(rules.instances()) > 2000
    bad = [(r.name, r.lhs.width) for r in rules.instances() if smt.prove_rule(r) != smt.PROVED]
    assert bad == []


def test_a_wrong_rule_is_refuted():
    t, V, n, K = rules.t, rules.V, rules.n, rules.K
    x, y = V("x", 32), V("y", 32)
    for r in (rules.Rule("a", t("slt", t("sub", x, y), n(0, 32)), t("slt", x, y)), rules.Rule("b", t("ult", x, y), t("ule", x, y)), rules.Rule("c", t("not", t("flt", x, y)), t("fle", y, x)),
              rules.Rule("d", t("zext", t("trunc", x, width=8), width=32), x), rules.Rule("e", t("fadd", x, n(0, 32)), x),
              rules.Rule("f", t("trunc", t("add", t("zext", V("z", 8), width=32), K("C", 32)), width=16), t("zext", t("add", V("z", 8), t("trunc", K("C", 32), width=8)), width=16))):
        assert smt.prove_rule(r) == smt.REFUTED, r.name


def test_what_is_proved_is_what_the_evaluator_computes():
    """z3 and the evaluator agree on random constants for every operation, floating point included."""
    z = smt.z3()
    r = random.Random(3)
    edge32 = (0, 0x80000000, 0x3F800000, 0x7F800000, 0xFF800000, 0x7FC00000, 0x7F800001, 1, 0x7FFFFF, 0x800000, 0x7F7FFFFF, 0x4B000001, 0x4EFFFFFF, 0xCF000000)
    edge64 = (0, 1 << 63, 0x3FF << 52, 0x7FF << 52, 0xFFF << 52, 0x7FF8 << 48, 0x7FF << 52 | 1, 1, (1 << 52) - 1, 1 << 52, (0x7FF << 52) - 1, 0x41DFFFFFFFC00000, 0xC1E << 52)
    checked = 0

    def value(w, fp):
        if fp and r.random() < 0.6:
            return r.choice(edge32 if w == 32 else edge64)
        return r.choice((0, 1, (1 << w) - 1, 1 << (w - 1), r.getrandbits(w)))
    for op, (arity, rule) in sem.OPS.items():
        if op == "undef" or op in sem.OPAQUE:
            continue
        fp = rule[0] == "f" and rule != "fsame" or rule in ("fsame", "i2f")
        for _ in range(40 if rule in ("f2i", "fsame", "fun", "f2f", "i2f") else 25):
            w = r.choice((32, 64)) if rule in ("fsame", "fcmp", "fun", "f2f", "f2i") else r.choice((8, 32)) if rule != "i2f" else r.choice((32, 64))
            out = None
            ws = [w] * arity
            if rule == "shift":
                ws[1] = r.choice((8, w))
            elif rule == "ite":
                ws[0] = 1
            elif rule in ("ext", "i2f", "f2f", "f2i", "trunc"):
                out = {"ext": 64, "trunc": 8, "i2f": r.choice((32, 64)), "f2f": 96 - w, "f2i": r.choice((32, 64))}[rule]
            args = [value(x, fp and rule != "i2f") for x in ws]
            if op in ("shl", "lshr", "ashr"):
                args[1] = r.choice((0, 1, w - 1, w, w + 1, args[1])) & ((1 << ws[1]) - 1)
            if op in ("udiv", "urem", "sdiv", "srem") and args[1] == 0:
                continue
            ow = sem.result_width(op, tuple(Const(0, x) for x in ws), out)
            want = ev.apply(op, args, ws, ow)
            got = z.simplify(smt.apply(op, [z.BitVecVal(a, x) for a, x in zip(args, ws)], ow, floats=True))
            assert z.is_bv_value(got) and got.as_long() == want, (op, args, ws, ow)
            checked += 1
    assert checked > 1000


def small(seed: int, widths=(8, 16, 32)) -> Fn:
    """A loop-free function of a few operations, built directly: a diamond or a straight line, private and shared memory, a call now and then."""
    r = random.Random(seed)
    types: dict = {}

    def new(w):
        types[len(types)] = w
        return len(types) - 1
    params = {n: new(64) for n in sorted((*CALLING.arguments, *CALLING.preserved, *CALLING.results)) if n[0] != "x"} | {n: new(128) for n in sorted((*CALLING.arguments, *CALLING.preserved)) if n[0] == "x"}
    rva = 0x1000
    insns: list[int] = []
    slots = [(-16, 8), (-8, 4), (-24, 1)]
    frame_ops = []
    slot_at = {}
    for off, _n in slots:
        v = new(64)
        slot_at[off] = v
        frame_ops.append(Op("frame", (v,), (), (("off", off),)))
    pool: dict[int, list] = {w: [Const(r.choice((0, 1, (1 << w) - 1, 5 % (1 << w))), w)] for w in (1, *widths, 64)}
    pool[64] += [params["rcx"], params["rdx"]]
    blocks: list[list] = [[] for _ in range(5)]

    def at():
        nonlocal rva
        rva += 4
        insns.append(rva)
        return (rva,)

    def pick(w, scope):
        return r.choice(scope[w] if r.random() < 0.4 else scope[w][-2:])

    def grow(k, scope, n):
        for _ in range(n):
            w = r.choice(widths)
            kind = r.randrange(12)
            if kind < 3:
                op = r.choice(("add", "sub", "and", "or", "xor"))
                if r.random() < 0.2 and blocks[k] and blocks[k][-1].kind in ("add", "sub", "and", "or", "xor"):  # the same again
                    again = blocks[k][-1]
                    v = new(types[again.defs[0]])
                    blocks[k].append(dataclasses.replace(again, defs=(v,), at=at()))
                    scope[types[v]].append(v)
                    continue
                v = new(w)
                blocks[k].append(Op(op, (v,), (pick(w, scope), pick(w, scope)), (), (), at()))
                scope[w].append(v)
            elif kind == 3:
                v = new(1)
                blocks[k].append(Op(r.choice(("eq", "ult", "slt", "ule", "sle", "ne")), (v,), (pick(w, scope), pick(w, scope)), (), (), at()))
                scope[1].append(v)
            elif kind == 4:
                a, b = sorted(r.sample((1, *widths), 2))
                v = new(b)
                blocks[k].append(Op(r.choice(("zext", "sext")), (v,), (pick(a, scope),), (), (), at()))
                scope[b].append(v)
            elif kind == 5:
                a, b = sorted(r.sample((1, *widths), 2))
                v = new(a)
                blocks[k].append(Op("trunc", (v,), (pick(b, scope),), (), (), at()))
                scope[a].append(v)
            elif kind == 6:
                v = new(w)
                blocks[k].append(Op("ite", (v,), (pick(1, scope), pick(w, scope), pick(w, scope)), (), (), at()))
                scope[w].append(v)
            elif kind == 7:
                v = new(w)
                blocks[k].append(Op(r.choice(("shl", "lshr", "ashr")), (v,), (pick(w, scope), Const(r.randrange(w), 8)), (), (), at()))
                scope[w].append(v)
            elif kind == 8:
                off, n2 = r.choice(slots)
                if 8 * n2 in scope:
                    if r.random() < 0.5:
                        blocks[k].append(Op("store", (), (slot_at[off], pick(8 * n2, scope)), (), (), at()))
                    else:
                        v = new(8 * n2)
                        blocks[k].append(Op("load", (v,), (slot_at[off],), (), (), at()))
                        scope[8 * n2].append(v)
            elif kind == 9:
                blocks[k].append(Op("store", (), (pick(64, scope), pick(w, scope)), (), (), at()))
            elif kind == 10:
                v = new(w)
                blocks[k].append(Op("load", (v,), (pick(64, scope),), (), (), at()))
                scope[w].append(v)
            elif r.random() < 0.4:
                names = tuple(sorted(CALLING.arguments))
                v = new(64)
                blocks[k].append(Op("call", (v,), (Const(0x9000, 64), *(params[n] for n in names)), (("args", names), ("defs", ("rax",)), ("sp", -0x40)), (), at()))
                scope[64].append(v)
    scope = {w: list(x) for w, x in pool.items()}
    grow(0, scope, r.randrange(2, 6))
    arms = [{w: list(x) for w, x in scope.items()} for _ in range(2)]
    grow(1, arms[0], r.randrange(0, 4))
    grow(2, arms[1], r.randrange(0, 4))
    phis = []
    for w in widths:
        v = new(w)
        phis.append(Phi(v, ((1, pick(w, arms[0])), (2, pick(w, arms[1])))))
        scope[w].append(v)
    grow(3, scope, r.randrange(1, 5))
    kept = tuple(sorted(CALLING.preserved))
    res = None
    for w in widths:
        for x in [x for x in scope[w] if isinstance(x, int)][-3:]:  # the result depends on what was computed last
            v = new(64)
            blocks[4].append(Op(r.choice(("zext", "sext")), (v,), (x,), (), (), at()))
            if res is not None:
                u = new(64)
                blocks[4].append(Op(r.choice(("add", "xor")), (u,), (res, v), (), (), at()))
                v = u
            res = v
    ret = Term("return", (res, params["xmm6"], *(params[n] for n in kept)), (), (("preserved", kept), ("results", tuple(sorted(CALLING.results)))), (), at())
    out = (Block(0, 0x1000, (), tuple(frame_ops) + tuple(blocks[0]), Term("branch", (pick(1, {1: scope[1][:1] + [x for x in scope[1] if isinstance(x, int) and any(x in o.defs for o in blocks[0])]}),), (1, 2), (), (), at())),
           Block(1, 0x1100, (), tuple(blocks[1]), Term("goto", (), (3,), (), (), at())), Block(2, 0x1200, (), tuple(blocks[2]), Term("goto", (), (3,), (), (), at())),
           Block(3, 0x1300, tuple(phis), tuple(blocks[3]), Term("goto", (), (4,), (), (), at())), Block(4, 0x1400, (), tuple(blocks[4]), ret))
    fn = Fn(0x1000, tuple(sorted(params.items())), (), types, out, (), tuple(sorted(insns)))
    return build.thread_with(fn, build.plan_regions(fn, {}), CALLING, ())


def test_small_generated_functions_are_valid():
    for seed in range(60):
        assert va.problems(small(seed), CALLING) == [], seed


@pytest.mark.parametrize("name", sorted(ps.PASSES))
def test_each_transformation_passes_its_smt_check_on_small_functions(name):
    """What goes in is also varied by first running some of the others, so that each one sees IR it changes."""
    proved = changed = 0
    for seed in range(40):
        fn = small(seed)
        r = random.Random(seed)
        for other in r.sample(sorted(ps.PASSES), r.randrange(0, 4)):
            fn = ps.apply(ps.PASSES[other], fn, CALLING)
        out = ps.apply(ps.PASSES[name], fn, CALLING)
        changed += out.blocks != fn.blocks
        assert smt.equivalent(fn, out) == smt.PROVED, seed
        proved += 1
    assert proved == 40 and changed >= (1 if name in ("polarity", "promote", "dead-stores", "forward") else 5)


def test_the_whole_normalisation_is_proved_on_small_functions_and_on_real_instruction_sequences():
    for seed in range(60, 110):
        fn = small(seed)
        assert smt.equivalent(fn, ps.normalise(fn, CALLING)) == smt.PROVED, seed
    proved = 0
    for seed in range(400, 440):
        an = L.analysed(L.program(seed))
        if an.frame is None or an.cfg.loops:
            continue
        fn = pg.to_ir(an, BASE)
        try:
            r = smt.equivalent(fn, ps.normalise(fn, CALLING))
        except smt.CannotEncode:  # a string instruction
            continue
        assert r != smt.REFUTED, seed
        proved += r == smt.PROVED
    assert proved > 20


def test_the_smt_check_notices_a_wrong_function():
    """One operation exchanged for another: refuted, unless it made no difference, which execution then confirms."""
    swap = {"add": "sub", "sub": "add", "and": "or", "or": "and", "xor": "or", "eq": "ne", "ne": "eq", "ult": "ule", "slt": "ult", "zext": "sext", "sext": "zext", "shl": "lshr", "lshr": "shl"}
    r = random.Random(11)
    refuted = same = 0
    for seed in range(50):
        fn = ps.normalise(small(seed), CALLING)
        spots = [(b, n, o) for b in fn.blocks for n, o in enumerate(b.ops) if o.kind in swap]
        if not spots:
            continue
        b, n, o = r.choice(spots)
        bad = with_block(fn, b.id, ops=b.ops[:n] + (dataclasses.replace(o, kind=swap[o.kind]),) + b.ops[n + 1:])
        if smt.equivalent(fn, bad) == smt.REFUTED:
            refuted += 1
        else:
            same += 1
            assert all(L.agree(L.run_ir(bad, s), L.run_ir(fn, s)) for s in range(40)), seed
    assert refuted > 25 and same < refuted


# ---------------------------------------------------------------- broken transformations

def lost_store(fn, _abi):
    b, n, _o = where(fn, "store")
    return build.thread_with(ps._drop_tokens(with_block(fn, b.id, ops=b.ops[:n] + b.ops[n + 1:])), list(fn.regions), CALLING, fn.assumptions)


def swapped_branch(fn, _abi):
    return change_term(fn, "branch", targets=next(b for b in fn.blocks if b.term.kind == "branch").term.targets[::-1])


def forwards_past_a_store(fn, _abi):
    """A load becomes the last stored value whatever was stored in between."""
    last = None
    for b in fn.blocks:
        for o in b.ops:
            if o.kind == "store":
                last = o
            elif o.kind == "load" and last is not None and fn.width(last.args[1]) == fn.width(o.defs[0]):
                keep = tuple(x for x in b.ops if x is not o)
                f = build.substitute(dataclasses.replace(with_block(fn, b.id, ops=keep), types={v: t for v, t in fn.types.items() if v not in o.defs}), {o.defs[0]: last.args[1]}, set())
                return build.record(f, set(o.at), "folded")
    return fn


def test_broken_transformations_are_caught():
    caught = {"lost_store": 0, "swapped_branch": 0, "forwards_past_a_store": 0}
    for seed in range(60):
        fn = small(seed)
        for f in (lost_store, swapped_branch, forwards_past_a_store):
            p = ps.Pass(f.__name__, "", "", f)
            try:
                out = ps.apply(p, fn, CALLING)
            except (va.InvalidIr, StopIteration, AssertionError):
                caught[f.__name__] += 1
                continue
            if out.blocks != fn.blocks and smt.equivalent(fn, out) == smt.REFUTED:
                caught[f.__name__] += 1
    assert all(n > 5 for n in caught.values()), caught


def test_transformations_state_what_they_need_and_keep():
    for p in ps.PASSES.values():
        assert p.precondition and "stay the same" in p.guarantee


# ---------------------------------------------------------------- memory, alias, effects

def test_a_wrong_claim_about_memory_is_noticed_when_it_runs():
    fn = sample()
    slot = next(r for r in fn.regions if r.private and not r.keeps)
    other = dataclasses.replace(fn, regions=tuple(dataclasses.replace(r, hi=r.hi - 1) if r is slot else r for r in fn.regions))
    with pytest.raises(ClaimBroken):
        L.run_ir(other, 1)
    stuck = with_op(fn, "store", mem=tuple(dataclasses.replace(m, before=m.after) for m in where(fn, "store")[2].mem))
    with pytest.raises(ClaimBroken):
        L.run_ir(stuck, 1)


def test_an_access_through_an_unknown_pointer_changes_everything_but_private_slots():
    a = Asm()
    a(A.sub_rsp(0x48))(A.store(mem(R.RSP, 0x20), R.RDX))(A.load(R.R10, mem(R.RCX)))(A.store(mem(R.R10), R.R8))(A.load(R.RAX, mem(R.RCX)))(A.load(R.R9, mem(R.RSP, 0x20)))
    a(A.add_rr(R.RAX, R.R9))(A.add_rsp(0x48))(A.ret())
    fn = ps.normalise(L.to_ir(a), CALLING)
    loads = [o for _b, o in fn.ops() if o.kind == "load"]
    assert len(loads) == 2 and loads[0].mem[0].before != loads[1].mem[0].before  # the two reads of [rcx] are not one value
    assert not any(r.private for r in fn.regions)                                # the slot became a value
    store = where(fn, "store")[2]
    assert store.attr("region") == "other" and {m.region for m in store.mem if m.after is not None} == {r.name for r in fn.regions}


def test_fields_of_one_argument_are_disjoint_and_of_two_are_not():
    a = Asm()
    a(A.store(mem(R.RCX, 8), R.R8))(A.load(R.R10, mem(R.RCX, 16)))(A.store(mem(R.RCX, 8), R.R9))(A.load(R.R11, mem(R.RDX, 16)))(A.lea(R.RAX, mem(R.R10, 0, R.R11, 1)))(A.ret())
    fn = L.to_ir(a)
    s1, l1, s2, l2 = [o for _b, o in fn.ops() if o.kind in ("load", "store")]
    assert effects.alias(fn, s1, l1) == effects.NO and effects.alias(fn, s1, s2) == effects.MUST and effects.alias(fn, s1, l2) == effects.MAY
    assert l1.mem[0].before == dict(fn.tokens)[l1.attr("region")]      # the store beside it did not touch it
    assert l2.mem[0].before != dict(fn.tokens)[l2.attr("region")]


def test_an_address_made_anew_each_time_round_is_not_the_same_bytes():
    a = Asm()
    a(A.mov_ri(R.RAX, 0)).label("top")(A.load(R.R8, mem(R.RCX)))(A.store(mem(R.R8), R.RAX))(A.load(R.R9, mem(R.R8)))(A.mov_rr(R.RCX, R.R9))
    a(I.create_reg_reg(C.TEST_RM64_R64, R.RCX, R.RCX)).branch(C.JNE_REL32_64, "top")(A.ret())
    fn = ps.normalise(L.to_ir(a), CALLING)
    st = where(fn, "store")[2]
    ld = [o for _b, o in fn.ops() if o.kind == "load"]
    assert all(effects.alias(fn, st, o) != effects.NO for o in ld) and effects.alias(fn, st, st) == effects.MAY


def test_effects_of_a_function():
    e = effects.effects(sample())
    assert e.calls == 1 and e.indirect_calls == 0 and not e.pure and not e.read_only and e.ends == ("return",) and not e.opens_frame
    a = Asm()
    a(A.load(R.RAX, mem(R.RCX, 8)))(A.ret())
    e = effects.effects(L.to_ir(a))
    assert e.reads == ("param:rcx",) and e.read_only and not e.pure
    b = Asm()
    b(A.lea(R.RAX, mem(R.RCX, 1)))(A.ret())
    assert effects.effects(L.to_ir(b)).pure


def test_atomic_operations_and_fences_order_memory():
    a = Asm()
    inc = I.create_mem_reg(C.XADD_RM32_R32, mem(R.RCX, 8), R.EAX)
    inc.has_lock_prefix = True
    a(A.load(R.R8, mem(R.RDX)))(inc)(A.load(R.R9, mem(R.RDX)))(A.add_rr(R.RAX, R.R8))(A.add_rr(R.RAX, R.R9))(A.ret())
    fn = ps.normalise(L.to_ir(a), CALLING)
    plain = [o for _b, o in fn.ops() if o.kind == "load" and not o.attr("atomic")]
    assert len(plain) == 2 and plain[0].mem[0].before != plain[1].mem[0].before
    assert effects.effects(fn).atomics == 2


def test_the_thread_block_is_a_base_of_its_own():
    a = Asm()
    g = A.load(R.RAX, mem(None, 0x58))
    g.segment_prefix = R.GS
    a(g)(A.load(R.RAX, mem(R.RAX, 0, R.RCX, 8)))(A.ret())
    fn = L.to_ir(a)
    assert [r.base for r in fn.regions if r.base.startswith("param")] == ["param:gs_base"]


def test_the_floating_point_environment_is_assumed_where_it_matters():
    for op, want in ((C.ADDSS_XMM_XMMM32, (build.FLOATING,)), (C.CVTSI2SS_XMM_RM32, (build.FLOATING,)), (C.MOVAPS_XMM_XMMM128, ())):
        a = Asm()
        a(I.create_reg_reg(op, R.XMM0, R.ECX if op == C.CVTSI2SS_XMM_RM32 else R.XMM1))(A.ret())
        assert L.to_ir(a).assumptions == want


def test_a_frame_address_that_is_stored_opens_the_frame_to_unknown_pointers():
    a = Asm()
    a(A.sub_rsp(0x48))(A.lea(R.RAX, mem(R.RSP, 0x28)))(A.store(mem(R.RCX), R.RAX))(A.store(mem(R.RSP, 0x28), R.R8))(A.load(R.R10, mem(R.RDX)))(A.store(mem(R.R10), R.R9))
    a(A.load(R.RAX, mem(R.RSP, 0x28)))(A.add_rsp(0x48))(A.ret())
    an = L.analysed(a)
    fn = pg.to_ir(an, BASE)
    assert any(r.name == "open-frame" for r in fn.regions) and not any(r.private for r in fn.regions)
    out = ps.normalise(fn, CALLING)
    (ret,) = [b.term for b in out.blocks if b.term.kind == "return"]
    assert out.defining()[ret.args[0]][1].kind == "load"  # not what was stored first: r10 may be that address
    through = 0
    for s in range(60):
        want, entry = L.run_lifted(an, s), L.Env(s).entry
        through += entry["rcx"] == entry["rdx"] and want[0][1][0] == entry["r9"] != entry["r8"]
        assert L.agree(L.run_ir(out, s), want) and L.agree(L.run_ir(fn, s), want)
    assert through


def test_one_of_two_frame_addresses_is_not_a_followed_address():
    a = Asm()
    a(A.sub_rsp(0x48))(A.store(mem(R.RSP, 0x28), R.R8))(A.store(mem(R.RSP, 0x30), R.R8))(A.lea(R.RAX, mem(R.RSP, 0x28)))(I.create_reg_reg(C.TEST_RM64_R64, R.RCX, R.RDX)).branch(C.JE_REL32_64, "x")
    a(A.lea(R.RAX, mem(R.RSP, 0x30))).label("x")(A.store(mem(R.RAX), R.R9))(A.load(R.RAX, mem(R.RSP, 0x28)))(A.add_rsp(0x48))(A.ret())
    an = L.analysed(a)
    fn = pg.to_ir(an, BASE)
    assert any(r.name == "open-frame" for r in fn.regions)
    out = ps.normalise(fn, CALLING)
    for s in range(20):
        assert L.agree(L.run_ir(fn, s), L.run_lifted(an, s)) and L.agree(L.run_ir(out, s), L.run_lifted(an, s))


def test_an_indexed_access_of_the_frame_is_not_a_followed_address():
    a = Asm()
    a(A.sub_rsp(0x48))(A.store(mem(R.RSP, 0x28), R.R8))(A.store(mem(R.RSP, 0x30), R.R8))(I.create_reg_i32(C.AND_RM32_IMM8, R.ECX, 8))
    a(A.store(mem(R.RSP, 0x28, R.RCX, 1), R.R9))(A.load(R.RAX, mem(R.RSP, 0x28)))(A.add_rsp(0x48))(A.ret())
    an = L.analysed(a)
    fn = pg.to_ir(an, BASE)
    assert any(r.name == "open-frame" for r in fn.regions)
    out = ps.normalise(fn, CALLING)
    ends = set()
    for s in range(30):
        want = L.run_lifted(an, s)
        e = L.Env(s).entry
        ends.add((want[0][1][0] == e["r9"], want[0][1][0] == e["r8"]))
        assert L.agree(L.run_ir(fn, s), want) and L.agree(L.run_ir(out, s), want)
    assert len(ends) >= 2


def test_an_address_made_by_a_subtraction_is_the_one_made_by_a_negative_offset():
    a = Asm()
    a(A.mov_rr(R.RAX, R.RCX))(I.create_reg_i32(C.SUB_RM64_IMM8, R.RAX, 8))(A.store(mem(R.RAX), R.R8))(A.store(mem(R.RCX, -8), R.R9))(A.load(R.RAX, mem(R.RAX)))(A.ret())
    an = L.analysed(a)
    raw = pg.to_ir(an, BASE)
    assert {r.lo for r in raw.regions if r.base == "param:rcx"} == {-8}
    for fn in (raw, ps.normalise(raw, CALLING)):
        for s in range(4):
            assert L.agree(L.run_ir(fn, s), L.run_lifted(an, s))


def test_a_callee_may_change_its_home_space():
    a = Asm()
    a(A.sub_rsp(0x38))(A.store(mem(R.RSP, 8), R.RDX)).branch(C.CALL_REL32_64, 0x9000)(A.load(R.RAX, mem(R.RSP, 8)))(A.add_rsp(0x38))(A.ret())
    an = L.analysed(a)
    raw = pg.to_ir(an, BASE)
    (call,) = [o for _b, o in raw.ops() if o.kind == "call"]
    (home,) = [r.name for r in raw.regions if r.private]
    assert [m.after is not None for m in call.mem if m.region == home] == [True]
    # nor does the check accept a function that returns what was there before the call
    (stored,) = [o.args[1] for _b, o in raw.ops() if o.kind == "store"]
    wrong = dataclasses.replace(raw, blocks=tuple(dataclasses.replace(b, term=dataclasses.replace(b.term, args=(stored, *b.term.args[1:]))) for b in raw.blocks))
    assert raw.blocks[-1].term.kind == "return" and smt.equivalent(raw, wrong) == smt.REFUTED
    for fn in (raw, ps.normalise(raw, CALLING)):
        for s in range(4):
            assert L.agree(L.run_ir(fn, s), L.run_lifted(an, s))


def test_an_atomic_operation_orders_memory_it_cannot_address_itself():
    # another thread that was handed the frame address may write it once the atomic operation is seen
    a = Asm()
    inc = I.create_mem_reg(C.XADD_RM32_R32, mem(R.RCX, 8), R.R11D)
    inc.has_lock_prefix = True
    a(A.sub_rsp(0x48))(A.lea(R.RAX, mem(R.RSP, 0x28)))(A.store(mem(R.RDX), R.RAX))
    a(A.load(R.R8, mem(R.RSP, 0x30)))(inc)(A.load(R.R9, mem(R.RSP, 0x30)))(A.lea(R.RAX, mem(R.R8, 0, R.R9, 1)))(A.add_rsp(0x48))(A.ret())
    fn = L.to_ir(a)
    plain = [o for _b, o in fn.ops() if o.kind == "load" and not o.attr("atomic")]
    assert len(plain) == 2 and plain[0].mem[0].before != plain[1].mem[0].before
    out = ps.normalise(fn, CALLING)
    assert len([o for _b, o in out.ops() if o.kind == "load" and not o.attr("atomic")]) == 2


def test_a_slot_accessed_in_parts_is_not_one_value():
    def d32(m, x=None):
        return I.create_mem_reg(C.MOV_RM32_R32, m, x) if x is not None else I.create_reg_mem(C.MOV_R32_RM32, R.EAX, m)
    for accesses in ([A.store(mem(R.RSP, 0x20), R.RCX), d32(mem(R.RSP, 0x24), R.EDX), A.load(R.RAX, mem(R.RSP, 0x20))],
                     [A.store(mem(R.RSP, 0x20), R.RCX), d32(mem(R.RSP, 0x24))],
                     [d32(mem(R.RSP, 0x20), R.ECX), d32(mem(R.RSP, 0x24), R.EDX), A.load(R.RAX, mem(R.RSP, 0x20))]):
        a = Asm()
        a(A.sub_rsp(0x48))
        for x in accesses:
            a(x)
        a(A.add_rsp(0x48))(A.ret())
        an = L.analysed(a)
        for fn in (pg.to_ir(an, BASE), ps.normalise(pg.to_ir(an, BASE), CALLING)):
            assert va.require(va.admit(fn, CALLING)) is fn
            for s in range(8):
                assert L.agree(L.run_ir(fn, s), L.run_lifted(an, s))


def test_memory_is_threaded_until_no_address_becomes_clearer():
    # in one way the pointer is read back from a slot; forwarding makes the join a join of one value, seen only once memory is threaded
    a = Asm()
    a(A.sub_rsp(0x48))(A.store(mem(R.RSP, 0x20), R.RCX))(I.create_reg_reg(C.TEST_RM32_R32, R.EDX, R.EDX)).branch(C.JE_REL32_64, "over")
    a(A.load(R.RCX, mem(R.RSP, 0x20)))(A.store(mem(R.RCX, 0x10), R.R8))
    a.label("over")(A.load(R.RAX, mem(R.RCX, 0x10)))(A.add_rsp(0x48))(A.ret())
    an = L.analysed(a)
    raw = pg.to_ir(an, BASE)
    out = ps.normalise(raw, CALLING)
    assert va.require(va.admit(out, CALLING)) is out
    assert {o.attr("region") for _b, o in out.ops() if o.kind == "load"} <= {r.name for r in out.regions if r.base == "param:rcx"}
    for s in range(6):
        assert L.agree(L.run_ir(out, s), L.run_lifted(an, s))


def test_the_check_knows_that_a_callee_may_change_shared_memory():
    a = Asm()
    a(A.push(R.RBX))(A.sub_rsp(0x20))(A.mov_rr(R.RBX, R.RCX))(A.load(R.RDX, mem(R.RBX))).branch(C.CALL_REL32_64, 0x9000)
    a(A.load(R.RAX, mem(R.RBX)))(A.add_rsp(0x20))(A.pop(R.RBX))(A.ret())
    raw = pg.to_ir(L.analysed(a), BASE)
    before = next(o.defs[0] for _b, o in raw.ops() if o.kind == "load" and not o.attr("region").startswith("frame"))
    wrong = dataclasses.replace(raw, blocks=tuple(dataclasses.replace(b, term=dataclasses.replace(b.term, args=(before, *b.term.args[1:]))) if b.term.kind == "return" else b for b in raw.blocks))
    assert smt.equivalent(raw, raw) == smt.PROVED and smt.equivalent(raw, wrong) == smt.REFUTED


def test_a_frame_that_contradicts_the_unwind_data_is_refused():
    a = Asm()
    a(A.sub_rsp(0x48))(A.add_rsp(0x48))(A.ret())
    an = L.analysed(a)
    assert isinstance(pg.to_ir(an, BASE), Fn)
    assert pg.to_ir(dataclasses.replace(an, unwind_conflicts=("leaf-with-a-frame",)), BASE).detail == "frame-contradicts-unwind-data"


# ---------------------------------------------------------------- structured exceptions and fragments (D-072)

SEH = UnwindInfo(1, 2, 0, 1, None, 0x9000, IMAGE_AT, None, (UnwindCode(4, 0x48),))


def seh_image(*scopes):
    """A reader over a made-up scope table: (begin, end, handler, jump target) RVAs, innermost first."""
    blob = struct.pack("<I", len(scopes)) + b"".join(struct.pack("<IIII", *s) for s in scopes)

    def read(rva, n):
        if not 0 <= rva - IMAGE_AT <= len(blob) - n:
            raise ValueError("outside")
        return blob[rva - IMAGE_AT : rva - IMAGE_AT + n]
    return read


def inside(r):
    return L.RVA <= r < L.RVA + 64


def test_a_termination_scope_runs_its_handler_for_the_calls_it_covers():
    u = eh.seh_unwinding(seh_image((L.RVA + 8, L.RVA + 30, 0x9900, 0)), SEH, inside, [L.RVA + 7, L.RVA + 20, L.RVA + 30])
    assert u == build.Unwinding(((-1, 0x9900),), ((L.RVA + 7, -1), (L.RVA + 20, 0), (L.RVA + 30, -1)), None)


def test_nested_termination_scopes_run_the_inner_handler_then_the_outer():
    inner, outer = (L.RVA + 10, L.RVA + 20, 0x9900, 0), (L.RVA + 4, L.RVA + 40, 0x9a00, 0)
    u = eh.seh_unwinding(seh_image(inner, outer), SEH, inside, [L.RVA + 15, L.RVA + 30])
    assert u.states == ((-1, 0x9a00), (0, 0x9900)) and dict(u.at) == {L.RVA + 15: 1, L.RVA + 30: 0}


@pytest.mark.parametrize("scopes,why", [
    (((L.RVA + 8, L.RVA + 30, 0x9900, L.RVA + 40),), "catch-blocks-not-represented"),          # __except: comes back into the function
    (((L.RVA + 4, L.RVA + 40, 0x9a00, 0), (L.RVA + 10, L.RVA + 20, 0x9900, 0)), eh.NOT_UNDERSTOOD),  # outer before inner
    (((L.RVA + 4, L.RVA + 20, 0x9a00, 0), (L.RVA + 10, L.RVA + 30, 0x9900, 0)), eh.NOT_UNDERSTOOD),  # overlapping
    (((L.RVA + 8, L.RVA + 30, L.RVA + 40, 0),), eh.NOT_UNDERSTOOD),                          # a handler inside the function
    (((L.RVA + 8, L.RVA + 90, 0x9900, 0),), eh.NOT_UNDERSTOOD),                              # a scope beyond its code
    ((), eh.NOT_UNDERSTOOD)])
def test_scope_tables_that_are_not_understood_are_refused(scopes, why):
    with pytest.raises(eh.EhError) as e:
        eh.seh_unwinding(seh_image(*scopes), SEH, inside, [])
    assert e.value.reason == why


def test_the_structured_handler_is_read_only_when_the_handler_imports_it():
    a = Asm()
    a(A.sub_rsp(0x48))(A.add_rsp(0x48))(A.ret())
    read = seh_image((L.RVA + 4, L.RVA + 8, 0x9900, 0))
    named = lambda at: eh.C_SPECIFIC_HANDLER if at == 0x9000 else None  # noqa: E731
    fn = pg.to_ir(L.analysed(a), BASE, [(L.RVA, L.RVA + 64, SEH)], read, named)
    assert isinstance(fn, Fn) and fn.unwind == ((-1, 0x9900),)
    assert pg.to_ir(L.analysed(a), BASE, [(L.RVA, L.RVA + 64, SEH)], read).detail == eh.NOT_UNDERSTOOD


def test_a_function_is_read_through_the_parts_its_unwind_data_chains_to_it_that_follow_on():
    """f(a): a ? 1 : 0, its .pdata split where the frame is set up: the a != 0 part follows the listed range as a chained entry."""
    from recon.adapters.skyrim.normal import with_fragments
    main = Asm(L.RVA)(A.sub_rsp(40))(I.create_reg_reg(C.TEST_RM32_R32, R.ECX, R.ECX))
    main.branch(C.JNE_REL32_64, "part")
    main(I.create_reg_reg(C.XOR_R32_RM32, R.EAX, R.EAX))(A.add_rsp(40))(A.ret())
    main.label("part")(I.create_reg_i32(C.MOV_R32_IMM32, R.EAX, 1))(A.add_rsp(40))(A.ret())
    code, labels = main.assemble()
    n = labels["part"] - L.RVA

    class Image:
        def __init__(self, parts):
            self.parts = parts

        def fragments(self, rva, size):
            return self.parts
    assert pg.analyse(code[:n], L.RVA, BASE, None, []).frame_refusal == "stack-not-balanced-at-exit"
    m = with_fragments(Image([(L.RVA + n, L.RVA + len(code), 0)]), L.RVA, n)
    assert m == len(code) and pg.analyse(code[:m], L.RVA, BASE, None, []).frame_refusal is None
    assert with_fragments(Image([(L.RVA + n + 16, L.RVA + n + 32, 0)]), L.RVA, n) == n     # a part apart is left out
    assert with_fragments(Image([]), L.RVA, n) == n
