# SPDX-License-Identifier: AGPL-3.0-or-later
"""Instruction coverage over an inventory: counts by stage, and the report that orders lifting work."""
import hashlib
import json

import pytest

from pe_builder import RDATA_RVA, TEXT_RVA, build_pe

from recon.adapters.skyrim import coverage as cv


def row(rva, *missing):
    return cv.Row(rva, 16, "lift" if missing else "analysed", "UNSUPPORTED_INSTRUCTION" if missing else "", tuple(missing),
                  facts=dict.fromkeys(("blocks", "loops", "irreducible", "switches", "unresolved", "tail", "unreachable_blocks", "insns", "calls", "assumed"), 0))


def test_demand_counts_what_one_form_would_complete():
    rows = [row(1), row(2, "A"), row(3, "A"), row(4, "B"), row(5, "A", "B"), row(6, "B", "C")]
    d = cv.demand(rows)
    assert d["functions"] == 6 and d["lift_completely_now"] == 1
    assert d["forms"] == {"A": {"functions": 3, "would_complete_alone": 2}, "B": {"functions": 3, "would_complete_alone": 1}, "C": {"functions": 1, "would_complete_alone": 0}}
    assert [(o["form"], o["completes"], o["completed_so_far"]) for o in d["greedy_order"]] == [("A", 2, 2), ("B", 2, 4), ("C", 1, 5)]


def test_aggregate_holds_counts_only():
    a = cv.aggregate([row(1), row(2, "SECRET_FORM"), row(3, "SECRET_FORM", "OTHER")])
    assert a["lift_completely"] == 1 and a["functions_missing_exactly_one_form"] == 1 and a["distinct_missing_forms"] == 2
    assert "SECRET" not in json.dumps(a)


@pytest.fixture
def img(tmp_path, upstream_worktree, iced):
    from recon.adapters.skyrim.image import PinnedImage

    # push rbx; sub rsp,20h; mov rbx,rcx; add rsp,20h; pop rbx; ret | addps xmm0,xmm1; ret | a branch into an instruction
    f1 = bytes.fromhex("40534883ec20488bd94883c4205bc3")
    f2 = bytes.fromhex("0f58c1c3")
    f3 = bytes([0x74, 0x01, 0xB8, 1, 0, 0, 0, 0xC3])
    text = f1.ljust(32, b"\xcc") + f2.ljust(16, b"\xcc") + f3
    # prologue of 6 bytes: alloc 32 at 6, push rbx at 2
    rdata = bytes([1, 6, 2, 0, 6, 0x32, 2, 0x30])
    blob = build_pe(text, rdata, [(TEXT_RVA, TEXT_RVA + len(f1), RDATA_RVA)])
    p = tmp_path / "img.bin"
    p.write_bytes(blob)
    from recon.adapters.skyrim.inventory import Target

    return PinnedImage(p, upstream_worktree, expected_sha256=hashlib.sha256(blob).hexdigest()), [
        Target(TEXT_RVA, len(f1), "", None), Target(TEXT_RVA + 32, len(f2), "", None), Target(TEXT_RVA + 48, len(f3), "", None)]


def test_coverage_runs_every_stage_and_agrees_with_unwind_data(img):
    image, targets = img
    rows = cv.run(image, targets, None)
    assert [(r.stage, r.reason) for r in rows] == [("analysed", ""), ("lift", "UNSUPPORTED_INSTRUCTION"), ("survey", "branch-into-instruction")]
    assert rows[0].unwind == (3, ()) and rows[0].frame == "" and rows[0].digest.startswith("sha256:")
    a = cv.aggregate(rows)
    assert a["lift_completely"] == 1 and a["frame"]["recovered"] == 1 and a["unwind"] == {"functions_checked": 1, "facts_checked": 3, "functions_agreeing": 1, "conflicts": {}}
    assert [r.digest for r in cv.run(image, targets, None)] == [r.digest for r in rows]
