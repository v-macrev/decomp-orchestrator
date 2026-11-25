# SPDX-License-Identifier: AGPL-3.0-or-later
"""Switch dispatch: an indirect jump through a table of image-relative addresses inside the function's range.

A dispatch is resolved only when every part is evidence, not shape: the jump's target is the image base plus a 32-bit
entry loaded from the data the decoder set apart; the block before compares that same index with a constant and
leaves when it is above; its fall-through is the only way to the jump; and every entry within the bound is an
instruction of the function. A compressed table (a byte index first) is read the same way, one level deeper.
Anything else stays unresolved.
"""
from __future__ import annotations

from dataclasses import dataclass

from recon.adapters.x64_msvc.abi import CLOBBERED
from recon.core.analysis.values import Values
from recon.core.sem import Branch, Const, Goto, Lifted, Put

MAX_CASES = 4096


@dataclass(frozen=True)
class Dispatch:
    rva: int                              # the indirect jump
    bound: int                            # the largest index the guard lets through
    tables: tuple[tuple[int, int], ...]   # (RVA, bytes) of the tables read
    targets: tuple[int, ...]              # one per index, RVAs


def block_start(insns: list[Lifted], k: int, leaders: set[int]) -> int:
    while k > 0 and insns[k].rva not in leaders:
        k -= 1
    return k


def direct_targets(insns: list[Lifted]) -> set[int]:
    """Addresses direct branches and jumps go to."""
    out = set()
    for i in insns:
        t = i.terminator
        if isinstance(t, Branch) and isinstance(t.taken, Const):
            out.add(t.taken.value)
        elif isinstance(t, Goto) and isinstance(t.target, Const):
            out.add(t.target.value)
    return out


def _const(v: Values, n: int) -> int | None:
    x = v.nodes[n]
    return x.value if x.kind == "const" else None


def _split(v: Values, n: int) -> tuple[list[int], int]:
    """A sum as (its terms that are not constant, its constant)."""
    terms, c, work = [], 0, [n]
    while work:
        m = work.pop()
        x = v.nodes[m]
        if x.kind == "const":
            c += x.value
        elif x.kind == "op" and x.op == "add":
            work.extend(x.args)
        else:
            terms.append(m)
    return sorted(terms), c & (2**64 - 1)


def _scaled(v: Values, n: int) -> tuple[int, int]:
    x = v.nodes[n]
    if x.kind == "op" and x.op == "shl":
        c = _const(v, x.args[1])
        if c is not None and c <= 3:
            return x.args[0], 1 << c
    return n, 1


def _root32(v: Values, n: int) -> int:
    """The 32-bit value an index is extended from."""
    x = v.nodes[n]
    while x.kind == "op" and x.op in ("zext", "sext") and x.width > 32 and v.nodes[x.args[0]].width >= 32:
        n, x = x.args[0], v.nodes[x.args[0]]
    return v.op("trunc", (n,), 32) if x.width > 32 else n


def resolve(insns: list[Lifted], image_base: int, data: tuple[int, bytes] | None, leaders: set[int]) -> dict[int, Dispatch]:
    """`data`: (RVA, bytes) of the table data the decoder set apart. `leaders`: block starts known from direct control flow."""
    out: dict[int, Dispatch] = {}
    if data is None:
        return out
    at = {i.rva for i in insns}
    into = direct_targets(insns)
    for k, i in enumerate(insns):
        t = i.terminator
        if not isinstance(t, Goto) or isinstance(t.target, Const):
            continue
        s = block_start(insns, k, leaders)
        if s == 0:
            continue
        guard = insns[s - 1].terminator
        # the only way in is the guard's fall-through
        if not isinstance(guard, Branch) or insns[s].rva + image_base in into:
            continue
        g = block_start(insns, s - 1, leaders)
        v = Values().run(insns[g : k + 1], CLOBBERED)
        d = _dispatch(v, i.rva, insns[g:s], image_base, data, at)
        if d is not None:
            out[i.rva] = d
    return out


def _bound(v: Values, before: list[Lifted]) -> tuple[int, int] | None:
    """(32-bit value, the largest that falls through) when the block ends in `cmp value, constant` and a jump if above (or equal)."""
    jcc = before[-1]
    if not jcc.form.startswith(("JA_REL", "JAE_REL")):
        return None
    for i in reversed(before[:-1]):
        if not any(isinstance(s, Put) and s.loc.width == 1 for s in i.stmts):
            continue
        if not i.form.startswith(("CMP_RM32_IMM", "CMP_EAX_IMM")):
            return None
        for op, args in v.ops_at.get(i.rva, ()):
            if op != "sub":
                continue
            c, x = _const(v, args[1]), v.nodes[args[0]]
            if c is None or x.kind != "op" or x.op != "zext":
                return None
            c -= jcc.form.startswith("JAE_REL")
            return (v.op("zext", x.args, 32), c) if 0 <= c < MAX_CASES else None
        return None
    return None


def _dispatch(v: Values, rva: int, before: list[Lifted], base: int, data: tuple[int, bytes], at: set[int]) -> Dispatch | None:
    b = _bound(v, before)
    if b is None:
        return None
    index32, top = b
    terms, c = _split(v, v.control[rva])
    if c != base or len(terms) != 1:
        return None
    entry = v.nodes[terms[0]]
    if entry.kind != "op" or entry.op not in ("zext", "sext") or v.nodes[entry.args[0]].kind != "load" or v.nodes[entry.args[0]].width != 32:
        return None
    tables: list[tuple[int, int]] = []

    def table(load: int) -> tuple[int, int, int] | None:
        """(RVA, index node, scale) of a load's address."""
        ts, off = _split(v, v.nodes[load].args[0])
        if len(ts) != 1:
            return None
        idx, scale = _scaled(v, ts[0])
        return off - base, idx, scale

    def read(r: int, size: int, n: int) -> list[int] | None:
        if r < data[0] or r + size * n > data[0] + len(data[1]):
            return None
        tables.append((r, size * n))
        o = r - data[0]
        return [int.from_bytes(data[1][o + size * k : o + size * k + size], "little") for k in range(n)]

    main = table(entry.args[0])
    if main is None or main[2] != 4:
        return None
    inner = v.nodes[main[1]]
    if inner.kind == "op" and inner.op == "zext" and v.nodes[inner.args[0]].kind == "load" and v.nodes[inner.args[0]].width == 8:
        first = table(inner.args[0])
        if first is None or first[2] != 1 or _root32(v, first[1]) != index32:
            return None
        cases = read(first[0], 1, top + 1)
        if cases is None:
            return None
    elif _root32(v, main[1]) == index32:
        cases = list(range(top + 1))
    else:
        return None
    entries = read(main[0], 4, max(cases) + 1)
    if entries is None:
        return None
    targets = tuple(entries[n] for n in cases)
    if any(t not in at for t in targets):
        return None
    return Dispatch(rva, top, tuple(sorted(tables)), targets)
