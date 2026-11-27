# SPDX-License-Identifier: AGPL-3.0-or-later
"""From the normal form to source text, without a compiler: signatures, types, forms, the execution check, the search."""
import itertools
import re

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
pytest.importorskip("z3", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

import asm as T  # noqa: E402
import irlab as L  # noqa: E402
from asm import BASE, RVA, Asm, C, I, R, mem  # noqa: E402

from recon.adapters.x64_msvc import cl  # noqa: E402
from recon.adapters.x64_msvc import program as pg  # noqa: E402
from recon.adapters.x64_msvc.abi import CALLING, SOURCE  # noqa: E402
from recon.core.emitter import cpp  # noqa: E402
from recon.core.inference import types as ty  # noqa: E402
from recon.core.inference.signature import NotReconstructed, Slot  # noqa: E402
from recon.core.ir import passes, validate  # noqa: E402
from recon.core.structuring import ast as A  # noqa: E402
from recon.core.structuring import evaluate as ev  # noqa: E402
from recon.core.structuring.build import negate  # noqa: E402
from recon.core.structuring.regions import Style, mirrored  # noqa: E402
from recon.core.synthesis import candidates as cd  # noqa: E402
from recon.core.synthesis import search  # noqa: E402

OTHER = 0x2000


def program(*fns: Asm, constants=None) -> cd.Program:
    """Functions at their own RVAs."""
    code = {f.rva: f for f in fns}

    def normal(at: int):
        f = code.get(at - BASE)
        if f is None:
            raise NotReconstructed("NO_SUCH_FUNCTION")
        a = pg.analyse(f.assemble()[0], f.rva, BASE, None)
        assert isinstance(a, pg.Analysis), a
        fn = pg.to_ir(a, BASE)
        return validate.require(validate.admit(passes.normalise(fn, CALLING), CALLING))

    def image(at: int, n: int):
        return None
    return cd.Program(normal, SOURCE, CALLING, BASE, image, constants or (lambda a, w: None))


def canonical(p: cd.Program, rva: int = RVA) -> cd.Candidate:
    x = cd.Generator(p, BASE + rva).make(cd.Choice(), set())
    assert x is not None
    assert x.verdict.agree, x.verdict
    return x


def rr(code, d, s):
    return I.create_reg_reg(code, d, s)


def adder(rva=RVA) -> Asm:
    """a1->member8 + a2"""
    return Asm(rva)(I.create_reg_mem(C.MOV_R32_RM32, R.EAX, mem(R.RCX, 8)))(rr(C.ADD_R32_RM32, R.EAX, R.EDX))(T.ret())


def branchy() -> Asm:
    """if (a1 == 0 || a2 <= 0) return false; a1->member8 -= a2; other(a1, a2); return true"""
    a = Asm()
    a(T.sub_rsp(40))
    a(rr(C.TEST_RM64_R64, R.RCX, R.RCX))
    a.branch(C.JE_REL32_64, "no")
    a(rr(C.TEST_RM32_R32, R.EDX, R.EDX))
    a.branch(C.JLE_REL32_64, "no")
    a(I.create_mem_reg(C.SUB_RM32_R32, mem(R.RCX, 8), R.EDX))
    a.branch(C.CALL_REL32_64, OTHER)
    a(I.create_reg_i32(C.MOV_R8_IMM8, R.AL, 1))
    a(T.add_rsp(40))(T.ret())
    a.label("no")
    a(rr(C.XOR_R8_RM8, R.AL, R.AL))
    a(T.add_rsp(40))(T.ret())
    return a


def stores(rva=OTHER) -> Asm:
    return Asm(rva)(I.create_mem_reg(C.MOV_RM32_R32, mem(R.RCX, 4), R.EDX))(T.ret())


def walker() -> Asm:
    """while (a1) { n++; a1 = a1->member0; } return n"""
    a = Asm()
    a(rr(C.XOR_R32_RM32, R.EAX, R.EAX))
    a(rr(C.TEST_RM64_R64, R.RCX, R.RCX))
    a.branch(C.JE_REL32_64, "out")
    a.label("again")
    a(T.load(R.RCX, mem(R.RCX)))
    a(I.create_reg_i32(C.ADD_RM32_IMM32, R.EAX, 1))
    a(rr(C.TEST_RM64_R64, R.RCX, R.RCX))
    a.branch(C.JNE_REL32_64, "again")
    a.label("out")
    a(T.ret())
    return a


# ------------------------------------------------------------------------------------ signatures and types

def test_parameters_results_and_members_are_read_from_the_code():
    x = canonical(program(adder()))
    assert x.signature.params == (Slot("i", 64), Slot("i", 32)) and x.signature.result == Slot("i", 32)
    assert "unsigned char unknown0[0x8];\n" in x.unit.text and re.search(r"return arg1->member8 \+ arg2;", x.unit.text)
    assert x.unit.name == f"Function{RVA:X}"


def test_a_parameter_nobody_reads_is_none_and_one_before_it_is_kept():
    x = canonical(program(Asm()(rr(C.MOV_R32_RM32, R.EAX, R.R8D))(T.ret())))
    assert len(x.signature.params) == 3


def test_a_callee_s_signature_comes_from_its_own_code():
    p = program(branchy(), stores())
    x = canonical(p)
    s = p.signature(BASE + OTHER)
    assert s.params == (Slot("i", 64), Slot("i", 32)) and s.result is None
    assert x.unit.callees == ((f"Function{OTHER:X}", BASE + OTHER),) and x.unit.text.startswith("bool ") is False
    assert re.search(rf"bool Function{RVA:X}\(Class1\* arg1, int arg2\)", x.unit.text)
    assert "member8" in x.unit.text and "member4" not in x.unit.text    # a class holds what this function accesses, no more


def test_a_callee_that_cannot_be_told_is_a_refusal():
    with pytest.raises(NotReconstructed):
        canonical(program(branchy()))


def test_a_function_that_calls_itself():
    """f(p): p ? f(p->member0) + 1 : 0"""
    a = Asm()
    a(rr(C.TEST_RM64_R64, R.RCX, R.RCX))
    a.branch(C.JNE_REL32_64, "some")
    a(rr(C.XOR_R32_RM32, R.EAX, R.EAX))(T.ret())
    a.label("some")
    a(T.sub_rsp(40))(T.load(R.RCX, mem(R.RCX)))
    a.branch(C.CALL_REL32_64, RVA)
    a(I.create_reg_i32(C.ADD_RM32_IMM32, R.EAX, 1))(T.add_rsp(40))(T.ret())
    x = canonical(program(a))
    assert x.signature.params == (Slot("i", 64),) and x.signature.result == Slot("i", 32)
    assert "Class1* member0;" in x.unit.text and f"Function{RVA:X}(arg1->member0)" in x.unit.text and not x.unit.callees


def test_two_functions_that_call_each_other_have_signatures():
    def one(rva, to):
        a = Asm(rva)
        a(rr(C.TEST_RM64_R64, R.RCX, R.RCX))
        a.branch(C.JNE_REL32_64, "some")
        a(rr(C.XOR_R32_RM32, R.EAX, R.EAX))(T.ret())
        a.label("some")
        a(T.sub_rsp(40))(T.load(R.RCX, mem(R.RCX, 8)))
        a.branch(C.CALL_REL32_64, to)
        a(I.create_reg_i32(C.ADD_RM32_IMM32, R.EAX, 3))(T.add_rsp(40))(T.ret())
        return a
    for first in (RVA, OTHER):
        p = program(one(RVA, OTHER), one(OTHER, RVA))
        assert p.signature(BASE + first).params == (Slot("i", 64),)
        assert p.signature(BASE + RVA) == p.signature(BASE + OTHER)
        canonical(p)


def test_a_pointer_to_its_own_kind_is_a_class_and_not_endless():
    x = canonical(program(Asm()(T.load(R.RAX, mem(R.RCX)))(T.load(R.RAX, mem(R.RAX)))(I.create_mem_reg(C.MOV_RM64_R64, mem(R.RCX), R.RAX))(T.ret())))
    assert "Class1* member0;" in x.unit.text


def test_accesses_that_overlap_are_refused():
    a = Asm()(I.create_reg_mem(C.MOV_R32_RM32, R.EAX, mem(R.RCX, 8)))(I.create_reg_mem(C.ADD_R64_RM64, R.RAX, mem(R.RCX, 8)))(T.ret())
    with pytest.raises(NotReconstructed, match="LAYOUT_CONFLICT|TYPES|CONFLICT"):
        canonical(program(a))


def test_a_location_nobody_set_is_refused():
    with pytest.raises(NotReconstructed, match="READS_A_LOCATION_NOBODY_SET"):
        canonical(program(Asm()(T.store(mem(R.RCX), R.R10))(T.ret())))


def test_open_signs_are_unsigned_in_sums_and_can_be_taken_the_other_way():
    p = program(adder())
    g = cd.Generator(p, BASE + RVA)
    a = g.make(cd.Choice(), set())
    assert g.open >= 1 and "no-signed-overflow" not in a.assumptions and "unsigned int" in a.unit.text
    b = g.make(cd.Choice(flips=tuple(range(g.open))), set())
    assert "no-signed-overflow" in b.assumptions and b.digest != a.digest


# ------------------------------------------------------------------------------------ form

def test_loops_and_short_circuits_are_written_as_such():
    x = canonical(program(walker()))
    assert re.search(r"while \(arg1 != nullptr\) \{", x.unit.text) and "goto" not in x.unit.text
    y = canonical(program(branchy(), stores()))
    assert "&&" in y.unit.text and "arg1 != nullptr" in y.unit.text and "arg2 > 0" in y.unit.text and "goto" not in y.unit.text


def test_rotation_is_undone_only_when_asked_and_both_forms_do_the_same():
    g = cd.Generator(program(walker()), BASE + RVA)
    a, b = g.make(cd.Choice(), set()), g.make(cd.Choice(unrotate=False), set())
    assert "do {" not in a.unit.text and "do {" in b.unit.text and a.verdict.agree and b.verdict.agree


def test_a_loop_whose_guard_tests_something_else_stays_as_it_is():
    """if (a2) do { n++; a1 = a1->member0; } while (a1); return n"""
    a = Asm()
    a(rr(C.XOR_R32_RM32, R.EAX, R.EAX))
    a(rr(C.TEST_RM64_R64, R.RDX, R.RDX))
    a.branch(C.JE_REL32_64, "out")
    a.label("again")
    a(T.load(R.RCX, mem(R.RCX)))
    a(I.create_reg_i32(C.ADD_RM32_IMM32, R.EAX, 1))
    a(rr(C.TEST_RM64_R64, R.RCX, R.RCX))
    a.branch(C.JNE_REL32_64, "again")
    a.label("out")
    a(T.ret())
    x = canonical(program(a))
    assert "do {" in x.unit.text and "arg2" in x.unit.text


def test_memory_is_read_again_only_where_nothing_can_have_changed_it():
    def fn(between=None):
        """x = a1->member8; if (x > a2) [between] a1->member16 = x"""
        a = Asm()(I.create_reg_mem(C.MOV_R32_RM32, R.EAX, mem(R.RCX, 8)))(rr(C.CMP_R32_RM32, R.EAX, R.EDX))
        a.branch(C.JLE_REL32_64, "out")
        if between is not None:
            a(between)
        a(I.create_mem_reg(C.MOV_RM32_R32, mem(R.RCX, 16), R.EAX))
        return a.label("out")(T.ret())
    again = cd.Choice(read_again=True)
    void = 1  # the result is left over from the comparison's operand

    def text(a):
        g = cd.Generator(program(a), BASE + RVA)
        k = next(j for j, (s, _e) in enumerate(g.results) if s is None) if void else 0
        x = g.make(cd.Choice(result=k, read_again=True), set())
        assert x.verdict.agree
        return x.unit.text
    assert again.changes() == ("read-again",)
    assert text(fn()).count("member8") == 3                  # the declaration and both uses
    assert text(fn(I.create_mem_reg(C.MOV_RM32_R32, mem(R.RCX, 8), R.EDX))).count("member8") == 3  # the declaration, one read, the store


def test_comparisons_written_from_the_other_side():
    i = ty.Int(32, True)
    x, y = A.Local(0, i), A.Local(1, i)
    s = (A.Return(A.Binary("<", x, A.Binary("+", y, A.Num(1, i), i), ty.BOOL)), A.Return(A.Binary(">=", x, y, ty.BOOL)), A.Return(A.Binary("<", x, A.Num(1, i), ty.BOOL)))
    assert [z.value.op for z in mirrored(s, (-1,))] == [">", "<=", "<"]
    assert [z.value.op for z in mirrored(s, (1,))] == ["<", "<=", "<"]
    assert mirrored(mirrored(s, (-1,)), (-1,)) == s


def test_the_negation_of_a_floating_comparison_is_not_the_opposite_comparison():
    f = ty.Float(32)
    e = A.Binary("<", A.Local(0, f), A.Local(1, f), ty.BOOL)
    assert negate(e) == A.Unary("!", e, ty.BOOL) and negate(negate(e)) == e
    i = ty.Int(32, True)
    assert negate(A.Binary("<", A.Local(0, i), A.Local(1, i), ty.BOOL)).op == ">="


# ------------------------------------------------------------------------------------ text

@pytest.mark.parametrize("bits,width,text", [(0x3F800000, 32, "1.0f"), (0x3E800000, 32, "0.25f"), (0x7F7FFFFF, 32, "3.4028235e+38f"), (0x00000001, 32, "1e-45f"), (0x80000000, 32, "-0.0f"),
                                             (0x3FB999999999999A, 64, "0.1"), (0x4340000000000000, 64, "9007199254740992.0")])
def test_floating_literals_are_exact(bits, width, text):
    import struct

    assert cpp.float_text(bits, width) == text
    back = struct.unpack("<I", struct.pack("<f", float(text.rstrip("f"))))[0] if width == 32 else struct.unpack("<Q", struct.pack("<d", float(text)))[0]
    assert back == bits


def test_every_float_gives_itself_back():
    import random
    import struct

    r = random.Random(5)
    for _ in range(20000):
        b = r.getrandbits(32)
        v = struct.unpack("<f", struct.pack("<I", b))[0]
        if v != v or abs(v) == float("inf"):
            with pytest.raises(NotReconstructed):
                cpp.float_text(b, 32)
        else:
            assert struct.unpack("<I", struct.pack("<f", float(cpp.float_text(b, 32).rstrip("f"))))[0] == b


def test_integer_literals_and_parentheses():
    i, u, q = ty.Int(32, True), ty.Int(32, False), ty.Int(64, True)
    e = cpp.Emitter.__new__(cpp.Emitter)
    e.locals = {0: "a", 1: "b", 2: "c"}
    a, b, c = (A.Local(k, i) for k in range(3))
    assert e.e(A.Num(0x80000000, i)) == "(-2147483647 - 1)" and e.e(A.Num(0xFFFFFFFF, i)) == "-1" and e.e(A.Num(0xFFFFFFFF, u)) == "4294967295u"
    assert e.e(A.Num(1 << 40, q)) == "1099511627776ll" and e.e(A.Num(-(1 << 31) & (1 << 64) - 1, q)) == "-2147483648ll" and e.e(A.Num((1 << 64) - 1, q)) == "-1"
    assert e.e(A.Num((1 << 64) - 1, ty.Int(64, False))) == "18446744073709551615ull" and e.e(A.Num(0xFFFF, ty.Int(16, True))) == "-1"
    assert e.e(A.Binary("<<", A.Num(1, q), a, q)) == "1ll << a" and e.e(A.Binary("<<", A.Num(1, i), a, i)) == "1 << a" and e.e(A.Binary(">>", A.Num(7, u), a, u)) == "7u >> a"
    assert e.e(A.Binary("-", a, A.Binary("-", b, c, i), i)) == "a - (b - c)"
    assert e.e(A.Binary("-", A.Binary("-", a, b, i), c, i)) == "a - b - c"
    assert e.e(A.Binary("*", A.Binary("+", a, b, i), c, i)) == "(a + b) * c"
    assert e.e(A.Unary("-", A.Unary("-", a, i), i)) == "-(-a)"
    assert e.e(A.Binary("&", a, A.Binary("==", b, c, ty.BOOL), i)) == "a & (b == c)"


def test_diagnostics():
    out = "unit.cpp\r\nunit.cpp(3): error C2065: 'x': undeclared identifier\r\nC:\\a\\unit.cpp(12): fatal error C1075: no match\r\ncl : Command line error D8021 : invalid\r\nunit.cpp(4): warning C4101: w\r\n"
    d = cl.diagnostics(out)
    assert [(x.code, x.file, x.line) for x in d] == [("C2065", "unit.cpp", 3), ("C1075", "unit.cpp", 12), ("D8021", "", 0)]
    assert len(cl.diagnostics(out, limit=1)) == 1


# ------------------------------------------------------------------------------------ the execution check

def mutants(body: A.Body):
    """Bodies with one thing changed."""
    ops = {"+": "-", "-": "+", "<": "<=", "<=": "<", ">": ">=", ">=": ">", "==": "!=", "!=": "==", "&&": "||", "||": "&&", "*": "+", "&": "|", "|": "&", "^": "&"}

    def variants(x):
        if isinstance(x, A.Binary) and x.op in ops:
            yield A.Binary(ops[x.op], x.left, x.right, x.type)
        if isinstance(x, A.Num) and isinstance(x.type, (ty.Int, ty.Bool)):
            yield A.Num(x.value ^ 1, x.type)
        if isinstance(x, A.Field):
            yield A.Field(x.base, x.offset + 4, x.type)
        if isinstance(x, A.If) and x.other == ():
            yield A.If(x.cond, (), ())
        for name in x.__dataclass_fields__:
            v = getattr(x, name)
            for j, y in enumerate(v if isinstance(v, tuple) else (v,)):
                if not isinstance(y, A.NODES):
                    continue
                for z in variants(y):
                    new = (*v[:j], z, *v[j + 1:]) if isinstance(v, tuple) else z
                    yield type(x)(**{**{f: getattr(x, f) for f in x.__dataclass_fields__}, name: new})
    for j, s in enumerate(body.stmts):
        for z in variants(s):
            yield A.Body(body.params, body.result, (*body.stmts[:j], z, *body.stmts[j + 1:]))
        if s != A.Return(None):
            yield A.Body(body.params, body.result, (*body.stmts[:j], *body.stmts[j + 1:]))


@pytest.mark.parametrize("fns", [(adder(),), (branchy(), stores()), (walker(),), (stores(RVA),)], ids=["adder", "branchy", "walker", "stores"])
def test_the_execution_check_notices_what_is_wrong(fns):
    p = program(*fns)
    g = cd.Generator(p, BASE + RVA)
    x = g.make(cd.Choice(), set())
    f, sig, callees = g.lowered(cd.Choice())
    t = ty.Types(f, sig, callees, own=BASE + RVA)
    noticed = total = 0
    for b in itertools.islice(mutants(x.body), 200):
        total += 1
        try:
            noticed += not ev.compare(b, g.fn, SOURCE, sig, callees, cd.size_of(t), p.image, 48).agree
        except (KeyError, AssertionError, ty.NotReconstructed):
            noticed += 1        # it reads a variable that is not there
    assert total >= 2 and noticed == total, (noticed, total)


def test_generated_functions_give_candidates_that_do_the_same_or_a_reason():
    made = refused = 0
    for seed in range(160):
        an = L.analysed(L.program(seed, escapes=False, vectors=seed % 2 == 0, calls=False))
        if an.frame is None:
            continue
        fn = pg.to_ir(an, BASE)
        n = validate.require(validate.admit(passes.normalise(fn, CALLING), CALLING))
        p = cd.Program(lambda at, n=n: n, SOURCE, CALLING, BASE, lambda a, k: None, lambda a, w: None)
        try:
            r = next(cd.Generator(p, BASE + RVA).stages())
        except NotReconstructed:
            refused += 1
            continue
        assert all(x.verdict.agree for x in r.candidates) and not set(r.disagreed) - {"no run ended"}, (seed, r.disagreed)
        made += bool(r.candidates)
        refused += not r.candidates
    assert made >= 20 and refused >= 20


def test_generation_is_deterministic():
    def once():
        out = []
        for r in cd.Generator(program(branchy(), stores()), BASE + RVA).stages():
            out = [(x.digest, x.unit.text, x.choice.changes()) for x in r.candidates]
        return out
    a = once()
    assert a == once() and len(a) > 3 and len({d for d, _t, _c in a}) == len(a) and a[0][2] == ()


# ------------------------------------------------------------------------------------ the search

class Shop:
    def __init__(self, distances, passes=True, reason="all-checks-passed"):
        self.distances, self.passes, self.reason = distances, passes, reason
        self.judged = []
        self.verified = 0

    def judge(self, candidates):
        out = []
        for c in candidates:
            d = self.distances(len(self.judged))
            self.judged.append(c)
            out.append(search.Judged(None, 0, ("C2065",)) if d is None else search.Judged(f"key{len(self.judged)}", d))
        return out

    def verify(self, c):
        self.verified += 1
        return self.passes, self.reason


def test_the_first_exact_candidate_is_verified_and_the_search_stops():
    shop = Shop(lambda k: 0 if k in (1, 2) else 5)
    r = search.reconstruct(program(branchy(), stores()), BASE + RVA, shop)
    assert r.state == search.BYTE_MATCHED and r.candidate is shop.judged[1] and shop.verified == 1 and r.counters["candidates"] == len(shop.judged)
    full = Shop(lambda k: 5)
    search.reconstruct(program(branchy(), stores()), BASE + RVA, full)
    assert len(full.judged) > len(shop.judged)      # the combinations are made only when needed


def test_only_the_verifier_makes_a_match():
    r = search.reconstruct(program(branchy(), stores()), BASE + RVA, Shop(lambda k: 0, passes=False, reason="unresolved-relocation"))
    assert r.state == search.COMPILED and r.reason == "unresolved-relocation" and r.counters["verified"] > 1
    r = search.reconstruct(program(branchy(), stores()), BASE + RVA, Shop(lambda k: 9 - min(k, 3)))
    assert r.state == search.COMPILED and r.reason == "NO_MATCH" and r.nearest == 6 and r.counters["verified"] == 0
    r = search.reconstruct(program(branchy(), stores()), BASE + RVA, Shop(lambda k: None))
    assert r.state == search.SEMANTICALLY_VALID and r.reason == "DOES_NOT_COMPILE" and r.errors["C2065"] == r.counters["candidates"]


def test_a_function_without_candidates_has_a_reason():
    r = search.reconstruct(program(branchy()), BASE + RVA, Shop(lambda k: 0))
    assert r.state == search.NONE and re.fullmatch(r"[A-Z_]+", r.reason) and r.candidate is None
    assert search.reconstruct(program(), BASE + RVA, Shop(lambda k: 0)).reason == "NO_SUCH_FUNCTION"


def test_what_differs_from_the_function_is_no_candidate(monkeypatch):
    real = cd.structure

    def broken(flow, style=Style()):
        b = real(flow, style)
        return A.Body(b.params, b.result, b.stmts[:-1] + (A.Return(A.Num(77, b.result)),), b.assumptions)
    monkeypatch.setattr(cd, "structure", broken)
    shop = Shop(lambda k: 0)
    r = search.reconstruct(program(adder()), BASE + RVA, shop)
    assert r.state == search.NONE and r.reason == "NOT_EQUIVALENT" and not shop.judged and r.disagreed


# ------------------------------------------------------------------------------------ budgets and frontiers (D3)

class Oracle:
    """A workshop whose answers depend on the candidate only, as a compiler's do: a resumed search may ask in another order."""

    def __init__(self, match=None, unknown=0):
        self.match, self.unknown = match, unknown
        self.asked: list[str] = []
        self.verified: list[str] = []

    def judge(self, candidates):
        out = []
        for c in candidates:
            self.asked.append(c.digest)
            d = 0 if c.choice.changes() == self.match else 1 + len(c.choice.changes())
            out.append(search.Judged("k" + c.digest, d, (), self.unknown))
        return out

    def verify(self, c):
        self.verified.append(c.digest)
        return (c.choice.changes() == self.match, "all-checks-passed" if c.choice.changes() == self.match else "instruction-mismatch")


def multiplier() -> Asm:
    """a1 * 10, as the compiler writes it: proved to be a multiplication by the solver"""
    return Asm()(I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RCX, 0, R.RCX, 4)))(rr(C.ADD_R32_RM32, R.EAX, R.EAX))(T.ret())


