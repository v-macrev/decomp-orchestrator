# SPDX-License-Identifier: AGPL-3.0-or-later
"""From a function's normal form to candidates: the canonical one first, then the few alternatives that forms of C++ leave open.

A candidate is a choice for each open point. The canonical one takes the best-supported reading everywhere; an alternative
changes one point, or two. Each is checked by execution against the normal form, and only those that do the same are
candidates at all; equal trees are one candidate. No choice looks at the target's bytes.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from itertools import combinations
from typing import Callable, Iterable, Iterator

from recon.core import budget
from recon.core.analysis.dataflow import Abi
from recon.core.emitter.cpp import Emitter, Unit
from recon.core.inference import lower as lw
from recon.core.inference import signature as sg
from recon.core.inference import types as ty
from recon.core.inference.signature import INT, Convention, Evidence, NotReconstructed, Signature, Slot
from recon.core.ir import idioms
from recon.core.ir.model import Arg, Const, Fn, Op
from recon.core.knowledge import MISSING, wait_for
from recon.core.structuring import ast as A
from recon.core.structuring import evaluate as ev
from recon.core.structuring.build import Builder
from recon.core.structuring.regions import Style, comparisons, structure
from recon.core.structuring.rotate import unrotate

#: compiler undo that the canonical form takes: the value has one natural reading
UNDO = frozenset({"unsigned-division", "signed-division", "unsigned-remainder", "signed-remainder", "multiplication"})
MAX_UNDO = 64
MAX_FLIPS = 4


def ir_nodes(fn: Fn) -> int:
    """What a function costs the `irNodes` budget: its operations and terminators."""
    return sum(len(b.ops) + 1 for b in fn.blocks)


def direct_callees(fn: Fn) -> tuple[int, ...]:
    """The addresses a normal form calls or jumps to as a call, in order of first appearance."""
    out: dict[int, None] = {}
    for b in fn.blocks:
        for o in (*b.ops, b.term):
            if o.kind in ("call", "tail") and o.args and isinstance(o.args[0], Const):
                out.setdefault(o.args[0].value, None)
    return tuple(out)


def computed_width(fn: Fn, d: dict, v: Arg) -> int:
    """The width a value was computed in (a 32-bit write zero-extends to the whole register)."""
    o = d.get(v) if isinstance(v, int) else None
    if isinstance(o, Op) and o.kind == "zext":
        return computed_width(fn, d, o.args[0])
    return v.width if isinstance(v, Const) else fn.width(v)


def call_sites(fn: Fn, conv: Convention) -> dict[str, list[dict]]:
    """What a caller's normal form shows of each call it makes (tails are left out: what they pass is the caller's own).

    Per call: `set`, the argument locations the caller puts a value of its own in, with the value's width; `reads`, the
    result locations whose value it uses after the call, with the width. A location it merely passes on from its own entry is
    not set: it may be an argument of the caller that the callee ignores."""
    params = {v for _n, v in fn.params}
    d = {v: o for v, (_b, o) in fn.defining().items()}
    uses: dict[int, int] = {}          # a value that only reaches a return may merely have been left there: not a use
    for b in fn.blocks:
        for a in [a for o in b.ops for a in o.args] + [a for p in b.phis for _k, a in p.args] + (list(b.term.args) if b.term.kind != "return" else []):
            if isinstance(a, int):
                uses[a] = uses.get(a, 0) + 1
    out: dict[str, list[dict]] = {}
    for b in fn.blocks:
        for o in b.ops:
            if o.kind != "call" or not o.args or not isinstance(o.args[0], Const):
                continue
            put = []
            for n, v in zip(o.attr("args") or (), o.args[1:]):  # type: ignore[call-overload]
                if isinstance(v, Const):
                    put.append([n, 64])
                elif isinstance(v, int) and v not in params and not (isinstance(d.get(v), Op) and d[v].kind == "undef"):  # type: ignore[union-attr]
                    put.append([n, computed_width(fn, d, v)])
            reads = [[n, fn.width(v)] for n, v in zip(o.attr("defs") or (), o.defs)  # type: ignore[call-overload]
                     if n in (conv.result_int, conv.result_float) and uses.get(v, 0)]
            out.setdefault(str(o.args[0].value), []).append({"set": sorted(put), "reads": sorted(reads)})
    return out


def _int_slot(w: int) -> Slot:
    return Slot(INT, next(x for x in (64, 32, 16, 8) if w >= x) if w >= 8 else 64)


def _float_slot(w: int) -> Slot:
    return Slot(sg.FLOAT, 32 if w == 32 else 64)


def indirect_signatures(fn: Fn, conv: Convention) -> dict[int, Signature]:
    """For each value a call jumps through (a virtual call, a function pointer), what the call site shows of its signature:
    arguments up to the last location the caller sets with a value of its own (one it merely passes on below that counts
    too), and a result where the caller reads one. For the signature of the function that makes the call; the call itself
    is still written only when its target is known."""
    params = {v for _n, v in fn.params}
    d = {v: o for v, (_b, o) in fn.defining().items()}
    uses: dict[int, int] = {}          # a value that only reaches a return may merely have been left there: not a use
    for b in fn.blocks:
        for a in [a for o in b.ops for a in o.args] + [a for p in b.phis for _k, a in p.args] + (list(b.term.args) if b.term.kind != "return" else []):
            if isinstance(a, int):
                uses[a] = uses.get(a, 0) + 1

    def own(v: Arg) -> bool:
        return isinstance(v, Const) or (isinstance(v, int) and v not in params and not (isinstance(d.get(v), Op) and d[v].kind == "undef"))  # type: ignore[union-attr]

    def width(v: Arg) -> int:
        return computed_width(fn, d, v)

    out: dict[int, Signature] = {}
    for b in fn.blocks:
        for o in (*b.ops, b.term):
            if o.kind not in ("call", "tail") or not o.args or not isinstance(o.args[0], int) or o.args[0] in out:
                continue
            have = dict(zip(o.attr("args") or (), o.args[1:]))  # type: ignore[call-overload]
            last = max((k for k, (i_loc, f_loc) in enumerate(conv.slots) if (i_loc in have and own(have[i_loc])) or (f_loc in have and own(have[f_loc]))), default=-1)
            slots = []
            for i_loc, f_loc in conv.slots[: last + 1]:
                if i_loc in have and own(have[i_loc]):
                    slots.append(_int_slot(width(have[i_loc])))
                elif f_loc in have and own(have[f_loc]):
                    slots.append(_float_slot(width(have[f_loc])))
                else:
                    slots.append(Slot(INT, 64))      # passed on from the caller's own entry
            result = None
            if o.kind == "call":
                back = dict(zip(o.attr("defs") or (), o.defs))  # type: ignore[call-overload]
                if conv.result_float in back and uses.get(back[conv.result_float], 0):
                    result = _float_slot(fn.width(back[conv.result_float]))
                elif conv.result_int in back and uses.get(back[conv.result_int], 0):
                    result = _int_slot(fn.width(back[conv.result_int]))
            out[o.args[0]] = Signature(tuple(slots), result, (("indirect", "SITE"),))
    return out


def _digest(*parts: object) -> str:
    return hashlib.sha256(repr(parts).encode()).hexdigest()


def _shape(s: Signature | None) -> tuple:
    return () if s is None else (s.params, s.result)


#: normal forms a program keeps in memory when a store holds them all (an evicted one is read back, never analysed again)
FN_CACHE = 4096
#: what a program counts: *computed* is work done, *loaded* is work reused, `redundant` is work another worker had done first
STATS = ("normal_computed", "normal_loaded", "normal_refused", "normal_evicted", "edges_loaded", "signature_computed",
         "signature_loaded", "signature_none", "scc_solved", "scc_cyclic", "scc_largest", "fixpoint_rounds", "fixpoint_resumed",
         "declared", "nested_solve", "alternatives_computed", "alternatives_loaded", "callers_unindexed", "lease_waits", "redundant", "ir_nodes_analysed")


class Program:
    """The functions of an image, by absolute address, as far as they have been needed.

    Signatures are found bottom-up over the call graph's strongly connected components: callees first, the members of a
    cycle together, from one assumption until what is assumed of every member is what comes out (a cycle that does not
    settle tells nothing). The graph is walked with an explicit stack, so a chain of callees is as long as the program makes
    it. What is found is kept: in memory for this program, and in `store` (`recon.core.knowledge`) for every later one, under
    keys that digest everything a fact depends on. A budget that runs out suspends the walk; every component already solved
    stays solved, and a cycle keeps its last finished round, so a larger budget continues where this one stopped.

    Callers' evidence runs the other way (`alternatives`): what callers set before a call and read after it gives readings
    of a callee's signature its own code leaves open. They are kept as alternatives for the search to try, never chosen in
    place of what the callee's own code says, so the bottom-up analysis stays a function of the callees alone."""

    def __init__(self, normal: Callable[[int], Fn], conv: Convention, abi: Abi, base: int, image: Callable[[int, int], "bytes | None"],
                 constant: Callable[[int, int], "int | None"], declared: Callable[[int], "tuple[str, Signature] | None"] = lambda at: None,
                 store=None, key: Callable[[int], "str | None"] = lambda at: None, universe: Callable[[], Iterable[int]] | None = None) -> None:
        """`normal(address)`: the admitted normal form, or NotReconstructed. `constant`: the bits of read-only memory, or None.
        `declared(address)`: the name and signature a declaration gives the function there (the highest-ranked evidence), or None.
        `key(address)`: a digest of everything the normal form there depends on, or None when it is not to be kept.
        `universe()`: every function of the program, for the index of callers."""
        self._normal = normal
        self._declared = declared
        self._store, self._key, self._universe = store, key, universe
        self.conv, self.abi, self.base, self.image, self.constant = conv, abi, base, image, constant
        self._fns: OrderedDict[int, Fn | NotReconstructed] = OrderedDict()
        self._edges: dict[int, tuple[int, ...]] = {}
        self._sites: dict[int, dict[str, list[dict]]] = {}
        self._sigs: dict[int, Signature | None] = {}
        self._sigkey: dict[int, str] = {}
        self._alts: dict[int, tuple[Signature, ...]] = {}
        self._callers: dict[int, tuple[int, ...]] | None = None
        self._assumed: dict[int, Signature | None] = {}     # members of the cycle being solved
        self._inferring = 0
        self._start = Signature((), Slot(INT, 64))
        self.stats: dict[str, int] = dict.fromkeys(STATS, 0)

    # -- the store ---------------------------------------------------------------------------------
    def _get(self, kind: str, key: str | None):
        if self._store is None or key is None:
            return MISSING
        return self._store.get(kind, key)

    def _put(self, kind: str, key: str | None, value) -> None:
        if self._store is not None and key is not None and self._store.put(kind, key, value) is False:
            self.stats["redundant"] += 1

    @contextmanager
    def _unit(self, kind: str, key: str | None) -> Iterator[object]:
        """One unit of work on `key`: yields the fact when another process computed it meanwhile, else MISSING, and the
        unit is then this process's until it ends. What the unit writes is written in one transaction."""
        if self._store is None or key is None:
            yield MISSING
            return
        got = self._store.get(kind, key)
        if got is MISSING:
            if self._store.lease(kind, key):
                got = self._store.get(kind, key)     # another may have finished it between the look and the lease
            else:
                self.stats["lease_waits"] += 1
                got = wait_for(self._store, kind, key)
        try:
            yield got
        finally:
            self._store.release(kind, key)

    def _keep(self, at: int, f: Fn | NotReconstructed) -> None:
        self._fns[at] = f
        self._fns.move_to_end(at)
        if self._store is not None and len(self._fns) > FN_CACHE:
            self._fns.popitem(last=False)
            self.stats["normal_evicted"] += 1

    # -- normal forms -----------------------------------------------------------------------------
    def normal(self, at: int) -> Fn:
        if at in self._fns:
            self._fns.move_to_end(at)
        else:
            k = self._key(at)
            with self._unit("normal", k) as got:
                if got is not MISSING:
                    self.stats["normal_loaded"] += 1
                    self._keep(at, NotReconstructed(got) if isinstance(got, str) else got)
                else:
                    self._analyse(at, k)
        f = self._fns[at]
        if isinstance(f, NotReconstructed):
            raise f
        return f

    def _analyse(self, at: int, k: str | None) -> None:
        """The normal form and what is read off it, kept together."""
        try:
            f = self._normal(at)
        except NotReconstructed as e:
            self.stats["normal_refused"] += 1
            self._keep(at, e)
            self._edges[at], self._sites[at] = (), {}
            if self._store is not None and k is not None:
                with self._store.transaction():
                    self._put("normal", k, e.code)
                    self._put("callees", k, [])
                    self._put("sites", k, {})
            return
        budget.spend("irNodes", ir_nodes(f))     # before it is kept: a larger budget analyses it again
        self.stats["normal_computed"] += 1
        self.stats["ir_nodes_analysed"] += ir_nodes(f)
        self._keep(at, f)
        sites = call_sites(f, self.conv)
        self._edges[at] = direct_callees(f)
        if self._store is not None and k is not None:
            with self._store.transaction():
                self._put("normal", k, f)
                self._put("callees", k, list(self._edges[at]))
                self._put("sites", k, sites)
        else:
            self._sites[at] = sites     # with a store, sites are read from it when a callee's alternatives ask

    def edges(self, at: int) -> tuple[int, ...]:
        """The functions `at` calls directly, none when it has no normal form."""
        if at not in self._edges:
            got = self._get("callees", self._key(at))
            if got is not MISSING:
                self.stats["edges_loaded"] += 1
                self._edges[at] = tuple(got)
            else:
                try:
                    self.normal(at)
                except NotReconstructed:
                    pass
                if at not in self._edges:   # read back from the store (another process analysed it): read them off the form
                    f = self._fns.get(at)
                    self._edges[at] = direct_callees(f) if isinstance(f, Fn) else ()
        return self._edges[at]

    def sites(self, at: int) -> dict[str, list[dict]]:
        """What `at` shows of the calls it makes (see `call_sites`). Not kept in memory when a store holds them."""
        if at not in self._sites:
            got = self._get("sites", self._key(at))
            if got is not MISSING:
                return got
            else:
                try:
                    self.normal(at)
                except NotReconstructed:
                    pass
                if at not in self._sites:   # read back from the store without its sites: read them off the form
                    f = self._fns.get(at)
                    self._sites[at] = call_sites(f, self.conv) if isinstance(f, Fn) else {}
        return self._sites[at]

    def callee(self, target: Arg) -> Signature | None:
        return self.signature(target.value) if isinstance(target, Const) else None

    def name(self, at: int) -> str | None:
        """The name a declaration gives the function at `at`, when it is a plain identifier the source can call."""
        d = self._declared(at)
        return d[0] if d is not None and d[0].isidentifier() else None

    # -- callers ------------------------------------------------------------------------------------
    def _universe_key(self) -> str | None:
        if self._universe is None:
            return None
        keys = [(a, self._key(a)) for a in sorted(self._universe())]
        return None if any(k is None for _a, k in keys) else _digest("callers", tuple(keys))

    def index_callers(self) -> int:
        """The callers of every function of the universe: every function's normal form is read (or analysed) once. Kept,
        so that it is done once for the program. Returns how many functions were read."""
        if self._universe is None:
            raise ValueError("a program without a universe has no index of callers")
        rev: dict[int, list[int]] = {}
        everything = sorted(self._universe())
        for a in everything:
            for c in self.edges(a):
                rev.setdefault(c, []).append(a)
        self._callers = {c: tuple(v) for c, v in rev.items()}
        self._put("callers", self._universe_key(), {str(c): list(v) for c, v in self._callers.items()})
        return len(everything)

    def callers(self, at: int) -> tuple[int, ...] | None:
        """The functions that call `at` directly, or None when the program's callers have not been indexed."""
        if self._callers is None:
            got = self._get("callers", self._universe_key())
            if got is MISSING:
                return None
            self._callers = {int(c): tuple(v) for c, v in got.items()}
        return self._callers.get(at, ())

    # -- signatures ---------------------------------------------------------------------------------
    def signature(self, at: int) -> Signature | None:
        """What a function takes and returns: from its declaration, else from its own code; None when that cannot be told."""
        if at in self._assumed:
            return self._assumed[at]
        if at not in self._sigs:
            d = self._declared(at)
            if d is not None:
                self.stats["declared"] += 1
                self._sigs[at] = d[1]
            else:
                # inside an inference every callee is solved already; one that is not is a callee the walk did not see
                self.stats["nested_solve"] += self._inferring > 0
                self._solve(at)
        return self._sigs[at]

    def _settled(self, at: int) -> bool:
        return at in self._sigs or at in self._assumed or self._declared(at) is not None

    def _solve(self, root: int) -> None:
        """Tarjan's components from `root` over the functions whose signatures are not known yet, each solved as it closes."""
        index: dict[int, int] = {}
        low: dict[int, int] = {}
        stack: list[int] = []
        on: set[int] = set()
        work: list[tuple[int, list[int]]] = []

        def enter(v: int) -> None:
            index[v] = low[v] = len(index)
            stack.append(v)
            on.add(v)
            work.append((v, [c for c in reversed(self.edges(v)) if not self._settled(c)]))

        enter(root)
        while work:
            v, todo = work[-1]
            if todo:
                c = todo.pop()
                if c not in index:
                    if not self._settled(c):
                        enter(c)
                elif c in on:
                    low[v] = min(low[v], index[c])
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                members = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    members.append(w)
                    if w == v:
                        break
                self._component(sorted(members))

    def _dependency(self, c: int) -> object:
        """What a caller's signature takes from callee `c`."""
        d = self._declared(c)
        if d is not None:
            return ("declared", d[1])
        return ("analysed", self._sigkey.get(c))

    def _component(self, members: list[int]) -> None:
        inside = set(members)
        cyclic = len(members) > 1 or members[0] in self.edges(members[0])
        keys = [self._key(m) for m in members]
        whole: str | None = None
        if None not in keys and self._store is not None:
            outside = sorted({(c, repr(self._dependency(c))) for m in members for c in self.edges(m) if c not in inside})
            whole = _digest("scc", tuple(zip(members, keys)), tuple(outside), tuple((m, self.edges(m)) for m in members))
            for m in members:
                self._sigkey[m] = _digest(whole, m)
        with self._unit("scc", whole):
            got = [self._get("signature", self._sigkey[m]) for m in members] if whole else [MISSING]
            if MISSING not in got:
                self.stats["signature_loaded"] += len(members)
                self._sigs.update(zip(members, got))
                return
            out = self._fixpoint(members, whole) if cyclic else {members[0]: self._infer_or_none(members[0])}
            self.stats["scc_solved"] += 1
            self.stats["scc_cyclic"] += cyclic
            self.stats["scc_largest"] = max(self.stats["scc_largest"], len(members))
            for m in members:
                self.stats["signature_computed"] += 1
                self.stats["signature_none"] += out[m] is None
                self._sigs[m] = out[m]
            if whole is not None:
                with self._store.transaction():   # type: ignore[union-attr]
                    for m in members:
                        self._put("signature", self._sigkey[m], out[m])
                    if cyclic:
                        self._store.drop("fixpoint", whole)   # type: ignore[union-attr]

    def _fixpoint(self, members: list[int], whole: str | None) -> dict[int, Signature | None]:
        """The members of a cycle, each inferred from what is assumed of all of them, until nothing changes. Every finished
        round is kept, so an interrupted cycle resumes from its last round and ends where an uninterrupted one would."""
        state: dict[int, Signature | None] = dict.fromkeys(members, self._start)
        seen: set[tuple] = set()
        saved = self._get("fixpoint", whole)
        if saved is not MISSING:
            state, history = saved
            seen = set(history)
            self.stats["fixpoint_resumed"] += 1
        try:
            while True:
                self._assumed.update(state)
                new = {m: self._infer_or_none(m) for m in members}
                self.stats["fixpoint_rounds"] += 1
                if new == state:
                    return new
                frozen = tuple(new[m] for m in members)
                if frozen in seen:   # it goes round without settling: nothing can be told
                    return dict.fromkeys(members)
                seen.add(frozen)
                if whole is not None:
                    self._put("fixpoint", whole, (new, sorted(seen, key=repr)))
                for m in members:    # each further round analyses them again
                    try:
                        budget.spend("irNodes", ir_nodes(self.normal(m)))
                    except NotReconstructed:
                        pass
                state = new
        finally:
            for m in members:
                self._assumed.pop(m, None)

    def _infer_or_none(self, at: int) -> Signature | None:
        try:
            return self._infer(at)
        except NotReconstructed:
            return None

    def _resolver(self, fn: Fn) -> tuple[Callable[[Arg], Signature | None], dict]:
        """How `fn`'s calls are read: a direct callee by its signature, a call through a value by what the site shows.
        Every reading of `fn`'s own code goes through this one resolver, so they agree on what its results are."""
        through = indirect_signatures(fn, self.conv)

        def resolve(t: Arg) -> Signature | None:
            return self.callee(t) if isinstance(t, Const) else through.get(t)  # type: ignore[arg-type]
        return resolve, through

    def _results(self, at: int) -> list:
        fn = self.normal(at)
        resolve, _through = self._resolver(fn)
        self._inferring += 1
        try:
            return sg.results(fn, self.conv, resolve)
        finally:
            self._inferring -= 1

    def _infer(self, at: int, k: int = 0) -> Signature:
        """From the function's own code: callees by their signatures, calls through a value by what the site shows."""
        fn = self.normal(at)
        resolve, through = self._resolver(fn)
        self._inferring += 1
        try:
            results = sg.results(fn, self.conv, resolve)
            if k >= len(results):
                raise NotReconstructed("RESULT_READING_ABSENT")
            result, why = results[k]
            _low, slots = lw.lower(fn, self.conv, self.abi, resolve, result)
        finally:
            self._inferring -= 1
        return Signature(slots, result, (("result", why.value),) + ((("indirect-calls", "SITE"),) if through else ()))

    # -- what is left open --------------------------------------------------------------------------
    def alternatives(self, at: int) -> tuple[Signature, ...]:
        """Every reading of `at`'s signature that its own code or its callers leave open, other than `signature(at)`;
        those its callers' evidence supports first. A declared function has none."""
        if at in self._alts:
            return self._alts[at]
        if self._declared(at) is not None:
            return ()
        best = self.signature(at)
        callers = self.callers(at)
        if callers is None:
            self.stats["callers_unindexed"] += 1
        key = None
        if at in self._sigkey and callers is not None and all(self._key(c) is not None for c in callers):
            key = _digest("alternatives", self._sigkey[at], tuple((c, self._key(c)) for c in callers))
            got = self._get("alternatives", key)
            if got is not MISSING:
                self.stats["alternatives_loaded"] += 1
                self._alts[at] = got
                return got
        out = self._open_readings(at, best, [s for c in (callers or ()) for s in self.sites(c).get(str(at), [])])
        self.stats["alternatives_computed"] += 1
        self._alts[at] = out
        self._put("alternatives", key, out)
        return out

    def _open_readings(self, at: int, best: Signature | None, sites: list[dict]) -> tuple[Signature, ...]:
        found: list[Signature] = []
        try:   # what its own code leaves open: the other results it may have
            n = len(self._results(at))
            for k in range(1, n):
                try:
                    found.append(self._infer(at, k))
                except NotReconstructed:
                    pass
        except NotReconstructed:
            pass
        if sites:   # what its callers say: how many arguments every one of them sets, and whether any reads a result
            conv = self.conv
            ints, floats = {conv.result_int}, {conv.result_float}

            def prefix(s: dict) -> list[Slot]:
                put = {n: w for n, w in s["set"]}
                out = []
                for i_loc, f_loc in conv.slots:
                    if i_loc in put:
                        out.append(Slot(INT, next(x for x in (64, 32, 16, 8) if put[i_loc] >= x) if put[i_loc] >= 8 else 64))
                    elif f_loc in put:
                        out.append(Slot(sg.FLOAT, 32 if put[f_loc] == 32 else 64))
                    else:
                        break
                return out

            given = [prefix(s) for s in sites]
            shortest = min(given, key=len)
            reads = [r for s in sites for r in s["reads"]]
            base = [best] if best is not None else []
            for b in base or [Signature((), None)]:
                params = b.params
                if len(shortest) > len(params):
                    params = params + tuple(shortest[len(params):])
                result = b.result
                if result is None and reads:
                    kind = INT if any(n in ints for n, _w in reads) else sg.FLOAT
                    w = max(w for n, w in reads if (n in ints) == (kind == INT))
                    result = Slot(kind, next(x for x in (64, 32, 16, 8) if w >= x) if w >= 8 else 64) if kind == INT else Slot(kind, 32 if w == 32 else 64)
                elif result is not None and not reads:
                    found.append(Signature(params, None, (("result", "CALLERS"),)))
                found.append(Signature(params, result, (("params", "CALLERS"), ("result", "CALLERS"))))
        out: list[Signature] = []
        shapes = {_shape(best)}
        for s in found:
            if _shape(s) not in shapes:
                shapes.add(_shape(s))
                out.append(s)
        if sites:   # those the callers agree with first
            reads = any(s["reads"] for s in sites)
            out.sort(key=lambda s: 0 if (s.result is not None) == reads else 1)
        return tuple(out)


