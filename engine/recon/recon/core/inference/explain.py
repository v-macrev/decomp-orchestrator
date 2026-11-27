# SPDX-License-Identifier: AGPL-3.0-or-later
"""Why a function has no signature: the chain of callees without one, down to the functions where it starts and the fixed
code that stops each of them there (P8, D8-003).

A function's signature is unknown when its declaration says nothing and its own code cannot be read: its normal form is
refused, its reading is refused (a callee without a signature, an argument on the stack, ...), or it is a member of a cycle
that does not settle. When the reason is a callee without a signature, the cause is further down; the walk follows every
such callee once, so a root shared by many chains is counted once per function that asks. Nothing here changes what the
program knows: it asks the program, and reads a refusal's code, which says nothing about the function.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from recon.core.inference.signature import NotReconstructed
from recon.core.ir.model import Const

#: the reasons a function itself gives (the leaves of an explanation)
DECLARED, KNOWN, CYCLE = "declared", "known", "cycle"


@dataclass(frozen=True)
class Root:
    """A function without a signature whose cause is not a callee: where a chain starts."""

    at: int
    #: `normal:<code>` (its normal form is refused), `reading:<code>` (its reading is), `cycle` (it does not settle)
    reason: str


@dataclass
class Explanation:
    at: int
    #: `declared`, `known`, or the reason it has none: the roots below it
    state: str
    roots: list[Root] = field(default_factory=list)
    #: functions without a signature walked through on the way, `at` included
    walked: int = 0
    #: the longest chain of callees without a signature from `at` to a root
    depth: int = 0


def _unknown_callees(program, at: int) -> list[int]:
    """The direct callees (calls and tail jumps) of `at` whose signature is unknown, in order of first appearance."""
    out: list[int] = []
    for c in program.edges(at):
        if c != at and program.signature(c) is None and c not in out:
            out.append(c)
    return out


def _own(program, at: int) -> str | None:
    """Why `at`'s own code gives no signature when its callees are not the cause; None when they are."""
    try:
        program.normal(at)
    except NotReconstructed as e:
        return f"normal:{e.code}"
    try:
        program._infer(at)
    except NotReconstructed as e:
        if e.code == "CALLEE_SIGNATURE_UNKNOWN":
            return None
        return f"reading:{e.code}"
    return CYCLE


def explain(program, at: int) -> Explanation:
    """Why `program` (a `whole.Program`) has no signature for the function at `at`."""
    if program.name(at) is not None or program._declared(at) is not None:
        return Explanation(at, DECLARED)
    if program.signature(at) is not None:
        return Explanation(at, KNOWN)
    roots: dict[int, Root] = {}
    depth: dict[int, int] = {}
    seen: set[int] = set()
    # an explicit stack: a chain is as long as the program makes it
    stack: list[tuple[int, list[int] | None]] = [(at, None)]
    while stack:
        v, todo = stack[-1]
        if todo is None:
            seen.add(v)
            why = _own(program, v)
            if why is not None:
                roots[v] = Root(v, why)
                depth[v] = 0
                stack.pop()
                continue
            below = _unknown_callees(program, v)
            if not below:            # refused for an unknown callee it no longer has (read through a value): a root
                roots[v] = Root(v, "reading:CALLEE_SIGNATURE_UNKNOWN")
                depth[v] = 0
                stack.pop()
                continue
            stack[-1] = (v, below)
            continue
        if todo:
            c = todo.pop(0)
            if c not in seen:
                stack.append((c, None))
            continue
        stack.pop()
        depth[v] = 1 + max((depth.get(c, 0) for c in _unknown_callees(program, v)), default=-1)
    return Explanation(at, "unknown", sorted(roots.values(), key=lambda r: r.at), len(seen), depth.get(at, 0))


def through_tail(program, at: int) -> int | None:
    """The function `at` forwards to, when its normal form makes no call and ends every path in one tail jump to a known
    address; None otherwise."""
    try:
        fn = program.normal(at)
    except NotReconstructed:
        return None
    if any(o.kind == "call" for _b, o in fn.ops()):
        return None
    tails = {b.term.args[0].value for b in fn.blocks if b.term.kind == "tail" and b.term.args and isinstance(b.term.args[0], Const)}
    others = [b for b in fn.blocks if b.term.kind in ("return", "tail") and not (b.term.kind == "tail" and isinstance(b.term.args[0], Const))]
    return tails.pop() if len(tails) == 1 and not others else None


__all__ = ["CYCLE", "DECLARED", "KNOWN", "Explanation", "Root", "explain", "through_tail"]
