# SPDX-License-Identifier: AGPL-3.0-or-later
"""Image loading, address mapping, inventory and per-function analysis on a synthetic PE (no game data)."""
import hashlib

import pytest

from pe_builder import IMAGE_BASE, PDATA_RVA, RDATA_RVA, TEXT_RVA, build_pe, unwind_info

from recon.adapters.skyrim.inventory import load_inventory, size_bucket


def write(tmp_path, blob):
    p = tmp_path / "img.bin"
    p.write_bytes(blob)
    return p, hashlib.sha256(blob).hexdigest()


# three functions in .text: a plain one with unwind data, a leaf, one whose unwind info has version 2
F1 = bytes([0x48, 0x83, 0xEC, 0x28, 0x48, 0x83, 0xC4, 0x28, 0xC3])           # sub rsp,28h ; add rsp,28h ; ret
F2 = bytes([0x31, 0xC0, 0xC3])                                                # xor eax,eax ; ret
F3 = bytes([0x90, 0xC3])
TEXT = F1 + b"\xCC" * 7 + F2 + b"\xCC" * 13 + F3                              # offsets 0, 16, 32
RVA1, RVA2, RVA3 = TEXT_RVA, TEXT_RVA + 16, TEXT_RVA + 32


def image(tmp_path, extra_pdata=()):
    rdata = unwind_info(prolog=4, codes=1) + b"\0" * 4 + unwind_info(version=2)
    ok_unwind, bad_unwind = RDATA_RVA, RDATA_RVA + len(unwind_info(prolog=4, codes=1)) + 4
    entries = [(RVA1, RVA1 + len(F1), ok_unwind), (RVA3, RVA3 + len(F3), bad_unwind), *extra_pdata]
    return write(tmp_path, build_pe(TEXT, rdata, sorted(entries)))


@pytest.fixture
def img(tmp_path, upstream_worktree, iced):
    from recon.adapters.skyrim.image import PinnedImage

    p, sha = image(tmp_path)
    return PinnedImage(p, upstream_worktree, expected_sha256=sha)


def test_load_checks_the_hash_and_maps_addresses(tmp_path, upstream_worktree):
    from recon.adapters.skyrim.image import ImageHashMismatch, PinnedImage

    p, sha = image(tmp_path)
    with pytest.raises(ImageHashMismatch):
        PinnedImage(p, upstream_worktree, expected_sha256="0" * 64)
    im = PinnedImage(p, upstream_worktree, expected_sha256=sha)
    assert im.image_base == IMAGE_BASE and im.sha256 == sha
    assert im.read(RVA1, len(F1)) == F1
    assert im.section_name_at(RVA2) == ".text" and im.section_name_at(0x9000_0000) is None
    assert im.is_code(RVA1) and not im.is_code(RDATA_RVA)
    assert im.pe.blob[im.file_offset(RVA2)] == F2[0]
    assert [(s.name, s.executable) for s in im.segments] == [(".text", True), (".rdata", False), (".pdata", False)]


def test_unreadable_ranges_are_reported_with_upstreams_reason(img):
    with pytest.raises(ValueError, match="target-range-outside-image"):
        img.read(0x7000_0000, 4)


def test_runtime_functions_are_sorted_pdata(img):
    assert [b for b, _e, _u in img.runtime_functions()] == [RVA1, RVA3]


def test_analyse_plain_function_with_unwind(img):
    from recon.adapters.skyrim import survey as sv

    f = sv.analyse_function(img, RVA1, len(F1))
    assert (f.status, f.insns, f.unwind, f.extent, f.pdata_entries) == (sv.DECODED, 3, "plain", "exact", 1)


def test_a_leaf_without_pdata_is_decoded_and_marked_leaf(img):
    from recon.adapters.skyrim import survey as sv

    f = sv.analyse_function(img, RVA2, len(F2))
    assert (f.status, f.unwind, f.extent) == (sv.DECODED, "none", "leaf")


def test_unwind_version_two_blocks_with_upstreams_reason(img):
    from recon.adapters.skyrim import survey as sv

    f = sv.analyse_function(img, RVA3, len(F3))
    assert (f.status, f.reason, f.unwind) == (sv.BLOCKED, "unsupported-unwind", "refused")


def test_a_pdata_entry_crossing_the_range_blocks(tmp_path, upstream_worktree, iced):
    from recon.adapters.skyrim import survey as sv
    from recon.adapters.skyrim.image import PinnedImage

    rdata = unwind_info(codes=0)
    p, sha = write(tmp_path, build_pe(TEXT, rdata, [(RVA1, RVA1 + 40, RDATA_RVA)]))  # the entry runs past the 9-byte range
    f = sv.analyse_function(PinnedImage(p, upstream_worktree, expected_sha256=sha), RVA1, len(F1))
    assert (f.status, f.reason) == (sv.BLOCKED, "unwind-entry-crosses-boundary")


