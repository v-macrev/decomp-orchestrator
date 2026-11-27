# SPDX-License-Identifier: AGPL-3.0-or-later
"""How a fact is known, and a function's signature read from what its callers do at their calls (P8, D8-002).

Every fact carries a status: `declared` (an upstream or platform declaration says so), `proven`, `constrained` (every
piece of evidence agrees and together they fix it), `inferred` (the function's own code reads so), `ambiguous` (the
evidence leaves a choice open), `contradicted` (two pieces of evidence disagree). A contradicted fact is no fact: what
needs it is blocked, and neither side is chosen.

A call (`callsites.call_evidence`) says which argument locations the caller set with a value of its own, which held
nothing the caller ever had (`left`: what an earlier call left there, or nothing), and which results it used afterwards.
Read together over every call of one function:

* position k is a parameter when some caller sets it (or a later position) and no caller leaves it: the convention passes
  arguments by position, so a caller that sets the third argument passes the first two, and a caller cannot mean what an
  earlier call left as an argument. A caller that sets a position another leaves contradicts it;
* its kind is the kind of location callers set (an integer or a floating one), the same for all, or it is contradicted;
* its width is the widest any caller computes it in (a constant fits any width); a position no caller sets but some later
  one is set is a 64-bit integer, as `lower.parameters` writes an unused position;
* the result is the kind every reading caller reads, as wide as the widest read; none read is no result (callers that
  ignore a result look the same: the reading says so in its evidence).
"""
from __future__ import annotations

from recon.core.inference.signature import FLOAT, INT, Convention, Signature, Slot

DECLARED, PROVEN, CONSTRAINED, INFERRED, AMBIGUOUS, CONTRADICTED = (
    "declared", "proven", "constrained", "inferred", "ambiguous", "contradicted")
STATUSES = (DECLARED, PROVEN, CONSTRAINED, INFERRED, AMBIGUOUS, CONTRADICTED)


def _int_width(w: int) -> int:
    return next((x for x in (8, 16, 32, 64) if w <= x), 64)


def _float_width(w: int) -> int:
    return 32 if w == 32 else 64


def from_sites(sites: list[dict], conv: Convention) -> tuple[Signature | None, str]:
    """(the signature every call site agrees on, its status), or (None, `contradicted`) when two disagree, or (None, "")
    when there is no site. The signature's evidence names where it comes from and how many sites said so."""
    if not sites:
        return None, ""
    kinds: dict[int, set[str]] = {}
    widths: dict[int, int] = {}
    left_at: set[int] = set()
    last = -1
    for s in sites:
        put = {n: w for n, w in s["set"]}
        gone = set(s.get("left", ()))
        for k, (i_loc, f_loc) in enumerate(conv.slots):
            if i_loc in put or f_loc in put:
                kind = INT if i_loc in put else FLOAT
                if i_loc in put and f_loc in put:     # both of one position set: nothing tells which it is
                    return None, CONTRADICTED
                kinds.setdefault(k, set()).add(kind)
                w = put[i_loc if kind == INT else f_loc]
                widths[k] = max(widths.get(k, 0), w)
                last = max(last, k)
            elif i_loc in gone and f_loc in gone:
                left_at.add(k)
    params: list[Slot] = []
    for k in range(last + 1):
        if k in left_at:
            return None, CONTRADICTED       # a later position is set, so this one is passed; another caller leaves it
        ks = kinds.get(k, set())
        if len(ks) > 1:
            return None, CONTRADICTED
        if not ks:
            params.append(Slot(INT, 64))
        elif INT in ks:
            params.append(Slot(INT, _int_width(widths[k]) if widths[k] else 64))
        else:
            params.append(Slot(FLOAT, _float_width(widths[k])))
    reads = [(n, w) for s in sites for n, w in s["reads"]]
    rk = {INT if n == conv.result_int else FLOAT for n, _w in reads}
    if len(rk) > 1:
        return None, CONTRADICTED
    result = None
    if rk:
        kind = rk.pop()
        w = max(w for _n, w in reads)
        result = Slot(kind, _int_width(w) if kind == INT else _float_width(w))
    evidence = (("params", "SITES"), ("result", "SITES" if reads else "SITES_READ_NONE"), ("sites", str(len(sites))),
                ("status", CONSTRAINED))
    return Signature(tuple(params), result, evidence), CONSTRAINED


__all__ = ["AMBIGUOUS", "CONSTRAINED", "CONTRADICTED", "DECLARED", "INFERRED", "PROVEN", "STATUSES", "from_sites"]
