# SPDX-License-Identifier: AGPL-3.0-or-later
"""What the whole-program analysis costs (D-066): three workloads over the same deterministic sample of the pack's
functions, each in a process of its own and on a store of its own (never the knowledge store campaigns read):

- cold: an empty store; every normal form, reading, callers index and signature the sample needs is computed;
- warm: the store cold left; what is asked again is read back;
- incremental: the store cold left, with the analysis code's namespace moved, as a change of the inference code moves it:
  the normal forms and what is read off them stay, every signature is computed again.

Each is measured by wall and processor time, peak memory, the store's reads and writes by kind (count, hits, bytes,
seconds), the decoding of what is read (the normal forms are the IR), and the time spent in each part of the analysis
(normal forms, the walk over the call graph's components, signature inference, alternatives), each part's own time, not
that of the parts it calls. The numbers measure; nothing here changes what is computed, and this module is outside the
analysis code's import closure, so that measuring changes no namespace. What is printed is counts and times.
"""
from __future__ import annotations

import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

WORKLOADS = ("cold", "warm", "incremental")

#: the analysis' methods timed, by the part of the work they are
PARTS = {"normal": "normal_forms", "_read_off": "readings", "index_callers": "callers_index", "_solve": "scc_walk",
         "_component": "scc_walk", "_fixpoint": "fixpoint", "_infer": "signature_inference", "_open_readings": "alternatives",
         "alternatives": "alternatives"}


def sample(functions: list[int], n: int) -> list[int]:
    """`n` functions spread evenly over the pack's, in address order: the same sample for the same pack."""
    if n <= 0 or n >= len(functions):
        return list(functions)
    step = len(functions) / n
    return [functions[int(k * step)] for k in range(n)]


class Clock:
    """Own time per part: entering a timed method pauses the part that called it."""

    def __init__(self) -> None:
        self.own: dict[str, float] = {}
        self.calls: dict[str, int] = {}
        self._stack: list[list] = []

    def wrap(self, part: str, f):
        def timed(*a, **k):
            now = time.perf_counter()
            if self._stack:
                top = self._stack[-1]
                self.own[top[0]] = self.own.get(top[0], 0.0) + now - top[1]
            self._stack.append([part, now])
            self.calls[part] = self.calls.get(part, 0) + 1
            try:
                return f(*a, **k)
            finally:
                end = time.perf_counter()
                p, t = self._stack.pop()
                self.own[p] = self.own.get(p, 0.0) + end - t
                if self._stack:
                    self._stack[-1][1] = end
        return timed


class MeteredStore:
    """A store, counted: reads by kind (hits, misses, bytes decoded, seconds), writes by kind (new, bytes, seconds)."""

    def __init__(self, inner) -> None:
        self.inner = inner
        self.reads: dict[str, dict[str, float]] = {}
        self.writes: dict[str, dict[str, float]] = {}

    def __getattr__(self, name):
        return getattr(self.inner, name)

    @staticmethod
    def _add(table: dict, kind: str, **v) -> None:
        row = table.setdefault(kind, {})
        for k, x in v.items():
            row[k] = row.get(k, 0) + x

    def get(self, kind: str, key: str):
        from recon.core import knowledge as kn

        t = time.perf_counter()
        v = self.inner.get(kind, key)
        self._add(self.reads, kind, n=1, hits=int(v is not kn.MISSING), s=time.perf_counter() - t)
        return v

    def put(self, kind: str, key: str, value) -> bool:
        t = time.perf_counter()
        new = self.inner.put(kind, key, value)
        self._add(self.writes, kind, n=1, new=int(bool(new)), s=time.perf_counter() - t)
        return new

    def lease(self, kind: str, key: str) -> bool:
        t = time.perf_counter()
        got = self.inner.lease(kind, key)
        self._add(self.writes, f"lease:{kind}", n=1, new=int(bool(got)), s=time.perf_counter() - t)
        return got

    def release(self, kind: str, key: str) -> None:
        t = time.perf_counter()
        self.inner.release(kind, key)
        self._add(self.writes, f"release:{kind}", n=1, new=0, s=time.perf_counter() - t)

    def drop(self, kind: str, key: str) -> None:
        t = time.perf_counter()
        self.inner.drop(kind, key)
        self._add(self.writes, f"drop:{kind}", n=1, new=0, s=time.perf_counter() - t)

    def transaction(self):
        """The inner store's transaction, with the time of its outermost commit counted under "commit"."""
        from contextlib import contextmanager

        @contextmanager
        def timed():
            outer = getattr(self.inner, "_depth", 1) == 0
            t: float | None = None
            try:
                with self.inner.transaction():
                    yield
                    t = time.perf_counter()
            finally:
                if outer and t is not None:
                    self._add(self.writes, "commit", n=1, new=0, s=time.perf_counter() - t)
        return timed()


