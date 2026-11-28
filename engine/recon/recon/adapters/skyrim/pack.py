# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reconstruction of functions of an image described by a pack: the image and the extents of its functions.

A pack is what a synthetic target comes as. It has no sources. It may have declarations of external functions, each with
the linker map entry that placed it: those name their functions and give their signatures. Everything else the source
needs is inferred: signatures from the code of the function and its callees, layouts from accesses.
"""
from __future__ import annotations

from pathlib import Path

from recon.adapters.skyrim.packfacts import SCN_MEM_EXECUTE, SCN_MEM_WRITE, PackFacts  # noqa: F401
from recon.adapters.skyrim.verify import PASS, Verifier
from recon.adapters.x64_msvc import coff
from recon.adapters.x64_msvc.batch import Compiler, distance
from recon.adapters.x64_msvc.cl import Toolchain
from recon.adapters.x64_msvc.symbols import scoped
from recon.adapters.x64_msvc.threads import thread_locals
from recon.core import budget as bg
from recon.core.inference.whole import Program
from recon.core.synthesis import search
from recon.core.synthesis.candidates import Candidate
from recon.core.synthesis.thread import ThreadLocals


class Pack(PackFacts):
    """A pack: its image's facts (`PackFacts`), the candidates of whose functions are compiled and verified here."""

    def thread_locals(self) -> ThreadLocals | None:
        """Where the image keeps its thread-local variables, from its thread-local directory (D-074); None without one."""
        try:
            template = self.image.pe.tls_template()
        except self.image.up.pecoff.Reject:      # an image with no (or no valid) directory
            template = None
        return thread_locals(template, self.image.image_base)

    def program(self) -> Program:
        """The facts' program, with where the image keeps its thread-local variables for the source it writes (`thread`):
        none of the facts depends on it."""
        p = super().program()
        p.thread = self.thread_locals()  # type: ignore[attr-defined]
        return p


class Workshop:
    """Compiles, ranks and verifies the candidates of one function."""

    def __init__(self, pack: Pack, rva: int, compiler: Compiler, verifier: Verifier) -> None:
        self.pack, self.rva, self.compiler, self.verifier = pack, rva, compiler, verifier
        self.target = pack.image.read(rva, pack.size[rva])
        self.report: dict | None = None

    def _resolver(self, c: Candidate):
        """Where a relocation of the candidate's object leads: the symbol map (the candidate itself, declared functions),
        then the names the pack's own naming gives callees and data by address, then compiler-made constants."""
        base = self.pack.image.image_base
        names = {n: a - base for n, a in (*c.unit.callees, *c.unit.globals)}

        def resolve(r: coff.Reloc) -> int | None:
            if coff.plain(r.symbol) == c.unit.name:
                return self.rva
            at = self.pack.symbols.resolve(r.symbol)
            if at is not None:
                return at
            n = coff.plain(r.symbol)
            if n in names and not self._declared_name(n):
                return names[n]
            return self._data(r)
        return resolve

    def _declared_name(self, n: str) -> bool:
        """A plain name a declaration gives: it resolves by its decorated name or not at all."""
        return any(scoped(s) == n for s, _sig in self.pack.declarations.values())

    def _data(self, r: coff.Reloc) -> int | None:
        """Data the object holds itself: the place in read-only memory the target's own field leads to, if it holds the same."""
        if r.content is None or r.kind not in coff.REL32 or r.offset + 4 > len(self.target):
            return None
        to = self.rva + r.offset + 4 + coff.REL32[r.kind] + int.from_bytes(self.target[r.offset:r.offset + 4], "little", signed=True)
        n = self._extent(r)
        there = self.pack.bytes_at(self.pack.image.image_base + to, n)
        return to if n and there == r.content[:n] and self.pack.constant(self.pack.image.image_base + to, 8) is not None else None

    @staticmethod
    def _extent(r: coff.Reloc) -> int:
        """How many bytes a compiler-made constant has: its name says it."""
        for prefix in ("__real@", "__xmm@", "__ymm@"):
            if r.symbol.startswith(prefix):
                return len(r.symbol[len(prefix):]) // 2
        return 0

    def judge(self, candidates: list[Candidate]) -> list[search.Judged]:
        out = []
        for c, x in zip(candidates, self.compiler.batch([(c.unit.name, c.unit.text) for c in candidates])):
            if x.function is None:
                out.append(search.Judged(None, 0, x.errors))
                continue
            d = distance(x.function, self.target, self.rva, self._resolver(c))
            out.append(search.Judged(x.function.key(coff.plain), d.total, (), d.unknown))
        return out

    def verify(self, c: Candidate) -> tuple[bool, str]:
        x = self.compiler.exact(c.unit.name, c.unit.text)
        if x is None:
            return False, "EXACT_UNIT_DOES_NOT_COMPILE"
        resolve = self._resolver(c)
        symbols: dict[str, tuple[int, int | None]] = {}
        for r in x.function.relocs:
            at = resolve(r)
            if at is not None:
                symbols[r.symbol] = (at, self.pack.size.get(at))
        self.report = self.verifier.verify(self.rva, self.pack.size[self.rva], x.function.symbol, x.source.encode("ascii"), x.object, symbols)
        return self.report["result"] == "pass" and self.report["reason"] == PASS, str(self.report["reason"])


def reconstruct(pack: Pack, rva: int, tool: Toolchain, flags: list[str], verifier: Verifier, work: Path, budget: bg.Budget | None = None,
                frontier: search.Frontier | None = None) -> tuple[search.Result, Workshop]:
    shop = Workshop(pack, rva, Compiler(tool, flags, work), verifier)
    return search.reconstruct(pack.program(), pack.image.image_base + rva, shop, budget, frontier), shop


__all__ = ["Pack", "Workshop", "reconstruct"]
