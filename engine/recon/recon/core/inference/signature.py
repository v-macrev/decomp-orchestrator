# SPDX-License-Identifier: AGPL-3.0-or-later
"""Signatures: which arguments a function takes, what it returns, and how well that is supported.

A location that holds an argument on entry is an argument when the function needs its value. A result location holds a
result when every return leaves something in it that the function computed. What a call needs is the callee's business,
so signatures of callees come from a resolver; without one only the caller's evidence is left.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Callable, Mapping

from recon.core.ir.model import Arg, Const, Fn, Op, Phi
from recon.core.sem import OPS


class Evidence(str, Enum):
    PROVEN = "PROVEN"
    CONSTRAINED = "CONSTRAINED"
    INFERRED = "INFERRED"
    AMBIGUOUS = "AMBIGUOUS"
    UNKNOWN = "UNKNOWN"


INT, FLOAT = "i", "f"


@dataclass(frozen=True, slots=True, order=True)
class Slot:
    """One argument or result: integer or floating point, and how many low bits of the location it uses."""

    kind: str
    width: int
    #: "signed" or "unsigned" when a declaration says so; code alone never decides it
    sign: str = ""


@dataclass(frozen=True)
class Signature:
    params: tuple[Slot, ...]
    result: Slot | None
    #: how well each part is supported, in a fixed order
    evidence: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class Convention:
    """Where arguments and results live. `slots`: for each position the integer and the floating-point location."""

    slots: tuple[tuple[str, str], ...]
    result_int: str
    result_float: str

    def place(self, k: int, kind: str) -> str:
        return self.slots[k][0 if kind == INT else 1]

    def result(self, kind: str) -> str:
        return self.result_int if kind == INT else self.result_float


class NotReconstructed(ValueError):
    """The function needs something that is not supported. `code` is fixed text that says nothing about the function."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


CalleeOf = Callable[[Arg], "Signature | None"]   # the target of a call -> its signature, when there is one

# ---------------------------------------------------------------------------------------- what is computed

FULL = 1 << 20


def computed(fn: Fn, conv: Convention, callee: CalleeOf) -> dict[int, int]:
    """For each value the number of low bits that the function computed or was given. Above them may be what a callee or
    the caller happened to leave. Argument locations count as given. Greatest fixpoint; a value that is missing is FULL."""
    given = {n for pair in conv.slots for n in pair}
    low: dict[int, int] = {v: (FULL if n in given else 0) for n, v in fn.params}

    def of(a: Arg) -> int:
        return FULL if isinstance(a, Const) else low.get(a, FULL)

    def result(o: Op) -> int:
        w = fn.width(o.defs[0])
        k, args = o.kind, o.args
        ls = [of(a) for a in args]
        if k == "undef":
            return 0
        if all(x >= fn.width(a) for x, a in zip(ls, args)):
            return FULL
        if k in ("and", "or"):
            for c, other in ((args[0], ls[1]), (args[1], ls[0])):
                if isinstance(c, Const) and other < w:
                    matters = c.value if k == "and" else ~c.value & (1 << w) - 1
                    rest = matters >> other << other
                    return FULL if not rest else (rest & -rest).bit_length() - 1
            return min(ls)
        if k in ("add", "sub", "mul", "neg", "not", "xor"):
            return min(ls)
        if k == "ite":
            return min(ls[1:]) if ls[0] >= 1 else 0
        if k in ("trunc", "zext"):
            n = min(w, fn.width(args[0]))
            return FULL if ls[0] >= n else ls[0]
        if k == "cat":
            n = fn.width(args[1])
            return ls[1] if ls[1] < n else n + ls[0]
        if k == "shl" and isinstance(args[1], Const):
            return ls[0] + args[1].value
        return 0

    def set_low(v: int, new: int) -> bool:
        if new < low.get(v, FULL):
            low[v] = new
            return True
        return False

    changed = True
    while changed:
        changed = False
        for b in fn.blocks:
            for p in b.phis:
                if p.region is None:
                    changed |= set_low(p.id, min(of(a) for _k, a in p.args))
            for o in b.ops:
                if o.kind == "call":
                    sig = callee(o.args[0])
                    for n, v in zip(o.attr("defs") or (), o.defs):  # type: ignore[call-overload]
                        if sig is None:
                            new = FULL if n in (conv.result_int, conv.result_float) else 0  # it may be the result
                        else:
                            new = sig.result.width if sig.result is not None and n == conv.result(sig.result.kind) else 0
                        changed |= set_low(v, new)
                elif o.pure and o.kind != "frame":
                    changed |= set_low(o.defs[0], result(o))
    return low


