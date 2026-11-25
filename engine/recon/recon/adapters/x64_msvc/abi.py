# SPDX-License-Identifier: AGPL-3.0-or-later
"""The Windows x64 calling convention: integer and vector registers. The floating-point control register is not modelled."""
from __future__ import annotations

from recon.adapters.x64_msvc.lift import FLAGS, GPR, GS_BASE, XMM
from recon.core.analysis.dataflow import Abi
from recon.core.inference.signature import Convention

VOLATILE = ("rax", "rcx", "rdx", "r8", "r9", "r10", "r11")
VOLATILE_VECTOR = XMM[:6]
CALLING = Abi(
    arguments=frozenset({"rcx", "rdx", "r8", "r9", *XMM[:4]}),
    clobbered=frozenset(VOLATILE) | frozenset(VOLATILE_VECTOR) | frozenset(f for f in FLAGS if f != "df"),
    preserved=frozenset({"rbx", "rbp", "rsi", "rdi", "r12", "r13", "r14", "r15", *XMM[6:]}),
    results=frozenset({"rax", "xmm0"}),
    stack="rsp",
    word=8,
    home=32,
)
WIDTHS = {**{n: 64 for n in (*GPR, GS_BASE)}, **{n: 128 for n in XMM}, **{f: 1 for f in FLAGS}}
CLOBBERED = {n: WIDTHS[n] for n in sorted(CALLING.clobbered)}
#: the same convention as the source sees it: one position, one location of either kind
SOURCE = Convention(slots=(("rcx", "xmm0"), ("rdx", "xmm1"), ("r8", "xmm2"), ("r9", "xmm3")), result_int="rax", result_float="xmm0")
