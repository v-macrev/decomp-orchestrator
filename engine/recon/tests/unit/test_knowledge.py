# SPDX-License-Identifier: AGPL-3.0-or-later
"""What the engine learns is kept and reused: callee analysis by strongly connected components, the persistent store,
resumption after a budget runs out or the process is killed, convergence that does not depend on the order of work,
leases between workers, a bounded memory, invalidation that follows dependencies, and callers' evidence as alternatives."""
import hashlib
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

import asm as T  # noqa: E402
from asm import BASE, RVA, Asm, C, I, R, mem  # noqa: E402

from recon.adapters.x64_msvc import program as pg  # noqa: E402
from recon.adapters.x64_msvc.abi import CALLING, SOURCE  # noqa: E402
from recon.core import knowledge as kn  # noqa: E402
from recon.core.budget import Budget, BudgetExhausted, active  # noqa: E402
from recon.core.inference.signature import INT, NotReconstructed, Signature, Slot  # noqa: E402
from recon.core.ir import passes, validate  # noqa: E402
from recon.core.synthesis import candidates as cd  # noqa: E402

TESTS = Path(__file__).resolve().parents[1]


def program(*fns: Asm, store=None, declared=None, universe: bool = False, slot=None) -> cd.Program:
    """Functions at their own RVAs; a function's key digests its bytes, as an adapter's digests its extent of the image."""
    code = {f.rva: f for f in fns}

    def normal(at: int):
        f = code.get(at - BASE)
        if f is None:
            raise NotReconstructed("NO_SUCH_FUNCTION")
        a = pg.analyse(f.assemble()[0], f.rva, BASE, None)
        assert isinstance(a, pg.Analysis), a
        return validate.require(validate.admit(passes.normalise(pg.to_ir(a, BASE), CALLING), CALLING))

    def key(at: int):
        f = code.get(at - BASE)
        return None if f is None else f"{f.rva:x}:" + hashlib.sha256(f.assemble()[0]).hexdigest()[:16]

    return cd.Program(normal, SOURCE, CALLING, BASE, lambda at, n: None, lambda a, w: None,
                      declared or (lambda at: None), store=store, key=key,
                      universe=(lambda: [BASE + r for r in code]) if universe else None, slot=slot or (lambda at: None))


def chain(depth: int, step: int = 0x100) -> list[Asm]:
    """depth functions, each passing its argument to the next and returning what it returns; the last returns it plus 1"""
    fns = []
    for k in range(depth):
        rva = RVA + step * k
        if k == depth - 1:
            fns.append(Asm(rva)(I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RCX, 1)))(T.ret()))
            continue
        a = Asm(rva)
        a(T.sub_rsp(40))
        a.branch(C.CALL_REL32_64, rva + step)
        a(T.add_rsp(40))(T.ret())
        fns.append(a)
    return fns


def mutual(rva: int, to: int, add: int = 3) -> Asm:
    """f(p): p ? g(p->member1) + add : 0, g the function at `to`"""
    a = Asm(rva)
    a(I.create_reg_reg(C.TEST_RM64_R64, R.RCX, R.RCX))
    a.branch(C.JNE_REL32_64, "some")
    a(I.create_reg_reg(C.XOR_R32_RM32, R.EAX, R.EAX))(T.ret())
    a.label("some")
    a(T.sub_rsp(40))(T.load(R.RCX, mem(R.RCX, 8)))
    a.branch(C.CALL_REL32_64, to)
    a(I.create_reg_i32(C.ADD_RM32_IMM32, R.EAX, add))(T.add_rsp(40))(T.ret())
    return a


def ring(n: int) -> list[Asm]:
    """n functions calling each other in a ring: one component of n members"""
    return [mutual(RVA + 0x100 * k, RVA + 0x100 * ((k + 1) % n), k + 1) for k in range(n)]


def signatures(p: cd.Program, fns) -> list:
    return [p.signature(BASE + f.rva) for f in fns]


