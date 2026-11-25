# SPDX-License-Identifier: AGPL-3.0-or-later
"""x64 UNWIND_INFO and `.pdata`, decoded the way contract v2 reads them (tools/pecoff.py `unwind_header`).

Only version 1 is decoded and a chain may not carry a handler: those are upstream's own refusals
(`unsupported-unwind`), reported here as the same reason code so that no search starts on a function the
comparator cannot accept. The reader is given a callback so this module touches no image format.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Callable

UNW_FLAG_EHANDLER = 1
UNW_FLAG_UHANDLER = 2
UNW_FLAG_CHAININFO = 4
FUNCINFO_MAGIC = 0x19930522

Reader = Callable[[int, int], bytes]  # (rva, size) -> bytes; raises ValueError when unreadable


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


def read_unwind(read: Reader, rva: int) -> UnwindInfo:
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
