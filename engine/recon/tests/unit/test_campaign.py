# SPDX-License-Identifier: AGPL-3.0-or-later
"""The measurement plumbing of Phase 7: taxonomy, held-out split, manifests, extents, and the overfitting scan."""
import json
import re
from pathlib import Path

import pytest

from recon.adapters.skyrim import manifest as mf
from recon.adapters.skyrim.inventory import Inventory, Target, extents
from recon.core import taxonomy as tx

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "recon"


# ------------------------------------------------------------------------------------ taxonomy

def codes_in_source() -> set[str]:
    out = set()
    for p in ENGINE.rglob("*.py"):
        t = p.read_text(encoding="utf-8")
        out |= set(re.findall(r'NotReconstructed\("([A-Z][A-Z_]+)"\)', t))
        out |= set(re.findall(r'Outcome\([^)]*?"(?:blocked|unsupported|unsolved)", "([A-Z][A-Z_]+)"', t))
        out |= set(re.findall(r'blocked\("([A-Z][A-Z_]+)"\)', t))
    from recon.adapters.x64_msvc import program as pg

    out |= {pg.UNSUPPORTED, pg.INVALID, pg.CONFLICT, pg.NOT_REPRESENTED}
    out |= {"NO_MATCH", "DOES_NOT_COMPILE", "EXACT_UNIT_DOES_NOT_COMPILE", "NOT_EQUIVALENT", "NO_CANDIDATE", "BUDGET_EXHAUSTED"}
    return out


def test_every_code_the_engine_writes_has_a_family():
    codes = codes_in_source()
    assert len(codes) > 60
    assert sorted(c for c in codes if tx.family(c) == "UNCLASSIFIED") == []


def test_prefixed_and_comparator_codes_are_classified():
    assert tx.family("OPERATION_FOO") == "Machine" and tx.name("EFFECT_BAR") == "NOT_REPRESENTED"
    assert tx.family("instruction-mismatch") == "Search" and tx.name("instruction-mismatch") == "MISMATCH(instruction-mismatch)"
    assert tx.family("NOT A CODE") == "UNCLASSIFIED"


def test_blockers_come_in_pipeline_order_and_decide_the_state():
    assert tx.blockers(["NO_MATCH", "CALLEE_SIGNATURE_UNKNOWN", "UNSUPPORTED_INSTRUCTION", "NO_MATCH"]) == ["UNSUPPORTED_INSTRUCTION", "CALLEE_SIGNATURE_UNKNOWN", "NO_MATCH"]
    assert tx.state(True, ["NO_MATCH"]) == tx.BYTE_MATCHED
    assert tx.state(False, ["BUDGET_EXHAUSTED"]) == tx.RESUMABLE
    assert tx.state(False, ["HEADER_SIZE_CAP"]) == tx.NEEDS_DECISION
    assert tx.state(False, ["TOOLCHAIN_UNAVAILABLE", "NO_MATCH"]) == tx.INFRA
    assert tx.state(False, ["MEMBER_NOT_DECLARED"]) == tx.OPEN


def test_a_campaign_record_takes_solve_over_reach():
    from recon.adapters.skyrim.campaign import Record, decide

    r = Record(1, 16, False, "refused: CALLEE_SIGNATURE_UNKNOWN", ["INDIRECT_CALL", "CALLEE_SIGNATURE_UNKNOWN"])
    decide(r)
    assert r.state == tx.OPEN and r.blockers == ["CALLEE_SIGNATURE_UNKNOWN", "INDIRECT_CALL"]
    r = Record(2, 16, True, "candidate", [], "solved BYTE_MATCHED")
    decide(r)
    assert r.state == tx.BYTE_MATCHED and r.blockers == []
    r = Record(3, 16, False, "candidate", [], "unsolved MEMBER_NOT_DECLARED")
    decide(r)
    assert r.state == tx.OPEN and r.blockers == ["MEMBER_NOT_DECLARED"]


# ------------------------------------------------------------------------------------ held-out split and manifests

def test_the_held_out_split_is_fixed_and_about_five_percent():
    rvas = range(0x1000, 0x1000 + 40_000 * 16, 16)
    share = sum(map(mf.heldout, rvas)) / 40_000
    assert 0.045 < share < 0.055
    assert [mf.heldout(r) for r in rvas[:2000]] == [mf.heldout(r) for r in rvas[:2000]]
    assert any(mf.heldout(r) != mf.heldout(r, b"heldout-v2") for r in rvas[:200])