# ------------------------------------------------------------------------------------ the store

def test_every_kind_of_fact_round_trips_through_both_stores(tmp_path):
    p = program(*chain(3))
    fn = p.normal(BASE + RVA)
    sig = Signature((Slot("i", 64), Slot("f", 32)), Slot("i", 32, "signed"), (("result", "INFERRED"),))
    facts = [("normal", fn), ("normal", "SOME_REFUSAL"), ("signature", sig), ("signature", None), ("callees", [1, 2]),
             ("alternatives", (sig, Signature((), None))), ("fixpoint", ({BASE: sig, BASE + 1: None}, [(sig, None)]))]
    for store in (kn.MemoryStore(), kn.SqliteStore(tmp_path / "k.db", "ns")):
        for i, (kind, value) in enumerate(facts):
            assert store.put(kind, str(i), value)
            got = store.get(kind, str(i))
            assert (got.digest() == value.digest()) if kind == "normal" and not isinstance(value, str) else got == value
        assert store.get("signature", "absent") is kn.MISSING
        assert not store.put("signature", "2", None)        # a fact is written once


def test_a_namespace_never_answers_for_another(tmp_path):
    a, b = kn.SqliteStore(tmp_path / "k.db", "one"), kn.SqliteStore(tmp_path / "k.db", "two")
    a.put("signature", "x", None)
    assert b.get("signature", "x") is kn.MISSING and a.get("signature", "x") is None


def test_the_code_digest_follows_the_engine_s_code_and_nothing_else():
    assert kn.code_digest() == kn.code_digest() and len(kn.code_digest()) == 64
    assert kn.code_digest(("core",)) != kn.code_digest(("core", "adapters/x64_msvc"))


def test_a_transaction_keeps_everything_or_nothing(tmp_path):
    s = kn.SqliteStore(tmp_path / "k.db", "ns")
    with pytest.raises(RuntimeError):
        with s.transaction():
            s.put("callees", "a", [1])
            s.put("callees", "b", [2])
            raise RuntimeError("interrupted")
    assert s.count("callees") == 0
    with s.transaction():
        s.put("callees", "a", [1])
        s.put("callees", "b", [2])
    assert s.count("callees") == 2


# ------------------------------------------------------------------------------------ reuse

@pytest.mark.parametrize("persistent", [False, True])
def test_shared_callees_are_analysed_once_and_reused_by_every_later_program(persistent, tmp_path):
    fns = chain(8)
    store = kn.SqliteStore(tmp_path / "k.db", "ns") if persistent else kn.MemoryStore()
    first = program(*fns, store=store)
    want = signatures(first, fns)
    assert first.stats["normal_computed"] == 8 and first.stats["signature_computed"] == 8
    later = program(*fns, store=kn.SqliteStore(tmp_path / "k.db", "ns") if persistent else store)
    assert signatures(later, fns) == want
    assert later.stats["normal_computed"] == 0 and later.stats["signature_computed"] == 0
    assert later.stats["signature_loaded"] == 8 and later.stats["redundant"] == 0
    assert first.stats["nested_solve"] == 0 and later.stats["nested_solve"] == 0     # callees solved before callers, always


def test_a_search_on_a_warm_store_finds_what_a_cold_one_does():
    from recon.core.synthesis import search
    from test_source import Oracle

    fns = chain(6)
    store = kn.MemoryStore()
    cold = search.reconstruct(program(*fns, store=store), BASE + RVA, Oracle())
    p = program(*fns, store=store)
    warm = search.reconstruct(p, BASE + RVA, Oracle())
    assert (warm.state, warm.reason) == (cold.state, cold.reason)
    assert warm.candidate is not None and warm.candidate.unit.text == cold.candidate.unit.text
    assert p.stats["normal_computed"] == 0


# ------------------------------------------------------------------------------------ resumption

