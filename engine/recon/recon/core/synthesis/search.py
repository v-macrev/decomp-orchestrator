# SPDX-License-Identifier: AGPL-3.0-or-later
"""One search: candidates chosen by what the compiler made of the nearest ones, compiled, and verified.

The search starts from the canonical form and grows by rules of the compiler knowledge base (core/synthesis/rules.py).
What the compiler made of a candidate decides what is tried next: the workshop says how far its function is from the
target and of which `MISMATCH` kind the difference is (adapters/x64_msvc/mismatch.py), and the candidate is expanded
first with the rule families that kind maps to (`rules.FAMILIES`), every other family only after every such expansion.
Expansions come from a priority queue keyed by (tier, distance, rule-trail length, canonical tree digest): nearest
first, shorter trails first, and the digest settles every tie, so the order is the same in any process, with any
number of workers and any `PYTHONHASHSEED` (workstream contract C4). Equal trees and equal objects are one candidate.

The search never decides: every candidate with no known difference goes to the verifier, in queue order, until one
passes or the `compiles` budget is spent; one whose only open points are references nothing names goes too, and the
verifier checks what the evidence binds them to. A reference is never bound because the bytes would then line up.

The search spends from a `Budget` (recon.core.budget). When one runs out the result says `BUDGET_EXHAUSTED` and carries a
frontier: what the compiler and the verifier said of each candidate. A search given that frontier and a larger budget
makes the same candidates again in the same order (the generator is deterministic and cheap next to the compiler),
takes those answers instead of compiling again, and goes on where the smaller budget stopped: it continues, it does not
repeat. When the queue runs dry the rules can make nothing more (`grammar_exhausted` counter) and the result keeps the
kind of its nearest candidate as its reason.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from typing import Protocol

from recon.core import budget as bg
from recon.core.inference.signature import NotReconstructed
from recon.core.synthesis import kinds as K
from recon.core.synthesis import rules as RL
from recon.core.synthesis.candidates import Candidate, Choice, Generator, Program

#: states a result may have here (`VERIFIED` and later ones are not this engine's to give)
SEMANTICALLY_VALID, COMPILED, BYTE_MATCHED, NONE = "SEMANTICALLY_VALID", "COMPILED", "BYTE_MATCHED", "NONE"
BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
FRONTIER_SCHEMA = 1
#: the distance of a node the compiler could not judge (the canonical form refused, or a candidate that does not compile)
UNJUDGED = 1 << 30


@dataclass(frozen=True)
class Judged:
    """What the compiler made of one candidate. `distance` 0: no known difference. `unknown`: references nothing names.
    `kind`: the `MISMATCH` kind of a candidate at a distance, "" when the workshop does not say."""

    key: str | None
    distance: int
    errors: tuple[str, ...] = ()
    unknown: int = 0
    kind: str = ""


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
                "judged": {d: [j.key, j.distance, list(j.errors), j.unknown, *([j.kind] if j.kind else [])] for d, j in sorted(self.judged.items())},
                "verified": {d: [ok, why] for d, (ok, why) in sorted(self.verified.items())}}

    @staticmethod
    def from_json(d: dict) -> "Frontier":
        if d.get("schema") != FRONTIER_SCHEMA:
            raise ValueError("unknown frontier schema")
        return Frontier(int(d["at"]), {k: Judged(v[0], int(v[1]), tuple(v[2]), int(v[3]), str(v[4]) if len(v) > 4 else "")
                                       for k, v in d["judged"].items()},
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
    #: the MISMATCH kind of the nearest candidate, "" when none was given
    kind: str = ""
    #: the rules that led from the canonical form to `candidate`, in order (rule id, and `:<k>` for an instance)
    trail: tuple[str, ...] = ()


def kind_of_reason(reason: str) -> str:
    """The kind a verifier's reason for a candidate with no known difference speaks of, "" when it does not say."""
    r = reason.lower()
    if "unwind" in r or r.startswith("eh-") or "pdata" in r or "xdata" in r:
        return K.UNWIND
    if "reloc" in r or "symbol" in r:
        return K.CALL
    if "size" in r:
        return K.SIZE_ONLY
    return ""


class _Rules:
    """What rules need to know of the function (`rules.Context`), the callees' readings asked for only when needed (they
    may read the callers)."""

    def __init__(self, gen: Generator) -> None:
        self.gen = gen

    @property
    def open(self) -> int:
        return self.gen.open

    @property
    def compared(self) -> int:
        return self.gen.compared

    @property
    def results(self) -> int:
        return len(self.gen.results)

    @property
    def readings(self) -> tuple[int, ...]:
        return tuple(len(a) for a in self.gen.alternatives())