def test_the_include_closure_follows_project_includes(tmp_path):
    (tmp_path / "src/a").mkdir(parents=True)
    (tmp_path / "inc").mkdir()
    (tmp_path / "src/a/unit.h").write_text('#include "near.h"\n#include "far.h"\n#include <vector>\n#include "nowhere.h"\n')
    (tmp_path / "src/a/near.h").write_text('#include "../../inc/far.h"\n')
    (tmp_path / "inc/far.h").write_text("int x;\n")
    got = mf.include_closure(tmp_path, "src/a/unit.h", None, ("inc",))
    assert set(got) == {"src/a/unit.h", "src/a/near.h", "inc/far.h", "unresolved:nowhere.h"}
    changed = mf.include_closure(tmp_path, "src/a/unit.h", (tmp_path / "src/a/unit.h").read_text() + "// more\n", ("inc",))
    assert changed["src/a/unit.h"] != got["src/a/unit.h"] and changed["inc/far.h"] == got["inc/far.h"]


def test_a_frontier_key_depends_on_its_inputs_but_not_the_budget():
    k = mf.frontier_key("b", "r", "header", 0x10, "A::f")
    assert k == mf.frontier_key("b", "r", "header", 0x10, "A::f")
    assert len({k, mf.frontier_key("b", "r", "header2", 0x10, "A::f"), mf.frontier_key("b", "r2", "header", 0x10, "A::f"),
                mf.frontier_key("b", "r", "header", 0x20, "A::f")}) == 4


def test_extents_add_recorded_functions_that_nothing_overlaps():
    inv = Inventory("b", (Target(0x100, 0x20, "x", None), Target(0x200, 0x10, "x", None)), 0, 0,
                    recorded=(Target(0x120, 0x10, "progress", "matched"),     # after the first: kept
                              Target(0x110, 0x8, "progress", "matched"),      # inside the first: left out
                              Target(0x1f8, 0x10, "progress", "matched"),     # runs into the second: left out
                              Target(0x300, 0x10, "progress", "mapped"), Target(0x308, 0x10, "progress", "mapped")))   # overlap each other
    got, dropped = extents(inv)
    assert got == {0x100: 0x20, 0x200: 0x10, 0x120: 0x10} and dropped == 4


# ------------------------------------------------------------------------------------ the overfitting scan

def test_no_engine_file_holds_a_target_address_or_name(upstream_worktree):
    """Convergence plan section 4: no engine source, rule or test may contain a target RVA or a name from the image."""
    progress = json.loads((upstream_worktree / "data/progress.json").read_text(encoding="utf-8"))
    starts = {f["rva"] for f in progress["functions"]}
    for p in sorted((upstream_worktree / "data/target-hashes").glob("contributor-targets-part-*.json")):
        starts |= {f["rva"] for f in json.loads(p.read_text())["functions"]}
    scoped = {f["name"] for f in progress["functions"] if "::" in (f.get("name") or "")}
    plain = {f["name"] for f in progress["functions"] if (f.get("name") or "").isidentifier() and len(f["name"]) >= 14}
    hits = []
    for p in sorted([*ROOT.rglob("*.py"), *ROOT.rglob("*.cpp"), *ROOT.rglob("*.h"), *ROOT.rglob("*.json"), *ROOT.rglob("*.md")]):
        if ".local" in p.parts or "venv" in p.parts or "__pycache__" in p.parts:
            continue
        t = p.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"\b0x([0-9a-fA-F]{5,8})\b", t):
            if int(m.group(1), 16) in starts:
                hits.append((p.relative_to(ROOT).as_posix(), m.group(0)))
        for w in set(re.findall(r"\b[A-Za-z_]\w*::[A-Za-z_~]\w*\b", t)) & scoped:
            hits.append((p.relative_to(ROOT).as_posix(), w))
        for w in set(re.findall(r"\b[A-Za-z_]\w{13,}\b", t)) & plain:
            hits.append((p.relative_to(ROOT).as_posix(), w))
    assert hits == [], hits[:20]


# ------------------------------------------------------------------------------------ the ceiling estimate

