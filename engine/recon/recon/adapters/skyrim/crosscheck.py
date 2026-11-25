# SPDX-License-Identifier: AGPL-3.0-or-later
"""Differential check of the decoder: iced-x86 against upstream's own length decoder (tools/analysis/x64.py)
and, on a sample, against capstone. Both are compared on instruction boundaries and on branch and
RIP-relative targets, over the common prefix of what each decodes. The result is counts by category; no
instruction text is kept.
"""
from __future__ import annotations

from collections import Counter

from recon.adapters.skyrim.image import PinnedImage
from recon.adapters.skyrim.inventory import Target
from recon.adapters.x64_msvc import decode as x64decode
from recon.core.model import Flow

AGREE = "agree"


def _upstream_sequence(img: PinnedImage, code: bytes, rva: int):
    x64 = img.up.x64
    out = []
    p = 0
    try:
        while p < len(code):
            ins = x64.decode(code, p, rva + p, len(code))
            out.append((rva + p, ins.length, ins.target, ins.rip_target, ins.flow))
            p += ins.length
        return out, None
    except x64.DecodeError as e:
        return out, "upstream-decode-error"


def _upstream_flow(img: PinnedImage, flow: int) -> Flow | None:
    """Upstream's flow class as ours; None for the classes it does not tell apart (everything else, padding)."""
    x = img.up.x64
    return {x.CALL: Flow.CALL, x.JMP: Flow.JUMP, x.JCC: Flow.BRANCH, x.RET: Flow.RETURN, x.INT3: Flow.TRAP,
            x.ICALL: Flow.CALL_INDIRECT, x.IJMP: Flow.JUMP_INDIRECT, x.NOP: Flow.FALL, x.OTHER: None}[flow]


def compare_upstream(img: PinnedImage, t: Target) -> str:
    try:
        code = img.read(t.rva, t.size)
    except ValueError:
        return "unreadable"
    ours = x64decode.decode_function(code, t.rva, img.image_base)
    theirs, err = _upstream_sequence(img, code, t.rva)
    n = min(len(ours.insns), len(theirs))
    for a, b in zip(ours.insns[:n], theirs[:n]):
        if (a.rva, a.length) != (b[0], b[1]):
            return "boundary-differs"
        # a reference only one of the two sees is a difference too
        if (a.target if a.flow in (Flow.JUMP, Flow.BRANCH, Flow.CALL) else None) != b[2]:
            return "branch-target-differs"
        if a.data_ref != b[3]:
            return "rip-target-differs"
        if _upstream_flow(img, b[4]) is not None and _upstream_flow(img, b[4]) is not a.flow:
            return "flow-differs"
    if ours.data_start is not None:
        # table data follows the code: a linear sweep reads it as instructions, so only the code prefix is compared
        return AGREE if len(theirs) >= len(ours.insns) else "one-stops-early"
    if ours.error is None and err is None and len(ours.insns) != len(theirs):
        return "count-differs"
    if (ours.error is None) != (err is None):
        return "one-stops-early"  # an undecodable tail reads differently; counted, not judged
    return AGREE


def compare_capstone(img: PinnedImage, t: Target) -> str:
    import capstone

    try:
        code = img.read(t.rva, t.size)
    except ValueError:
        return "unreadable"
    ours = x64decode.decode_function(code, t.rva, img.image_base)
    cs = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    theirs = [(a, s) for a, s, _m, _o in cs.disasm_lite(code, t.rva)]
    n = min(len(ours.insns), len(theirs))
    for a, b in zip(ours.insns[:n], theirs[:n]):
        if (a.rva, a.length) != b:
            return "boundary-differs"
    if ours.data_start is None and (ours.error is None) != bool(theirs and theirs[-1][0] + theirs[-1][1] == t.rva + t.size):
        return "one-stops-early"
    if ours.data_start is not None and len(theirs) < len(ours.insns):
        return "one-stops-early"
    return AGREE


def run(img: PinnedImage, targets: list[Target], *, capstone_every: int = 0) -> dict:
    up: Counter[str] = Counter()
    cap: Counter[str] = Counter()
    for k, t in enumerate(targets):
        up[compare_upstream(img, t)] += 1
        if capstone_every and k % capstone_every == 0:
            cap[compare_capstone(img, t)] += 1
    return {"functions": len(targets), "upstream_x64": dict(sorted(up.items())), "capstone_sample": dict(sorted(cap.items()))}