def used(kind, prog, shop=None, **limits):
    from recon.core.budget import Budget

    r = search.reconstruct(prog(), BASE + RVA, shop or Oracle(), Budget.of(limits))
    return r, r.counters[f"budget_{kind}"]


@pytest.mark.parametrize("kind", ["candidates", "compiles", "expansions", "irNodes", "solverUnits"])
def test_each_budget_bounds_its_own_work(kind):
    prog = (lambda: program(multiplier())) if kind == "solverUnits" else (lambda: program(branchy(), stores()))
    full, need = used(kind, prog)
    assert full.reason != search.BUDGET_EXHAUSTED and need > 1, (kind, need, full.reason)
    for limit in (0, 1):
        r, n = used(kind, prog, **{kind: limit})
        assert n <= limit and r.counters[f"limit_{kind}"] == limit
        assert r.reason == search.BUDGET_EXHAUSTED and r.exhausted == kind and r.frontier is not None, (kind, limit, r.reason)
    if kind == "compiles":
        shop = Oracle()
        r, n = used(kind, prog, shop, compiles=1)
        assert len(shop.asked) + len(shop.verified) == n == 1


def test_a_budget_that_runs_out_after_the_match_does_not_hide_it():
    shop = Oracle(match=())
    r, _n = used("candidates", lambda: program(branchy(), stores()), shop, candidates=1)
    assert r.state == search.BYTE_MATCHED and r.counters["budget_candidates"] == 1


