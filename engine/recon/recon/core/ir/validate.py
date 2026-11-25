# SPDX-License-Identifier: AGPL-3.0-or-later
"""The IR validator, and the only way into reconstruction.

`problems` lists every rule a function breaks, as fixed codes. `admit` wraps a function that breaks none; later phases
accept an `Admitted` and nothing else, so invalid IR cannot enter candidate generation.
"""
from __future__ import annotations

from recon.core.analysis import graph
from recon.core.analysis.dataflow import Abi
from recon.core.ir import memory as mm
from recon.core.ir.build import call_memory, cleans, exit_memory, main_region, op_memory
from recon.core.ir.model import EFFECTS, FRAME, IR_VERSION, OBSERVATIONS, OTHER, TERMS, Arg, Const, Fn, Op, Phi, op_width
from recon.core.sem import OPS, SemanticsError


NONE = -1  # no token is current


class InvalidIr(ValueError):
    def __init__(self, found: list[str]) -> None:
        super().__init__("; ".join(found[:5]))
        self.found = found


def problems(fn: Fn, abi: Abi, *, restored: bool = False) -> list[str]:
    """Codes of the rules broken, sorted, each once. `restored`: also require that every exit gives back the registers the caller owns."""
    out: set[str] = set()
    structure(fn, abi, out)
    if out:
        return sorted(out)  # the rest would stumble over a broken structure
    ssa(fn, out)
    types(fn, out)
    if not out:
        memory(fn, abi, out)
    coverage(fn, out)
    mandatory(fn, abi, out, restored)
    return sorted(out)


# ---------------------------------------------------------------------------------------- structure

def structure(fn: Fn, abi: Abi, out: set[str]) -> None:
    n = len(fn.blocks)
    if fn.version != IR_VERSION:
        out.add("version")
    if not n or any(b.id != k for k, b in enumerate(fn.blocks)):
        out.add("block-numbering")
        return
    for b in fn.blocks:
        t = b.term
        shape = TERMS.get(t.kind)
        if shape is None:
            out.add("terminator-kind")
            continue
        if shape[0] is not None and len(t.args) != shape[0] or shape[1] is not None and len(t.targets) != shape[1]:
            out.add("terminator-shape")
        if any(not isinstance(x, int) or not 0 <= x < n for x in t.targets):
            out.add("target")
        if t.kind == "branch" and len(set(t.targets)) != 2:
            out.add("branch-to-one-block")
        if t.kind == "switch" and [x for _a, x in t.attr("cases", ())] != list(t.targets):  # type: ignore[misc]
            out.add("switch-cases")
        if t.kind == "return" and len(t.args) != len(t.attr("results", ())) + len(t.attr("preserved", ())):  # type: ignore[arg-type]
            out.add("terminator-shape")
        if t.kind == "tail" and len(t.args) != 1 + len(t.attr("args", ())) + len(t.attr("preserved", ())):  # type: ignore[arg-type]
            out.add("terminator-shape")
        for o in b.ops:
            if o.kind in EFFECTS:
                want = EFFECTS[o.kind]
                if want is not None and len(o.args) != want:
                    out.add("arity")
                if o.kind == "call":
                    if len(o.args) != 1 + len(o.attr("args", ())) or len(o.defs) != len(o.attr("defs", ())):  # type: ignore[arg-type]
                        out.add("call-shape")
                    if not set(o.attr("defs", ())) <= abi.clobbered or set(o.attr("args", ())) != abi.arguments or not isinstance(o.attr("sp"), int):  # type: ignore[arg-type]
                        out.add("call-convention")
                elif len(o.defs) != (1 if o.kind == "load" else 0):
                    out.add("arity")
            elif o.kind == FRAME:
                if o.args or len(o.defs) != 1 or not isinstance(o.attr("off"), int):
                    out.add("arity")
            elif o.kind not in OPS:
                out.add("operation")
            elif len(o.args) != OPS[o.kind][0] or len(o.defs) != 1 or o.attrs:
                out.add("arity")
            if o.mem and o.kind not in EFFECTS:
                out.add("memory-on-a-pure-operation")
    if any(len(u) != 2 or not -1 <= u[0] < s or u[1] < 0 for s, u in enumerate(fn.unwind)):
        out.add("unwind-table")
    for b in fn.blocks:
        for o in b.ops:
            s = o.attr("state")
            if o.kind == "call" and (isinstance(s, int) and -1 <= s < len(fn.unwind)) != bool(fn.unwind) or (o.kind != "call" or not fn.unwind) and s is not None:
                out.add("call-state")
    if out:
        return
    if len(graph.reverse_postorder(fn.succ, 0)) != n:
        out.add("unreachable-block")
    preds = fn.preds()
    if preds[0] or fn.blocks[0].phis:
        out.add("entry-block")
    names = [r.name for r in fn.regions]
    if len(set(names)) != len(names):
        out.add("region-names")
    for b in fn.blocks:
        for p in b.phis:
            if [k for k, _v in p.args] != sorted(preds[b.id]):
                out.add("phi-predecessors")
    every: list[int] = [v for _n, v in (*fn.params, *fn.tokens)]
    for b in fn.blocks:
        every += [p.id for p in b.phis]
        for o in b.ops:
            every += [*o.defs, *(m.after for m in o.mem if m.after is not None)]
        if any(m.after is not None for m in b.term.mem):
            out.add("terminator-changes-memory")
    if len(set(every)) != len(every):
        out.add("value-defined-twice")
    if set(every) != set(fn.types):
        out.add("value-without-definition")
    used = {a for b in fn.blocks for o in (*b.ops, b.term) for a in (*o.args, *(m.before for m in o.mem)) if isinstance(a, int)}
    used |= {a for b in fn.blocks for p in b.phis for _k, a in p.args if isinstance(a, int)}
    if not used <= set(every):
        out.add("use-of-nothing")