def test_a_budget_that_runs_out_suspends_and_a_larger_one_resumes_without_doing_it_again():
    fns = chain(40)
    store = kn.MemoryStore()
    cold = program(*fns)
    want = signatures(cold, fns)
    done, computed, level = 0, 0, 1
    while True:
        p = program(*fns, store=store)
        try:
            with active(Budget.of({"irNodes": 8 * level})):
                got = signatures(p, fns)
        except BudgetExhausted as e:
            assert e.kind == "irNodes"
            computed += p.stats["normal_computed"]
            now = store.count("signature")
            assert now >= done                        # what was solved stays solved, and each level adds to it
            done, level = now, level * 2
            continue
        computed += p.stats["normal_computed"]
        break
    assert got == want and level > 1
    assert computed == cold.stats["normal_computed"] == 40      # every normal form analysed once, over all the levels


def test_a_cycle_interrupted_halfway_resumes_from_its_last_round_and_ends_as_an_uninterrupted_one():
    fns = ring(6)
    want = signatures(program(*fns), fns)
    store = kn.MemoryStore()
    interrupted = 0
    for level in range(1, 200):
        p = program(*fns, store=store)
        try:
            with active(Budget.of({"irNodes": 30 + 10 * level})):
                got = signatures(p, fns)
            break
        except BudgetExhausted:
            interrupted += 1
    assert interrupted and got == want and all(s is not None for s in got)


CRASH = textwrap.dedent("""
    import sys, time
    sys.path[:0] = [{tests!r}, {unit!r}, {root!r}]
    import test_knowledge as tk
    from recon.core import knowledge as kn
    fns = tk.chain({depth})
    p = tk.program(*fns, store=kn.SqliteStore({db!r}, "ns"))
    slow = p._normal
    def normal(at):
        time.sleep(0.05)
        return slow(at)
    p._normal = normal
    tk.signatures(p, fns)
    print("finished")
""")


def test_a_process_killed_while_it_writes_loses_nothing_it_had_committed(tmp_path):
    depth, db = 60, tmp_path / "k.db"
    code = CRASH.format(tests=str(TESTS), unit=str(TESTS / "unit"), root=str(TESTS.parent), depth=depth, db=str(db))
    proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if db.is_file() and kn.SqliteStore(db, "ns").count("normal") >= 10:
                break
            time.sleep(0.05)
        proc.kill()                                  # no clean-up, no commit of what was in hand
    finally:
        proc.wait(30)
    s = kn.SqliteStore(db, "ns")
    assert s.check() == "ok"
    kept = s.count("normal")
    assert 10 <= kept < depth
    fns = chain(depth)
    p = program(*fns, store=s)
    assert signatures(p, fns) == signatures(program(*fns), fns)
    assert p.stats["normal_computed"] == depth - kept            # what the killed process had committed is not done again


# ------------------------------------------------------------------------------------ convergence

def test_a_cycle_converges_to_the_same_signatures_whichever_member_is_asked_first():
    fns = ring(5)
    seen = set()
    for first in fns:
        p = program(*fns)
        p.signature(BASE + first.rva)
        seen.add(tuple(signatures(p, fns)))
        assert p.stats["scc_cyclic"] == 1 and p.stats["scc_largest"] == 5
    assert len(seen) == 1 and None not in next(iter(seen))


def test_a_chain_longer_than_any_stack_is_analysed():
    fns = chain(1500, step=0x40)
    p = program(*fns)
    assert len(p.signature(BASE + RVA).params) == 1
    assert p.stats["signature_computed"] == 1500


def test_a_cycle_inside_a_chain_and_a_chain_inside_a_cycle_are_both_solved():
    top = Asm(RVA - 0x100)
    top(T.sub_rsp(40))
    top.branch(C.CALL_REL32_64, RVA)
    top(T.add_rsp(40))(T.ret())
    fns = [top, *ring(3)]
    p = program(*fns)
    got = signatures(p, fns)
    assert None not in got and p.stats["scc_solved"] == 2


# ------------------------------------------------------------------------------------ workers

