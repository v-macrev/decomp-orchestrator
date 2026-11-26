# SPDX-License-Identifier: AGPL-3.0-or-later
"""What a normal form of a function of the image is made of: its extent's bytes, its unwind data and the validated forms,
and the code here and below. Nothing else of the pack's (declarations, imports, the search) reaches a normal form, so this
module, not the pack, is what the store files normal forms under (`recon.core.knowledge.NORMAL_ROOTS`)."""
from __future__ import annotations

import bisect

from recon.adapters.skyrim.image import PinnedImage
from recon.adapters.x64_msvc import program as pg
from recon.adapters.x64_msvc import unwind as uw
from recon.adapters.x64_msvc.abi import CALLING
from recon.adapters.x64_msvc.leaf import leaf_extent
from recon.core.inference.signature import NotReconstructed
from recon.core.ir import passes, validate
from recon.core.ir.model import Fn

SCN_MEM_EXECUTE = 0x2000_0000


def normal_form(image: PinnedImage, validated: frozenset[str] | None, rva: int, n: int) -> Fn:
    """The admitted normal form of the function at `rva`, `n` bytes long, or NotReconstructed."""
    entries = [(b, e, uw.read_unwind(image.read, u)) for b, e, u in image.runtime_functions() if rva <= b < rva + n]
    a = pg.analyse(image.read(rva, n), rva, image.image_base, validated, entries)
    if isinstance(a, pg.Refusal):
        raise NotReconstructed(a.code)
    fn = pg.to_ir(a, image.image_base, entries, image.read)
    if isinstance(fn, pg.Refusal):
        raise NotReconstructed(fn.detail.upper().replace("-", "_"))
    return validate.require(validate.admit(passes.normalise(fn, CALLING), CALLING))


def leaf_size(image: PinnedImage, size: dict[int, int], starts: list[int], rva: int) -> int | None:
    """The size of the leaf function at `rva` (D-051), from the listed extents `size` (`starts`: their sorted starts), or
    None when no leaf starts there."""
    k = bisect.bisect_right(starts, rva)
    if k and starts[k - 1] + size[starts[k - 1]] > rva:
        return None                                  # a place inside a listed function
    try:
        sec = image.pe.section_for(rva)
    except image.up.pecoff.Reject:
        return None
    if not sec.flags & SCN_MEM_EXECUTE:
        return None
    hi = sec.vaddr + min(sec.raw_size, sec.vsize or sec.raw_size)
    if k < len(starts):
        hi = min(hi, starts[k])
    if hi <= rva:
        return None
    return leaf_extent(image.read(rva, hi - rva), rva, image.image_base, size.__contains__)[0]


__all__ = ["leaf_size", "normal_form"]
