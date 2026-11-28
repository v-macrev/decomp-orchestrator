# SPDX-License-Identifier: AGPL-3.0-or-later
"""Thread-local variables (D-074).

A compiler reaches a thread-local variable through the thread's block: the thread block holds the array of the threads'
storage blocks at a fixed place, the module's slot in it is the module's index, and the variable lies at its offset in the
module's block, the offset it has in the image's template of that block. The source names the variable (`thread_local`)
and the compiler writes the whole reach again, so the reach is read as the variable: its address is taken to be the
address of its initial value in the template, which the source then reads and writes as an object of its own.

Nothing here reads the target's bytes beyond what its normal form shows: the reach is a pattern of the normal form, and
the template and the index are what the image's thread-local directory says.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from recon.core.ir.build import substitute
from recon.core.ir.model import Arg, Const, Fn, Op


@dataclass(frozen=True)
class ThreadLocals:
    """`base`: the location holding the thread block's address; `array`: where the thread block holds the array of storage
    blocks; `index`: the address of the module's index; `start`, `end`: the address range of the template."""

    base: str
    array: int
    index: int
    start: int
    end: int

    def holds(self, at: int) -> bool:
        """Whether `at` is the address of a thread-local variable (a place in the template)."""
        return self.start <= at < self.end


def _plus(d: dict[int, Op], v: Arg) -> tuple[Arg, int] | None:
    """(x, c) when `v` is x + c for a constant c (either order), else None."""
    o = d.get(v) if isinstance(v, int) else None
    if o is None or o.kind != "add":
        return None
    a, b = o.args
    if isinstance(b, Const) and not isinstance(a, Const):
        return a, b.value
    if isinstance(a, Const) and not isinstance(b, Const):
        return b, a.value
    return None


def _slot(d: dict[int, Op], v: Arg, index: int) -> bool:
    """Whether `v` is the module's index times the width of an array entry (8): shl(zext(load32 index), 3) and the like."""
    o = d.get(v) if isinstance(v, int) else None
    if o is None:
        return False
    if o.kind == "shl" and isinstance(o.args[1], Const) and o.args[1].value == 3:
        x = o.args[0]
    elif o.kind == "mul" and any(isinstance(a, Const) and a.value == 8 for a in o.args):
        x = next(a for a in o.args if not isinstance(a, Const))
    else:
        return False
    z = d.get(x) if isinstance(x, int) else None
    if z is not None and z.kind == "zext":
        z = d.get(z.args[0]) if isinstance(z.args[0], int) else None
    return z is not None and z.kind == "load" and isinstance(z.args[0], Const) and z.args[0].value == index


def thread_locals(fn: Fn, t: ThreadLocals | None) -> Fn:
    """The function with every reach of a thread-local variable read as the variable's address (its template address);
    unchanged when a reach is used otherwise (the module's block kept, handed on or indexed), or when there is none."""
    if t is None:
        return fn
    base = {v for n, v in fn.params if n == t.base}
    if not base:
        return fn
    d = {v: o for v, (_b, o) in fn.defining().items() if isinstance(o, Op)}
    uses: dict[int, list[Op]] = {}
    for b in fn.blocks:
        for x in (*b.ops, b.term):
            for a in x.args:
                if isinstance(a, int):
                    uses.setdefault(a, []).append(x)  # type: ignore[arg-type]
        for p in b.phis:
            for _k, a in p.args:
                if isinstance(a, int):
                    uses.setdefault(a, []).append(p)  # type: ignore[arg-type]
    arrays = {o.defs[0] for o in d.values() if o.kind == "load" and fn.width(o.defs[0]) == 64
              and (p := _plus(d, o.args[0])) is not None and p[0] in base and p[1] == t.array}
    blocks: set[int] = set()
    for o in d.values():
        if o.kind != "load" or fn.width(o.defs[0]) != 64 or not isinstance(o.args[0], int):
            continue
        a = d.get(o.args[0])
        if a is not None and a.kind == "add" and any(x in arrays for x in a.args) and any(_slot(d, x, t.index) for x in a.args):
            blocks.add(o.defs[0])
    if not blocks:
        return fn
    sub: dict[int, Arg] = {}
    moved: dict[int, int] = {}                     # a load or store whose address is the block itself -> its offset 0
    for v in blocks:
        for u in uses.get(v, []):
            if isinstance(u, Op) and u.kind == "add" and (p := _plus(d, u.defs[0])) is not None and p[0] == v:
                if not t.holds(t.start + p[1]):
                    return fn
                sub[u.defs[0]] = Const(t.start + p[1], 64)
            elif isinstance(u, Op) and u.kind in ("load", "store") and u.args[0] == v and v not in u.args[1:]:
                moved[id(u)] = v
            else:
                return fn
    blocks_ops = []
    for b in fn.blocks:
        ops = []
        for o in b.ops:
            if id(o) in moved:
                o = replace(o, args=(Const(t.start, 64), *o.args[1:]))
            ops.append(o)
        blocks_ops.append(replace(b, ops=tuple(ops)))
    out = substitute(replace(fn, blocks=tuple(blocks_ops)), sub, set())
    # the reaches nothing uses now go: the module's blocks, the arrays, the index reads and the sums leading to them
    chain, work = set(sub), [*blocks, *arrays]
    while work:
        v = work.pop()
        o = d.get(v)
        if v in chain or o is None or o.kind not in ("load", "add", "shl", "mul", "zext"):
            continue
        chain.add(v)
        work.extend(a for a in o.args if isinstance(a, int) and a not in base)
    while True:
        used = {a for b in out.blocks for x in (*b.ops, b.term) for a in x.args if isinstance(a, int)} | \
               {a for b in out.blocks for p in b.phis for _k, a in p.args if isinstance(a, int)}
        kept = tuple(replace(b, ops=tuple(o for o in b.ops if not (o.defs and o.defs[0] in chain and o.defs[0] not in used)))
                     for b in out.blocks)
        if kept == out.blocks:
            break
        out = replace(out, blocks=kept)
    return replace(out, history=(*out.history, "thread-locals"))


__all__ = ["ThreadLocals", "thread_locals"]
