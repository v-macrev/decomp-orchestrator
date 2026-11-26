# SPDX-License-Identifier: AGPL-3.0-or-later
"""Leaf functions, which have no unwind data: their extents from where they are called, by the convention's own rule."""
from __future__ import annotations

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

from recon.adapters.x64_msvc.leaf import leaf_extent  # noqa: E402

BASE, AT = 0x140000000, 0x1000
KNOWN = {0x2000}


def leaf(*parts: bytes, room: int = 64) -> tuple[int | None, str]:
    code = b"".join(parts)
    return leaf_extent(code + b"\xcc" * (room - len(code)), AT, BASE, KNOWN.__contains__)


def test_a_function_that_reads_and_returns_is_a_leaf_as_long_as_its_code():
    assert leaf(b"\x8b\x01", b"\xc3") == (3, "LEAF")                          # mov eax,[rcx]; ret


def test_both_ways_of_a_branch_are_followed_and_the_extent_ends_with_the_last_instruction():
    # xor eax,eax; test ecx,ecx; je +5; mov eax,1; ret
    assert leaf(b"\x31\xc0", b"\x85\xc9", b"\x74\x05", b"\xb8\x01\x00\x00\x00", b"\xc3") == (12, "LEAF")


def test_padding_between_its_parts_belongs_to_it_and_data_does_not():
    # test ecx,ecx; jne +2; ret; nop; nop;  mov eax,1; ret
    assert leaf(b"\x85\xc9", b"\x75\x03", b"\xc3", b"\x90\x90", b"\xb8\x01\x00\x00\x00", b"\xc3") == (13, "LEAF")
    # jmp +2; two bytes that are no instruction; ret
    assert leaf(b"\xeb\x02", b"\x06\x07", b"\xc3")[0] is None


@pytest.mark.parametrize("code,why", [
    (b"\x53\x8b\x01\x5b\xc3", "MOVES_THE_STACK"),                               # push rbx ... pop rbx
    (b"\x48\x83\xec\x28\x48\x83\xc4\x28\xc3", "MOVES_THE_STACK"),               # sub rsp,28h ... add rsp,28h
    (b"\x48\x89\xcb\xc3", "WRITES_A_PRESERVED_REGISTER"),                       # mov rbx,rcx
    (b"\x0f\x28\xf0\xc3", "WRITES_A_PRESERVED_REGISTER"),                       # movaps xmm6,xmm0
    (b"\xe8\x00\x00\x00\x00\xc3", "CALLS"),                                     # call
    (b"\xff\xe0", "JUMPS_THROUGH_A_VALUE"),                                     # jmp rax: a table it cannot bound
    (b"\xe9\x00\x01\x00\x00", "JUMPS_OUT_OF_ITS_BYTES"),                        # jmp to no known function
    (b"\x0f\x0b", "TRAPS"),                                                     # ud2
    (b"\x8b\x01", "DOES_NOT_DECODE"),                                           # runs past what it may reach
])
def test_what_the_convention_requires_unwind_data_of_is_no_leaf(code, why):
    room = len(code) if why == "DOES_NOT_DECODE" else 64
    assert leaf(code, room=room) == (None, why)


def test_a_tail_call_to_a_known_function_or_through_a_pointer_ends_a_leaf():
    assert leaf(b"\x8b\x01", b"\xe9" + (0x2000 - (AT + 7)).to_bytes(4, "little", signed=True)) == (7, "LEAF")
    assert leaf(b"\xff\x25\x00\x10\x00\x00") == (6, "LEAF")                   # jmp [rip+1000h], as an import thunk


def test_a_loop_back_to_its_start_is_followed_once():
    # dec ecx; jne -4 (back to the start); ret
    assert leaf(b"\xff\xc9", b"\x75\xfc", b"\xc3") == (5, "LEAF")
