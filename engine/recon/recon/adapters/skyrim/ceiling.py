# SPDX-License-Identifier: AGPL-3.0-or-later
"""The early ceiling estimate (convergence plan, section 4): how much of the denominator may need the user's decision.

A fixed sample of development functions (never held-out ones), the same number from each size bucket, is looked at for
what would stop a match beyond any capability the engine could build:

* `near_cap`: the unit's header or source is already within 10% of upstream's per-file size or line cap
  (`tools/contrib_screen.py`), so a declaration more may not fit
* `foreign`: its code is not what the pinned compiler writes for C++: it lies outside `.text`, or it holds an invalid
  instruction (data, or hand-written code)
* not measured yet, reported as such: whether it needs a recipe other than its unit's, and whether matching it needs a
  body upstream already matched (neither can be told before a match is attempted)

Informational, not a flag: `same_bytes_as_matched` (identical bytes at another address mean the linker did not fold the
two, so each has its own definition).

The share with any flag is the projected `NEEDS_DECISION` share, with a 95% Wilson interval. Counts only leave here.
"""
from __future__ import annotations

import hashlib
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

from recon.adapters.skyrim.inventory import SIZE_BUCKETS, size_bucket
from recon.adapters.skyrim.manifest import heldout
from recon.adapters.x64_msvc import program as pg

BUCKETS = tuple(f"<={b}" for b in SIZE_BUCKETS) + (f">{SIZE_BUCKETS[-1]}",)


def caps(worktree: Path) -> tuple[int, int]:
    """Upstream's per-file caps: bytes and lines."""
    t = (worktree / "tools/contrib_screen.py").read_text(encoding="utf-8")
    return int(re.search(r"^MAX_BYTES\s*=\s*(\d+)", t, re.M).group(1)), int(re.search(r"^MAX_LINES\s*=\s*(\d+)", t, re.M).group(1))


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    r = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - r) / d), min(1.0, (c + r) / d))


def stratified(rvas_sizes: list[tuple[int, int]], n: int, salt: str = "ceiling-v1") -> list[tuple[int, int]]:
    """`n` functions, as even across size buckets as the population allows, each bucket in a fixed hash order."""
    by: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for r, s in rvas_sizes:
        by[size_bucket(s)].append((r, s))
    for b in by:
        by[b].sort(key=lambda x: hashlib.sha256(f"{salt}:{x[0]:x}".encode()).digest())
    out: list[tuple[int, int]] = []
    k = 0
    while len(out) < n and any(by.values()):
        b = BUCKETS[k % len(BUCKETS)]
        if by.get(b):
            out.append(by[b].pop(0))
        k += 1
    return out


def estimate(image, inv, worktree: Path, startable: dict[int, dict], validated, n: int = 200) -> dict:
    max_bytes, max_lines = caps(worktree)
    matched = defaultdict(set)
    for t in (*inv.targets, *inv.recorded):
        if t.matched:
            try:
                matched[t.size].add(hashlib.sha256(image.read(t.rva, t.size)).digest())
            except ValueError:
                pass
    pop = [(t.rva, t.size) for t in inv.unmatched() if not heldout(t.rva) and t.rva in startable]
    picked = stratified(pop, n)
    flags: Counter = Counter()
    info: Counter = Counter()
    by_bucket: dict[str, Counter] = defaultdict(Counter)
    for rva, size in picked:
        f = set()
        s = startable[rva]
        unit = (s.get("unit") or "").replace("\\", "/")
        for rel in (unit, unit[:-4] + ".h") if unit.endswith(".cpp") else ():
            p = worktree / rel
            if p.is_file():
                b = p.read_bytes()
                if len(b) > 0.9 * max_bytes or b.count(b"\n") > 0.9 * max_lines:
                    f.add("near_cap")
        try:
            body = image.read(rva, size)
            if hashlib.sha256(body).digest() in matched.get(size, ()):
                info["same_bytes_as_matched"] += 1
        except ValueError:
            body = None
        try:
            if image.pe.section_for(rva).name.rstrip("\0") != ".text":
                f.add("foreign")
        except Exception:  # noqa: BLE001 - an address the image does not map is foreign to its code
            f.add("foreign")
        if body is not None:
            a = pg.analyse(body, rva, image.image_base, validated, [])
            if isinstance(a, pg.Refusal) and a.code == pg.INVALID:
                f.add("foreign")
        b = size_bucket(size)
        by_bucket[b]["sampled"] += 1
        for x in f:
            flags[x] += 1
            by_bucket[b][x] += 1
        if f:
            flags["any"] += 1
            by_bucket[b]["any"] += 1
    lo, hi = wilson(flags["any"], len(picked))
    return {"population": len(pop), "sampled": len(picked), "flags": dict(sorted(flags.items())),
            "projected_needs_decision": round(flags["any"] / len(picked), 4) if picked else None, "interval95": [round(lo, 4), round(hi, 4)],
            "by_bucket": {b: dict(sorted(by_bucket[b].items())) for b in BUCKETS if b in by_bucket},
            "informational": dict(info), "not_measured": ["recipe", "needs-a-matched-body"], "caps": {"bytes": max_bytes, "lines": max_lines}}


__all__ = ["caps", "estimate", "stratified", "wilson"]