def test_a_lease_keeps_a_unit_to_one_live_process_and_a_dead_one_s_is_taken_over(tmp_path):
    a = kn.SqliteStore(tmp_path / "k.db", "ns", owner=f"{os.getpid()}:a")
    b = kn.SqliteStore(tmp_path / "k.db", "ns", owner=f"{os.getpid()}:b")
    assert a.lease("scc", "x") and not b.lease("scc", "x")
    a.release("scc", "x")
    assert b.lease("scc", "x")
    gone = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"], capture_output=True, text=True).stdout.strip()
    dead = kn.SqliteStore(tmp_path / "k.db", "ns", owner=f"{gone}:dead")
    assert dead.lease("scc", "y")
    assert a.lease("scc", "y")                       # its process has ended: nobody is computing it


def test_two_workers_on_one_store_never_analyse_the_same_function_twice(tmp_path):
    fns = chain(30)
    db = tmp_path / "k.db"
    code = textwrap.dedent(f"""
        import sys, json
        sys.path[:0] = [{str(TESTS)!r}, {str(TESTS / "unit")!r}, {str(TESTS.parent)!r}]
        import test_knowledge as tk
        from recon.core import knowledge as kn
        fns = tk.chain(30)
        p = tk.program(*fns, store=kn.SqliteStore({str(db)!r}, "ns"))
        tk.signatures(p, fns[::int(sys.argv[1])])
        print(json.dumps(p.stats))
    """)
    import json
    procs = [subprocess.Popen([sys.executable, "-c", code, str(k)], stdout=subprocess.PIPE, text=True) for k in (1, 1)]
    stats = [json.loads(p.communicate(300)[0]) for p in procs]
    assert sum(s["normal_computed"] for s in stats) == 30          # each function analysed by one of them
    assert sum(s["signature_computed"] for s in stats) == 30
    p = program(*fns, store=kn.SqliteStore(db, "ns"))
    assert signatures(p, fns) == signatures(program(*fns), fns) and p.stats["normal_computed"] == 0


# ------------------------------------------------------------------------------------ memory

def test_memory_holds_a_bounded_number_of_normal_forms_and_the_store_holds_them_all(monkeypatch):
    monkeypatch.setattr(__import__("recon.core.inference.whole", fromlist=["x"]), "FN_CACHE", 16)
    fns = chain(80)
    store = kn.MemoryStore()
    p = program(*fns, store=store)
    got = signatures(p, fns)
    assert len(p._fns) <= 16 and p.stats["normal_evicted"] > 0 and store.count("normal") == 80
    assert got == signatures(program(*fns), fns)
    p.normal(BASE + RVA)                             # evicted, read back, not analysed again
    assert p.stats["normal_computed"] == 80


def test_what_a_form_read_back_shows_of_its_calls_is_filed_so_no_later_program_reads_the_form_again():
    """D-061: a store whose normal forms outlived their readings (filed under other code) gets the readings once."""
    fns = chain(6)
    store = kn.MemoryStore()
    want = signatures(program(*fns, store=store), fns)
    for kind, key in [k for k in store.facts if k[0] in ("callees", "sites", "sigkey")]:   # filed before D-067, too
        store.drop(kind, key)
    healing = program(*fns, store=store)
    assert signatures(healing, fns) == want
    assert healing.stats["readings_filed"] == 6 and healing.stats["normal_loaded"] == 6 and healing.stats["normal_computed"] == 0
    assert store.count("callees") == 6 and store.count("sites") == 6 and store.count("sigkey") == 6
    healed = program(*fns, store=store)
    assert signatures(healed, fns) == want and healed.sites(BASE + RVA) == healing.sites(BASE + RVA)
    # D-067: the signatures are read by the keys filed with them, so not even the callees are read
    assert healed.stats["normal_loaded"] == 0 and healed.stats["readings_filed"] == 0 and healed.stats["edges_loaded"] == 0
    assert healed.stats["sigkey_loaded"] == 6