def test_addresses_without_file_content_are_value_errors_not_other_bytes(img):
    for rva in (0x7000_0000, RDATA_RVA + 0xFFF):  # outside the image; inside the section's page but past its file content
        with pytest.raises(ValueError):
            img.file_offset(rva)
        with pytest.raises(ValueError):
            img.read_cstr(rva)


def test_an_undecodable_tail_is_never_assumed_to_be_data(tmp_path, upstream_worktree, iced):
    from recon.adapters.skyrim import survey as sv
    from recon.adapters.skyrim.image import PinnedImage

    p, sha = write(tmp_path, build_pe(bytes([0x31, 0xC0, 0xC3, 0x06, 0x06, 0x06])))  # xor eax,eax ; ret ; undecodable
    f = sv.analyse_function(PinnedImage(p, upstream_worktree, expected_sha256=sha), RVA1, 6)
    assert (f.status, f.reason, f.stop_offset) == (sv.INVALID, "invalid-instruction", 3)
    assert sv.coverage_if([f], {"XOR", "RET"})["fully_covered"] == 0


def test_a_branch_into_an_instruction_blocks(tmp_path, upstream_worktree, iced):
    from recon.adapters.skyrim import survey as sv
    from recon.adapters.skyrim.image import PinnedImage

    p, sha = write(tmp_path, build_pe(bytes([0x74, 0x01, 0xB8, 1, 0, 0, 0, 0xC3])))
    f = sv.analyse_function(PinnedImage(p, upstream_worktree, expected_sha256=sha), RVA1, 8)
    assert (f.status, f.reason) == (sv.BLOCKED, "branch-into-instruction")


def test_a_range_outside_file_content_is_unreadable(img):
    from recon.adapters.skyrim import survey as sv

    f = sv.analyse_function(img, 0x7000_0000, 16)
    assert (f.status, f.reason) == (sv.UNREADABLE, "target-range-outside-image")


def test_survey_aggregates_counts_only(img):
    from recon.adapters.skyrim import survey as sv
    from recon.adapters.skyrim.inventory import Target

    ts = [Target(RVA1, len(F1), "", None), Target(RVA2, len(F2), "", None), Target(RVA3, len(F3), "", None)]
    report, rows = sv.survey(img, ts)
    assert report["functions"] == 3 and report["status"] == {"blocked": 1, "decoded": 2}
    assert report["pdata_extent"] == {"exact": 2, "leaf": 1}
    assert report["refusal_reasons"] == {"unsupported-unwind": 1}
    assert report["instructions"] == 3 + 2 + 2
    cov = sv.coverage_if(rows, {"SUB", "ADD", "RET", "XOR", "NOP"})
    assert cov["fully_covered"] == 2  # the blocked function is never covered
    assert sv.coverage_if(rows, {"SUB", "ADD", "RET"})["blocked_by_one_form"] == {"XOR": 1}


def test_inventory_marks_unmatched_and_missing_progress_entries(synthetic_inventory):
    inv = load_inventory(synthetic_inventory)
    assert [t.rva for t in inv.targets] == [0x1000, 0x1100, 0x1200]  # the duplicate is one function, sorted by RVA
    assert [t.rva for t in inv.unmatched()] == [0x1100, 0x1200]
    assert all(t.progress_status is None for t in inv.unmatched())  # an offered target need not have a progress entry
    assert (inv.progress_entries, inv.progress_matched) == (2, 1)
    # a recorded but unmatched function that is not offered is a population of its own, and every start is known
    assert [(t.rva, t.progress_status) for t in inv.recorded_unmatched] == [(0x9000, "mapped")]
    assert inv.known_starts == {0x1000, 0x1100, 0x1200, 0x9000}


@pytest.mark.parametrize("row", [{"rva": 0x1100, "size": 44}, {"rva": 0x1110, "size": 4}])
def test_a_list_that_contradicts_itself_is_refused(synthetic_inventory, row):
    import json

    from recon.adapters.skyrim.inventory import InventoryConflict

    p = synthetic_inventory / "data/target-hashes/contributor-targets-part-000.json"
    part = json.loads(p.read_text())
    part["functions"].append({**row, "extent_source": "x"})
    p.write_text(json.dumps(part))
    with pytest.raises(InventoryConflict):
        load_inventory(synthetic_inventory)


def test_size_buckets():
    assert [size_bucket(n) for n in (1, 16, 17, 1024, 1025)] == ["<=16", "<=16", "<=32", "<=1024", ">1024"]


def test_upstream_modules_are_imported_from_the_pinned_worktree_with_digests(upstream_worktree):
    from recon.adapters.skyrim import upstream

    up = upstream.load(upstream_worktree)
    assert set(up.digests) == {"tools/pecoff.py", "tools/analysis/x64.py"}
    assert all(len(d) == 64 for d in up.digests.values())
    assert up.pecoff.__file__.startswith(str(upstream_worktree.resolve()))