def _peak_bytes() -> int | None:
    try:
        import resource

        r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return r if sys.platform == "darwin" else r * 1024
    except ImportError:
        pass
    try:
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        c = PMC()
        c.cb = ctypes.sizeof(c)
        proc = ctypes.windll.kernel32.GetCurrentProcess()
        return c.PeakWorkingSetSize if ctypes.windll.psapi.GetProcessMemoryInfo(proc, ctypes.byref(c), c.cb) else None
    except (OSError, AttributeError):
        return None


def instrument(program_cls, clock: Clock):
    """Time the analysis' parts on the class; returns what puts them back."""
    kept = {name: program_cls.__dict__[name] for name in PARTS if name in program_cls.__dict__}
    for name, f in kept.items():
        setattr(program_cls, name, clock.wrap(PARTS[name], f))
    return lambda: [setattr(program_cls, name, f) for name, f in kept.items()]


def measure(pack, store, chunk: list[int], phases: tuple[str, ...] = ("normal", "signature"), callers: bool = True) -> dict:
    """Run the prewarm's work over `chunk` on `store` (a SqliteStore), as the prewarm runs it, measured. `callers`: index
    the callers of every function of the pack when the store has no index (it reads every normal form); without it, what
    callers leave open is computed and not filed, as for any program without the index."""
    from recon.core import knowledge as kn
    from recon.core.inference import whole

    clock = Clock()
    restore = instrument(whole.Program, clock)
    decoded: dict[str, dict[str, float]] = {}
    decode = kn.decode

    def timed_decode(kind: str, blob: bytes):
        t = time.perf_counter()
        v = decode(kind, blob)
        MeteredStore._add(decoded, kind, n=1, bytes=len(blob), s=time.perf_counter() - t)
        return v

    kn.decode = timed_decode
    metered = MeteredStore(store)
    pack.store = metered
    stats: dict[str, int] = {}
    w0, c0 = time.perf_counter(), time.process_time()
    try:
        for phase in phases:
            p = pack.program()
            if phase == "signature" and callers and p.callers(chunk[0]) is None:
                p.index_callers()
            for at in chunk:
                if phase == "normal":
                    p.edges(at)
                else:
                    p.signature(at)
                    p.alternatives(at)
            for k, v in p.stats.items():
                if v:
                    stats[k] = stats.get(k, 0) + v
    finally:
        kn.decode = decode
        restore()
        pack.store = store
    wall, cpu = time.perf_counter() - w0, time.process_time() - c0
    r3 = lambda d: {k: {f: (round(x, 3) if isinstance(x, float) else x) for f, x in row.items()} for k, row in sorted(d.items())}  # noqa: E731
    hits = {k: round(row["hits"] / row["n"], 4) for k, row in sorted(metered.reads.items()) if row["n"]}
    return {"wall_s": round(wall, 2), "cpu_s": round(cpu, 2), "peak_mib": (_peak_bytes() or 0) >> 20,
            "store_reads": r3(metered.reads), "store_writes": r3(metered.writes), "decode": r3(decoded), "hit_ratio": hits,
            "parts_own_s": {k: round(v, 2) for k, v in sorted(clock.own.items())}, "parts_calls": dict(sorted(clock.calls.items())),
            "unattributed_s": round(wall - sum(clock.own.values()), 2), "stats": dict(sorted(stats.items()))}


