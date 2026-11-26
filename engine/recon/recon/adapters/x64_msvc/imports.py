# SPDX-License-Identifier: AGPL-3.0-or-later
"""What an image imports: for every slot of its import address table, the library and the name of the function the loader
puts there (D-052).

The import directory lists, per library, the slots of the table and, in the lookup table beside them, each slot's function by
name (or by ordinal, which names nothing). The table's own bytes in the file are not the address the loader writes there, so
they are never a constant of the program.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Callable

#: data directory entries
IMPORT_DIRECTORY = 1
IAT_DIRECTORY = 12


@dataclass(frozen=True)
class Import:
    library: str
    name: str | None          # None: imported by ordinal


def directories(blob: bytes) -> list[tuple[int, int]]:
    """The data directories of a PE32+ image: (RVA, size) each."""
    pe = struct.unpack_from("<I", blob, 0x3C)[0]
    if blob[pe:pe + 4] != b"PE\0\0":
        raise ValueError("not a PE image")
    opt = pe + 24
    if struct.unpack_from("<H", blob, opt)[0] != 0x20B:
        raise ValueError("not a PE32+ image")
    count = struct.unpack_from("<I", blob, opt + 108)[0]
    return [struct.unpack_from("<II", blob, opt + 112 + 8 * k) for k in range(min(count, 16))]


def _cstring(read: Callable[[int, int], bytes], rva: int) -> str:
    """The string at `rva`, read in chunks that shrink near the end of its section, which may end with the string."""
    out = b""
    n = 64
    while True:
        try:
            chunk = read(rva + len(out), n)
        except ValueError:
            if n == 1:
                raise
            n //= 2
            continue
        k = chunk.find(b"\0")
        if k >= 0:
            return (out + chunk[:k]).decode("ascii", "replace")
        out += chunk


def import_slots(blob: bytes, read: Callable[[int, int], bytes]) -> dict[int, Import]:
    """Every slot of the import address table (its RVA) and what the loader puts there. `read(rva, n)`: the image's bytes."""
    dirs = directories(blob)
    if len(dirs) <= IMPORT_DIRECTORY or not dirs[IMPORT_DIRECTORY][0]:
        return {}
    at, _size = dirs[IMPORT_DIRECTORY]
    out: dict[int, Import] = {}
    while True:
        lookup, _stamp, _chain, name_rva, iat = struct.unpack("<IIIII", read(at, 20))
        if not (lookup or name_rva or iat):
            break
        library = _cstring(read, name_rva).lower()
        names = lookup or iat
        k = 0
        while True:
            entry = struct.unpack("<Q", read(names + 8 * k, 8))[0]
            if not entry:
                break
            name = None if entry >> 63 else _cstring(read, (entry & 0x7FFFFFFF) + 2)
            out[iat + 8 * k] = Import(library, name)
            k += 1
        at += 20
    return out


def iat_range(blob: bytes) -> tuple[int, int]:
    """The import address table's extent, [begin, end) RVAs; (0, 0) when the image has none."""
    dirs = directories(blob)
    if len(dirs) <= IAT_DIRECTORY:
        return 0, 0
    b, n = dirs[IAT_DIRECTORY]
    return b, b + n


__all__ = ["IAT_DIRECTORY", "IMPORT_DIRECTORY", "Import", "directories", "iat_range", "import_slots"]
