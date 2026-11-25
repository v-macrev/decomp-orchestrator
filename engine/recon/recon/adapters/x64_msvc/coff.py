# SPDX-License-Identifier: AGPL-3.0-or-later
"""Object files, as far as judging a candidate needs: code sections, relocations, unwind data, symbols.

This reader ranks and deduplicates candidates. It decides nothing: upstream's comparator reads the object by itself.
"""
from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass

CODE = 0x20
NAME = 8
EXTERNAL = 2
REL32 = {4: 0, 5: 1, 6: 2, 7: 3, 8: 4, 9: 5}      # relocation type -> bytes between the field and the end of the instruction
ADDR64, ADDR32NB, SECREL = 1, 3, 11


class BadObject(ValueError):
    pass


@dataclass(frozen=True)
class Section:
    name: str
    data: bytes
    flags: int
    relocs: tuple[tuple[int, int, int], ...]     # (offset, symbol index, type)


@dataclass(frozen=True)
class Symbol:
    name: str
    value: int
    section: int
    storage: int


@dataclass(frozen=True)
class Reloc:
    offset: int
    kind: int
    symbol: str
    #: what the symbol holds when the object itself defines it as data, else None
    content: bytes | None


@dataclass(frozen=True)
class Function:
    symbol: str
    code: bytes
    relocs: tuple[Reloc, ...]
    #: unwind information of the function, without the relocated fields
    unwind: tuple[bytes, ...]

    def key(self, plain) -> str:
        """Digest of what the compiler made: code, references (named by `plain`) and unwind data."""
        h = hashlib.sha256()
        h.update(struct.pack("<I", len(self.code)) + self.code)
        for r in self.relocs:
            n = plain(r.symbol).encode()
            h.update(struct.pack("<IHI", r.offset, r.kind, len(n)) + n + (r.content or b""))
        for u in self.unwind:
            h.update(struct.pack("<I", len(u)) + u)
        return h.hexdigest()


class Object:
    def __init__(self, blob: bytes) -> None:
        try:
            self._read(blob)
        except (struct.error, IndexError) as e:
            raise BadObject("truncated object") from e

    def _read(self, b: bytes) -> None:
        machine, nsec, _t, at, count, opt, _c = struct.unpack_from("<HHIIIHH", b, 0)
        if machine != 0x8664 or opt:
            raise BadObject("not an x86-64 object")
        strings = b[at + 18 * count:]

        def name(raw: bytes) -> str:
            if raw[:4] == b"\0\0\0\0":
                k = struct.unpack_from("<I", raw, 4)[0]
                return strings[k:strings.index(b"\0", k)].decode("utf-8", "replace")
            return raw.rstrip(b"\0").decode("utf-8", "replace")
        self.sections: list[Section] = []
        for k in range(nsec):
            raw, _vs, _va, size, ptr, rptr, _l, nrel, _nl, flags = struct.unpack_from("<8sIIIIIIHHI", b, 20 + 40 * k)
            relocs = tuple(struct.unpack_from("<IIH", b, rptr + 10 * j) for j in range(nrel))
            self.sections.append(Section(raw.rstrip(b"\0").decode("ascii", "replace"), b[ptr:ptr + size] if ptr and not flags & 0x80 else b"\0" * size, flags, relocs))
        self.symbols: dict[int, Symbol] = {}
        k = 0
        while k < count:
            raw, value, section, _kind, storage, aux = struct.unpack_from("<8sIhHBB", b, at + 18 * k)
            self.symbols[k] = Symbol(name(raw), value, section, storage)
            k += 1 + aux

    def functions(self) -> dict[str, Function]:
        """External functions that start their own code section, by symbol."""
        out = {}
        for s in self.symbols.values():
            if s.storage == EXTERNAL and s.section > 0 and s.value == 0 and self.sections[s.section - 1].flags & CODE:
                sec = self.sections[s.section - 1]
                out[s.name] = Function(s.name, sec.data, tuple(self._reloc(r) for r in sorted(sec.relocs)), self._unwind(s.section))
        return out

    def _reloc(self, r: tuple[int, int, int]) -> Reloc:
        s = self.symbols[r[1]]
        content = None
        if s.section > 0 and not self.sections[s.section - 1].flags & CODE:
            content = self.sections[s.section - 1].data[s.value:]
        return Reloc(r[0], r[2], s.name, content)

    def _unwind(self, section: int) -> tuple[bytes, ...]:
        out = []
        for p in self.sections:
            if p.name != ".pdata":
                continue
            for k in range(len(p.data) // 12):
                fields = {o - 12 * k: self.symbols[i] for o, i, _t in p.relocs if 12 * k <= o < 12 * k + 12}
                if 0 in fields and fields[0].section == section and 8 in fields and fields[8].section > 0:
                    x = fields[8]
                    d = self.sections[x.section - 1].data[x.value:]
                    extent = struct.unpack_from("<II", p.data, 12 * k)
                    codes = d[2] + (d[2] & 1)
                    out.append(struct.pack("<II", *extent) + d[:4 + 2 * codes])
        return tuple(out)


def plain(symbol: str) -> str:
    """The identifier a decorated name is about, without scopes and types."""
    if symbol.startswith("?") and not symbol.startswith("??"):
        return symbol[1:].split("@", 1)[0]
    return symbol


__all__ = ["ADDR32NB", "ADDR64", "BadObject", "Function", "Object", "REL32", "Reloc", "Section", "Symbol", "plain"]