def made() -> list:
    """The changes of each candidate of branchy(), in the generator's order."""
    out = []
    for r in cd.Generator(program(branchy(), stores()), BASE + RVA).stages():
        out = [x.choice.changes() for x in r.candidates]
    return out


@pytest.mark.parametrize("kind,limit", [("compiles", 1), ("compiles", 3), ("candidates", 2), ("expansions", 3), ("expansions", 9)])
@pytest.mark.parametrize("which", [None, -1, 1])
def test_a_resumed_search_equals_an_uninterrupted_one(kind, limit, which):
    import json

    from recon.core.budget import Budget

    match = None if which is None else made()[which]

    def run(budget, frontier=None, shop=None):
        return search.reconstruct(program(branchy(), stores()), BASE + RVA, shop or Oracle(match), budget, frontier)
    whole = run(Budget.of(None))
    cut = run(Budget.of({kind: limit}))
    if cut.state == search.BYTE_MATCHED:         # found before the budget ran out: the same match
        assert whole.state == search.BYTE_MATCHED and cut.candidate.digest == whole.candidate.digest
        return
    assert cut.reason == search.BUDGET_EXHAUSTED and cut.exhausted == kind
    # the frontier goes through its file form, as it does between processes
    frontier = search.Frontier.from_json(json.loads(json.dumps(cut.frontier.to_json())))
    shop = Oracle(match)
    resumed = run(Budget.of(None), frontier, shop)
    assert {k: v for k, v in vars(resumed).items() if k != "candidate"} == {k: v for k, v in vars(whole).items() if k != "candidate"}
    assert (resumed.candidate and resumed.candidate.digest) == (whole.candidate and whole.candidate.digest)
    assert not set(shop.asked) & set(frontier.judged)           # what the frontier knew was not compiled again
    assert not set(shop.verified) & set(frontier.verified)


