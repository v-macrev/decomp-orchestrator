# SPDX-License-Identifier: AGPL-3.0-or-later
"""One search: candidates, one compile of all of them, the first that is the target, its exact unit, and its verification.

The search ranks by the number of changes from the canonical form and by what the compiler made of each candidate. It
never decides: the last word is the verifier's, which knows nothing of the search.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from recon.core.inference.signature import NotReconstructed
from recon.core.synthesis.candidates import Candidate, Generator, Program

#: states a result may have here (`VERIFIED` and later ones are not this engine's to give)
SEMANTICALLY_VALID, COMPILED, BYTE_MATCHED, NONE = "SEMANTICALLY_VALID", "COMPILED", "BYTE_MATCHED", "NONE"


@dataclass(frozen=True)
class Judged:
    """What the compiler made of one candidate. `distance` 0: no difference is known."""

    key: str | None
    distance: int
    errors: tuple[str, ...] = ()


class Workshop(Protocol):
    def judge(self, candidates: list[Candidate]) -> list[Judged]: ...

    def verify(self, candidate: Candidate) -> tuple[bool, str]:
        """The exact unit, built on its own and compared by the independent verifier: (passed, its reason code)."""
        ...


@dataclass
class Result:
    state: str
    reason: str
    candidate: Candidate | None = None
    counters: dict[str, int] = field(default_factory=dict)
    refused: dict[str, int] = field(default_factory=dict)
    disagreed: dict[str, int] = field(default_factory=dict)
    errors: dict[str, int] = field(default_factory=dict)
    nearest: int | None = None
    evidence: tuple[tuple[str, str], ...] = ()


def reconstruct(program: Program, at: int, shop: Workshop) -> Result:
    """In two stages: the canonical form with its single changes, and only when none of those is the target, the combinations."""
    out = Result(NONE, "")
    n = {"tried": 0, "candidates": 0, "equal_trees": 0, "compiled": 0, "equal_code": 0, "verified": 0}
    out.counters = n
    seen: set[str] = set()
    done = 0
    best: tuple[int, int] | None = None
    try:
        for r in Generator(program, at).stages():
            out.evidence, out.refused, out.disagreed = r.evidence, r.refused, r.disagreed
            n["tried"], n["candidates"], n["equal_trees"] = r.tried, len(r.candidates), r.equal_trees
            new = r.candidates[done:]
            if not new:
                continue
            if out.state == NONE:
                out.state, out.reason, out.candidate = SEMANTICALLY_VALID, "DOES_NOT_COMPILE", r.candidates[0]
            order: list[tuple[int, int]] = []
            for k, j in enumerate(shop.judge(new), done):
                for e in j.errors:
                    out.errors[e] = out.errors.get(e, 0) + 1
                if j.key is None:
                    continue
                n["compiled"] += 1
                if j.key in seen:
                    n["equal_code"] += 1
                    continue
                seen.add(j.key)
                order.append((j.distance, k))
            done = len(r.candidates)
            for dist, k in sorted(order):
                if best is None or (dist, k) < best:
                    best = (dist, k)
                    if out.state != COMPILED:
                        out.state, out.reason = COMPILED, "NO_MATCH"
                    out.candidate, out.nearest = r.candidates[k], dist
                if dist:
                    break
                n["verified"] += 1
                ok, out.reason = shop.verify(r.candidates[k])
                if ok:
                    out.state, out.candidate = BYTE_MATCHED, r.candidates[k]
                    return out
    except NotReconstructed as e:
        return Result(NONE, e.code)
    if out.state == NONE:
        out.reason = "NOT_EQUIVALENT" if out.disagreed and not out.refused else min(out.refused, default="NO_CANDIDATE")
    return out


__all__ = ["BYTE_MATCHED", "COMPILED", "Judged", "NONE", "Result", "SEMANTICALLY_VALID", "Workshop", "reconstruct"]
