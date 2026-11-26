# SPDX-License-Identifier: AGPL-3.0-or-later
"""Where the symbols an object refers to are in the image, from evidence only.

The evidence is ranked, highest first:

* `own`: the function being reconstructed, under the name its unit gives it
* `declared`: a declaration and the linker map that placed it (a decorated name, so the types are part of the name)
* `recorded`: a name the project records for an address (a plain or scoped name, so overloads are not told apart)

A name is looked up as written, then by its scoped form (`?Method@Class@@...` is `Class::Method`). A name that the
best-ranked evidence gives two addresses is ambiguous and resolves to nothing; so does a name nothing gives. Nothing
here looks at the target's bytes: a reference is bound because the evidence names it, and the comparator then checks it.
"""
from __future__ import annotations

from dataclasses import dataclass, field

RANKS = ("own", "declared", "recorded")


def scoped(symbol: str) -> str | None:
    """The scoped name a decorated name is about (`?b@a@@...` is `a::b`), the name itself when it is not decorated, or
    None for what has no such name: special members, templates, back-references, compiler-made names."""
    if not symbol.startswith("?"):
        return symbol if symbol.isidentifier() else None
    if symbol.startswith("??"):
        return None
    head, sep, _rest = symbol[1:].partition("@@")
    if not sep:
        return None
    parts = head.split("@")
    if not all(p.isidentifier() for p in parts):
        return None
    return "::".join(reversed(parts))


@dataclass
class SymbolMap:
    #: name -> rank -> the (rva, size) entries that rank gives it
    _names: dict[str, dict[str, set[tuple[int, int | None]]]] = field(default_factory=dict)

    def add(self, name: str, rva: int, size: int | None, rank: str) -> None:
        if rank not in RANKS:
            raise ValueError(f"unknown evidence rank {rank}")
        self._names.setdefault(name, {}).setdefault(rank, set()).add((rva, size))

    def _best(self, name: str) -> tuple[int, int | None] | None:
        by = self._names.get(name)
        if not by:
            return None
        for rank in RANKS:
            if rank in by:
                got = by[rank]
                return next(iter(got)) if len({r for r, _s in got}) == 1 else None
        return None

    def lookup(self, symbol: str) -> tuple[int, int | None] | None:
        """(rva, size or None) of what `symbol` names, or None when the evidence does not say, or says two things."""
        got = self._best(symbol)
        if got is not None or symbol in self._names:
            return got
        s = scoped(symbol)
        return self._best(s) if s is not None and s != symbol else None

    def resolve(self, symbol: str) -> int | None:
        got = self.lookup(symbol)
        return None if got is None else got[0]

    def __len__(self) -> int:
        return len(self._names)


__all__ = ["RANKS", "SymbolMap", "scoped"]