# ---------------------------------------------------------------------------------------- SSA and types

def ssa(fn: Fn, out: set[str]) -> None:
    """Every use is dominated by its definition; a phi's argument by the end of the block it comes from."""
    idom = graph.immediate_dominators(fn.succ, 0)
    home = {v: b for v, (b, _o) in fn.defining().items()}
    place: dict[int, int] = {v: -2 for _n, v in (*fn.params, *fn.tokens)}
    for b in fn.blocks:
        for p in b.phis:
            place[p.id] = -1
        for k, o in enumerate(b.ops):
            for v in (*o.defs, *(m.after for m in o.mem if m.after is not None)):
                place[v] = k

    def ok(v: Arg, block: int, k: int) -> bool:
        if not isinstance(v, int):
            return True
        return place[v] < k if home[v] == block else graph.dominates(idom, home[v], block)

    for b in fn.blocks:
        for k, o in enumerate(b.ops):
            if not all(ok(a, b.id, k) for a in (*o.args, *(m.before for m in o.mem))):
                out.add("use-not-dominated")
        if not all(ok(a, b.id, len(b.ops)) for a in (*b.term.args, *(m.before for m in b.term.mem))):
            out.add("use-not-dominated")
        for p in b.phis:
            if not all(ok(a, k, len(fn.blocks[k].ops)) for k, a in p.args):
                out.add("phi-argument-not-dominated")


def types(fn: Fn, out: set[str]) -> None:
    t = fn.types
    regions = {r.name for r in fn.regions}
    if any(not (isinstance(x, int) and not isinstance(x, bool) and x > 0 or isinstance(x, str) and x in regions) for x in t.values()):
        out.add("type")
        return
    if any(isinstance(t[v], str) for _n, v in fn.params) or any(t[v] != n for n, v in fn.tokens):
        out.add("entry-type")

    def width(a: Arg) -> int | None:
        if isinstance(a, Const):
            return a.width
        x = t[a]
        return x if isinstance(x, int) else None

    for b in fn.blocks:
        for p in b.phis:
            if p.region is None:
                if any(width(a) != width(p.id) or width(a) is None for _k, a in p.args):
                    out.add("phi-type")
            elif t[p.id] != p.region or any(not isinstance(a, int) or t[a] != p.region for _k, a in p.args):
                out.add("phi-type")
        for o in (*b.ops, b.term):
            if any(width(a) is None for a in o.args):
                out.add("token-used-as-value")
                continue
            if any(t[m.before] != m.region or m.after is not None and t[m.after] != m.region for m in o.mem):
                out.add("token-type")
            if not isinstance(o, Op):
                if o.kind == "branch" and width(o.args[0]) != 1 or o.kind in ("switch", "tail") and width(o.args[0]) != 64:
                    out.add("terminator-type")
                continue
            ws = [width(a) or 0 for a in o.args]
            ds = [width(v) for v in o.defs]
            if None in ds:
                out.add("token-used-as-value")
            elif o.kind in OPS:
                try:
                    if op_width(o.kind, o.args, ws, ds[0]) != ds[0]:
                        out.add("operation-type")
                except SemanticsError:
                    out.add("operation-type")
            elif o.kind == FRAME:
                if ds[0] != 64:
                    out.add("operation-type")
            elif o.kind == "load":
                if ws[0] != 64 or ds[0] % 8:  # type: ignore[operator]
                    out.add("memory-type")
            elif o.kind == "store":
                if ws[0] != 64 or ws[1] % 8:
                    out.add("memory-type")
            elif o.kind == "blockcopy":
                if ws[:3] != [64, 64, 64] or ws[3] != 1 or o.attr("size") not in (1, 2, 4, 8):
                    out.add("memory-type")
            elif o.kind == "blockfill":
                if ws[0] != 64 or ws[1] % 8 or ws[2] != 64 or ws[3] != 1:
                    out.add("memory-type")
            elif o.kind == "trap" and ws[0] != 1 or o.kind == "call" and ws[0] != 64:
                out.add("operation-type")


