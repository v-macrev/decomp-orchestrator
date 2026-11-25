# SPDX-License-Identifier: AGPL-3.0-or-later
"""Checks on the real pinned image and inventory. They print and assert counts only; they need the upstream
worktree, the checkout's private config and the game image, and are skipped with the reason where absent."""
import pytest

pytestmark = pytest.mark.needs_checkout


def test_the_inventory_matches_the_published_numbers(upstream_worktree):
    from recon.adapters.skyrim.inventory import load_inventory

    inv = load_inventory(upstream_worktree)
    assert len(inv.targets) == 64010
    assert len(inv.unmatched()) == 62247
    assert (inv.progress_entries, inv.progress_matched) == (42221, 41235)


def test_a_sample_decodes_and_agrees_with_upstream_and_capstone(real_image, upstream_worktree, iced):
    pytest.importorskip("capstone", reason="needs the private venv")
    from recon.adapters.skyrim import crosscheck
    from recon.adapters.skyrim.inventory import load_inventory

    sample = load_inventory(upstream_worktree).unmatched()[::50]
    res = crosscheck.run(real_image, sample, capstone_every=2)
    assert res["upstream_x64"] == {"agree": len(sample)}
    assert set(res["capstone_sample"]) == {"agree"}


def test_the_unmatched_set_decodes_completely_and_its_extents_agree_with_pdata(real_image, upstream_worktree, iced):
    from recon.adapters.skyrim import survey
    from recon.adapters.skyrim.inventory import load_inventory

    ts = load_inventory(upstream_worktree).unmatched()[::7]
    report, _rows = survey.survey(real_image, ts)
    assert report["status"] == {"decoded": len(ts)}
    assert set(report["pdata_extent"]) <= {"exact", "leaf"}  # no function whose range and .pdata disagree


def test_rtti_finds_vtables_whose_slots_are_code(real_image, iced):
    from recon.adapters.x64_msvc import rtti

    vts = rtti.find_vtables(real_image.segments, real_image.image_base)
    assert len(vts) > 1000
    assert all(real_image.is_code(s) for v in vts for s in v.slots)