# ------------------------------------------------------------------------------------ invalidation

def test_a_change_below_a_function_changes_its_key_and_a_change_elsewhere_does_not():
    fns = chain(4)
    other = Asm(0x9000)(I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RCX, 2)))(T.ret())
    p = program(*fns, other, store=kn.MemoryStore())
    signatures(p, [*fns, other])
    before = dict(p._sigkey)
    changed = [*fns[:-1], Asm(fns[-1].rva)(I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RCX, 5)))(T.ret())]
    q = program(*changed, other, store=kn.MemoryStore())
    signatures(q, [*changed, other])
    assert all(q._sigkey[BASE + f.rva] != before[BASE + f.rva] for f in fns)      # everything above the change
    assert q._sigkey[BASE + other.rva] == before[BASE + other.rva]                 # and nothing beside it


def test_a_declaration_of_a_callee_is_a_dependency_of_its_callers():
    fns = chain(3)
    last = BASE + fns[-1].rva
    plain = program(*fns, store=kn.MemoryStore())
    plain.signature(BASE + RVA)
    decl = Signature((Slot("i", 32, "signed"),), Slot("i", 32, "signed"), (("declared", "declaration"),))
    told = program(*fns, store=kn.MemoryStore(), declared=lambda at: ("Last", decl) if at == last else None)
    told.signature(BASE + RVA)
    assert told._sigkey[BASE + RVA] != plain._sigkey[BASE + RVA]


# ------------------------------------------------------------------------------------ callers' evidence

def caller(rva: int, to: int, reads: bool) -> Asm:
    """sets two arguments, calls `to`, and returns (or ignores) what it returns"""
    a = Asm(rva)
    a(T.sub_rsp(40))(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 5))(I.create_reg_i32(C.MOV_R32_IMM32, R.EDX, 7))
    a.branch(C.CALL_REL32_64, to)
    if reads:
        a(I.create_reg_i32(C.ADD_RM32_IMM32, R.EAX, 1))
    else:
        a(I.create_reg_reg(C.XOR_R32_RM32, R.EAX, R.EAX))
    a(T.add_rsp(40))(T.ret())
    return a


def test_callers_that_set_more_arguments_than_a_callee_reads_leave_that_reading_open():
    callee = Asm(RVA)(I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RCX, 1)))(T.ret())
    fns = [callee, caller(0x3000, RVA, True), caller(0x3100, RVA, True)]
    p = program(*fns, universe=True)
    assert p.callers(BASE + RVA) is None             # not indexed yet: no evidence, and it says so
    assert p.index_callers() == 3
    assert sorted(p.callers(BASE + RVA)) == [BASE + 0x3000, BASE + 0x3100]
    best = p.signature(BASE + RVA)
    assert len(best.params) == 1
    alts = p.alternatives(BASE + RVA)
    assert any(len(s.params) == 2 and s.result is not None for s in alts)
    assert p.signature(BASE + RVA) == best           # the callee's own reading is not replaced


def test_callers_that_read_a_result_a_callee_does_not_leave_one_give_that_reading_first():
    callee = Asm(RVA)(T.store(mem(R.RCX), R.RDX))(T.ret())
    fns = [callee, caller(0x3000, RVA, True)]
    p = program(*fns, universe=True, store=kn.MemoryStore())
    p.index_callers()
    assert p.signature(BASE + RVA).result is None
    alts = p.alternatives(BASE + RVA)
    assert alts and alts[0].result is not None
    q = program(*fns, universe=True, store=p._store)
    assert q.alternatives(BASE + RVA) == alts and q.stats["alternatives_loaded"] == 1 and q.stats["normal_computed"] == 0


