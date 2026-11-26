# SPDX-License-Identifier: AGPL-3.0-or-later
"""The extent of a leaf function, which has no unwind data.

The x64 calling convention requires unwind data of every function that moves the stack pointer, saves a register the caller
expects preserved, or calls; a function that does none of these, a leaf, needs none, and the image's exception directory does
not list it (D-049 gives the extents of the functions it lists). Such a function is found where something calls it: decoded
from there, following both ways of every branch, it must

- never call, never write the stack pointer (but by `ret`) and never write a register the convention preserves;
- end every path in `ret`, a jump to the start of a known function (a tail call) or a jump through a pointer in memory;
- decode cleanly within the bytes it may have: up to the next known function or the end of the executable section;
- be contiguous: its instructions do not overlap, and what lies between them is padding.

Its extent is then from where it is called to the end of its last instruction. Anything else is no leaf, and the address
stays no extent, as before; this says nothing about the function there but that it is not one of these.
"""
from __future__ import annotations

from typing import Callable

from recon.adapters.x64_msvc.decode import _iced


def _sets(ix) -> tuple[frozenset[int], frozenset[int]]:
    R, A = ix.Register, ix.OpAccess
    preserved = {R.RBX, R.RBP, R.RSI, R.RDI, R.R12, R.R13, R.R14, R.R15} | {getattr(R, f"ZMM{k}") for k in range(6, 16)}
    writes = {A.WRITE, A.READ_WRITE, A.COND_WRITE, A.READ_COND_WRITE}
    return frozenset(preserved), frozenset(writes)


def leaf_extent(code: bytes, rva: int, image_base: int, is_start: Callable[[int], bool]) -> tuple[int | None, str]:
    """The size of the leaf function at `rva`, or None, and a fixed code that says which. `code`: the bytes from `rva` to the
    most it may reach (the next known function or the end of the executable section); `is_start(rva)`: whether a known
    function starts there."""
    ix = _iced()
    F = ix.FlowControl
    preserved, writes = _sets(ix)
    full = ix.RegisterExt.full_register
    hi = rva + len(code)
    dec = ix.Decoder(64, code, ip=image_base + rva)
    info = ix.InstructionInfoFactory()
    seen: dict[int, int] = {}
    todo = [rva]
    while todo:
        pc = todo.pop()
        while pc not in seen:
            dec.position, dec.ip = pc - rva, image_base + pc
            i = dec.decode()
            end = pc + i.len
            if i.code == ix.Code.INVALID or end > hi:
                return None, "DOES_NOT_DECODE"
            seen[pc] = end
            fc = i.flow_control
            if fc in (F.CALL, F.INDIRECT_CALL):
                return None, "CALLS"
            for r in info.info(i).used_registers():
                if r.access in writes:
                    reg = full(r.register)
                    if reg == ix.Register.RSP and fc != F.RETURN:
                        return None, "MOVES_THE_STACK"
                    if reg in preserved:
                        return None, "WRITES_A_PRESERVED_REGISTER"
            if fc == F.NEXT:
                pc = end
            elif fc == F.RETURN:
                break
            elif fc in (F.UNCONDITIONAL_BRANCH, F.CONDITIONAL_BRANCH):
                t = i.near_branch_target - image_base
                if rva <= t < hi:
                    todo.append(t)
                elif not is_start(t):
                    return None, "JUMPS_OUT_OF_ITS_BYTES"
                if fc == F.UNCONDITIONAL_BRANCH:
                    break
                pc = end
            elif fc == F.INDIRECT_BRANCH and i.is_ip_rel_memory_operand:
                break                                # a tail call through a pointer the image holds
            elif fc == F.INDIRECT_BRANCH:
                return None, "JUMPS_THROUGH_A_VALUE"
            else:
                return None, "TRAPS"
    spans = sorted(seen.items())
    for (a, b), (c, _d) in zip(spans, spans[1:]):
        if c < b:
            return None, "OVERLAPPING_INSTRUCTIONS"
        if c > b and not _padding(ix, code[b - rva:c - rva], b, image_base):
            return None, "NOT_CONTIGUOUS"
    return spans[-1][1] - rva, "LEAF"


def _padding(ix, gap: bytes, at: int, image_base: int) -> bool:
    """Whether bytes no path reaches are padding: no-operation and breakpoint instructions, decoding exactly to their end."""
    dec = ix.Decoder(64, gap, ip=image_base + at)
    while dec.can_decode:
        i = dec.decode()
        if i.code == ix.Code.INVALID or i.mnemonic not in (ix.Mnemonic.NOP, ix.Mnemonic.INT3):
            return False
    return True


__all__ = ["leaf_extent"]
