# SPDX-License-Identifier: AGPL-3.0-or-later
"""What the engine asks of a pack's image to analyse its functions: extents, normal forms, read-only constants, declarations
and imports, and the program that analyses them. The pack itself (`pack.Pack`) adds compiling and verifying candidates.

Every fact the store keeps is derived through this module and what it imports (`recon.core.knowledge.ANALYSIS_ROOTS`): it
imports no search, emitter or compiler, so that a change to those leaves the facts where they are.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from recon.adapters.skyrim.image import PinnedImage
from recon.adapters.skyrim.normal import leaf_size, normal_form
from recon.adapters.x64_msvc.abi import CALLING, SOURCE
from recon.adapters.x64_msvc.imports import Import
from recon.adapters.x64_msvc.symbols import SymbolMap, scoped
from recon.core import knowledge as kn
from recon.core.inference.signature import NotReconstructed, Signature, Slot
from recon.core.inference.whole import Program
from recon.core.ir.model import Fn

SCN_MEM_WRITE = 0x8000_0000
SCN_MEM_EXECUTE = 0x2000_0000


@dataclass
class PackFacts:
    build_id: str
    image: PinnedImage
    size: dict[int, int]             # function RVA -> size
    validated: frozenset[str] | None
    symbols: SymbolMap = field(default_factory=SymbolMap)
    #: function RVA -> (decorated name, signature), from declarations the linker map places
    declarations: dict[int, tuple[str, Signature]] = field(default_factory=dict)
    #: where what is learnt is kept across programs (`open_store`), or None
    store: "kn.Store | None" = None
    #: RVA -> the extent of the leaf function there, or None: found where something calls it (`extent`)
    _leaves: dict[int, int | None] = field(default_factory=dict, repr=False)
    #: slot RVA of the import address table -> what the loader puts there (D-052)
    imports: dict[int, Import] = field(default_factory=dict)
    #: imported function name -> the signature the platform's headers declare
    import_signatures: dict[str, Signature] = field(default_factory=dict)
    #: the import address table, [begin, end) RVAs
    iat: tuple[int, int] = (0, 0)
    _starts: list[int] | None = field(default=None, repr=False)

    @classmethod
    def load(cls, path: str | Path, worktree: str | Path, validated: frozenset[str] | None):
        path = Path(path)
        d = json.loads(path.read_text(encoding="utf-8"))
        if d.get("schema") != 1:
            raise ValueError("unknown pack schema")
        img = PinnedImage(path.parent / d["image"], worktree, d["image_sha256"])
        pack = cls(d["build_id"], img, {int(f["rva"]): int(f["size"]) for f in d["functions"]}, validated)
        slot = lambda v: None if v is None else Slot(str(v[0]), int(v[1]), str(v[2]) if len(v) > 2 else "")  # noqa: E731
        two: set[int] = set()
        for x in d.get("declarations", []):
            rva, size = int(x["rva"]), x.get("size")
            pack.symbols.add(x["symbol"], rva, None if size is None else int(size), "declared")
            if rva in pack.declarations and pack.declarations[rva][0] != x["symbol"]:
                two.add(rva)         # two declarations of one function: neither says what it is
            pack.declarations[rva] = (x["symbol"], Signature(tuple(slot(p) for p in x["params"]), slot(x["result"]), (("declared", "declaration"),)))
        for rva in two:
            del pack.declarations[rva]
        return pack

    # -- what the engine asks of an image -------------------------------------------------------
    def extent(self, rva: int) -> int | None:
        """The size of the function at `rva`: a listed one's, or a leaf function's, which has no unwind data and is found
        from where it is called (D-051). Which addresses are leaves depends only on the image and the listed extents, never
        on what was asked before, so every worker and every run finds the same ones. None: no function starts there."""
        n = self.size.get(rva)
        if n is not None:
            return n
        if rva not in self._leaves:
            self._leaves[rva] = self._leaf(rva)
        return self._leaves[rva]

    def _leaf(self, rva: int) -> int | None:
        if self._starts is None:
            self._starts = sorted(self.size)
        return leaf_size(self.image, self.size, self._starts, rva)

    def normal(self, at: int) -> Fn:
        rva = at - self.image.image_base
        n = self.extent(rva)
        if n is None:
            raise NotReconstructed("NOT_A_FUNCTION_OF_THE_PACK")
        return normal_form(self.image, self.validated, rva, n)

    def constant(self, at: int, width: int) -> int | None:
        rva = at - self.image.image_base
        if self.iat[0] <= rva < self.iat[1] or rva in self.imports:
            return None                     # what the file holds there is not what the loader writes
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

    def declared(self, at: int) -> tuple[str, Signature] | None:
        """The plain name and the signature a declaration gives the function at `at`. An import's thunk (a function that
        is one jump through a slot of the import address table) has the import's signature, under `library!name`, which
        is no name the source can call: it is known for what it takes and returns, not yet written as a call (D-052)."""
        d = self.declarations.get(at - self.image.image_base)
        if d is None:
            return self._thunk(at - self.image.image_base)
        name = scoped(d[0])
        return None if name is None else (name, d[1])

    def _thunk(self, rva: int) -> tuple[str, Signature] | None:
        n = self.extent(rva)
        if n not in (6, 7):
            return None
        b = self.image.read(rva, n)
        op = b[n - 6:]
        if op[:2] != bytes((0xFF, 0x25)) or (n == 7 and b[0] != 0x48):    # jmp [rip+disp32], or with REX.W
            return None
        imp = self.imports.get(rva + n + int.from_bytes(op[2:6], "little", signed=True))
        sig = self.import_signatures.get(imp.name) if imp is not None and imp.name else None
        return None if sig is None else (f"{imp.library}!{imp.name}", sig)  # type: ignore[union-attr]

    def slot_signature(self, at: int) -> Signature | None:
        """The signature of the imported function whose slot of the import address table is at `at`, or None."""
        imp = self.imports.get(at - self.image.image_base)
        return self.import_signatures.get(imp.name) if imp is not None and imp.name else None

    def imports_digest(self) -> str:
        """A digest of what is declared of imported functions: which slot holds which, and their signatures."""
        rows = sorted((rva, i.library, i.name or "", repr(self.import_signatures.get(i.name or ""))) for rva, i in self.imports.items())
        return hashlib.sha256(repr(rows).encode()).hexdigest()

    def namespace(self) -> dict[str, str]:
        """What the facts about this pack's functions depend on beyond their own extents, by kind: the engine's code (only
        the code that makes normal forms, for the facts read off them), the image, the validated forms."""
        return kn.namespaces("skyrim-pack", self.image.sha256, sorted(self.validated) if self.validated is not None else None,
                             extra=(self.imports_digest(),))

    def key(self, at: int) -> str | None:
        """What the normal form at `at` depends on within the namespace: where its extent starts and how long it is."""
        rva = at - self.image.image_base
        n = self.extent(rva)
        return None if n is None else f"{rva:x}:{n}"

    def functions(self) -> list[int]:
        return [self.image.image_base + rva for rva in sorted(self.size)]

    def open_store(self, path: str | Path) -> kn.SqliteStore:
        """The persistent store of what is learnt about this pack's functions, shared by every worker and campaign."""
        self.store = kn.SqliteStore(path, self.namespace())
        return self.store

    def program(self) -> Program:
        """A program for one search: what it analyses is spent from that search's budget, and kept in the store if any."""
        return Program(self.normal, SOURCE, CALLING, self.image.image_base, self.bytes_at, self.constant, self.declared,
                       store=self.store, key=self.key, universe=self.functions, slot=self.slot_signature)


__all__ = ["PackFacts", "SCN_MEM_EXECUTE", "SCN_MEM_WRITE"]
