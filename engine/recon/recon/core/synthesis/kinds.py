# SPDX-License-Identifier: AGPL-3.0-or-later
"""The kinds of `MISMATCH`: how a candidate that compiles differs from the target (convergence plan, Phase 9).

This module owns the list (workstream contract C2: P9 owns the kinds, `core/taxonomy.py` lands them as codes). Kinds are
appended, never renamed, merged or removed. Each kind has an engine code (`MISMATCH_<KIND>`) and the plan's name
(`MISMATCH(<kind>)`). The order is the precedence of a tie: when two kinds explain equally many differing instructions,
the earlier one is primary, so the more specific explanation wins over the more general one.

This module imports nothing of the engine, so the taxonomy can import it.
"""
from __future__ import annotations

SIZE_ONLY = "size-only"                          # the same instructions; only encodings or trailing padding differ
REGISTERS = "register-assignment"                # the same instructions under a renaming of registers
POLARITY = "branch-polarity"                     # a condition taken the other way (and its arms exchanged)
BLOCKS = "block-order"                           # the same blocks in another order, or a jump added or removed
STACK = "stack-layout"                           # frame offsets or the frame's size
UNWIND = "unwind"                                # the saved registers, their order or their slots
EXTENSION = "extension"                          # the width or the signedness of a value: extensions, signed and unsigned forms
CONSTANT = "constant-materialisation"            # how a constant is made: an immediate, a zeroing, a load
CALL = "call-relocation"                         # a call, a tail call or a reference that leads elsewhere
SELECTION = "instruction-selection"              # other instructions computing the same

#: every kind, in the order of precedence
KINDS: tuple[str, ...] = (SIZE_ONLY, REGISTERS, POLARITY, BLOCKS, STACK, UNWIND, EXTENSION, CONSTANT, CALL, SELECTION)
#: the version of the kind list: appended kinds raise it
KINDS_VERSION = 1


def code(kind: str) -> str:
    """The engine code of a kind: `MISMATCH_BLOCK_ORDER` for `block-order`."""
    if kind not in KINDS:
        raise ValueError(f"not a mismatch kind: {kind}")
    return "MISMATCH_" + kind.upper().replace("-", "_")


def name(kind: str) -> str:
    """The plan's name of a kind: `MISMATCH(block-order)`."""
    if kind not in KINDS:
        raise ValueError(f"not a mismatch kind: {kind}")
    return f"MISMATCH({kind})"


def kind_of(engine_code: str) -> str | None:
    """The kind an engine code names, or None."""
    return next((k for k in KINDS if code(k) == engine_code), None)


CODES: dict[str, str] = {code(k): name(k) for k in KINDS}

__all__ = ["BLOCKS", "CALL", "CODES", "CONSTANT", "EXTENSION", "KINDS", "KINDS_VERSION", "POLARITY", "REGISTERS", "SELECTION", "SIZE_ONLY",
           "STACK", "UNWIND", "code", "kind_of", "name"]
