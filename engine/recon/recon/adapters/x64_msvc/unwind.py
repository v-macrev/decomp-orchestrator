# SPDX-License-Identifier: AGPL-3.0-or-later
"""x64 UNWIND_INFO and `.pdata`, decoded the way contract v2 reads them (tools/pecoff.py `unwind_header`).

Only version 1 is decoded and a chain may not carry a handler: those are upstream's own refusals
(`unsupported-unwind`), reported here as the same reason code so that no search starts on a function the
comparator cannot accept. The reader is given a callback so this module touches no image format.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, replace
from typing import Callable

UNW_FLAG_EHANDLER = 1
UNW_FLAG_UHANDLER = 2
UNW_FLAG_CHAININFO = 4
FUNCINFO_MAGIC = 0x19930522

# the architecture's register numbering in unwind codes
REGISTERS = ("rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15")

Reader = Callable[[int, int], bytes]  # (rva, size) -> bytes; raises ValueError when unreadable


@dataclass(frozen=True)
class UnwindCode:
    """One prologue step. `offset`: where the step's instruction ends, from the entry's begin."""

    offset: int
    alloc: int = 0                  # bytes the stack pointer goes down
    register: str | None = None     # the saved register
    push: bool = False
    slot: int = 0                   # saved by a move: its place above the stack pointer after the whole prologue
    vector: bool = False            # the saved register is a vector register
    sets_frame: bool = False


@dataclass(frozen=True)
class UnwindInfo:
    version: int
    flags: int
    prolog_size: int
    code_count: int
    #: RUNTIME_FUNCTION this entry chains to: (begin, end, unwind info RVA)
    chained: tuple[int, int, int] | None
    #: language-specific handler RVA and the RVA of its data
    handler: int | None
    handler_data: int | None
    #: upstream reason code when the comparator cannot take this entry, else None
    refusal: str | None
    #: prologue steps in the order of the table (last step first); None when one of them is not understood
    codes: tuple[UnwindCode, ...] | None = ()


def _codes(raw: bytes, count: int) -> tuple[UnwindCode, ...] | None:
    out: list[UnwindCode] = []
    k = 0

    def slots(n: int) -> int:
        if k + n >= count:
            raise ValueError("a code runs past the table")
        return int.from_bytes(raw[2 * k + 2 : 2 * k + 2 + 2 * n], "little")

    try:
        while k < count:
            offset, op, inf = raw[2 * k], raw[2 * k + 1] & 15, raw[2 * k + 1] >> 4
            used = 1
            if op == 0:
                out.append(UnwindCode(offset, 8, REGISTERS[inf], push=True))
            elif op == 1 and inf in (0, 1):
                used = 2 + inf
                v = slots(used - 1)
                out.append(UnwindCode(offset, v * 8 if inf == 0 else v))
            elif op == 2:
                out.append(UnwindCode(offset, inf * 8 + 8))
            elif op == 3:
                out.append(UnwindCode(offset, sets_frame=True))
            elif op in (4, 5):
                used = op - 2
                v = slots(used - 1)
                out.append(UnwindCode(offset, register=REGISTERS[inf], slot=v * 8 if op == 4 else v))
            elif op in (8, 9):
                used = op - 6
                v = slots(used - 1)
                out.append(UnwindCode(offset, register=f"xmm{inf}", vector=True, slot=v * 16 if op == 8 else v))
            else:
                return None  # a machine frame, or a code version 1 does not define
            k += used
    except ValueError:
        return None
    return tuple(out)


def read_unwind(read: Reader, rva: int) -> UnwindInfo:
    """The header as upstream reads it, plus the decoded prologue steps."""
    info = _header(read, rva)
    if info.refusal or not info.code_count:
        return info
    return replace(info, codes=_codes(read(rva + 4, 2 * info.code_count), info.code_count))


def _header(read: Reader, rva: int) -> UnwindInfo:
    head = read(rva, 4)
    version, flags = head[0] & 7, head[0] >> 3
    prolog, count = head[1], head[2]
    if version != 1:
        return UnwindInfo(version, flags, prolog, count, None, None, None, "unsupported-unwind")
    if flags & UNW_FLAG_CHAININFO and flags & (UNW_FLAG_EHANDLER | UNW_FLAG_UHANDLER):
        return UnwindInfo(version, flags, prolog, count, None, None, None, "unsupported-unwind")
    at = rva + 4 + 2 * (count + (count & 1))
    if flags & UNW_FLAG_CHAININFO:
        b, e, u = struct.unpack("<III", read(at, 12))
        return UnwindInfo(version, flags, prolog, count, (b, e, u), None, None, None)
    if flags & (UNW_FLAG_EHANDLER | UNW_FLAG_UHANDLER):
        handler, data = struct.unpack("<II", read(at, 8))
        return UnwindInfo(version, flags, prolog, count, None, handler, at + 4, None)
    return UnwindInfo(version, flags, prolog, count, None, None, None, None)


def funcinfo_magic(read: Reader, info: UnwindInfo) -> int | None:
    """The magic of the FuncInfo a handler's data starts with (its first field is the FuncInfo RVA), or None if it holds no readable one."""
    if info.handler_data is None:
        return None
    try:
        (funcinfo,) = struct.unpack("<I", read(info.handler_data, 4))
        (magic,) = struct.unpack("<I", read(funcinfo, 4))
        return magic
    except (ValueError, struct.error):
        return None
