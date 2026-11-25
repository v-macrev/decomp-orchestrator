# SPDX-License-Identifier: AGPL-3.0-or-later
"""The lifter: refusals, the recorded coverage table, and a sample of the execution-based differential tests.

The whole differential run is `python -m recon validate-lift --write`; the table it wrote is checked here against the
sources it was made from, so a change to the lifter without a new run fails a test and disables lifting."""
import json
import platform
import random
import zlib

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

from mutants import mutants  # noqa: E402

from recon.adapters.x64_msvc import validate as v  # noqa: E402
from recon.adapters.x64_msvc.decode import mnemonic_name  # noqa: E402
from recon.adapters.x64_msvc.lift import lift  # noqa: E402
from recon.core import evaluate as ev  # noqa: E402
from recon.core.sem import Lifted, Unsupported  # noqa: E402

ix = v._iced()
BASE = 0x1_4000_0000
x64 = pytest.mark.skipif(platform.machine().lower() not in ("amd64", "x86_64"), reason="executes x86-64 instructions on this processor")


def dec(code: str, rva: int = 0x1000):
    return ix.Decoder(64, bytes.fromhex(code), ip=BASE + rva).decode()


def step(code: str, **locs):
    r = lift(dec(code), BASE)
    assert isinstance(r, Lifted), r
    m = ev.Machine(lambda a, n: 0, lambda a, n, x: None, {**{n: 0 for n in v.GPR}, **{n: 0 for n in v.FLAGS}, **locs})
    return m, ev.run(r, m)


# ---------------------------------------------------------------- what is refused

@pytest.mark.parametrize("code,reason", [
    ("65488b042558000000", "segment-override"),        # mov rax, gs:[58h]
    ("678b01", "address-size-override"),                # mov eax, [ecx]
    ("6667e800", None),                                 # decodes to something else or nothing lifted
    ("6650", "operand-size"),                           # push ax
    ("f3ac", "prefix-not-modelled"),                    # rep lodsb
    ("f2a4", "prefix-not-modelled"),                    # repne movsb
    ("0f58c1", "not-in-subset"),                        # addps
    ("f20f100a", "not-in-subset"),                      # movsd xmm1, [rdx] shares its name with the string form
    ("0fa2", "not-in-subset"),                          # cpuid
    ("8cd8", "operand-not-general-purpose"),            # mov eax, ds
    ("660fc8", None),
])
def test_what_is_outside_the_subset_is_refused_with_a_reason(code, reason):
    r = lift(dec(code), BASE)
    if reason is None:
        assert isinstance(r, Unsupported)
    else:
        assert isinstance(r, Unsupported) and r.reason == reason


def test_a_form_outside_the_table_is_refused_even_though_it_could_be_lifted():
    r = lift(dec("4803c1"), BASE, frozenset({"SUB_R64_RM64"}))
    assert isinstance(r, Unsupported) and (r.form, r.reason) == ("ADD_R64_RM64", "form-not-validated")
    assert isinstance(lift(dec("4803c1"), BASE, frozenset({"ADD_R64_RM64"})), Lifted)


def test_register_memory_and_prefixes_are_different_forms():
    names = {lift(dec(c), BASE).form for c in ("03c1", "0301", "0101", "f00101", "f3a4", "a4")}
    assert names == {"ADD_R32_RM32", "ADD_R32_RM32:mem", "ADD_RM32_R32:mem", "ADD_RM32_R32:mem:lock", "MOVSB_M8_M8:rep", "MOVSB_M8_M8"}


# ---------------------------------------------------------------- a few semantics in plain sight

def test_partial_register_writes():
    assert step("8bc1", rax=2**64 - 1, rcx=5)[0].locs["rax"] == 5                              # mov eax, ecx clears the upper half
    assert step("668bc1", rax=2**64 - 1, rcx=5)[0].locs["rax"] == 0xFFFF_FFFF_FFFF_0005        # mov ax, cx keeps it
    assert step("8ae1", rax=2**64 - 1, rcx=5)[0].locs["rax"] == 0xFFFF_FFFF_FFFF_05FF          # mov ah, cl


def test_flags_a_shift_leaves_undefined_are_undefined_and_a_zero_count_keeps_them():
    assert step("c1e002", rax=1)[0].locs["of"] is ev.UNDEF
    assert step("c1e002", rax=1)[0].locs["af"] is ev.UNDEF
    assert step("d3e0", rax=1, rcx=0, of=1, af=1, cf=1)[0].locs["of"] == 1
    assert step("d3e0", rax=1, rcx=32, zf=1)[0].locs["zf"] == 1  # the count is masked to five bits


def test_addresses_are_virtual_addresses():
    m, out = step("e8fb0f0000", rsp=0x7000)
    assert out == ev.Outcome("call", BASE + 0x2000) and m.locs["rsp"] == 0x6FF8
    m, _ = step("488d0500010000")
    assert m.locs["rax"] == BASE + 0x1000 + 7 + 0x100


def test_division_traps_are_explicit():
    for locs in ({"rcx": 0}, {"rcx": 1, "rdx": 1}):
        with pytest.raises(ev.Trapped):
            step("f7f1", **locs)
    with pytest.raises(ev.Trapped):
        step("f7f9", rax=0x8000_0000, rdx=0xFFFF_FFFF, rcx=0xFFFF_FFFF)


# ---------------------------------------------------------------- the recorded table

