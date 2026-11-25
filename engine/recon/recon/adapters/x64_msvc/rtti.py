# SPDX-License-Identifier: AGPL-3.0-or-later
"""MSVC x64 RTTI and vtables, found from the image alone (evidence label EXE_RTTI, no symbols).

An x64 RTTICompleteObjectLocator is six 32-bit fields: signature (1), vtable offset, constructor offset,
TypeDescriptor RVA, ClassHierarchyDescriptor RVA and its own RVA. A vtable is the 64-bit address of such a
locator stored at `v - 8`, followed by code addresses. The self-RVA field makes a locator recognisable without
any name, so a stray `1` in data is not mistaken for one.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

from recon.core.model import Segment

COL_SIZE = 24


@dataclass(frozen=True)
class Vtable:
    rva: int                 # first slot
    locator: int             # RVA of the RTTICompleteObjectLocator
    type_descriptor: int     # RVA
    offset: int              # vtable offset inside the complete object (non-zero: a secondary base)
    slots: tuple[int, ...]   # code RVAs


def _segment_at(segments: list[Segment], rva: int) -> Segment | None:
    for s in segments:
        if s.rva <= rva < s.end:
            return s
    return None


def find_locators(segments: list[Segment]) -> dict[int, tuple[int, int, int]]:
    """{locator RVA: (type descriptor RVA, vtable offset, class hierarchy RVA)} over the non-code segments."""
    found: dict[int, tuple[int, int, int]] = {}
    sig = b"\x01\x00\x00\x00"
    for seg in segments:
        if seg.executable:
            continue
        data = seg.data
        p = data.find(sig)
        while p != -1:
            if p % 4 == 0 and p + COL_SIZE <= len(data):
                _s, off, _cd, td, chd, selfrva = struct.unpack_from("<6I", data, p)
                if selfrva == seg.rva + p and td and chd:
                    found[selfrva] = (td, off, chd)
            p = data.find(sig, p + 1)
    return found


def find_vtables(segments: list[Segment], image_base: int) -> list[Vtable]:
    locators = find_locators(segments)
    if not locators:
        return []
    by_va = {image_base + r: r for r in locators}
    code = [s for s in segments if s.executable]

    def is_code_va(q: int) -> bool:
        r = q - image_base
        return any(s.rva <= r < s.end for s in code)

    starts: list[tuple[int, int]] = []  # (vtable first-slot RVA, locator RVA)
    for seg in segments:
        if seg.executable:
            continue
        data = seg.data
        usable = len(data) - len(data) % 8
        # Qword values are examined at 8-byte alignment relative to the segment start (sections are page aligned).
        for k, (q,) in enumerate(struct.iter_unpack("<Q", data[:usable])):
            r = by_va.get(q)
            if r is not None:
                starts.append((seg.rva + 8 * k + 8, r))
    starts.sort()
    starts_set = {a for a, _ in starts}
    out: list[Vtable] = []
    for rva, loc in starts:
        seg = _segment_at(segments, rva)
        if seg is None or seg.executable:
            continue
        slots: list[int] = []
        at = rva
        while at + 8 <= seg.end:
            if at + 8 in starts_set:
                break  # this slot holds the next vtable's locator pointer
            (q,) = struct.unpack_from("<Q", seg.data, at - seg.rva)
            if not is_code_va(q):
                break
            slots.append(q - image_base)
            at += 8
        td, off, _chd = locators[loc]
        out.append(Vtable(rva, loc, td, off, tuple(slots)))
    return out


def type_name(read_cstr, td_rva: int) -> str | None:
    """The decorated class name of a TypeDescriptor (`.?AV…@@`); `read_cstr(rva)` returns bytes up to a NUL or raises ValueError."""
    try:
        raw = read_cstr(td_rva + 16)
    except ValueError:
        return None
    s = raw.decode("ascii", "replace")
    return s if s.startswith(".?A") else None
