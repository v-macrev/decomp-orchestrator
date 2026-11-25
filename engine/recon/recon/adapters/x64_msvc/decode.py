# SPDX-License-Identifier: AGPL-3.0-or-later
"""x86-64 decoding through iced-x86 (upstream's own pin, 1.21.0). The decoder is not written here.

`decode_range` is a linear sweep that stops at the first invalid instruction and says where. Anything the
decoder cannot decode is a structured stop, never a guess (specification section 9: unsupported means the
function stops, and the stop is counted).
"""
from __future__ import annotations

from recon.core.model import TERMINATORS, DecodeResult, Flow, FunctionDecode, Insn


class DecoderUnavailable(RuntimeError):
    """iced_x86 is not installed in this interpreter (run scripts/setup-venv.sh and use the venv's python)."""


_MNEMONIC_NAMES: dict[int, str] | None = None
# A base-register displacement below this cannot be an image-relative address of code in any function of a real image.
MIN_IMAGE_DISP = 0x1000
# Alignment padding between the last instruction and a table.
PADDING = frozenset({"NOP"})


def misdirected_branches(insns) -> int:
    """How many direct branches land inside the decoded range but not on an instruction start: the linear sweep and
    the code's own control flow then disagree about where instructions begin, which is conflicting evidence."""
    starts = {i.rva for i in insns}
    if not insns:
        return 0
    lo, hi = insns[0].rva, insns[-1].end
    return sum(1 for i in insns if i.flow in (Flow.JUMP, Flow.BRANCH, Flow.CALL) and i.target is not None and lo <= i.target < hi and i.target not in starts)


def _iced():
    try:
        import iced_x86
    except ImportError as e:  # pragma: no cover - exercised only without the venv
        raise DecoderUnavailable("iced_x86 is not installed; use the private venv (docs/recon/TECHNICAL_DECISIONS.md, D-002)") from e
    return iced_x86


def mnemonic_name(iced_x86, value: int) -> str:
    global _MNEMONIC_NAMES
    if _MNEMONIC_NAMES is None:
        _MNEMONIC_NAMES = {v: k for k, v in vars(iced_x86.Mnemonic).items() if isinstance(v, int) and not k.startswith("_")}
    return _MNEMONIC_NAMES.get(value, f"UNKNOWN_{value}")


def _flow(iced_x86, fc: int) -> Flow:
    F = iced_x86.FlowControl
    if fc == F.NEXT:
        return Flow.FALL
    if fc == F.UNCONDITIONAL_BRANCH:
        return Flow.JUMP
    if fc == F.CONDITIONAL_BRANCH:
        return Flow.BRANCH
    if fc == F.CALL:
        return Flow.CALL
    if fc == F.INDIRECT_CALL:
        return Flow.CALL_INDIRECT
    if fc == F.INDIRECT_BRANCH:
        return Flow.JUMP_INDIRECT
    if fc == F.RETURN:
        return Flow.RETURN
    # INTERRUPT, EXCEPTION, XBEGIN_XABORT_XEND: control does not follow the ordinary path.
    return Flow.TRAP


def decode_range(code: bytes, rva: int, image_base: int) -> DecodeResult:
    """Decode `code`, which sits at `rva` in an image loaded at `image_base`. Addresses in the result are RVAs."""
    ix = _iced()
    ip = image_base + rva
    dec = ix.Decoder(64, code, ip=ip)
    out: list[Insn] = []
    while dec.can_decode:
        i = dec.decode()
        here = i.ip - image_base
        if i.code == ix.Code.INVALID:
            return DecodeResult(tuple(out), here, "invalid-instruction")
        flow = _flow(ix, i.flow_control)
        target = None
        if flow in (Flow.JUMP, Flow.BRANCH, Flow.CALL):
            target = i.near_branch_target - image_base
        data_ref = i.ip_rel_memory_address - image_base if i.is_ip_rel_memory_operand else None
        disp = None
        if data_ref is None and i.memory_displ_size and MIN_IMAGE_DISP <= i.memory_displacement < 0x7FFFFFFF:
            disp = i.memory_displacement
        out.append(Insn(here, i.len, flow, mnemonic_name(ix, i.mnemonic), target, data_ref, disp))
    stop = (out[-1].end if out else rva)
    # A final instruction that runs past the buffer is reported by iced as invalid, so reaching here is a clean end.
    return DecodeResult(tuple(out), stop, None)


def decode_function(code: bytes, rva: int, image_base: int) -> FunctionDecode:
    """Decode a whole inventory range, setting trailing table data apart.

    MSVC places switch tables after a function's code, inside its range. A linear sweep reads them as
    instructions, so the data start is taken from the code itself: the lowest address after an instruction that a
    RIP-relative operand or an image-relative displacement points at inside the range. The code before it must then
    decode cleanly to exactly that address, must not fall through into it and must not branch into it; the rest is
    table data. A range with no such reference is all code. A reference that fails those checks is conflicting
    evidence: the error is `ambiguous-data-reference` and the caller blocks the function (it is never read as all code).
    """
    end = rva + len(code)
    first = decode_range(code, rva, image_base)
    cut: int | None = None
    for i in first.insns:
        if cut is not None and i.rva >= cut:
            break
        for ref in (i.data_ref, i.disp):
            if ref is not None and i.end <= ref < end and (cut is None or ref < cut):
                cut = ref
    if cut is None:
        return FunctionDecode(first.insns, None, end, first.stop, first.error)
    head = decode_range(code[: cut - rva], rva, image_base)
    last = next((i for i in reversed(head.insns) if i.mnemonic not in PADDING), None)
    falls_in = last is None or last.flow not in TERMINATORS
    branches_in = any(i.flow in (Flow.JUMP, Flow.BRANCH, Flow.CALL) and i.target is not None and cut <= i.target < end for i in head.insns)
    if head.error is not None or head.stop != cut or falls_in or branches_in:
        return FunctionDecode(first.insns, None, end, cut, "ambiguous-data-reference")
    first_entry = int.from_bytes(code[cut - rva : cut - rva + 4], "little")
    kind = "rva-table" if rva <= first_entry < end else "other-data"
    return FunctionDecode(head.insns, cut, end, cut, None, kind)