def test_the_ceiling_sample_is_even_across_sizes_and_fixed():
    from recon.adapters.skyrim import ceiling as ce

    pop = [(0x1000 + 64 * k, 8 + (k % 300) * 7) for k in range(5000)]
    a = ce.stratified(pop, 200)
    assert a == ce.stratified(pop, 200) and len(a) == 200 == len(set(a))
    from collections import Counter

    from recon.adapters.skyrim.inventory import size_bucket
    per = Counter(size_bucket(s) for _r, s in a)
    assert max(per.values()) - min(per.values()) <= 1, per
    lo, hi = ce.wilson(10, 200)
    assert 0.02 < lo < 0.05 < hi < 0.09 and ce.wilson(0, 0) == (0.0, 1.0)


def test_the_caps_are_read_from_upstream(upstream_worktree):
    from recon.adapters.skyrim import ceiling as ce

    b, n = ce.caps(upstream_worktree)
    assert b > 1000 and n > 100


# ------------------------------------------------------------------------------------ levels, journal, workers

def test_a_level_multiplies_every_budget_and_the_last_is_not_a_limit():
    from recon.core import budget as bg

    assert bg.level(0) == {k: bg.DEFAULTS[k] for k in bg.KINDS}
    assert all(bg.level(3)[k] == 64 * bg.DEFAULTS[k] for k in bg.KINDS)
    assert list(bg.LEVELS) == sorted(set(bg.LEVELS))
    with pytest.raises(ValueError):
        bg.level(len(bg.LEVELS))


def test_the_journal_resumes_a_campaign_and_never_redoes_a_function_at_one_level(tmp_path):
    from recon.adapters.skyrim.campaign import Journal, Record, wanted

    j = Journal(tmp_path / "c.jsonl")
    j.append(Record(1, 16, False, "exhausted: irNodes", ["BUDGET_EXHAUSTED"], state=tx.RESUMABLE, level=0))
    j.append(Record(2, 16, False, "candidate", [], "solved BYTE_MATCHED", state=tx.BYTE_MATCHED, level=0))
    j.append(Record(3, 16, False, "failed: 9", ["WORKER_DIED"], state=tx.INFRA, level=0))
    with open(j.path, "a", encoding="utf-8") as f:
        f.write('{"rva": 4, "size"')                 # the line being written when the machine ended
    got = j.latest()
    assert sorted(got) == [1, 2, 3]
    assert [r for r in (1, 2, 3, 4) if wanted(got.get(r), 0, set())] == [3, 4]
    assert [r for r in (1, 2, 3) if wanted(got.get(r), 1, set())] == [1]
    assert not wanted(got[3], 0, {3})                # an infrastructure failure is retried once per run
    j = Journal(j.path)                              # the campaign started again
    j.append(Record(1, 16, False, "candidate", [], "unsolved NO_MATCH", state=tx.OPEN, level=1))
    assert j.latest()[1].level == 1 and not wanted(j.latest()[1], 2, set())


def double(st, task):
    return 2 * task + st


def die_on(st, task):
    import os

    if task == st:
        os._exit(9)                                  # as the kernel's out-of-memory killer would end it
    if task == -1:
        raise ValueError("a defect")
    return task


def test_the_pool_answers_every_task_and_a_task_that_kills_its_worker_is_infrastructure():
    from recon.core.workers import Pool

    got = {}
    Pool(int, (1,), double, most=3).run(range(20), lambda t, kind, v, m: got.__setitem__(t, (kind, v)))
    assert got == {t: ("ok", 2 * t + 1) for t in range(20)}
    got = {}
    pool = Pool(int, (7,), die_on, most=2)
    pool.run([1, 7, -1, 3], lambda t, kind, v, m: got.__setitem__(t, kind))
    assert got == {1: "ok", 7: "died", -1: "error", 3: "ok"}
    assert pool.stats.died == 2                      # tried again once before it is answered


def test_the_pool_starts_with_one_worker_and_grows_only_while_memory_allows(monkeypatch):
    from recon.core import workers as wk

    monkeypatch.setattr(wk, "meminfo", lambda: (64 * wk.GIB, 64 * wk.GIB))
    pool = wk.Pool(int, (0,), double, most=3, reserve=wk.GIB, step_s=0)
    pool.run(range(40), lambda *a: None)
    assert pool.stats.most > 1
    monkeypatch.setattr(wk, "meminfo", lambda: (wk.GIB // 2, 64 * wk.GIB))
    pool = wk.Pool(int, (0,), double, most=3, reserve=wk.GIB, step_s=0)
    pool.run(range(40), lambda *a: None)
    assert pool.stats.most == 1                      # short of memory: one worker, every task still done
