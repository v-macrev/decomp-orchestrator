# SPDX-License-Identifier: AGPL-3.0-or-later
"""One search: candidates, one compile of all of them, those the target may be, their exact units, and their verification.

The search ranks by what the compiler made of each candidate (known differences, then references nothing names) and by
the number of changes from the canonical form. It never decides: the last word is the verifier's, which knows nothing of
the search. Every candidate with no known difference goes to the verifier, in that order, until one passes or the
`compiles` budget is spent; one whose only open points are references nothing names goes too, and the verifier checks
what the evidence binds them to. A reference is never bound because the bytes would then line up.

The search spends from a `Budget` (recon.core.budget). When one runs out the result says `BUDGET_EXHAUSTED` and carries a
frontier: what the compiler and the verifier said of each candidate. A search given that frontier and a larger budget
makes the same candidates again (the generator is deterministic and cheap next to the compiler), takes those answers
instead of compiling again, and ends where an uninterrupted search with that budget ends, with the same counters.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from recon.core import budget as bg
from recon.core.inference.signature import NotReconstructed
from recon.core.synthesis.candidates import Candidate, Generator, Program

#: states a result may have here (`VERIFIED` and later ones are not this engine's to give)
SEMANTICALLY_VALID, COMPILED, BYTE_MATCHED, NONE = "SEMANTICALLY_VALID", "COMPILED", "BYTE_MATCHED", "NONE"
BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
FRONTIER_SCHEMA = 1


@dataclass(frozen=True)
class Judged:
    """What the compiler made of one candidate. `distance` 0: no known difference. `unknown`: references nothing names."""

    key: str | None
    distance: int
    errors: tuple[str, ...] = ()
    unknown: int = 0


class Workshop(Protocol):
    def judge(self, candidates: list[Candidate]) -> list[Judged]: ...

    def verify(self, candidate: Candidate) -> tuple[bool, str]:
        """The exact unit, built on its own and compared by the independent verifier: (passed, its reason code)."""
        ...


@dataclass
class Frontier:
    """What a search learned from the compiler and the verifier, by candidate digest: enough to go on without asking again."""

    at: int
    judged: dict[str, Judged] = field(default_factory=dict)
    verified: dict[str, tuple[bool, str]] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {"schema": FRONTIER_SCHEMA, "at": self.at,
                "judged": {d: [j.key, j.distance, list(j.errors), j.unknown] for d, j in sorted(self.judged.items())},
                "verified": {d: [ok, why] for d, (ok, why) in sorted(self.verified.items())}}

    @staticmethod
    def from_json(d: dict) -> "Frontier":
        if d.get("schema") != FRONTIER_SCHEMA:
            raise ValueError("unknown frontier schema")
        return Frontier(int(d["at"]), {k: Judged(v[0], int(v[1]), tuple(v[2]), int(v[3])) for k, v in d["judged"].items()},
                        {k: (bool(v[0]), str(v[1])) for k, v in d["verified"].items()})


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
    #: the budget that ran out, when the reason is BUDGET_EXHAUSTED
    exhausted: str = ""
    #: what to resume from, when the reason is BUDGET_EXHAUSTED
    frontier: Frontier | None = None


def reconstruct(program: Program, at: int, shop: Workshop, budget: bg.Budget | None = None, frontier: Frontier | None = None) -> Result:
    """In two stages: the canonical form with its single changes, and only when none of those is the target, the combinations.

    `program` should be made for this search: what it has analysed is spent from the budget once, when it is analysed."""
    b = budget or bg.Budget.of(None)
    if frontier is not None and frontier.at != at:
        raise ValueError("the frontier is of another function")
    past = frontier or Frontier(at)
    trail = Frontier(at)
    out = Result(NONE, "")
    n = {"tried": 0, "candidates": 0, "equal_trees": 0, "compiled": 0, "equal_code": 0, "verified": 0, "unknown_references": 0}
    out.counters = n
    seen: set[str] = set()
    done = 0
    best: tuple[int, int, int] | None = None
    with bg.active(b):
        try:
            for r in Generator(program, at).stages():
                out.evidence, out.refused, out.disagreed = r.evidence, r.refused, r.disagreed
                n["tried"], n["candidates"], n["equal_trees"] = r.tried, len(r.candidates), r.equal_trees
                new = r.candidates[done:]
                if new and out.state == NONE:
                    out.state, out.reason, out.candidate = SEMANTICALLY_VALID, "DOES_NOT_COMPILE", r.candidates[0]
                take = new[:b.left("compiles")]
                b.spend("compiles", len(take))
                ask = [c for c in take if c.digest not in past.judged]
                answers = iter(shop.judge(ask) if ask else [])
                order: list[tuple[int, int, int]] = []
                for k, c in enumerate(take, done):
                    j = past.judged[c.digest] if c.digest in past.judged else next(answers)
                    trail.judged[c.digest] = j
                    for e in j.errors:
                        out.errors[e] = out.errors.get(e, 0) + 1
                    if j.key is None:
                        continue
                    n["compiled"] += 1
                    if j.key in seen:
                        n["equal_code"] += 1
                        continue
                    seen.add(j.key)
                    n["unknown_references"] += j.unknown
                    order.append((j.distance, j.unknown, k))
                done += len(take)
                for dist, unknown, k in sorted(order):
                    if best is None or (dist, unknown, k) < best:
                        best = (dist, unknown, k)
                        if out.state != COMPILED:
                            out.state, out.reason = COMPILED, "NO_MATCH"
                        out.candidate, out.nearest = r.candidates[k], dist
                    if dist:
                        break
                    c = r.candidates[k]
                    b.spend("compiles")
                    n["verified"] += 1
                    ok, why = past.verified[c.digest] if c.digest in past.verified else shop.verify(c)
                    trail.verified[c.digest] = (ok, why)
                    out.reason = why
                    if ok:
                        out.state, out.candidate = BYTE_MATCHED, c
                        out.counters |= b.counters()
                        return out
                if len(take) < len(new):
                    raise bg.BudgetExhausted("compiles")
                if r.exhausted:
                    raise bg.BudgetExhausted(r.exhausted)
        except bg.BudgetExhausted as e:
            out.reason, out.exhausted, out.frontier = BUDGET_EXHAUSTED, e.kind, trail
        except NotReconstructed as e:
            out = Result(NONE, e.code, counters=n)
    out.counters |= b.counters()
    if out.state == NONE and not out.reason:
        out.reason = "NOT_EQUIVALENT" if out.disagreed and not out.refused else min(out.refused, default="NO_CANDIDATE")
    return out


__all__ = ["BUDGET_EXHAUSTED", "BYTE_MATCHED", "COMPILED", "Frontier", "Judged", "NONE", "Result", "SEMANTICALLY_VALID", "Workshop",
           "reconstruct"]
