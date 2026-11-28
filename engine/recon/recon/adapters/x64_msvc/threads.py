# SPDX-License-Identifier: AGPL-3.0-or-later
"""Where x64 Windows keeps a module's thread-local variables (D-074): the thread block (`gs`) holds the address of the
thread's array of storage blocks at 0x58 (`ThreadLocalStoragePointer`); the module's block is the entry its index names;
a variable lies at its offset in the image's template of that block."""
from __future__ import annotations

from recon.adapters.x64_msvc.lift import GS_BASE
from recon.core.synthesis.thread import ThreadLocals

#: where the thread block holds the address of the thread's array of storage blocks
STORAGE_ARRAY = 0x58
#: the symbol a compiler reaches the module's index by
TLS_INDEX = "_tls_index"


def thread_locals(template: tuple[int, int, int] | None, image_base: int) -> ThreadLocals | None:
    """The thread-local facts of an image whose thread-local directory gives `template` = (start, end, index slot) as RVAs;
    None for an image without one."""
    if template is None:
        return None
    start, end, index = template
    return ThreadLocals(GS_BASE, STORAGE_ARRAY, image_base + index, image_base + start, image_base + end)


__all__ = ["STORAGE_ARRAY", "TLS_INDEX", "thread_locals"]
