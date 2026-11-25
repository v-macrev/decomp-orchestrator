# SPDX-License-Identifier: AGPL-3.0-or-later
"""How far the lifter and the analyses reach over the inventory, and which instruction form would unlock most.

The printed report is counts by stage and fixed reason. The demand by form is written privately by the caller:
what the target's code contains is game-derived even as a list of names.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from recon.adapters.skyrim.image import PinnedImage
from recon.adapters.skyrim.inventory import Target
from recon.adapters.skyrim import survey as sv
from recon.adapters.x64_msvc import program as pg
from recon.adapters.x64_msvc import unwind as uw
from recon.core.analysis import cfg as cf


@dataclass
class Row:
    rva: int
    size: int
    stage: str                                     # refused at: survey, decode, lift, cfg; or "analysed"
    reason: str = ""
    missing: tuple[str, ...] = ()
    digest: str = ""
    frame: str = ""                                # "" or the refusal
    unwind: tuple[int, tuple[str, ...]] = (0, ())
    facts: dict[str, int] = field(default_factory=dict)


def analyse_target(img: PinnedImage, t: Target, pdata, starts, validated: frozenset[str] | None) -> Row:
    seen = sv.analyse_function(img, t.rva, t.size, _pdata=pdata, _starts=starts)
    if seen.status != sv.DECODED:  # conflicting or unsupported evidence stops a function before any lifting
        return Row(t.rva, t.size, "survey", seen.reason or seen.status)
    code = img.read(t.rva, t.size)
    entries = [(b, e, uw.read_unwind(img.read, u)) for b, e, u in sv._pdata_overlapping(pdata, starts, t.rva, t.rva + t.size)]
    r = pg.analyse(code, t.rva, img.image_base, validated, entries)
    if isinstance(r, pg.Refusal):
        return Row(t.rva, t.size, r.stage, r.code if r.stage == "lift" else r.detail, tuple(f"{f} ({w})" for f, w in r.missing))
    kinds = Counter(b.end_kind for b in r.cfg.blocks)
    facts = {"blocks": len(r.cfg.blocks), "loops": len(r.cfg.loops), "irreducible": int(not r.cfg.reducible), "switches": len(r.switches), "unresolved": kinds[cf.UNRESOLVED],
             "tail": kinds[cf.TAIL] + kinds[cf.TAIL_INDIRECT] + sum(1 for b in r.cfg.blocks if b.end_kind == cf.BRANCH and b.leaves_to),
             "unreachable_blocks": len(r.cfg.blocks) - len(r.cfg.reachable), "insns": len(r.insns),
             "calls": len(r.frame.calls) if r.frame else 0, "assumed": len(r.frame.assumptions) if r.frame else 0}
    return Row(t.rva, t.size, "analysed", digest=r.digest(), frame=r.frame_refusal or "", unwind=(r.unwind_checked, r.unwind_conflicts), facts=facts)


def run(img: PinnedImage, targets: list[Target], validated: frozenset[str] | None, progress=None) -> list[Row]:
    pdata = img.runtime_functions()
    starts = [p[0] for p in pdata]
    rows = []
    for n, t in enumerate(targets):
        rows.append(analyse_target(img, t, pdata, starts, validated))
        if progress and n % 2000 == 0:
            progress(n)
    return rows


def aggregate(rows: list[Row]) -> dict:
    """Counts only."""
    done = [r for r in rows if r.stage == "analysed"]
    framed = [r for r in done if not r.frame]
    by = Counter(f"{r.stage}:{r.reason}" if r.stage != "analysed" else "analysed" for r in rows)
    one = Counter(len(r.missing) for r in rows if r.stage == "lift")
    return {
        "functions": len(rows), "by_stage": dict(sorted(by.items())),
        "lift_completely": len(rows) - sum(1 for r in rows if r.stage in ("survey", "decode", "lift")),
        "distinct_missing_forms": len({m for r in rows for m in r.missing}),
        "functions_missing_exactly_one_form": one[1],
        "frame": {"recovered": len(framed), "refused": dict(sorted(Counter(r.frame for r in done if r.frame).items())), "with_a_stated_assumption": sum(1 for r in framed if r.facts["assumed"])},
        "unwind": {"functions_checked": sum(1 for r in framed if r.unwind[0]), "facts_checked": sum(r.unwind[0] for r in framed),
                   "functions_agreeing": sum(1 for r in framed if not r.unwind[1]), "conflicts": dict(sorted(Counter(c for r in framed for c in r.unwind[1]).items()))},
        "with_loops": sum(1 for r in done if r.facts["loops"]), "irreducible": sum(r.facts["irreducible"] for r in done),
        "switches_resolved": sum(r.facts["switches"] for r in done), "with_unresolved_jump": sum(1 for r in done if r.facts["unresolved"]),
        "with_tail_exit": sum(1 for r in done if r.facts["tail"]), "with_unreachable_blocks": sum(1 for r in done if r.facts["unreachable_blocks"]),
        "blocks": sum(r.facts["blocks"] for r in done), "instructions_analysed": sum(r.facts["insns"] for r in done),
    }


def demand(rows: list[Row], steps: int = 200) -> dict:
    """The machine-readable report that orders lifting work: for each missing form, the functions that would lift completely
    if it alone were added, and a greedy order of forms with the functions lifted after each."""
    left = [frozenset(r.missing) for r in rows if r.stage == "lift"]
    total = Counter(f for m in left for f in m)
    sole = Counter(next(iter(m)) for m in left if len(m) == 1)
    order = []
    have: set[str] = set()
    lifted = 0
    groups = Counter(left)
    for _ in range(min(steps, len(total))):
        gain: Counter[str] = Counter()
        near: Counter[str] = Counter()
        for m, n in groups.items():
            rest = m - have
            if len(rest) == 1:
                gain[next(iter(rest))] += n
            for f in rest:
                near[f] += n / len(rest) ** 2
        if not near:
            break
        # when no single form completes a function, the one that brings most functions nearest
        best = min(near, key=lambda f: (-gain[f], -near[f], f))
        have.add(best)
        lifted += gain[best]
        groups = Counter({m: n for m, n in groups.items() if m - have})
        order.append({"form": best, "completes": gain[best], "completed_so_far": lifted})
    return {"schema": 1, "functions": len(rows), "lift_completely_now": sum(1 for r in rows if r.stage in ("cfg", "analysed")),
            "forms": {f: {"functions": total[f], "would_complete_alone": sole[f]} for f in sorted(total, key=lambda f: (-total[f], f))}, "greedy_order": order}