def reconstruct(program: Program, at: int, shop: Workshop, budget: bg.Budget | None = None, frontier: Frontier | None = None) -> Result:
    """The canonical form, then rule applications from the nearest candidates, directed by their mismatch kinds.

    `program` should be made for this search: what it has analysed is spent from the budget once, when it is analysed."""
    b = budget or bg.Budget.of(None)
    if frontier is not None and frontier.at != at:
        raise ValueError("the frontier is of another function")
    past = frontier or Frontier(at)
    trail = Frontier(at)
    out = Result(NONE, "")
    n = {"tried": 0, "candidates": 0, "equal_trees": 0, "compiled": 0, "equal_code": 0, "verified": 0, "unknown_references": 0,
         "expanded": 0, "expanded_directed": 0, "grammar_exhausted": 0}
    out.counters = n
    tried: set[Choice] = set()
    trees: set[str] = set()
    codes: set[str] = set()
    heap: list[tuple] = []
    seq = [0]
    best: list[tuple[int, int, int] | None] = [None]

    def push(tier: int, dist: int, c: Candidate | None, choice: Choice, steps: tuple[str, ...], kind: str) -> None:
        if len(steps) >= RL.MAX_TRAIL:
            return
        seq[0] += 1
        heapq.heappush(heap, (tier, dist, len(steps), c.digest if c is not None else "", seq[0], choice, steps, kind))

    def attempt(gen: Generator, choices: list[tuple[Choice, tuple[str, ...]]]) -> list[tuple[Candidate, tuple[str, ...]]]:
        """The candidates of the choices not tried before: each spends one `expansions`, each kept one `candidates`."""
        kept = []
        for c, steps in choices:
            if c in tried:
                continue
            tried.add(c)
            if not b.left("candidates"):
                raise bg.BudgetExhausted("candidates")
            b.spend("expansions")
            n["tried"] += 1
            try:
                x = gen.make(c, trees)
            except NotReconstructed as e:
                out.refused[e.code] = out.refused.get(e.code, 0) + 1
                continue
            if x is None:
                n["equal_trees"] += 1
                continue
            if not x.verdict.agree:
                out.disagreed[x.verdict.why] = out.disagreed.get(x.verdict.why, 0) + 1
                continue
            b.spend("candidates")
            n["candidates"] += 1
            kept.append((x, steps))
        return kept

    def judge(kept: list[tuple[Candidate, tuple[str, ...]]]) -> bool:
        """Compile, rank and verify a batch, and queue what may be expanded. True when one passed the verifier."""
        if kept and out.state == NONE:
            out.state, out.reason, out.candidate, out.trail = SEMANTICALLY_VALID, "DOES_NOT_COMPILE", kept[0][0], kept[0][1]
        take = kept[:b.left("compiles")]
        b.spend("compiles", len(take))
        ask = [c for c, _s in take if c.digest not in past.judged]
        answers = iter(shop.judge(ask) if ask else [])
        ranked: list[tuple[int, int, int, Candidate, tuple[str, ...], Judged]] = []
        for c, steps in take:
            j = past.judged[c.digest] if c.digest in past.judged else next(answers)
            trail.judged[c.digest] = j
            for e in j.errors:
                out.errors[e] = out.errors.get(e, 0) + 1
            if j.key is None:
                push(0, UNJUDGED, c, c.choice, steps, "")
                continue
            n["compiled"] += 1
            if j.key in codes:
                n["equal_code"] += 1
                continue
            codes.add(j.key)
            n["unknown_references"] += j.unknown
            seq[0] += 1
            ranked.append((j.distance, j.unknown, seq[0], c, steps, j))
        for dist, unknown, k, c, steps, j in sorted(ranked, key=lambda r: r[:3]):
            kind = j.kind
            if best[0] is None or (dist, unknown, k) < best[0]:
                best[0] = (dist, unknown, k)
                out.state, out.reason = COMPILED, K.code(kind) if kind in K.KINDS else "NO_MATCH"
                out.candidate, out.nearest, out.kind, out.trail = c, dist, kind, steps
            if not dist:
                b.spend("compiles")
                n["verified"] += 1
                ok, why = past.verified[c.digest] if c.digest in past.verified else shop.verify(c)
                trail.verified[c.digest] = (ok, why)
                out.reason = why
                if ok:
                    out.state, out.candidate, out.trail = BYTE_MATCHED, c, steps
                    return True
                kind = kind_of_reason(why)
                if out.candidate is c:
                    out.kind = kind
            push(0, dist, c, c.choice, steps, kind)
        if len(take) < len(kept):
            raise bg.BudgetExhausted("compiles")
        return False

    with bg.active(b):
        try:
            gen = Generator(program, at)
            ctx = _Rules(gen)
            out.evidence = tuple((f"result:{k}", e.value) for k, (_s, e) in enumerate(gen.results))
            first = attempt(gen, [(Choice(), ())])
            if not first:
                push(0, UNJUDGED, None, Choice(), (), "")
            elif judge(first):
                out.counters |= b.counters()
                return out
            while heap:
                tier, dist, _l, _d, _s, choice, steps, kind = heapq.heappop(heap)
                families = RL.directed(kind) if tier == 0 else RL.rest(kind)
                if tier == 0 and RL.rest(kind):
                    heapq.heappush(heap, (1, dist, _l, _d, _s, choice, steps, kind))     # the other families, after every directed one
                children = [(c, (*steps, step)) for c, step in RL.expand(choice, families, ctx)]
                if not children:
                    continue
                n["expanded"] += 1
                n["expanded_directed"] += tier == 0 and bool(kind)
                kept = attempt(gen, children)
                if kept and judge(kept):
                    out.counters |= b.counters()
                    return out
            n["grammar_exhausted"] = 1
        except bg.BudgetExhausted as e:
            out.reason, out.exhausted, out.frontier = BUDGET_EXHAUSTED, e.kind, trail
        except NotReconstructed as e:
            out = Result(NONE, e.code, counters=n)
    out.counters |= b.counters()
    if out.state == NONE and not out.reason:
        out.reason = "NOT_EQUIVALENT" if out.disagreed and not out.refused else min(out.refused, default="NO_CANDIDATE")
    return out


__all__ = ["BUDGET_EXHAUSTED", "BYTE_MATCHED", "COMPILED", "Frontier", "Judged", "NONE", "Result", "SEMANTICALLY_VALID", "UNJUDGED", "Workshop",
           "kind_of_reason", "reconstruct"]