def test_the_search_tries_a_callee_s_alternatives_and_says_which():
    callee = Asm(RVA)(I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RCX, 1)))(T.ret())
    fns = [callee, caller(0x3000, RVA, True), caller(0x3100, RVA, True)]
    p = program(*fns, universe=True)
    p.index_callers()
    g = cd.Generator(p, BASE + 0x3000)
    read = [c for c in g.choices() if c is not None and c.callees]
    assert read and all(ch.startswith("callee:") for c in read for ch in c.changes() if ch.startswith("callee"))
    made = [g.make(c, set()) for c in read[:3]]
    assert any(m is not None for m in made)


# ------------------------------------------------------------------------------------ calls through a value

def virtual(rva: int) -> Asm:
    """f(p): p->vtable[1](p, 5)"""
    a = Asm(rva)
    a(T.sub_rsp(40))(T.load(R.RAX, mem(R.RCX)))(I.create_reg_i32(C.MOV_R32_IMM32, R.EDX, 5))
    a(I.create_mem(C.CALL_RM64, mem(R.RAX, 8)))
    a(T.add_rsp(40))(T.ret())
    return a


def test_a_function_that_calls_through_a_value_has_a_signature_and_so_do_its_callers():
    top = Asm(RVA)
    top(T.sub_rsp(40))
    top.branch(C.CALL_REL32_64, 0x2000)
    top(T.add_rsp(40))(T.ret())
    fns = [top, virtual(0x2000)]
    p = program(*fns)
    s = p.signature(BASE + 0x2000)
    assert s is not None and s.params and s.params[0] == Slot("i", 64) and ("indirect-calls", "SITE") in s.evidence
    assert p.signature(BASE + RVA) is not None                    # the chain above it is no longer blocked
    with pytest.raises(NotReconstructed, match="INDIRECT_CALL"):     # the call itself is still written only with its target
        cd.Generator(p, BASE + 0x2000).make(cd.Choice(), set())


def test_a_tail_jump_through_a_value_leaves_the_signature_unknown_rather_than_empty():
    thunk = Asm(0x2000)(I.create_mem(C.JMP_RM64, mem(R.RCX, 8)))       # f(p, ...): tail-jumps to p's second slot
    p = program(thunk)
    assert cd.indirect_signatures(p.normal(BASE + 0x2000), SOURCE) == {}
    assert p.signature(BASE + 0x2000) is None


def test_a_call_through_a_slot_that_holds_an_import_has_the_import_s_declared_signature():
    slot_at = BASE + 0x9000
    f = Asm(0x2000)                                  # f(_, b): return imported(5, b) + 1, through its slot of the import address table
    f(T.sub_rsp(40))(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 5))(I.create_mem(C.CALL_RM64, mem(R.RIP, slot_at)))
    f(I.create_reg_i32(C.ADD_RM32_IMM8, R.EAX, 1))(T.add_rsp(40))(T.ret())
    declared = Signature((Slot(INT, 32), Slot(INT, 32)), Slot(INT, 32), (("declared", "import"),))
    s = program(f, slot=lambda at: declared if at == slot_at else None).signature(BASE + 0x2000)
    assert s is not None and len(s.params) == 2 and s.result == Slot(INT, 32)  # the second argument is f's own, passed on
    site = program(f).signature(BASE + 0x2000)                                  # no declaration: the site shows one argument
    assert site is not None and len(site.params) == 0


def test_what_a_function_leaves_open_is_read_with_the_same_calls_as_its_signature():
    p = program(virtual(0x2000))
    at = BASE + 0x2000
    assert len(p._results(at)) == 1          # the site says nothing reads a result after the call
    assert p.alternatives(at) == ()          # so there is no other reading to try, and asking for one does not fail


def test_what_a_call_site_shows_is_read_from_the_caller_s_own_values():
    p = program(virtual(0x2000))
    fn = p.normal(BASE + 0x2000)
    (sig,) = cd.indirect_signatures(fn, SOURCE).values()
    assert len(sig.params) == 2 and sig.result is None   # this, passed on, and the 5 it sets; nothing read after it