def test_a_frontier_of_another_function_is_refused():
    with pytest.raises(ValueError):
        search.reconstruct(program(branchy(), stores()), BASE + RVA, Oracle(), None, search.Frontier(BASE + RVA + 1))


# ------------------------------------------------------------------------------------ unknown references (D1)

def test_candidates_whose_only_open_points_are_unnamed_references_go_to_the_verifier_in_order():
    shop = Oracle(match=made()[-1], unknown=1)
    r = search.reconstruct(program(branchy(), stores()), BASE + RVA, shop)
    assert r.state == search.BYTE_MATCHED and r.counters["unknown_references"] >= 1
    assert shop.verified and len(shop.verified) == r.counters["verified"]


def test_every_candidate_with_no_known_difference_is_verified_until_one_passes():
    class Every(Oracle):
        def judge(self, candidates):
            self.asked += [c.digest for c in candidates]
            return [search.Judged("k" + c.digest, 0, (), len(c.choice.changes()) % 2) for c in candidates]
    shop = Every(match=made()[-1])
    r = search.reconstruct(program(branchy(), stores()), BASE + RVA, shop)
    assert r.state == search.BYTE_MATCHED and len(shop.verified) == r.counters["verified"] == len(made())
    # those without unnamed references first, then by the number of changes, the same every time
    again = Every(match=shop.match)
    search.reconstruct(program(branchy(), stores()), BASE + RVA, again)
    assert again.verified == shop.verified


