# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reconstruction of functions of an image described by a pack: the image and the extents of its functions.

A pack is what a synthetic target comes as. It has no names, no sources and no declarations, so everything the source
needs is inferred: signatures from the code of the function and its callees, layouts from accesses.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from recon.adapters.skyrim.image import PinnedImage
from recon.adapters.skyrim.verify import PASS, Verifier
from recon.adapters.x64_msvc import coff
from recon.adapters.x64_msvc import program as pg
from recon.adapters.x64_msvc import unwind as uw
from recon.adapters.x64_msvc.abi import CALLING, SOURCE
from recon.adapters.x64_msvc.batch import Compiler, distance
from recon.adapters.x64_msvc.cl import Toolchain
from recon.core.inference.signature import NotReconstructed
from recon.core.ir import passes, validate
from recon.core.ir.model import Fn
from recon.core.synthesis import search
from recon.core.synthesis.candidates import Candidate, Program

SCN_MEM_WRITE = 0x8000_0000
SCN_MEM_EXECUTE = 0x2000_0000


@dataclass
class Pack:
    build_id: str
    image: PinnedImage
    size: dict[int, int]             # function RVA -> size
    validated: frozenset[str] | None

    @staticmethod
    def load(path: str | Path, worktree: str | Path, validated: frozenset[str] | None) -> "Pack":
        path = Path(path)
        d = json.loads(path.read_text(encoding="utf-8"))
        if d.get("schema") != 1:
            raise ValueError("unknown pack schema")
        img = PinnedImage(path.parent / d["image"], worktree, d["image_sha256"])
        return Pack(d["build_id"], img, {int(f["rva"]): int(f["size"]) for f in d["functions"]}, validated)

    # -- what the engine asks of an image -------------------------------------------------------
    def normal(self, at: int) -> Fn:
        rva = at - self.image.image_base
        if rva not in self.size:
            raise NotReconstructed("NOT_A_FUNCTION_OF_THE_PACK")
        n = self.size[rva]
        entries = [(b, e, uw.read_unwind(self.image.read, u)) for b, e, u in self.image.runtime_functions() if rva <= b < rva + n]
        a = pg.analyse(self.image.read(rva, n), rva, self.image.image_base, self.validated, entries)
        if isinstance(a, pg.Refusal):
            raise NotReconstructed(a.code)
        fn = pg.to_ir(a, self.image.image_base, entries, self.image.read)
        if isinstance(fn, pg.Refusal):
            raise NotReconstructed(fn.detail.upper().replace("-", "_"))
        return validate.require(validate.admit(passes.normalise(fn, CALLING), CALLING))

    def constant(self, at: int, width: int) -> int | None:
        rva = at - self.image.image_base
        try:
            s = self.image.pe.section_for(rva)
            if s.flags & (SCN_MEM_WRITE | SCN_MEM_EXECUTE):
                return None
            return int.from_bytes(self.image.read(rva, width // 8), "little")
        except (ValueError, self.image.up.pecoff.Reject):
            return None

    def bytes_at(self, at: int, n: int) -> bytes | None:
        try:
            return self.image.read(at - self.image.image_base, n)
        except ValueError:
            return None

    def program(self) -> Program:
        return Program(self.normal, SOURCE, CALLING, self.image.image_base, self.bytes_at, self.constant)


class Workshop:
    """Compiles, ranks and verifies the candidates of one function."""

    def __init__(self, pack: Pack, rva: int, compiler: Compiler, verifier: Verifier) -> None:
        self.pack, self.rva, self.compiler, self.verifier = pack, rva, compiler, verifier
        self.target = pack.image.read(rva, pack.size[rva])
        self.report: dict | None = None

    def _resolver(self, c: Candidate):
        base = self.pack.image.image_base
        names = {n: a - base for n, a in (*c.unit.callees, *c.unit.globals)}
        names[c.unit.name] = self.rva

        def resolve(r: coff.Reloc) -> int | None:
            n = coff.plain(r.symbol)
            if n in names:
                return names[n]
            return self._data(r)
        return resolve

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
            out.append(search.Judged(x.function.key(coff.plain), distance(x.function, self.target, self.rva, self._resolver(c)).total))
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


def reconstruct(pack: Pack, program: Program, rva: int, tool: Toolchain, flags: list[str], verifier: Verifier, work: Path) -> tuple[search.Result, Workshop]:
    shop = Workshop(pack, rva, Compiler(tool, flags, work), verifier)
    return search.reconstruct(program, pack.image.image_base + rva, shop), shop


__all__ = ["Pack", "Workshop", "reconstruct"]