def two_calls(rva: int, second) -> Asm:
    """g(): a(5, 7, 8, 9); then one argument, 3, to the second call; what the first call left in the other argument
    locations is still there, listed at the second call, and no argument of the caller's"""
    a = Asm(rva)
    a(T.sub_rsp(40))
    for reg, v in ((R.ECX, 5), (R.EDX, 7), (R.R8D, 8), (R.R9D, 9)):
        a(I.create_reg_i32(C.MOV_R32_IMM32, reg, v))
    a.branch(C.CALL_REL32_64, 0x5000)
    a(I.create_reg_i32(C.MOV_R32_IMM32, R.ECX, 3))
    second(a)
    a(T.add_rsp(40))(T.ret())
    return a


def test_what_an_earlier_call_left_in_an_argument_location_is_not_set_by_the_caller():
    g = two_calls(0x3000, lambda a: a.branch(C.CALL_REL32_64, 0x6000))
    sites = cd.call_sites(program(g).normal(BASE + 0x3000), SOURCE)
    assert [n for n, _w in sites[str(BASE + 0x5000)][0]["set"]] == ["r8", "r9", "rcx", "rdx"]
    assert [n for n, _w in sites[str(BASE + 0x6000)][0]["set"]] == ["rcx"]


def test_what_an_earlier_call_left_is_no_argument_of_a_call_through_a_value():
    g = two_calls(0x3000, lambda a: a(I.create_mem(C.CALL_RM64, mem(R.RIP, BASE + 0x9000))))
    (sig,) = cd.indirect_signatures(program(g).normal(BASE + 0x3000), SOURCE).values()
    assert len(sig.params) == 1 and sig.params[0].kind == INT


def test_a_callee_read_from_its_callers_takes_what_they_set_after_an_earlier_call():
    callee = Asm(0x6000)(I.create_reg_mem(C.LEA_R32_M, R.EAX, mem(R.RCX, 1)))(I.create_reg_reg(C.ADD_R32_RM32, R.EAX, R.EDX))(T.ret())
    first = Asm(0x5000)(T.ret())
    g = two_calls(0x3000, lambda a: a.branch(C.CALL_REL32_64, 0x6000))
    p = program(callee, first, g, universe=True)
    p.index_callers()
    sites = [s for c in p.callers(BASE + 0x6000) for s in p.sites(c).get(str(BASE + 0x6000), [])]
    assert sites and all([n for n, _w in s["set"]] == ["rcx"] for s in sites)


# ------------------------------------------------------------------------------------ namespaces

def loaded_by(roots: tuple[str, ...]) -> set[str]:
    """The engine's source files that importing `roots` runs, in a fresh interpreter."""
    code = textwrap.dedent(f"""
        import sys, json
        sys.path.insert(0, {str(TESTS.parent)!r})
        for m in {list(roots)!r}:
            __import__(m)
        import pathlib
        root = pathlib.Path({str(Path(kn.__file__).resolve().parents[1])!r})
        print(json.dumps(sorted(pathlib.Path(m.__file__).resolve().relative_to(root).as_posix()
                                for n, m in sys.modules.items() if n.startswith("recon") and getattr(m, "__file__", None))))
    """)
    import json
    return set(json.loads(subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout))


def test_normal_forms_are_filed_under_the_code_that_makes_them_and_nothing_else():
    closure = kn.import_closure(kn.NORMAL_ROOTS)
    assert not any(x.startswith(("core/synthesis", "core/structuring", "core/emitter")) for x in closure)
    assert loaded_by(kn.NORMAL_ROOTS) <= closure | set(kn.NORMAL_FILES)     # every module that runs is in the digest


def test_what_is_read_off_a_normal_form_is_filed_under_its_code_and_the_site_readings():
    closure = kn.import_closure(kn.NORMAL_ROOTS + kn.SITE_ROOTS)
    assert "core/inference/sites.py" in closure and not any(x.startswith(("core/synthesis", "core/emitter")) for x in closure)
    assert loaded_by(kn.NORMAL_ROOTS + kn.SITE_ROOTS) <= closure | set(kn.NORMAL_FILES)
    assert cd.call_sites is __import__("recon.core.inference.sites", fromlist=["x"]).call_sites   # the store's sites come from there