# ---------------------------------------------------------------------------------------- memory

def memory(fn: Fn, abi: Abi, out: set[str]) -> None:
    """The tokens are those a fresh reading of the function would give: each operation names every region it may touch, reads the
    token current there, and a private region is reached by nothing that is not followed."""
    d = {v: o for v, (_b, o) in fn.defining().items()}
    params = {v: n for n, v in fn.params}
    regions = list(fn.regions)
    if not any(r.name == OTHER for r in regions) or [n for n, _v in fn.tokens] != [r.name for r in regions]:
        out.add("regions")
        return
    for r in regions:
        known = r.base in (OTHER, "frame", mm.FRAME_REGION, "global") or r.base.startswith("param:") and r.base[6:] in params.values()
        if not known or r.hi < r.lo or r.private and r.base != "frame" or r.keeps and not r.private:
            out.add("regions")
    if any(a.base == b.base and a.lo < b.hi and b.lo < a.hi for k, a in enumerate(regions) for b in regions[:k] if a.hi > a.lo and b.hi > b.lo):
        out.add("regions-overlap")

    def extents(o: Op):
        return mm.access_extents(o, d.get, params, fn.width)

    ops = [o for _b, o in fn.ops()]
    private_exposed = [r for r in regions if r.private and not r.keeps]
    if private_exposed and mm.frame_escapes(fn):
        out.add("private-region-escapes")
    for o in ops:
        for e, _w in extents(o):
            # no access may overlap a private region without lying in it
            if e.place is not None and e.place[0] == "frame" and e.size is not None:
                lo, hi = e.place[1], e.place[1] + e.size
                if any(r.private and lo < r.hi and r.lo < hi and not (r.lo <= lo and hi <= r.hi) for r in regions):
                    out.add("access-crosses-a-private-region")
            if e.place is not None and e.place[0] == "frame" and not any(r.name == mm.FRAME_REGION for r in regions):
                if e.size is None or not any(r.private and r.lo <= e.place[1] and e.place[1] + e.size <= r.hi for r in regions):
                    out.add("frame-access-without-a-region")
    if out:
        return
    preds = fn.preds()
    end: dict[int, dict[str, int]] = {}
    pending: list[tuple[int, str]] = []  # (block, region) taken from the ways in seen first; the others are checked at the end
    start: dict[int, dict[str, int]] = {}
    for b in graph.reverse_postorder(fn.succ, 0):
        blk = fn.blocks[b]
        if b == 0:
            cur = dict(fn.tokens)
        else:
            cur = {p.region: p.id for p in blk.phis if p.region is not None}
            for r in regions:
                if r.name not in cur:
                    seen = {end[p][r.name] for p in preds[b] if p in end}
                    # where the ways into a block disagree and there is no phi, there is no current token: any use is stale
                    cur[r.name] = seen.pop() if len(seen) == 1 else NONE
                    if any(p not in end for p in preds[b]) and cur[r.name] != NONE:
                        pending.append((b, r.name))
        start[b] = dict(cur)
        for o in blk.ops:
            want = op_memory(o, regions, lambda o: call_memory(regions, abi, int(o.attr("sp")), cleans(fn, o)), extents)
            if [(m.region, m.after is not None) for m in o.mem] != [(r.name, c) for r, c in want]:
                out.add("memory-operands")
            if main_region(o, regions, extents) != o.attr("region"):
                out.add("memory-region")
            for m in o.mem:
                if cur[m.region] != m.before:
                    out.add("stale-token")
                if m.after is not None:
                    cur[m.region] = m.after
        t = blk.term
        if t.kind in ("return", "tail"):
            if [m.region for m in t.mem] != [r.name for r, _c in exit_memory(regions, abi, t.kind == "tail")] or any(cur[m.region] != m.before for m in t.mem):
                out.add("exit-memory")
        elif t.mem:
            out.add("exit-memory")
        end[b] = cur
    for b in fn.blocks:
        for p in b.phis:
            if p.region is not None and any(end[k][p.region] != a for k, a in p.args):
                out.add("stale-token")
    # a loop may change a region without a phi only when nothing in or after it uses that region again
    bad = {(b, n) for b, n in pending if any(end[p][n] != start[b][n] for p in preds[b])}
    if bad and _used_while_stale(fn, bad):
        out.add("stale-token")


