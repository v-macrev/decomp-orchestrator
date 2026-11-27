# SPDX-License-Identifier: AGPL-3.0-or-later
"""The whole-program analysis: every function's normal form, call graph, signature and the readings it leaves open, solved
over strongly connected components of the call graph and kept in a store (D-045 to D-047).

What it learns is filed under this module's code and what it imports (`recon.core.knowledge.ANALYSIS_ROOTS`): it imports no
structuring, emitting or search, so that a change to those writes different source without analysing anything again.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from contextlib import contextmanager
from typing import Callable, Iterable, Iterator

from recon.core import budget
from recon.core.analysis.dataflow import Abi
from recon.core.inference import lower as lw
from recon.core.inference import signature as sg
from recon.core.inference.signature import INT, Convention, NotReconstructed, Signature, Slot
from recon.core.inference.sites import call_sites, direct_callees, indirect_signatures
from recon.core.ir.model import Arg, Const, Fn, Op
from recon.core.knowledge import MISSING, wait_for


def ir_nodes(fn: Fn) -> int:
    """What a function costs the `irNodes` budget: its operations and terminators."""
    return sum(len(b.ops) + 1 for b in fn.blocks)


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
                 store=None, key: Callable[[int], "str | None"] = lambda at: None, universe: Callable[[], Iterable[int]] | None = None,
                 slot: Callable[[int], "Signature | None"] = lambda at: None) -> None:
        """`normal(address)`: the admitted normal form, or NotReconstructed. `constant`: the bits of read-only memory, or None.
        `declared(address)`: the name and signature a declaration gives the function there (the highest-ranked evidence), or None.
        `key(address)`: a digest of everything the normal form there depends on, or None when it is not to be kept.
        `universe()`: every function of the program, for the index of callers.
        `slot(address)`: the signature a declaration gives the function whose address the memory at `address` holds (an
        imported function, through its slot of the import address table), or None."""
        self._normal = normal
        self._slot = slot
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
        """How `fn`'s calls are read: a direct callee by its signature; a call through a value read from a slot that holds
        a declared function (an import) by that declaration; any other call through a value by what the site shows.
        Every reading of `fn`'s own code goes through this one resolver, so they agree on what its results are."""
        through = indirect_signatures(fn, self.conv)
        imported: dict[int, Signature] = {}
        for v, (_b, o) in fn.defining().items():
            if isinstance(o, Op) and o.kind == "load" and o.args and isinstance(o.args[0], Const):
                sig = self._slot(o.args[0].value)
                if sig is not None:
                    imported[v] = sig

        def resolve(t: Arg) -> Signature | None:
            if isinstance(t, Const):
                return self.callee(t)
            return imported.get(t) or through.get(t)  # type: ignore[arg-type]
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


__all__ = ["FN_CACHE", "STATS", "Program", "ir_nodes"]