def test_the_other_facts_are_filed_under_the_analysis_and_not_under_what_writes_source():
    closure = kn.import_closure(kn.ANALYSIS_ROOTS)
    assert {"core/inference/whole.py", "core/inference/sites.py", "adapters/skyrim/packfacts.py", "adapters/skyrim/normal.py"} <= closure
    assert not any(x.startswith(("core/synthesis", "core/structuring", "core/emitter")) for x in closure)
    assert not any(x in closure for x in ("adapters/skyrim/pack.py", "adapters/skyrim/solve.py", "adapters/x64_msvc/batch.py"))
    assert cd.Program is __import__("recon.core.inference.whole", fromlist=["x"]).Program
    assert loaded_by(kn.ANALYSIS_ROOTS) <= closure | set(kn.NORMAL_FILES)


def test_each_kind_of_fact_has_the_namespace_of_the_code_it_depends_on():
    ns = kn.namespaces("x")
    assert ns["callees"] == ns["sites"] == ns["callers"]
    assert len({ns["normal"], ns["sites"], ns["*"]}) == 3
    assert kn.namespaces("x", extra=("imports",))["sites"] == ns["sites"]  # what is declared of imports reaches no site


def test_why_a_signature_is_unknown_is_kept_with_it_and_read_back_with_its_key(tmp_path):
    """D-067: an inference that ends without a signature files the code it ended with; a later program reads the signature
    by the key filed with it, without walking the callees, and learns why it is unknown."""
    fns = chain(3)
    refused = BASE + fns[-1].rva
    plain = program(*fns)

    def normal(at):
        if at == refused:
            raise NotReconstructed("SYNTHETIC_REFUSAL")
        return plain._normal(at)

    def build(store):
        p = program(*fns, store=store)
        p._normal = normal
        return p

    store = kn.SqliteStore(tmp_path / "k.db", "ns")
    first = build(store)
    assert first.signature(BASE + fns[0].rva) is None
    assert first.why_unknown(refused) == "SYNTHETIC_REFUSAL"
    later = build(kn.SqliteStore(tmp_path / "k.db", "ns"))
    assert later.why_unknown(refused) == "SYNTHETIC_REFUSAL" and later.stats["attempts_loaded"] == 1
    assert later.stats["sigkey_loaded"] == 1 and later.stats["edges_loaded"] == 0 and later.stats["signature_computed"] == 0


def test_a_cycle_read_back_by_its_filed_key_is_read_back_whole_and_gets_no_second_key(tmp_path):
    """D-067: reading one member of a cycle back by its filed key settles every member, so a later walk that reaches
    another member finds it settled: no component is formed of part of a cycle, and no function has two keys."""
    a, b = mutual(RVA, RVA + 0x100), mutual(RVA + 0x100, RVA)
    r = Asm(RVA + 0x200)(T.sub_rsp(40))
    r.branch(C.CALL_REL32_64, RVA + 0x100)
    r(T.add_rsp(40))(T.ret())
    fns = (a, b, r)
    whole_walk = kn.SqliteStore(tmp_path / "one.db", "ns")
    want = signatures(program(*fns, store=whole_walk), fns)
    keys = whole_walk.keys("signature")

    store = kn.SqliteStore(tmp_path / "two.db", "ns")
    program(*fns, store=store).signature(BASE + a.rva)                # files the cycle {a, b}
    later = program(*fns, store=kn.SqliteStore(tmp_path / "two.db", "ns"))
    assert later.signature(BASE + a.rva) == want[0]                  # read back by its key: b with it
    assert BASE + b.rva in later._sigs and later.stats["sigkey_loaded"] == 2
    assert later.signature(BASE + r.rva) == want[2] and later.stats["edges_loaded"] <= 1
    assert store.keys("signature") == keys and store.count("signature") == 3
