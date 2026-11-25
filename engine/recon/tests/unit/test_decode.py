# SPDX-License-Identifier: AGPL-3.0-or-later
"""Decoder checks on original hand-assembled encodings (no game data)."""
import struct

import pytest

from recon.core.model import Flow

BASE = 0x1_4000_0000


@pytest.fixture
def dec(iced):
    from recon.adapters.x64_msvc import decode

    return decode


def b(*xs):
    return bytes(xs)


def test_straight_line_code_and_flow_kinds(dec):
    code = b(0x48, 0x83, 0xEC, 0x28) + b(0xE8) + struct.pack("<i", 0x100 - 9) + b(0x48, 0x83, 0xC4, 0x28, 0xC3)
    r = dec.decode_range(code, 0x1000, BASE)
    assert r.error is None and r.stop == 0x1000 + len(code)
    assert [i.length for i in r.insns] == [4, 5, 4, 1]
    assert [i.flow for i in r.insns] == [Flow.FALL, Flow.CALL, Flow.FALL, Flow.RETURN]
    assert r.insns[1].target == 0x1000 + 4 + 5 + (0x100 - 9)  # relative to the end of the call


def test_conditional_and_unconditional_branch_targets(dec):
    code = b(0x85, 0xC9, 0x74, 0x02, 0xEB, 0x00, 0xC3)  # test ecx,ecx ; je +2 ; jmp +0 ; ret
    r = dec.decode_range(code, 0x2000, BASE)
    assert [i.flow for i in r.insns] == [Flow.FALL, Flow.BRANCH, Flow.JUMP, Flow.RETURN]
    assert r.insns[1].target == 0x2006 and r.insns[2].target == 0x2006


def test_indirect_flow_kinds(dec):
    r = dec.decode_range(b(0xFF, 0xD0, 0xFF, 0xE0), 0x1000, BASE)  # call rax ; jmp rax
    assert [i.flow for i in r.insns] == [Flow.CALL_INDIRECT, Flow.JUMP_INDIRECT]
    assert all(i.target is None for i in r.insns)


def test_rip_relative_reference_is_an_rva(dec):
    code = b(0x48, 0x8D, 0x05) + struct.pack("<i", 0x500) + b(0xC3)  # lea rax,[rip+0x500]
    r = dec.decode_range(code, 0x1000, BASE)
    assert r.insns[0].data_ref == 0x1000 + 7 + 0x500


def test_invalid_instruction_stops_with_a_reason_and_position(dec):
    r = dec.decode_range(b(0x90, 0x90, 0x06, 0x90), 0x1000, BASE)  # 0x06 is invalid in 64-bit mode
    assert r.error == "invalid-instruction" and r.stop == 0x1002 and len(r.insns) == 2


def test_a_truncated_last_instruction_is_not_a_clean_end(dec):
    r = dec.decode_range(b(0x90, 0xE8, 0x01), 0x1000, BASE)  # call rel32 cut short
    assert r.error == "invalid-instruction" and r.stop == 0x1001


def test_trailing_rva_table_is_set_apart_from_the_code(dec):
    rva = 0x2000
    lea = b(0x48, 0x8D, 0x0D) + struct.pack("<i", 2)  # lea rcx,[rip+2]: past ret and the int3 pad, where the table starts
    code = lea + b(0xC3) + b(0xCC) + struct.pack("<II", rva, rva + 1)
    r = dec.decode_function(code, rva, BASE)
    assert r.data_start == rva + 9 and r.error is None and r.data_kind == "rva-table"
    assert [i.flow for i in r.insns] == [Flow.FALL, Flow.RETURN, Flow.TRAP]  # lea, ret, int3 padding
    assert r.end == rva + len(code)


def test_a_range_without_internal_references_is_all_code(dec):
    r = dec.decode_function(b(0x31, 0xC0, 0xC3), 0x1000, BASE)
    assert r.data_start is None and r.error is None and len(r.insns) == 2


def test_a_forward_reference_to_code_is_conflicting_evidence_not_a_table_and_not_silently_code(dec):
    code = b(0x48, 0x8D, 0x05) + struct.pack("<i", 0) + b(0xB8, 1, 0, 0, 0, 0xC3)  # lea rax,[rip+0] -> the next instruction
    r = dec.decode_function(code, 0x1000, BASE)
    assert r.data_start is None and r.error == "ambiguous-data-reference" and r.stop == 0x1007


def test_code_that_branches_into_the_supposed_table_is_conflicting_evidence(dec):
    # test ecx,ecx ; je +8 (into the "table") ; lea rax,[rip+1] ; ret ; table
    code = b(0x85, 0xC9, 0x74, 0x08) + b(0x48, 0x8D, 0x05) + struct.pack("<i", 1) + b(0xC3) + b(0x31, 0xC0, 0xC3, 0x90)
    r = dec.decode_function(code, 0x1000, BASE)
    assert r.data_start is None and r.error == "ambiguous-data-reference"


def test_padding_before_a_table_is_skipped_when_looking_for_the_terminator(dec):
    rva = 0x2000
    code = b(0x48, 0x8D, 0x0D) + struct.pack("<i", 3) + b(0xC3) + b(0x66, 0x90) + struct.pack("<I", rva)  # lea ; ret ; nop ; table
    r = dec.decode_function(code, rva, BASE)
    assert r.error is None and r.data_start == rva + 10 and r.data_kind == "rva-table"


def test_branches_that_land_inside_an_instruction_are_counted(dec):
    good = dec.decode_range(b(0x85, 0xC9, 0x74, 0x02, 0xEB, 0x00, 0xC3), 0x2000, BASE)
    assert dec.misdirected_branches(good.insns) == 0
    bad = dec.decode_range(b(0x74, 0x01, 0xB8, 1, 0, 0, 0, 0xC3), 0x2000, BASE)  # je into the mov's immediate
    assert dec.misdirected_branches(bad.insns) == 1
    assert dec.misdirected_branches(()) == 0


def test_displacement_only_operands_below_the_threshold_are_not_references(dec):
    code = b(0x8B, 0x80) + struct.pack("<i", 0x40) + b(0xC3)  # mov eax,[rax+0x40]
    r = dec.decode_function(code, 0x1000, BASE)
    assert r.data_start is None and r.insns[0].disp is None
