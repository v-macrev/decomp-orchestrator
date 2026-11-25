# SPDX-License-Identifier: AGPL-3.0-or-later
"""A minimal PE32+ x86-64 image built from original synthetic bytes, so the loaders run on the same code paths
as for the real target without any game data."""
from __future__ import annotations

import struct

IMAGE_BASE = 0x1_4000_0000
TEXT_RVA, RDATA_RVA, PDATA_RVA = 0x1000, 0x2000, 0x3000
SCN_CODE_EXEC_READ = 0x6000_0020
SCN_DATA_READ = 0x4000_0040


def _pad(b: bytes, to: int = 0x200) -> bytes:
    return b + b"\0" * (-len(b) % to or 0) if b else b"\0" * to


def build_pe(text: bytes, rdata: bytes = b"", runtime_functions: list[tuple[int, int, int]] | None = None, image_base: int = IMAGE_BASE) -> bytes:
    pdata = b"".join(struct.pack("<III", *e) for e in (runtime_functions or []))
    secs = [(b".text", TEXT_RVA, text, SCN_CODE_EXEC_READ), (b".rdata", RDATA_RVA, rdata, SCN_DATA_READ), (b".pdata", PDATA_RVA, pdata, SCN_DATA_READ)]
    opt_size = 112 + 16 * 8
    headers_end = 0x80 + 24 + opt_size + 40 * len(secs)
    first_raw = (headers_end + 0x1FF) // 0x200 * 0x200
    dos = b"MZ" + b"\0" * 58 + struct.pack("<I", 0x80)
    coff = struct.pack("<HHIIIHH", 0x8664, len(secs), 0, 0, 0, opt_size, 0x22)
    opt = bytearray(opt_size)
    struct.pack_into("<H", opt, 0, 0x20B)
    struct.pack_into("<Q", opt, 24, image_base)
    struct.pack_into("<I", opt, 108, 16)
    if pdata:
        struct.pack_into("<II", opt, 112 + 8 * 3, PDATA_RVA, len(pdata))
    table, body, raw = b"", b"", first_raw
    for name, rva, data, flags in secs:
        padded = _pad(data)
        table += struct.pack("<8sIIIIIIHHI", name, max(len(data), 1), rva, len(padded), raw, 0, 0, 0, 0, flags)
        body += padded
        raw += len(padded)
    head = dos + b"\0" * (0x80 - len(dos)) + b"PE\0\0" + coff + bytes(opt) + table
    return head + b"\0" * (first_raw - len(head)) + body


def unwind_info(*, version: int = 1, flags: int = 0, prolog: int = 0, codes: int = 0, tail: bytes = b"") -> bytes:
    """UNWIND_INFO header, `codes` unwind-code slots (zeros, padded to an even count) and `tail`."""
    slots = codes + (codes & 1)
    return bytes([version | (flags << 3), prolog, codes, 0]) + b"\0" * (2 * slots) + tail
