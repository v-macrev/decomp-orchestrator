# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reconstruction of functions of an image described by a pack: the image and the extents of its functions.

A pack is what a synthetic target comes as. It has no sources. It may have declarations of external functions, each with
the linker map entry that placed it: those name their functions and give their signatures. Everything else the source
needs is inferred: signatures from the code of the function and its callees, layouts from accesses.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from recon.adapters.skyrim.image import PinnedImage
from recon.adapters.skyrim.normal import leaf_size, normal_form
from recon.adapters.skyrim.verify import PASS, Verifier
from recon.adapters.x64_msvc import coff
from recon.adapters.x64_msvc.imports import Import
from recon.adapters.x64_msvc.abi import CALLING, SOURCE
from recon.adapters.x64_msvc.batch import Compiler, distance
from recon.adapters.x64_msvc.cl import Toolchain
from recon.adapters.x64_msvc.symbols import SymbolMap, scoped
from recon.core import budget as bg
from recon.core import knowledge as kn
from recon.core.inference.signature import NotReconstructed, Signature, Slot
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

    @staticmethod
    def load(path: str | Path, worktree: str | Path, validated: frozenset[str] | None) -> "Pack":
        path = Path(path)
        d = json.loads(path.read_text(encoding="utf-8"))
        if d.get("schema") != 1:
            raise ValueError("unknown pack schema")
        img = PinnedImage(path.parent / d["image"], worktree, d["image_sha256"])
        pack = Pack(d["build_id"], img, {int(f["rva"]): int(f["size"]) for f in d["functions"]}, validated)
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
