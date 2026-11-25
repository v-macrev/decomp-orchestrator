# SPDX-License-Identifier: AGPL-3.0-or-later
"""Memory regions: what an address can be known to lie in, and which regions may overlap.

An address is followed through additions of constants to a base: the frame, the value a location had on entry, or an
absolute address. What is not followed lies in `other`. Regions of one base are disjoint when their offsets are.
Beyond that only two facts are used: a private part of the frame is reached by nothing else, and what an entry value
or an absolute address points to is not this function's frame, which did not exist yet.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable

from recon.core.ir.model import FRAME, FRAME_REGION, OTHER, Arg, Const, Fn, Mem, Op, Phi, Region

#: more regions than this are not worth their tokens: everything but the frame becomes `other`
MAX_REGIONS = 48

Place = tuple[str, int]  # (base, signed offset)
Lookup = Callable[[int], "Op | Phi | None"]


def signed64(v: int) -> int:
    return v - (1 << 64) if v >> 63 & 1 else v


def resolve(a: Arg, defining: Lookup, params: dict[int, str]) -> Place | None:
    """(base, offset) of an address, or None when it is not followed."""
    off = 0
    for _ in range(64):
        if isinstance(a, Const):
            return ("global", (a.value + off) & ((1 << 64) - 1))
        if a in params:
            return (f"param:{params[a]}", signed64(off & ((1 << 64) - 1)))
        o = defining(a)
        if not isinstance(o, Op):
            return None
        if o.kind == FRAME:
            return ("frame", int(o.attr("off")) + signed64(off & ((1 << 64) - 1)))  # type: ignore[call-overload]
        if o.kind == "add":
            x, y = o.args
            if isinstance(y, Const):
                a, off = x, off + y.value
            elif isinstance(x, Const):
                a, off = y, off + x.value
            else:
                return None
        elif o.kind == "sub" and isinstance(o.args[1], Const):
            a, off = o.args[0], off - o.args[1].value
        else:
            return None
    return None


def may_alias(a: Region, b: Region) -> bool:
    if a.name == b.name:
        return True
    if a.private or b.private:
        return False
    if a.base == b.base and a.base != OTHER:
        return a.lo < b.hi and b.lo < a.hi
    if FRAME_REGION in (a.base, b.base):
        # only a pointer that was not followed can lead into the frame
        return OTHER in (a.base, b.base)
    return True


@dataclass(frozen=True)
class Extent:
    """Bytes one access covers: a place and its size, or None when either is unknown."""

    place: Place | None
    size: int | None


def intervals(spans: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    """Overlapping spans joined."""
    out: list[tuple[int, int]] = []
    for lo, hi in sorted(set(spans)):
        if out and lo < out[-1][1]:
            out[-1] = (out[-1][0], max(hi, out[-1][1]))
        else:
            out.append((lo, hi))
    return out


def access_extents(o: Op, defining: Lookup, params: dict[int, str], width: Callable[[Arg], int]) -> list[tuple[Extent, bool]]:
    """(extent, whether it is written) for each stretch of memory an operation touches itself."""
    if o.kind == "load":
        return [(Extent(resolve(o.args[0], defining, params), width(o.defs[0]) // 8), False)]
    if o.kind == "store":
        return [(Extent(resolve(o.args[0], defining, params), width(o.args[1]) // 8), True)]
    if o.kind in ("blockcopy", "blockfill"):
        size = int(o.attr("size")) if o.kind == "blockcopy" else width(o.args[1]) // 8  # type: ignore[call-overload]
        count, back = o.args[2], o.args[3]
        n = count.value if isinstance(count, Const) and isinstance(back, Const) and back.value == 0 else None
        total = n * size if n is not None and n * size < 1 << 31 else None
        out = [(Extent(resolve(o.args[0], defining, params), total), True)]
        if o.kind == "blockcopy":
            out.append((Extent(resolve(o.args[1], defining, params), total), False))
        return out
    return []


def classify(extents: list[Extent], escapes: bool, kept: dict[tuple[int, int], str]) -> list[Region]:
    """The regions of a function. `escapes`: a frame address is used other than as a followed address. `kept`: spans of the frame that
    hold a saved register, by its name; they stay private even then (the frame analysis states that assumption)."""
    by_base: dict[str, list[tuple[int, int]]] = {}
    for e in extents:
        if e.place is None or e.size is None or e.size == 0:
            continue
        base, off = e.place
        by_base.setdefault(base, []).append((off, off + e.size))
    regions: list[Region] = []
    frame = intervals(by_base.pop("frame", []))
    if not escapes:
        regions += [Region(f"frame[{lo}:{hi}]", "frame", lo, hi, True, kept.get((lo, hi), "")) for lo, hi in frame]
    else:
        regions += [Region(f"frame[{lo}:{hi}]", "frame", lo, hi, True, kept[(lo, hi)]) for lo, hi in frame if (lo, hi) in kept]
        regions.append(Region(FRAME_REGION, FRAME_REGION, 0, 0))
    rest = [Region(f"{base}[{lo}:{hi}]", base, lo, hi) for base in sorted(by_base) for lo, hi in intervals(by_base[base])]
    if len(rest) <= MAX_REGIONS:
        regions += rest
    regions.append(Region(OTHER, OTHER, 0, 0))
    return regions


def region_of(e: Extent, regions: list[Region]) -> Region:
    """The region an access lies in wholly. An access whose extent is not known and that may be in the frame is in the frame region."""
    by = {r.name: r for r in regions}
    if e.place is not None and e.size is not None:
        base, off = e.place
        for r in regions:
            if r.base == base and r.lo <= off and off + e.size <= r.hi and r.base not in (OTHER, FRAME_REGION):
                return r
        if base == "frame":
            return by[FRAME_REGION]
    elif e.place is not None and e.place[0] == "frame":
        return by[FRAME_REGION]
    return by[OTHER]


def touched(r: Region, regions: list[Region]) -> list[Region]:
    return [q for q in regions if may_alias(r, q)]


def frame_escapes(fn: Fn) -> bool:
    """Whether a frame address is used as anything but the address of an access that is followed."""
    d = {v: o for v, (_b, o) in fn.defining().items()}
    frames = {v for v, o in d.items() if isinstance(o, Op) and o.kind == FRAME}
    return escapes_from(frames, d.get, {v: n for n, v in fn.params}, [(o.kind, o.args, o) for _b, o in fn.ops()],
                        [a for b in fn.blocks for p in b.phis for _k, a in p.args] + [a for b in fn.blocks for a in b.term.args], fn.width)


def escapes_from(frames: set[int], defining: Lookup, params: dict[int, str], ops: list, other_uses: list[Arg], width) -> bool:
    """Values derived from the frame by constant offsets may only be addresses of followed accesses, or go into another such value."""
    derived = set(frames)
    grew = True
    while grew:
        grew = False
        for kind, args, o in ops:
            if kind in ("add", "sub") and o.defs[0] not in derived and any(a in derived for a in args if not isinstance(a, Const)):
                place = resolve(o.defs[0], defining, params)
                if place is None or place[0] != "frame":
                    return True
                derived.add(o.defs[0])
                grew = True
    for kind, args, o in ops:
        for k, a in enumerate(args):
            if isinstance(a, Const) or a not in derived or kind in ("add", "sub"):
                continue
            if kind in ("load", "store") and k == 0:
                continue
            if kind in ("blockcopy", "blockfill") and k < (2 if kind == "blockcopy" else 1):
                if all(e.size is not None for e, _w in access_extents(o, defining, params, width)):
                    continue
            return True
    return any(a in derived for a in other_uses if not isinstance(a, Const))


def thread(mem: Iterable[tuple[Region, bool]], current: dict[str, int], fresh: Callable[[str], int]) -> tuple[Mem, ...]:
    """The memory operands of one operation: (region, whether it may change), reading `current` and advancing it."""
    out = []
    for r, changes in mem:
        after = fresh(r.name) if changes else None
        out.append(Mem(r.name, current[r.name], after))
        if after is not None:
            current[r.name] = after
    return tuple(out)
