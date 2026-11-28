# SPDX-License-Identifier: AGPL-3.0-or-later
"""The pinned game image: opened read-only, hashed against builds/target.json on every load, read through
upstream's `PeImage` (the reference the engine must agree with). Nothing here writes, and nothing is logged
beyond counts and digests.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from recon.core.model import Segment

from . import upstream as _up


class ImageHashMismatch(RuntimeError):
    pass


class PinnedImage:
    def __init__(self, image_path: str | Path, worktree: str | Path, expected_sha256: str | None = None):
        self.up = _up.load(worktree)
        self.origin = (str(image_path), str(worktree), expected_sha256)  # what another process needs to open the same
        manifest = json.loads((Path(worktree) / "builds/target.json").read_text())
        self.build_id = manifest.get("build_id")
        want = expected_sha256 or manifest["image_sha256"]
        with open(image_path, "rb") as f:  # read-only; the bytes object is immutable
            blob = f.read()
        self.sha256 = hashlib.sha256(blob).hexdigest()
        if self.sha256 != want:
            raise ImageHashMismatch("the image's sha256 differs from builds/target.json")
        self.pe = self.up.pecoff.PeImage(blob)
        self.image_base: int = self.pe.image_base
        self._pdata: list[tuple[int, int, int]] | None = None
        self._segments: list[Segment] | None = None
        self._chains: dict[int, list[tuple[int, int, int]]] | None = None
        self._imports: dict[int, str] | None = None

    # -- address mapping ------------------------------------------------------------------------
    def read(self, rva: int, size: int) -> bytes:
        """`size` file-backed bytes at `rva`; ValueError (with upstream's reason) when they are not all file content."""
        try:
            return self.pe.read(rva, size, "range")[1]
        except self.up.pecoff.Reject as e:
            raise ValueError(e.reason) from None

    def _backed(self, rva: int):
        """The section of `rva` and how many file-backed bytes it has; ValueError when the address is not file content."""
        try:
            sec = self.pe.section_for(rva)
        except self.up.pecoff.Reject as e:
            raise ValueError(e.reason) from None
        backed = min(sec.raw_size, sec.vsize or sec.raw_size)
        if rva - sec.vaddr >= backed:
            raise ValueError("target-range-not-file-backed")
        return sec, backed

    def file_offset(self, rva: int) -> int:
        sec, _ = self._backed(rva)
        return sec.raw_ptr + (rva - sec.vaddr)

    def read_cstr(self, rva: int, limit: int = 512) -> bytes:
        sec, backed = self._backed(rva)
        start = sec.raw_ptr + (rva - sec.vaddr)
        end = min(start + limit, sec.raw_ptr + backed)
        chunk = self.pe.blob[start:end]
        nul = chunk.find(b"\0")
        if nul < 0:
            raise ValueError("unterminated string")
        return chunk[:nul]

    def section_name_at(self, rva: int) -> str | None:
        try:
            return self.pe.section_for(rva).name
        except self.up.pecoff.Reject:
            return None

    def is_code(self, rva: int) -> bool:
        try:
            return bool(self.pe.section_for(rva).flags & self.up.pecoff.SCN_MEM_EXECUTE)
        except self.up.pecoff.Reject:
            return False

    @property
    def segments(self) -> list[Segment]:
        """File-backed parts of every section, as the RTTI scanner and the surveys read them."""
        if self._segments is None:
            segs = []
            for s in self.pe.sections:
                n = min(s.raw_size, s.vsize or s.raw_size)
                if n:
                    segs.append(Segment(s.name, s.vaddr, self.pe.blob[s.raw_ptr:s.raw_ptr + n], bool(s.flags & self.up.pecoff.SCN_MEM_EXECUTE)))
            self._segments = segs
        return self._segments

    # -- exception directory --------------------------------------------------------------------
    def runtime_functions(self) -> list[tuple[int, int, int]]:
        if self._pdata is None:
            self._pdata = sorted(self.pe.runtime_functions())
        return self._pdata

    def fragments(self, rva: int, n: int) -> list[tuple[int, int, int]]:
        """The `.pdata` entries outside [rva, rva + n) whose unwind data chains, directly or through another such entry, to
        the entry that starts at `rva` (D-072): parts of that function the compiler placed elsewhere."""
        if self._chains is None:
            from recon.adapters.x64_msvc import unwind as uw
            self._chains = {}
            for b, e, u in self.runtime_functions():
                try:
                    c = uw.read_unwind(self.read, u).chained
                except (ValueError, IndexError):
                    continue
                if c is not None:
                    self._chains.setdefault(c[0], []).append((b, e, u))
        out: list[tuple[int, int, int]] = []
        work, seen = [rva], {rva}
        while work:
            for f in self._chains.get(work.pop(), ()):
                if f[0] not in seen:
                    seen.add(f[0])
                    work.append(f[0])
                    if not rva <= f[0] < rva + n:
                        out.append(f)
        return sorted(out)

    def imported_through(self, rva: int) -> str | None:
        """The name of the function the code at `rva` jumps to through the import address table, when it is such a thunk."""
        if self._imports is None:
            from recon.adapters.x64_msvc.imports import import_slots
            self._imports = {at: i.name for at, i in import_slots(self.pe.blob, self.read).items() if i.name}
        try:
            code = self.read(rva, 7)
        except ValueError:
            return None
        k = 1 if code[0] == 0x48 else 0
        if code[k:k + 2] != bytes((0xFF, 0x25)):
            return None
        return self._imports.get(rva + k + 6 + int.from_bytes(code[k + 2:k + 6], "little", signed=True))


def locate_image(checkout: str | Path) -> Path:
    """The executable the checkout is configured with (private contrib config)."""
    cfg = json.loads((Path(checkout) / ".local/contrib/config.json").read_text())
    exe = cfg.get("exe")
    if not exe:
        raise FileNotFoundError("the checkout's contrib config names no executable")
    return Path(exe)


__all__ = ["PinnedImage", "ImageHashMismatch", "locate_image"]