def _used_while_stale(fn: Fn, bad: set[tuple[int, str]]) -> bool:
    """Whether a token that is wrong at the start of a block is used before the region gets a new one."""
    work, seen = list(bad), set(bad)
    while work:
        b, n = work.pop()
        blk = fn.blocks[b]
        for o in (*blk.ops, blk.term):
            for m in o.mem:
                if m.region == n:
                    return True  # it reads the token, if only to make the next one
        for t in dict.fromkeys(blk.term.targets):
            if any(p.region == n for p in fn.blocks[t].phis):
                return True
            if (t, n) not in seen:
                seen.add((t, n))
                work.append((t, n))
    return False


# ---------------------------------------------------------------------------------------- coverage and properties

def coverage(fn: Fn, out: set[str]) -> None:
    """Every instruction became an operation or is recorded with what it was; nothing else is named."""
    have = {a for b in fn.blocks for o in (*b.ops, b.term) for a in o.at}
    seen = {o.rva for o in fn.observations}
    if any(o.kind not in OBSERVATIONS for o in fn.observations):
        out.add("observation-kind")
    if not set(fn.insns) <= have | seen:
        out.add("instruction-not-covered")
    if not have | seen <= set(fn.insns):
        out.add("instruction-unknown")
    for b in fn.blocks:
        for o in b.ops:
            if o.kind in EFFECTS and not o.at:
                out.add("effect-without-an-instruction")


def mandatory(fn: Fn, abi: Abi, out: set[str], restored: bool) -> None:
    """What no transformation may lose: exits name every register the convention fixes, and give back those the caller owns."""
    entry = dict(fn.params)
    d = {v: o for v, (_b, o) in fn.defining().items()}

    def gives_back(a: Arg, name: str, seen: set[int]) -> bool:
        if a == entry.get(name):
            return True
        if isinstance(a, int) and isinstance(d[a], Phi) and a not in seen:
            seen.add(a)
            return all(x in seen or gives_back(x, name, seen) for _k, x in d[a].args)  # type: ignore[union-attr]
        return False

    for b in fn.blocks:
        t = b.term
        if t.kind == "return" and (set(t.attr("results", ())) != abi.results or set(t.attr("preserved", ())) != abi.preserved):  # type: ignore[arg-type]
            out.add("return-convention")
        if t.kind == "tail" and (set(t.attr("args", ())) != abi.arguments or set(t.attr("preserved", ())) != abi.preserved):  # type: ignore[arg-type]
            out.add("tail-convention")
        if restored and t.kind in ("return", "tail"):
            kept = t.attr("preserved", ())
            for name, a in zip(kept, t.args[len(t.args) - len(kept):]):  # type: ignore[arg-type]
                if not gives_back(a, name, set()):
                    out.add("register-not-given-back")
    if not all(a and isinstance(a, str) for a in fn.assumptions):
        out.add("assumptions")


# ---------------------------------------------------------------------------------------- admission

_KEY = object()


class Admitted:
    """A function that passed the validator. Made by `admit` only."""

    __slots__ = ("fn", "digest")

    def __init__(self, fn: Fn, key: object) -> None:
        if key is not _KEY:
            raise InvalidIr(["not-validated"])
        self.fn = fn
        self.digest = fn.digest()


def admit(fn: Fn, abi: Abi) -> Admitted:
    found = problems(fn, abi, restored=True)
    if found:
        raise InvalidIr(found)
    return Admitted(fn, _KEY)


def require(x: object) -> Fn:
    """What a later phase calls first: the function inside an `Admitted`, unchanged since, or InvalidIr."""
    if not isinstance(x, Admitted) or x.fn.digest() != x.digest:
        raise InvalidIr(["not-validated"])
    return x.fn
