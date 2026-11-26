# SPDX-License-Identifier: AGPL-3.0-or-later
"""From a function's normal form to candidates: the canonical one first, then the few alternatives that forms of C++ leave open.

A candidate is a choice for each open point. The canonical one takes the best-supported reading everywhere; an alternative
changes one point, or two. Each is checked by execution against the normal form, and only those that do the same are
candidates at all; equal trees are one candidate. No choice looks at the target's bytes.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from itertools import combinations
from typing import Callable, Iterator

from recon.core import budget
from recon.core.analysis.dataflow import Abi
from recon.core.emitter.cpp import Emitter, Unit
from recon.core.inference import lower as lw
from recon.core.inference import signature as sg
from recon.core.inference import types as ty
from recon.core.inference.signature import INT, Convention, Evidence, NotReconstructed, Signature, Slot
from recon.core.ir import idioms
from recon.core.ir.model import Arg, Const, Fn
from recon.core.structuring import ast as A
from recon.core.structuring import evaluate as ev
from recon.core.structuring.build import Builder
from recon.core.structuring.regions import Style, comparisons, structure
from recon.core.structuring.rotate import unrotate

#: compiler undo that the canonical form takes: the value has one natural reading
UNDO = frozenset({"unsigned-division", "signed-division", "unsigned-remainder", "signed-remainder", "multiplication"})
MAX_UNDO = 64
MAX_DEPTH = 4
MAX_FLIPS = 4


def ir_nodes(fn: Fn) -> int:
    """What a function costs the `irNodes` budget: its operations and terminators."""
    return sum(len(b.ops) + 1 for b in fn.blocks)


class Program:
    """The functions of an image, by absolute address, as far as they have been needed."""

    def __init__(self, normal: Callable[[int], Fn], conv: Convention, abi: Abi, base: int, image: Callable[[int, int], "bytes | None"],
                 constant: Callable[[int, int], "int | None"], declared: Callable[[int], "tuple[str, Signature] | None"] = lambda at: None) -> None:
        """`normal(address)`: the admitted normal form, or NotReconstructed. `constant`: the bits of read-only memory, or None.
        `declared(address)`: the name and signature a declaration gives the function there (the highest-ranked evidence), or None."""
        self._normal = normal
        self._declared = declared
        self.conv, self.abi, self.base, self.image, self.constant = conv, abi, base, image, constant
        self._fns: dict[int, Fn | NotReconstructed] = {}
        self._sigs: dict[int, Signature | None] = {}
        self._open: list[int] = []
        self._guess: dict[int, Signature] = {}
        self._start = Signature((), Slot(INT, 64))
        self._cyclic: set[int] = set()

    def normal(self, at: int) -> Fn:
        if at not in self._fns:
            try:
                f = self._normal(at)
            except NotReconstructed as e:
                self._fns[at] = e
            else:
                budget.spend("irNodes", ir_nodes(f))     # before it is kept: a larger budget analyses it again
                self._fns[at] = f
        f = self._fns[at]
        if isinstance(f, NotReconstructed):
            raise f
        return f

    def callee(self, target: Arg) -> Signature | None:
        return self.signature(target.value) if isinstance(target, Const) else None

    def name(self, at: int) -> str | None:
        """The name a declaration gives the function at `at`, when it is a plain identifier the source can call."""
        d = self._declared(at)
        return d[0] if d is not None and d[0].isidentifier() else None

    def signature(self, at: int) -> Signature | None:
        """What a function takes and returns: from its declaration, else from its own code; None when that cannot be told."""
        if at in self._sigs:
            return self._sigs[at]
        d = self._declared(at)
        if d is not None:
            self._sigs[at] = d[1]
            return d[1]
        if at in self._open:
            self._cyclic.add(at)
            return self._guess.get(at, self._start)
        if len(self._open) >= MAX_DEPTH:
            return None
        self._open.append(at)
        try:
            out: Signature | None = None
            for _ in range(8):       # a function that calls itself: until what is assumed of it is what comes out
                self._cyclic.discard(at)
                try:
                    out = self._infer(at)
                except NotReconstructed:
                    out = None
                    break
                if at not in self._cyclic or out == self._guess.get(at, self._start):
                    break
                self._guess[at] = out
            else:
                out = None
        finally:
            self._open.pop()
        if not (self._cyclic & set(self._open)):
            self._sigs[at] = out     # it does not rest on a guess about a function still being looked at
        return out

    def _infer(self, at: int) -> Signature:
        fn = self.normal(at)
        result, why = sg.results(fn, self.conv, self.callee)[0]
        _low, slots = lw.lower(fn, self.conv, self.abi, self.callee, result)
        return Signature(slots, result, (("result", why.value),))


@dataclass(frozen=True)
class Choice:
    """What a candidate decides. The default is the canonical form."""

    result: int = 0                              # which of the possible results
    style: Style = Style()
    unrotate: bool = True
    undo: bool = True
    read_again: bool = False
    flips: tuple[int, ...] = ()                  # open signs taken the other way, by position

    def changes(self) -> tuple[str, ...]:
        d = Choice()
        out = []
        if self.result != d.result:
            out.append(f"result:{self.result}")
        if self.style.split_returns != d.style.split_returns:
            out.append("shared-return")
        if self.style.select != d.style.select:
            out.append("select-as-if")
        if self.style.invert != d.style.invert:
            out.append("arms-exchanged")
        out += ["mirror:" + ("all" if k < 0 else str(k)) for k in self.style.mirror]
        if self.read_again:
            out.append("read-again")
        if self.unrotate != d.unrotate:
            out.append("guarded-do-while")
        if self.undo != d.undo:
            out.append("no-arithmetic-undo")
        out += [f"sign:{k}" for k in self.flips]
        return tuple(out)


@dataclass(frozen=True)
class Candidate:
    choice: Choice
    unit: Unit
    body: A.Body
    digest: str
    verdict: ev.Verdict
    signature: Signature
    assumptions: tuple[str, ...]                 # the source's own
    function_assumptions: tuple[str, ...]        # those its normal form rests on
    history: tuple[str, ...]                     # the rules that led from the code to the source-level form
    #: the types the tree was made with (classes by number), for another form of the same tree
    types: ty.Types | None = field(default=None, compare=False, repr=False)


@dataclass
class Report:
    """What was tried: counts and codes only."""

    candidates: list[Candidate] = field(default_factory=list)
    tried: int = 0
    equal_trees: int = 0
    refused: dict[str, int] = field(default_factory=dict)
    disagreed: dict[str, int] = field(default_factory=dict)
    evidence: tuple[tuple[str, str], ...] = ()
    #: the budget that ran out before every choice was tried, or ""
    exhausted: str = ""
    #: trees execution rejected, kept only when asked (to measure the filter, never to compile in a search)
    rejected: list[Candidate] = field(default_factory=list)


def size_of(types: ty.Types) -> Callable[[ty.CType], int]:
    def size(t: ty.CType) -> int:
        if not isinstance(t, ty.Named):
            return t.width // 8
        lay = types.layout(t.number)
        if lay.size is not None:
            return lay.size
        end = max(m.offset + m.type.width // 8 for m in lay.members)
        align = max(m.type.width // 8 for m in lay.members)
        return -(-end // align) * align
    return size


class Generator:
    """Candidates of one function."""

    def __init__(self, program: Program, at: int) -> None:
        self.p = program
        self.at = at
        self.fn = program.normal(at)
        self.results = sg.results(self.fn, program.conv, program.callee)
        self._undone: Fn | None = None
        self._lowered: dict[tuple, tuple[Fn, Signature, dict[int, Signature]]] = {}
        self.open = 0                            # open signs of the canonical form
        self.compared = 0                        # its comparisons of order

    def undone(self) -> Fn:
        """The normal form with the proved arithmetic readings the canonical form takes."""
        if self._undone is None:
            fn = self.fn
            for _ in range(MAX_UNDO):
                h = next((h for h in idioms.hypotheses(fn) if h.kind in UNDO and h.expr is not None), None)
                if h is None:
                    break
                fn = idioms.accept(fn, h)
            self._undone = fn
        return self._undone

    def lowered(self, c: Choice) -> tuple[Fn, Signature, dict[int, Signature]]:
        key = (c.result, c.unrotate, c.undo)
        if key not in self._lowered:
            result, why = self.results[c.result]
            # a function that calls itself is called as it is written here
            own = Const(self.at, 8 * self.p.abi.word)

            def callee(a: Arg) -> Signature | None:
                if a == own:
                    s = self.p.signature(self.at)
                    return None if s is None else replace(s, result=result)
                return self.p.callee(a)
            f, slots = lw.lower(self.undone() if c.undo else self.fn, self.p.conv, self.p.abi, callee, result)
            if c.unrotate:
                f = unrotate(f)
            callees: dict[int, Signature] = {}
            for _b, o in f.ops():
                if o.kind == "call":
                    s = callee(o.args[0])
                    assert s is not None and isinstance(o.args[0], Const)
                    callees[o.args[0].value] = s
            self._lowered[key] = (f, Signature(slots, result, (("result", why.value),)), callees)
        return self._lowered[key]

    def make(self, c: Choice, seen: set[str]) -> Candidate | None:
        """The candidate, or None when its tree is one already made."""
        f, sig, callees = self.lowered(c)
        t = ty.Types(f, sig, callees, own=self.at)
        signs = t.open_signs()
        if c == Choice():
            self.open = len(signs)
        if c.flips:
            t = ty.Types(f, sig, callees, frozenset(signs[k] for k in c.flips if k < len(signs)), self.at)
        body = structure(Builder(f, t, self.p.constant, c.read_again).flow(), c.style)
        if c == Choice():
            self.compared = comparisons(body)
        if body.digest() in seen:
            return None
        seen.add(body.digest())
        rva = self.at - self.p.base
        unit = Emitter(t, self.p.base, rva, names=self.p.name).unit(body, rva)
        verdict = ev.compare(body, self.fn, self.p.conv, sig, self._called(callees), size_of(t), self.p.image)
        return Candidate(c, unit, body, body.digest(), verdict, sig, body.assumptions, self.fn.assumptions, f.history, t)

    def _called(self, callees: dict[int, Signature]) -> dict[int, Signature]:
        """Signatures for every call of the normal form, which may have calls the source-level form dropped."""
        out = dict(callees)
        for b in self.fn.blocks:
            for o in (*b.ops, b.term):
                if o.kind in ("call", "tail") and isinstance(o.args[0], Const) and o.args[0].value not in out:
                    s = self.p.callee(o.args[0])
                    if s is not None:
                        out[o.args[0].value] = s
        return out

    def choices(self) -> Iterator[Choice | None]:
        """The canonical form, then by number of changes, in a fixed order. None ends the first stage."""
        base = Choice()
        yield base
        single: list[Choice] = [
            replace(base, style=Style(split_returns=False)),
            replace(base, style=Style(select="if")),
            replace(base, unrotate=False),
            replace(base, style=Style(invert=True)),
            replace(base, read_again=True),
            *([replace(base, style=Style(mirror=(-1,)))] if self.compared else []),
            *(replace(base, style=Style(mirror=(k,))) for k in range(min(self.compared, MAX_FLIPS) if self.compared > 1 else 0)),
            *(replace(base, flips=(k,)) for k in range(min(self.open, MAX_FLIPS))),
            *([replace(base, flips=tuple(range(self.open)))] if self.open > 1 else []),
            replace(base, undo=False),
            *(replace(base, result=k) for k in range(1, len(self.results))),
        ]
        yield from single
        yield None
        styles = [x for x in single if x.style != Style() or not x.unrotate or x.read_again]
        for n in range(2, len(styles) + 1):
            for some in combinations(styles, n):
                mirrors = [x.style.mirror for x in some if x.style.mirror]
                if len(mirrors) > 1 and (-1,) in mirrors:
                    continue
                yield Choice(0, Style(all(x.style.split_returns for x in some), "if" if any(x.style.select == "if" for x in some) else "expr",
                                      any(x.style.invert for x in some), tuple(sorted(k for m in mirrors for k in m))),
                             all(x.unrotate for x in some), True, any(x.read_again for x in some))
        for a in styles:
            if self.open:
                yield replace(a, flips=tuple(range(self.open)))

    def stages(self, keep_rejected: bool = False) -> Iterator[Report]:
        """What has been found after the first stage, and again after the second.

        Each choice tried spends one `expansions`, each candidate kept one `candidates`, of the active budget (outside a
        search, of a budget with the defaults). When one runs out, or another runs out inside a choice, the report says
        which in `exhausted` and is the last. `keep_rejected`: keep the trees execution rejected, to measure the filter."""
        b = budget.current() or budget.Budget.of(None)
        r = Report(evidence=tuple((f"result:{k}", e.value) for k, (_s, e) in enumerate(self.results)))
        seen: set[str] = set()
        for c in self.choices():
            if c is None:
                yield r
                continue
            try:
                if not b.left("candidates"):
                    raise budget.BudgetExhausted("candidates")
                b.spend("expansions")
                r.tried += 1
                x = self.make(c, seen)
            except budget.BudgetExhausted as e:
                r.exhausted = e.kind
                break
            except NotReconstructed as e:
                r.refused[e.code] = r.refused.get(e.code, 0) + 1
                continue
            if x is None:
                r.equal_trees += 1
                continue
            if not x.verdict.agree:
                r.disagreed[x.verdict.why] = r.disagreed.get(x.verdict.why, 0) + 1
                if keep_rejected:
                    r.rejected.append(x)
                continue
            b.spend("candidates")
            r.candidates.append(x)
        yield r


__all__ = ["Candidate", "Choice", "Evidence", "Generator", "Program", "Report", "Slot", "UNDO", "ir_nodes", "size_of"]
