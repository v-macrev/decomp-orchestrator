# SPDX-License-Identifier: AGPL-3.0-or-later
"""How far source generation reaches over the inventory, before anything is compiled: counts and fixed codes only.

For each selected target: is there a candidate that does what the function does, and what would its source need from the
project (classes, callees, globals)? Nothing of a function's code is printed or kept.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from recon.adapters.skyrim.image import PinnedImage
from recon.adapters.skyrim.inventory import Target
from recon.adapters.skyrim.pack import Pack
from recon.core.budget import BudgetExhausted
from recon.core.inference import types as ty
from recon.core.inference.signature import NotReconstructed
from recon.core.structuring import ast as A
from recon.core.synthesis.candidates import Generator


@dataclass
class Row:
    rva: int
    size: int
    result: str                                   # "candidate", "refused: CODE", "disagreed", "failed: Kind"
    facts: dict[str, int] = field(default_factory=dict)
    #: every reason code met, for the taxonomy (the result names only the first)
    codes: list[str] = field(default_factory=list)


def one(pack: Pack, program, t: Target) -> Row:
    at = pack.image.image_base + t.rva
    try:
        r = None
        for r in Generator(program, at).stages():   # every stage: what the search could compile (D7)
            pass
        assert r is not None
    except NotReconstructed as e:
        return Row(t.rva, t.size, f"refused: {e.code}", codes=[e.code])
    except BudgetExhausted as e:     # suspended, not refused: a larger budget continues from what is kept
        return Row(t.rva, t.size, f"exhausted: {e.kind}", codes=["BUDGET_EXHAUSTED"])
    except RecursionError:
        return Row(t.rva, t.size, "failed: RecursionError", codes=["ENGINE_ERROR"])
    except Exception as e:  # noqa: BLE001 - a defect, counted by kind so that it is found
        return Row(t.rva, t.size, f"failed: {type(e).__name__}", codes=["ENGINE_ERROR"])
    codes = sorted(r.refused) + (["NOT_EQUIVALENT"] if r.disagreed else []) + (["BUDGET_EXHAUSTED"] if r.exhausted else [])
    if not r.candidates and r.exhausted:   # what was left untried is not a refusal
        return Row(t.rva, t.size, f"exhausted: {r.exhausted}", codes=["BUDGET_EXHAUSTED", *codes[:-1]])
    if not r.candidates:
        if r.refused:
            return Row(t.rva, t.size, f"refused: {min(r.refused)}", codes=codes)
        return Row(t.rva, t.size, "disagreed" if r.disagreed else "refused: NO_CANDIDATE", codes=codes or ["NO_CANDIDATE"])
    c = r.candidates[0]
    nodes = [x for s in c.body.stmts for x in A.walk(s)]
    first = c.body.params[0] if c.body.params else None
    facts = {
        "candidates": len(r.candidates), "callees": len(c.unit.callees), "globals": len(c.unit.globals),
        "classes": c.unit.text.count("\nstruct Class") + c.unit.text.startswith("struct Class"),
        "loops": sum(isinstance(x, A.Loop) for x in nodes), "branches": sum(isinstance(x, A.If) for x in nodes),
        "first_is_class_pointer": int(first is not None and isinstance(first.type, ty.Ptr) and isinstance(first.type.to, ty.Named)),
        "floats": int("Float" in repr([x.type for x in nodes if isinstance(x, A.EXPRS)])),
        "signed_assumption": int(bool(c.assumptions)),
    }
    return Row(t.rva, t.size, "candidate", facts, codes)


def run(pack: Pack, targets: list[Target], progress=None, jobs: int = 1) -> list[Row]:
    if jobs > 1:
        import multiprocessing as mp

        with mp.get_context("spawn").Pool(jobs, _start, (pack.image.origin, pack.size, pack.validated), maxtasksperchild=100) as pool:
            rows = []
            for row in pool.imap(_run, targets, chunksize=8):
                rows.append(row)
                if progress and len(rows) % 500 == 0:
                    progress(len(rows))
            return rows
    program = pack.program()
    rows = []
    for n, t in enumerate(targets):
        rows.append(one(pack, program, t))
        if progress and n % 500 == 0:
            progress(n)
    return rows


_W: dict = {}


def _start(origin: tuple, size: dict[int, int], validated) -> None:
    pack = Pack("pinned", PinnedImage(*origin), size, validated)
    _W.update(pack=pack, program=pack.program())


def _run(t: Target) -> Row:
    return one(_W["pack"], _W["program"], t)


def report(rows: list[Row]) -> dict:
    got = [r for r in rows if r.result == "candidate"]

    def having(**want) -> int:
        return sum(1 for r in got if all((r.facts[k] > 0) == v for k, v in want.items()))
    return {
        "selected": len(rows), "with_a_candidate": len(got),
        "by_result": dict(Counter(r.result for r in rows).most_common(40)),
        "candidates_needing": {"no_callee_no_global": having(callees=False, globals=False), "no_callee_no_global_no_class": having(callees=False, globals=False, classes=False),
                               "only_a_class_of_the_first_parameter": having(callees=False, globals=False, first_is_class_pointer=True),
                               "a_callee": having(callees=True), "a_global": having(globals=True)},
        "with_loops": having(loops=True), "with_branches": having(branches=True), "with_floats": having(floats=True),
        "with_the_signed_assumption": having(signed_assumption=True),
        "bytes_with_a_candidate": sum(r.size for r in got),
    }


__all__ = ["Row", "one", "report", "run"]
