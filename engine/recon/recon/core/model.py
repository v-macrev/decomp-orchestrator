# SPDX-License-Identifier: AGPL-3.0-or-later
"""Architecture-independent records the adapters fill and the analyses read.

No register names, no flags of a compiler, no address of a target: an instruction here is a flow kind, a
length, an optional direct target and an optional data reference, plus the mnemonic as the adapter names it.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Flow(str, Enum):
    FALL = "fall"          # continues with the next instruction
    JUMP = "jump"          # unconditional direct branch
    BRANCH = "branch"      # conditional branch (also loops)
    CALL = "call"          # direct call
    CALL_INDIRECT = "call_indirect"
    JUMP_INDIRECT = "jump_indirect"
    RETURN = "return"
    TRAP = "trap"          # interrupt, breakpoint, undefined instruction: control does not continue normally


TERMINATORS = frozenset({Flow.JUMP, Flow.JUMP_INDIRECT, Flow.RETURN, Flow.TRAP})


@dataclass(frozen=True)
class Insn:
    rva: int
    length: int
    flow: Flow
    mnemonic: str
    #: destination of a direct branch or call, as an RVA
    target: int | None = None
    #: RVA reached by an instruction-relative memory operand
    data_ref: int | None = None
    #: displacement of a base-register memory operand when it is large enough to be an image-relative address (switch tables)
    disp: int | None = None

    @property
    def end(self) -> int:
        return self.rva + self.length


@dataclass(frozen=True)
class DecodeResult:
    """A linear sweep of a range. `stop` is the RVA where decoding stopped, `error` why (None when it ended on the range's end)."""

    insns: tuple[Insn, ...]
    stop: int
    error: str | None


@dataclass(frozen=True)
class Segment:
    """A loaded, file-backed range of the image: its RVA, its bytes (already read) and whether it holds code."""

    name: str
    rva: int
    data: bytes
    executable: bool

    @property
    def end(self) -> int:
        return self.rva + len(self.data)


@dataclass(frozen=True)
class FunctionDecode:
    """A function range decoded with its trailing data kept apart: `insns` are the instructions before
    `data_start` (None: the range is all code), and `data_start` to `end` is table data referenced from the code."""

    insns: tuple[Insn, ...]
    data_start: int | None
    end: int
    stop: int
    error: str | None
    #: what the trailing data looks like: "rva-table" (its first entry is an address inside the range) or "other-data"
    data_kind: str | None = None