def test_the_table_was_made_by_these_sources_and_every_form_has_enough_vectors():
    t = json.loads(v.TABLE.read_text(encoding="utf-8"))
    assert t["source_digest"] == v.source_digest(), "the lifter or its tests changed: run `python -m recon validate-lift --write`"
    assert t["seed"] == v.SEED and len(t["date"]) == 10
    assert all(f["vectors"] >= v.MIN_VECTORS or f["traps"] > 0 for f in t["forms"].values())
    assert t["vectors"] == sum(f["vectors"] for f in t["forms"].values())
    assert v.load_validated() == frozenset(t["forms"])


def test_every_form_the_lifter_accepts_is_in_the_table():
    """Gate: no supported form without passed vectors. A form that cannot be built in 64-bit mode is not supported."""
    proc = v.processor()
    table = v.load_validated()
    missing = []
    for e in v.forms(ix):
        if e[0] in table:
            continue
        g = v.Gen(ix, proc, random.Random(1))
        for _ in range(20):
            try:
                ins, _data = g.build(*e[1:])
            except v.CannotBuild:
                continue
            if not isinstance(lift(ins), Unsupported):
                missing.append(e[0])
                break
    assert missing == []


def test_a_table_of_other_sources_validates_nothing(monkeypatch, tmp_path):
    t = json.loads(v.TABLE.read_text(encoding="utf-8"))
    t["source_digest"] = "0" * 64
    p = tmp_path / "t.json"
    p.write_text(json.dumps(t))
    monkeypatch.setattr(v, "TABLE", p)
    assert v.load_validated() == frozenset() and len(v.load_validated(check=False)) > 1000
    monkeypatch.setattr(v, "TABLE", tmp_path / "absent.json")
    assert v.load_validated() == frozenset()


def test_a_table_is_never_written_over_failures():
    with pytest.raises(SystemExit):
        v.write_table({"failed": {"X": ["differs"]}, "passed": {}}, "2026-01-01")


# ---------------------------------------------------------------- execution

SAMPLE = [e for e in v.forms(ix) if e[0] in v.load_validated(check=False)][::9]


@x64
def test_a_sample_of_forms_matches_the_processor():
    proc = v.processor()
    vectors = 0
    for e in SAMPLE:
        r = v.run_form(proc, e, 8, 6)
        assert not isinstance(r, str), (e[0], r)
        assert not r.failures and not r.unaimed, (e[0], r.failures[:2])
        vectors += r.vectors
    assert vectors > 3000


@x64
def test_results_do_not_depend_on_the_run():
    proc = v.processor()
    a, b = (v.run_form(proc, SAMPLE[3], 6, 6) for _ in range(2))
    assert (a.vectors, a.traps, a.undefined) == (b.vectors, b.traps, b.undefined)


@x64
def test_predicted_traps_really_trap():
    proc = v.processor()
    for name in ("DIV_RM32", "INT3", "UD2"):
        e = next(x for x in v.forms(ix) if x[0] == name)
        r = v.run_form(proc, e, 4, 12)
        assert r.trap_samples and v.confirm_trap(proc.base, r.trap_samples[0]) == "confirmed"
    # ... and the confirmation itself notices a vector that does not
    data, regs, flags, win, _k = r.trap_samples[0]
    assert v.confirm_trap(proc.base, (b"\x90", regs, flags, win, "divide-error")) == "no trap happened"


@x64
@pytest.mark.parametrize("name", ["ADD_R32_RM32", "SBB_R64_RM64", "INC_RM64", "XOR_RM8_R8", "IMUL_R64_RM64", "SHL_RM32_CL", "ROR_RM16_CL", "BT_RM64_IMM8",
                                  "MOVSX_R32_RM8:mem", "PUSH_R64", "POP_R64", "CMOVLE_R64_RM64", "JA_REL32_64", "XADD_RM32_R32:mem:lock", "CMPXCHG_RM64_R64", "STOSQ_M64_RAX:rep", "LEAVEQ"])
def test_a_dropped_effect_or_an_inverted_branch_is_always_noticed(name):
    """Mutation: the vectors must kill every mutant that drops an effect or inverts control (other mutants may be equivalent)."""
    e = next(x for x in v.forms(ix) if x[0] == name)
    proc = v.processor()
    g = v.Gen(ix, proc, random.Random(v.SEED ^ zlib.crc32(name.encode())))
    killed: dict[tuple, bool] = {}
    for _ in range(16):
        try:
            ins, data = g.build(*e[1:])
        except v.CannotBuild:
            continue
        good = lift(ins)
        assert isinstance(good, Lifted)
        proc.load(data)
        states = [s for s in (v.make_state(g, ins, mnemonic_name(ix, ins.mnemonic)) for _ in range(12)) if s]
        for n, (what, bad) in enumerate(mutants(good)):
            if not what.startswith(("drop", "invert")):
                continue
            if killed.get((what,)):
                continue
            res = v.FormResult()
            for st in states:
                try:
                    v.check_vector(proc, bad, data, ins.next_ip, st, res, "")
                except (ev.UndefinedControl, KeyError):
                    res.failures.append("raised")
                if res.failures:
                    break
            # an effect can be invisible in one instance (a move of a register to itself): it must show in some instance
            killed[(what,)] = killed.get((what,), False) or bool(res.failures)
    assert killed and all(killed.values()), [k for k, x in killed.items() if not x]
