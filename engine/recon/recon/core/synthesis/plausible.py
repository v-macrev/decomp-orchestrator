# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plausibility of a candidate before it is compiled (spec section 15.4; convergence plan, Phase 9).

A candidate may only be source a person could have written for what the function does: no code that can never run, no
cast that converts nothing, no construct that exists only to steer the compiler (`volatile`, inline assembly, pragmas,
`noinline`, helpers the function does not need). The check reads the tree and the unit's text, never the target, and
runs on every candidate before compilation, so an implausible form is never compiled, let alone matched.
"""
from __future__ import annotations

import re

from recon.core.structuring import ast as A

DEAD_CODE, CAST, CONSTRUCT = "IMPLAUSIBLE_DEAD_CODE", "IMPLAUSIBLE_CAST", "IMPLAUSIBLE_CONSTRUCT"
CODES = (DEAD_CODE, CAST, CONSTRUCT)
#: what only steers code generation
STEERING = re.compile(r"\bvolatile\b|\b__asm\b|\basm\b|#\s*pragma|__declspec\s*\(\s*noinline|__forceinline|\bregister\b")
LEAVES = (A.Return, A.Break, A.Continue, A.Goto)


def _dead(stmts: tuple) -> bool:
    """A statement after one that leaves, with no label in between to reach it; or an arm under a constant condition."""
    left = False
    for s in stmts:
        if isinstance(s, A.Label):
            left = False
        elif left:
            return True
        if isinstance(s, LEAVES):
            left = True
        if isinstance(s, A.If):
            if isinstance(s.cond, A.Num) or _dead(s.then) or _dead(s.other):
                return True
        elif isinstance(s, A.Loop) and _dead(s.body):
            return True
    return False


def check(body: A.Body, text: str) -> str | None:
    """None when the candidate is plausible, else the code of the first reason it is not."""
    if STEERING.search(text):
        return CONSTRUCT
    if _dead(body.stmts):
        return DEAD_CODE
    for s in body.stmts:
        for x in A.walk(s):
            if isinstance(x, A.Cast) and not x.implicit and getattr(x.arg, "type", None) == x.type:
                return CAST
    return None


__all__ = ["CAST", "CODES", "CONSTRUCT", "DEAD_CODE", "check"]
