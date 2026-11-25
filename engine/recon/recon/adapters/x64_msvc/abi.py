# SPDX-License-Identifier: AGPL-3.0-or-later
"""The Windows x64 calling convention, as far as the lifted subset sees it (no vector registers yet)."""
from __future__ import annotations

from recon.adapters.x64_msvc.lift import FLAGS, GPR
from recon.core.analysis.dataflow import Abi

VOLATILE = ("rax", "rcx", "rdx", "r8", "r9", "r10", "r11")
CALLING = Abi(
    arguments=frozenset({"rcx", "rdx", "r8", "r9"}),
    clobbered=frozenset(VOLATILE) | frozenset(f for f in FLAGS if f != "df"),
    preserved=frozenset({"rbx", "rbp", "rsi", "rdi", "r12", "r13", "r14", "r15"}),
    results=frozenset({"rax"}),
    stack="rsp",
    word=8,
    home=32,
)
WIDTHS = {**{n: 64 for n in GPR}, **{f: 1 for f in FLAGS}}
CLOBBERED = {n: WIDTHS[n] for n in sorted(CALLING.clobbered)}