#: the kinds of fact compared with another store
FACTS = ("normal", "callees", "sites", "callers", "signature", "alternatives", "sigkey", "attempt")


def agreement(db: str, ns: dict[str, str], against: str) -> dict:
    """Every fact the profile's store holds, looked up in `against` (opened read-only) under the same namespace: how many
    are there and equal, there and different, or absent, by kind. Equal: the same decoded value."""
    import sqlite3

    from recon.core import knowledge as kn

    mine = sqlite3.connect(f"file:{Path(db).as_posix()}?mode=ro", uri=True)
    theirs = sqlite3.connect(f"file:{Path(against).as_posix()}?mode=ro", uri=True, timeout=600)
    out: dict[str, dict[str, int]] = {}
    try:
        for kind in FACTS:
            space = ns.get(kind, ns["*"])
            row = out.setdefault(kind, {"equal": 0, "different": 0, "absent": 0})
            for key, blob in mine.execute("SELECT key, value FROM facts WHERE ns = ? AND kind = ?", (space, kind)):
                got = theirs.execute("SELECT value FROM facts WHERE ns = ? AND kind = ? AND key = ?", (space, kind, key)).fetchone()
                if got is None:
                    row["absent"] += 1
                elif got[0] == blob or kn.decode(kind, got[0]) == kn.decode(kind, blob):
                    row["equal"] += 1
                else:
                    row["different"] += 1
    finally:
        mine.close()
        theirs.close()
    return out


def _one(worktree: str, checkout: str, db: str, workload: str, n: int, against: str | None = None, callers: bool = False) -> dict:
    from recon.adapters.skyrim import solve as S
    from recon.core import knowledge as kn

    pack, _offered = S.pack_of(Path(worktree), Path(checkout), None)
    ns = pack.namespace()
    if workload == "incremental":
        ns = {**ns, "*": ns["*"] + ":incremental"}
    chunk = sample(pack.functions(), n)
    store = kn.SqliteStore(db, ns)
    try:
        out = measure(pack, store, chunk, callers=callers)
        out["store_after"] = {k: store.count(k) for k in FACTS}
    finally:
        store.close()
    out["sample"] = len(chunk)
    if against and workload == "cold":
        out["against"] = agreement(db, ns, against)
    return out


def run(worktree: Path, checkout: Path, out: Path, n: int, workloads: tuple[str, ...] = WORKLOADS, against: Path | None = None,
        callers: bool = False) -> dict:
    """Each workload in a fresh process, in order, on `out`/profile.db (made afresh before cold). `against`: a knowledge
    store the cold workload's facts are compared with. `callers`: index every caller (always when the sample is all)."""
    out.mkdir(parents=True, exist_ok=True)
    db = out / "profile.db"
    callers = callers or n <= 0
    report: dict = {"sample": n, "cores": os.cpu_count(), "callers_indexed": callers}
    if against is not None:
        from recon.core import workload

        report["analysis_running"] = workload.holder(against.parent) is not None   # the numbers are then contended (D-065)
    if hasattr(os, "getloadavg"):
        report["load_before"] = [round(x, 2) for x in os.getloadavg()]
    for w in workloads:
        if w not in WORKLOADS:
            raise ValueError(w)
        if w == "cold":
            for f in (db, db.with_name(db.name + "-wal"), db.with_name(db.name + "-shm")):
                f.unlink(missing_ok=True)
        with ProcessPoolExecutor(max_workers=1, mp_context=get_context("spawn")) as ex:
            report[w] = ex.submit(_one, str(worktree), str(checkout), str(db), w, n, str(against) if against else None, callers).result()
    if hasattr(os, "getloadavg"):
        report["load_after"] = [round(x, 2) for x in os.getloadavg()]
    return report


__all__ = ["Clock", "FACTS", "MeteredStore", "PARTS", "WORKLOADS", "agreement", "instrument", "measure", "run", "sample"]