# ---------------------------------------------------------------------------------------- results

def _zero_above(fn: Fn, d: Mapping[int, object], a: Arg, w: int) -> bool:
    """Whether every bit from `w` up is zero, seen through phis.

    A value that reaches itself through phis is taken to be zero above `w` unless something else says otherwise: the
    greatest fixed point. It is computed over the values reachable from `a`, each once (every value starts true and is
    made false when its own rule fails, which is passed on to the values that use it), so a ladder of phis that reach
    the same values along many paths costs what its size costs, not the number of its paths."""
    if isinstance(a, Const):
        return a.value >> w == 0

    def rule(v: int) -> tuple[str, list[Arg]] | bool:
        o = d.get(v)
        if isinstance(o, Phi):
            return "all", [x for _k, x in o.args]
        if isinstance(o, Op):
            if o.kind == "zext":
                return True if fn.width(o.args[0]) <= w else ("all", [o.args[0]])
            if o.kind == "and":
                return "any", list(o.args)
            if o.kind == "ite":
                return "all", list(o.args[1:])
            if o.kind == "lshr" and isinstance(o.args[1], Const):
                return fn.width(v) - o.args[1].value <= w
        return False

    rules: dict[int, tuple[str, list[Arg]] | bool] = {}
    users: dict[int, list[int]] = {}
    todo = [a]
    while todo:
        v = todo.pop()
        if v in rules:
            continue
        rules[v] = r = rule(v)
        if not isinstance(r, bool):
            for x in r[1]:
                if not isinstance(x, Const):
                    users.setdefault(x, []).append(v)  # type: ignore[arg-type]
                    todo.append(x)
    value = {v: r if isinstance(r, bool) else True for v, r in rules.items()}

    def holds(x: Arg) -> bool:
        return x.value >> w == 0 if isinstance(x, Const) else value[x]  # type: ignore[index]
    work = list(rules)
    while work:
        v = work.pop()
        r = rules[v]
        if isinstance(r, bool) or not value[v]:
            continue
        mode, xs = r
        if not (all(map(holds, xs)) if mode == "all" else any(map(holds, xs))):
            value[v] = False
            work.extend(users.get(v, ()))
    return value[a]  # type: ignore[index]


def _float_width(fn: Fn, d: Mapping[int, object], vals: list[Arg], callee: CalleeOf) -> int:
    """32 or 64: the width at which the lowest element is made; 0 when nothing says it is floating point."""
    made: set[int] = set()
    seen: set[int] = set()

    def walk(a: Arg) -> None:
        if isinstance(a, Const) or a in seen:
            return
        seen.add(a)
        o = d.get(a)
        if isinstance(o, Phi):
            for _k, x in o.args:
                walk(x)
        elif isinstance(o, Op):
            if o.kind in OPS and OPS[o.kind][1] in ("fsame", "fun", "f2f", "i2f") or o.kind == "load" and fn.width(a) in (32, 64):
                made.add(fn.width(a))
            elif o.kind == "cat":
                walk(o.args[1])
            elif o.kind == "ite":
                walk(o.args[1])
                walk(o.args[2])
            elif o.kind in ("zext", "trunc", "and", "or"):
                for x in o.args:
                    walk(x)
            elif o.kind == "call":
                sig = callee(o.args[0])
                if sig is not None and sig.result is not None and sig.result.kind == FLOAT:
                    made.add(sig.result.width)
    for a in vals:
        walk(a)
    return min(made) if made else 0