@dataclass(frozen=True)
class Choice:
    """What a candidate decides. The default is the canonical form."""

    result: int = 0                              # which of the possible results
    style: Style = Style()
    unrotate: bool = True
    undo: bool = True
    read_again: bool = False
    flips: tuple[int, ...] = ()                  # open signs taken the other way, by position
    #: callees read another way: (the callee's place in the order of first call, which of its alternatives)
    callees: tuple[tuple[int, int], ...] = ()

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
        out += [f"callee:{i}:{j}" for i, j in self.callees]
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
        #: the functions it calls, in order of first call, itself left out
        self.targets = tuple(a for a in direct_callees(self.fn) if a != at)
        self._alternatives: list[tuple[Signature, ...]] | None = None
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

    def alternatives(self) -> list[tuple[Signature, ...]]:
        """For each callee, by place, the other readings of its signature (`Program.alternatives`)."""
        if self._alternatives is None:
            self._alternatives = [self.p.alternatives(a) for a in self.targets]
        return self._alternatives

    def read_as(self, c: Choice) -> dict[int, Signature]:
        """The callees the choice reads another way, by address."""
        alts = self.alternatives() if c.callees else []
        return {self.targets[i]: alts[i][j] for i, j in c.callees}

    def lowered(self, c: Choice) -> tuple[Fn, Signature, dict[int, Signature]]:
        key = (c.result, c.unrotate, c.undo, c.callees)
        if key not in self._lowered:
            other = self.read_as(c)
            result, why = self.results[c.result]
            # a function that calls itself is called as it is written here
            own = Const(self.at, 8 * self.p.abi.word)

            def callee(a: Arg) -> Signature | None:
                if a == own:
                    s = self.p.signature(self.at)
                    return None if s is None else replace(s, result=result)
                if isinstance(a, Const) and a.value in other:
                    return other[a.value]
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
        verdict = ev.compare(body, self.fn, self.p.conv, sig, self._called(callees, self.read_as(c)), size_of(t), self.p.image)
        return Candidate(c, unit, body, body.digest(), verdict, sig, body.assumptions, self.fn.assumptions, f.history, t)

    def _called(self, callees: dict[int, Signature], other: dict[int, Signature] | None = None) -> dict[int, Signature]:
        """Signatures for every call of the normal form, which may have calls the source-level form dropped."""
        out = dict(callees)
        for b in self.fn.blocks:
            for o in (*b.ops, b.term):
                if o.kind in ("call", "tail") and isinstance(o.args[0], Const) and o.args[0].value not in out:
                    s = (other or {}).get(o.args[0].value) or self.p.callee(o.args[0])
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
        # callees read as their callers or their own code leave open (asked for only now: it may read the callers)
        read = [replace(base, callees=((i, j),)) for i, alts in enumerate(self.alternatives()) for j in range(len(alts))]
        yield from read
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
        for n in range(2, len({x.callees[0][0] for x in read}) + 1):   # several callees read another way at once
            for some in combinations(read, n):
                if len({x.callees[0][0] for x in some}) == n:
                    yield replace(base, callees=tuple(x.callees[0] for x in some))
        for x in read:                                                  # and with the forms of the first stage
            for a in single:
                yield replace(a, callees=x.callees)

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