# ------------------------------------------------------------------------------------ callee depth (D2)

def chain(depth: int) -> list:
    """depth functions, each passing its argument to the next and returning what it returns; the last returns it plus 1"""
    fns = []
    for k in range(depth):
        rva = RVA + 0x100 * k
        if k == depth - 1:
            fns.append(Asm(rva)(I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RCX, 1)))(T.ret()))
            continue
        a = Asm(rva)
        a(T.sub_rsp(40))
        a.branch(C.CALL_REL32_64, rva + 0x100)
        a(T.add_rsp(40))(T.ret())
        fns.append(a)
    return fns


@pytest.mark.parametrize("depth", [3, 6, 12])
def test_a_chain_of_callees_deeper_than_a_constant_has_signatures(depth):
    from recon.core.budget import Budget

    p = program(*chain(depth))
    x = canonical(p)
    assert re.search(rf"Function{RVA + 0x100:X}\(arg1\);", x.unit.text) and x.signature.params    # the callee's signature is known
    # how far it looks is the irNodes budget's to say: too little, and the search says so
    r = search.reconstruct(program(*chain(depth)), BASE + RVA, Oracle(), Budget.of({"irNodes": 3 * depth // 2}))
    assert r.reason == search.BUDGET_EXHAUSTED and r.exhausted == "irNodes"


def _reads_rip(code, reg):
    """`reg <- [rip -> BASE + 0x5000]; ret`"""
    return Asm(RVA)(I.create_reg_mem(code, reg, T.ix.MemoryOperand(R.RIP, R.NONE, 1, BASE + 0x5000, 8)))(T.ret())


def test_an_integer_read_of_read_only_memory_stays_a_read_and_a_float_one_is_its_value():
    """D-056: the compiler writes an integer constant as an immediate and a float as a read of read-only data, so only a
    float folds; an integer the program reads from such memory is a read of an object, as it was compiled."""
    ro = lambda a, w: 7 if a == BASE + 0x5000 and w == 32 else None       # noqa: E731
    i = canonical(program(_reads_rip(C.MOV_R32_RM32, R.EAX), constants=ro)).body
    assert any(isinstance(x, A.Global) for s in i.stmts for x in A.walk(s))
    assert not any(isinstance(x, A.Num) and x.value == 7 for s in i.stmts for x in A.walk(s))
    one = lambda a, w: 0x3F80_0000 if a == BASE + 0x5000 and w == 32 else None   # noqa: E731
    # the fixture's image has no bytes there, so the check cannot agree; the tree is what this is about
    f = cd.Generator(program(_reads_rip(C.MOVSS_XMM_XMMM32, R.XMM0), constants=one), BASE + RVA).make(cd.Choice(), set()).body
    assert f.stmts == (A.Return(A.Num(0x3F80_0000, ty.Float(32))),)