def _by_chance(d: Mapping[int, object], uses: Mapping[int, int], given: Mapping[int, object] | set, constants: set,
               root: Arg) -> bool:
    """Whether the value has another use than being returned, so that it may merely have been left there: through
    phis and widenings, every value it may be has one (`via`: the uses on the way there, 0 for the returned value
    itself). A phi met again adds nothing, and what is said of any other value depends only on the value and `via`,
    so each is looked at once, however many paths reach it."""
    todo: list[tuple[Arg, int]] = [(root, 0)]
    done: set = set()
    while todo:
        a, via = todo.pop()
        if isinstance(a, Const):
            if a.value not in constants:
                return False
            continue
        o = d.get(a)
        key = a if isinstance(o, Phi) else (a, via)
        if key in done:
            continue
        done.add(key)
        if isinstance(o, Phi):
            todo.extend((x, 1) for _k, x in o.args)
        elif isinstance(o, Op) and o.kind in ("zext", "trunc", "cat", "and") and uses.get(a, 0) <= via and not isinstance(o.args[-1], Const):
            todo.append((o.args[-1], 1))
        elif not (a in given or uses.get(a, 0) > via or isinstance(o, Op) and o.kind == "call"):
            return False
    return True


def results(fn: Fn, conv: Convention, callee: CalleeOf) -> list[tuple[Slot | None, Evidence]]:
    """What the function may return, best supported first."""
    low = computed(fn, conv, callee)
    d = {v: o for v, (_b, o) in fn.defining().items()}
    given = {v: n for n, v in fn.params}
    rets = [b.term for b in fn.blocks if b.term.kind == "return"]
    tails = [callee(b.term.args[0]) for b in fn.blocks if b.term.kind == "tail"]
    if not rets:
        known = {t.result for t in tails if t is not None}
        return [(known.pop(), Evidence.INFERRED)] if len(known) == 1 and None not in tails else [(None, Evidence.UNKNOWN)]
    uses: dict[int, int] = {}
    for b in fn.blocks:
        args = [a for o in b.ops for a in o.args] + [a for p in b.phis for _k, a in p.args] + ([] if b.term.kind == "return" else list(b.term.args))
        for a in args:
            if isinstance(a, int):
                uses[a] = uses.get(a, 0) + 1

    constants = {a.value for b in fn.blocks for o in b.ops if not o.pure for a in o.args if isinstance(a, Const)}

    def by_chance(a: Arg) -> bool:
        return _by_chance(d, uses, given, constants, a)

    found: list[tuple[Slot | None, Evidence]] = []
    copied = {n for o in fn.observations if o.kind == "copy" for n in o.detail.split(",")}
    for kind in (FLOAT, INT):
        n = conv.result(kind)
        vals: list[Arg] = [dict(zip(t.attr("results"), t.args))[n] for t in rets]  # type: ignore[call-overload]
        if any(t is not None and (t.result is None or t.result.kind != kind) for t in tails):
            continue
        bits = min(min(low.get(a, FULL), fn.width(a)) if isinstance(a, int) else fn.width(a) for a in vals)
        w = next((x for x in (64, 32, 16, 8) if bits >= x), 0)
        if kind == FLOAT:
            made = _float_width(fn, d, vals, callee)
            w = made if made and w >= made else 0
        elif w == 64 and all(_zero_above(fn, d, a, 32) for a in vals):
            w = 32
        if w:
            found.append((Slot(kind, w), Evidence.AMBIGUOUS if all(map(by_chance, vals)) else Evidence.INFERRED))
    sure = [x for x in found if x[1] is Evidence.INFERRED]
    if not found:
        return [(None, Evidence.PROVEN)]
    if sure:
        return sure + [x for x in found if x not in sure]
    # a value moved into the place of a result is more likely one than a value that was computed there
    moved = [x for x in found if x[0] is not None and conv.result(x[0].kind) in copied]
    return [*moved, (None, Evidence.AMBIGUOUS), *(x for x in found if x not in moved)]


__all__ = ["CalleeOf", "Convention", "Evidence", "FLOAT", "FULL", "INT", "NotReconstructed", "Signature", "Slot", "computed", "results"]
