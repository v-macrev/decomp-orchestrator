# SPDX-License-Identifier: AGPL-3.0-or-later
"""How often the execution check rejects a source the comparator would pass (defect D8 of the convergence plan).

The search compiles only candidates that agree with the function's normal form in generated worlds. A world the generator
makes up could make a correct source disagree, and the search would never see it. Here every tree the check rejected is
compiled anyway, ranked like any candidate, and each one with no known difference goes to the comparator. A rejected tree
the comparator passes is a false rejection. Counts only: no source, name or byte leaves this module.
"""
from __future__ import annotations

import hashlib
from collections import Counter
from dataclasses import dataclass, field

from recon.adapters.skyrim.pack import Pack, Workshop
from recon.adapters.skyrim.verify import Verifier
from recon.adapters.x64_msvc.batch import Compiler
from recon.core import budget as bg
from recon.core.inference.signature import NotReconstructed
from recon.core.synthesis.candidates import Generator


@dataclass
class Audit:
    functions: int = 0               # functions looked at
    with_trees: int = 0              # of which the generator made at least one tree: the check ran
    with_rejections: int = 0         # of which the check rejected at least one tree
    accepted: int = 0                # trees the check let through
    rejected: int = 0                # trees it rejected
    compiled: int = 0                # rejected trees that compiled
    no_known_difference: int = 0     # of those, how many had distance 0 (references nothing names allowed)
    false_rejections: int = 0        # of those, how many the comparator passed
    #: why the check rejected the trees the comparator passed, and why it rejected the others
    false_why: Counter = field(default_factory=Counter)
    rejected_why: Counter = field(default_factory=Counter)
    refused: Counter = field(default_factory=Counter)
    #: the compiler's codes for rejected trees that did not compile
    errors: Counter = field(default_factory=Counter)

    def to_json(self) -> dict:
        return {"functions": self.functions, "with_trees": self.with_trees, "with_rejections": self.with_rejections, "accepted": self.accepted, "rejected": self.rejected,
                "compiled": self.compiled, "no_known_difference": self.no_known_difference, "false_rejections": self.false_rejections,
                "false_why": dict(sorted(self.false_why.items())), "rejected_why": dict(sorted(self.rejected_why.items())),
                "refused": dict(sorted(self.refused.items())), "errors": dict(sorted(self.errors.items()))}


def audit_function(pack: Pack, rva: int, compiler: Compiler, verifier: Verifier, into: Audit) -> None:
    """Every tree of the function the check rejects, compiled and, when nothing known differs, compared."""
    into.functions += 1
    try:
        with bg.active(bg.Budget.of(None)):
            last = None
            for r in Generator(pack.program(), pack.image.image_base + rva).stages(keep_rejected=True):
                last = r
    except (NotReconstructed, bg.BudgetExhausted) as e:
        into.refused[getattr(e, "code", None) or f"BUDGET_{getattr(e, 'kind', '')}"] += 1
        return
    assert last is not None
    into.accepted += len(last.candidates)
    into.with_trees += bool(last.candidates or last.rejected)
    if not last.rejected:
        return
    into.with_rejections += 1
    into.rejected += len(last.rejected)
    shop = Workshop(pack, rva, compiler, verifier)
    for c, j in zip(last.rejected, shop.judge(last.rejected)):
        into.rejected_why[c.verdict.why] += 1
        if j.key is None:
            for e in j.errors or ("DOES_NOT_COMPILE",):
                into.errors[e] += 1
            continue
        into.compiled += 1
        if j.distance:
            continue
        into.no_known_difference += 1
        ok, _why = shop.verify(c)
        if ok:
            into.false_rejections += 1
            into.false_why[c.verdict.why] += 1


def sample(rvas: list[int], n: int, salt: str = "d8") -> list[int]:
    """A fixed order of the functions that depends on nothing but their addresses: the first `n` are the sample."""
    return sorted(rvas, key=lambda r: hashlib.sha256(f"{salt}:{r:x}".encode()).digest())[:n] if n else sorted(rvas)


__all__ = ["Audit", "audit_function", "sample"]
