# SPDX-License-Identifier: AGPL-3.0-or-later
"""Step 1 of the convergence loop: every function of a population gets a state and its blockers.

Reach first (all stages, nothing compiled): a function without a candidate is `OPEN` with the codes that refused it.
Then `solve` on the exact unit for every function with a candidate that `sr next` places in an existing unit as
`Class::Method`, and for every function of a given solve set: its outcome decides.

A campaign runs in levels (`recon.core.budget.LEVELS`): every function at level 0, then the functions whose budget ran out
at the next level, and so on. A budget that runs out suspends a function, it never decides it: what the lower level
computed is read back (normal forms and signatures from the knowledge store, compiler and comparator verdicts from the
saved frontiers), and past the last level the function stays `RESUMABLE`. Each finished function is appended to a journal
and synced before the next is counted, so a campaign that is stopped, or whose machine ends abruptly, resumes where it was:
a function is never done twice at one level. Records name functions, so they are written under the private data
directory; what is printed is counts, development and held-out apart.
"""
from __future__ import annotations

import json
import os
import time
from collections import Counter
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Callable

from recon import ENGINE_VERSION, RULE_STORE_VERSION
from recon.adapters.skyrim import reach as rc
from recon.adapters.skyrim import solve as S
from recon.adapters.skyrim.inventory import Target
from recon.adapters.skyrim.manifest import heldout
from recon.core import budget as bg
from recon.core import taxonomy as tx
from recon.core.canonical import digest
from recon.core.knowledge import code_digest
from recon.core.workers import Pool, meminfo

#: why solve did not run on a function that reach gave a candidate
NOT_RUN = frozenset({"NOT_STARTABLE", "NAME_NOT_PLAIN", "NEW_UNIT"})
#: a worker starts its program afresh after this many functions (what it learnt is in the store)
FRESH_AFTER = 200


@dataclass
class Record:
    rva: int
    size: int
    heldout: bool
    reach: str                                    # the reach row's result
    reach_codes: list[str] = field(default_factory=list)
    solve: str | None = None                      # "status reason" when solve ran
    blockers: list[str] = field(default_factory=list)
    state: str = tx.OPEN
    counters: dict[str, int] = field(default_factory=dict)
    level: int = 0
    code: str = ""                                # the engine that made it (`engine_code()`)

    @staticmethod
    def of(d: dict) -> "Record":
        names = {f.name for f in fields(Record)}
        return Record(**{k: v for k, v in d.items() if k in names})


def decide(r: Record) -> None:
    """The state and the blockers, primary first, from what reach and solve said."""
    codes: list[str] = []
    matched = False
    if r.solve is not None:
        status, _sp, reason = r.solve.partition(" ")
        matched = status == "solved"
        if not matched:
            codes.append(reason or "NO_MATCH")
    elif r.reach != "candidate":
        codes += r.reach_codes or ["NO_CANDIDATE"]
    else:
        codes.append("NOT_ATTEMPTED")
    r.blockers = [] if matched else tx.blockers(codes)
    r.state = tx.state(matched, codes)


# -- the journal ----------------------------------------------------------------------------------------

def engine_code() -> str:
    """What a campaign's results depend on of the engine: its version, its rules and all of its code but the command line."""
    return digest({"engine": ENGINE_VERSION, "rules": RULE_STORE_VERSION, "code": code_digest(("core", "adapters", "__init__.py"))})[:16]


class Journal:
    """Records appended one per line and synced: the last record of a function is its state. Each record carries the engine
    that made it, and only those of this engine count: a journal resumed after the engine changed does its functions again
    (what the older engine said stays in the file, apart, never mixed with what this one says)."""

    def __init__(self, path: Path, code: str = "") -> None:
        self.path = path
        self.code = code
        self.other = 0                           # records of another engine, read and left aside
        self._ended = False
        path.parent.mkdir(parents=True, exist_ok=True)

    def latest(self) -> dict[int, Record]:
        out: dict[int, Record] = {}
        self.other = 0
        if not self.path.is_file():
            return out
        with open(self.path, encoding="utf-8") as f:
            for line in f:
                try:
                    r = Record.of(json.loads(line))
                except (ValueError, TypeError):
                    continue                     # the line being written when the machine ended
                if r.code != self.code:
                    self.other += 1
                    continue
                out[r.rva] = r
        return out

    def append(self, r: Record) -> None:
        r.code = self.code
        if not self._ended:              # a line cut short by an abrupt end is closed, so that it stays one bad line
            if self.path.is_file() and self.path.stat().st_size:
                with open(self.path, "rb") as f:
                    f.seek(-1, os.SEEK_END)
                    if f.read(1) != b"\n":
                        with open(self.path, "ab") as g:
                            g.write(b"\n")
            self._ended = True
        with open(self.path, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(asdict(r), sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())


def wanted(r: Record | None, level: int, retried: set[int]) -> bool:
    """Whether a function is to be done at `level`: never done; suspended one level below; or an infrastructure failure at
    this level, once per run."""
    if r is None:
        return True
    if r.state == tx.RESUMABLE and r.level == level - 1:
        return True
    return r.state == tx.INFRA and r.level == level and r.rva not in retried


# -- one function, in a worker --------------------------------------------------------------------------

def _init(worktree: str, checkout: str, data: str, knowledge: str | None, startable: dict[int, dict], solve_set: frozenset[int]) -> dict:
    pack, _offered = S.pack_of(Path(worktree), Path(checkout), knowledge)
    return {"pack": pack, "program": pack.program(), "n": 0, "worktree": Path(worktree), "checkout": Path(checkout),
            "data": Path(data), "knowledge": knowledge, "startable": startable, "solve_set": solve_set}


def _work(st: dict, task: tuple[int, int, int]) -> dict:
    rva, size, level = task
    if st["n"] and st["n"] % FRESH_AFTER == 0:
        st["program"] = st["pack"].program()
    st["n"] += 1
    p = st["program"]
    before = dict(p.stats)
    t0 = time.monotonic()
    with bg.active(bg.Budget.of(bg.level(level))) as b:
        row = rc.one(st["pack"], p, Target(rva, size, "campaign", None))
    rec = Record(rva, size, heldout(rva), row.result, list(row.codes), level=level)
    rec.counters = {"reach_ms": int(1000 * (time.monotonic() - t0)), **{f"reach_{k}": v for k, v in b.used.items() if v},
                    **{k: p.stats[k] - before.get(k, 0) for k in p.stats if p.stats[k] - before.get(k, 0)}}
    _solve(st, rec)
    decide(rec)
    return asdict(rec)


def _solve(st: dict, rec: Record) -> None:
    worktree, s = st["worktree"], st["startable"].get(rec.rva)
    if not (rec.rva in st["solve_set"] or rec.reach == "candidate"):
        return
    if s is None:
        rec.solve = "unsupported NOT_STARTABLE"
        return
    name, cpp = s.get("name") or "", (s.get("unit") or "").replace("\\", "/")
    if not S.PLAIN.match(name):
        rec.solve = "unsupported NAME_NOT_PLAIN"
        return
    hrel = cpp[:-4] + ".h"
    if not s.get("unit_exists") or not (worktree / hrel).is_file():
        rec.solve = "unsupported NEW_UNIT"
        return
    req = {"packet": {"functions": [{"rva": f"0x{rec.rva:x}", "size": rec.size, "name": name}], "unit": cpp, "allowedPaths": [hrel, cpp]},
           "worktree": str(worktree), "checkout": str(st["checkout"]), "dataDir": str(st["data"] / "solve"),
           "options": {"knowledge": st["knowledge"]} if st["knowledge"] else {}, "budgets": bg.level(rec.level)}
    try:
        o = S.solve(req, lambda stage, counters: None)[0][0]
        rec.solve = f"{o.status} {o.reason}"
        rec.counters.update({f"solve_{k}": int(v) for k, v in o.counters.items()})
    except Exception:  # noqa: BLE001 - a defect, counted so that it is found
        rec.solve = "error ENGINE_ERROR"


# -- the campaign -----------------------------------------------------------------------------------------

#: program counters summed in the progress lines: work done, work reused, and work done twice
WORK = ("normal_computed", "signature_computed", "alternatives_computed", "scc_cyclic", "fixpoint_rounds")
REUSE = ("normal_loaded", "edges_loaded", "signature_loaded", "alternatives_loaded", "fixpoint_resumed")
WASTE = ("redundant", "lease_waits", "nested_solve")


class Progress:
    def __init__(self, level: int, total: int, log: Callable[[str], None], every_s: float = 60.0) -> None:
        self.level, self.total, self.log, self.every_s = level, total, log, every_s
        self.t0 = self.last = time.monotonic()
        self.states: Counter = Counter()
        self.sums: Counter = Counter()
        self.ms: list[int] = []
        self.measure: dict = {}

    def add(self, r: Record, measure: dict) -> None:
        self.states[r.state] += 1
        self.sums.update({k: v for k, v in r.counters.items() if k in WORK + REUSE + WASTE})
        self.ms.append(int(measure.get("ms", 0)))
        self.measure = measure
        if time.monotonic() - self.last >= self.every_s or sum(self.states.values()) == self.total:
            self.last = time.monotonic()
            self.log(self.line())

    def line(self) -> str:
        n = sum(self.states.values())
        h = max(1e-9, (time.monotonic() - self.t0) / 3600)
        ms = sorted(self.ms) or [0]
        m = meminfo()
        done = sum(self.sums[k] for k in WORK)
        reused = sum(self.sums[k] for k in REUSE)
        return (f"L{self.level} {n}/{self.total} | " + " ".join(f"{k.lower()} {v}" for k, v in sorted(self.states.items()))
                + f" | {n / h:.0f}/h, median {ms[len(ms) // 2]} ms, p90 {ms[int(len(ms) * 0.9)]} ms, max {ms[-1]} ms"
                + f" | workers {self.measure.get('workers', 1)}, worker rss {self.measure.get('rss', 0) >> 20} MiB"
                + (f", available {m[0] >> 20} MiB" if m else "")
                + " | analysis: " + " ".join(f"{k} {self.sums[k]}" for k in WORK + REUSE + WASTE if self.sums[k])
                + f" | reused {reused / max(1, reused + done):.0%}")


def run(population: list[Target], startable: dict[int, dict], worktree: Path, checkout: Path, data: Path, name: str,
        solve_set: frozenset[int] = frozenset(), jobs: int = 1, knowledge: str | None = None, levels: range = range(len(bg.LEVELS)),
        log: Callable[[str], None] = print, every_s: float = 60.0) -> list[Record]:
    """Every function of the population, level by level; the journal `<data>/<name>.jsonl` holds what is done."""
    journal = Journal(data / f"{name}.jsonl", engine_code())
    latest = journal.latest()
    if journal.other:
        log(f"the journal has {journal.other} records of another engine: they are left aside and their functions done again")
    if latest:
        log(f"resuming: {len(latest)} functions already have a state")
    retried: set[int] = set()
    sizes = {t.rva: t.size for t in population}
    for level in levels:
        todo = [t for t in population if wanted(latest.get(t.rva), level, retried)]
        log(f"level {level} (budgets x{bg.LEVELS[level]}): {len(todo)} functions")
        if not todo:
            continue
        retried |= {t.rva for t in todo if latest.get(t.rva) is not None and latest[t.rva].state == tx.INFRA}
        progress = Progress(level, len(todo), log, every_s)

        def done(task, kind, value, measure, level=level, progress=progress) -> None:
            rva = task[0]
            if kind == "ok":
                r = Record.of(value)
            else:
                code = "WORKER_DIED" if kind == "died" else "ENGINE_ERROR"
                r = Record(rva, sizes[rva], heldout(rva), f"failed: {value}", [code], blockers=[code], state=tx.INFRA, level=level)
            r.counters["ms"] = int(measure.get("ms", 0))
            journal.append(r)
            latest[rva] = r
            progress.add(r, measure)

        pool = Pool(_init, (str(worktree), str(checkout), str(data), knowledge, startable, frozenset(solve_set)), _work, most=jobs, log=log)
        pool.run([(t.rva, t.size, level) for t in todo], done)
        log(f"level {level} done: workers started {pool.stats.started}, at most {pool.stats.most} at once, "
            f"died {pool.stats.died}, largest {pool.stats.largest >> 20} MiB")
    return [latest[t.rva] for t in population if t.rva in latest]


def summary(records: list[Record]) -> dict:
    """Counts only: states and primary blockers by function and by bytes, development and held-out apart."""
    def part(rs: list[Record]) -> dict:
        return {
            "functions": len(rs), "bytes": sum(r.size for r in rs),
            "states": dict(sorted(Counter(r.state for r in rs).items())),
            "state_bytes": dict(sorted(Counter({s: sum(r.size for r in rs if r.state == s) for s in {r.state for r in rs}}).items())),
            "levels": dict(sorted(Counter(f"L{r.level}" for r in rs).items())),
            "primary": dict(Counter(tx.name(r.blockers[0]) for r in rs if r.blockers).most_common(25)),
            "primary_family": dict(sorted(Counter(tx.family(r.blockers[0]) for r in rs if r.blockers).items())),
            "carrying": dict(Counter(tx.name(b) for r in rs for b in set(r.blockers)).most_common(25)),
            "unclassified": sorted({b for r in rs for b in r.blockers if tx.family(b) == "UNCLASSIFIED"}),
            "with_a_candidate": sum(r.reach == "candidate" for r in rs),
            "solve_ran": sum(r.solve is not None and r.solve.split(" ")[-1] not in NOT_RUN for r in rs),
        }
    return {"development": part([r for r in records if not r.heldout]), "heldout": part([r for r in records if r.heldout])}


def write(records: list[Record], data: Path, name: str) -> Path:
    """The final state of every function, one per line (the journal keeps every level)."""
    data.mkdir(parents=True, exist_ok=True)
    p = data / f"{name}-final.jsonl"
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        for r in records:
            f.write(json.dumps(asdict(r), sort_keys=True) + "\n")
    return p


__all__ = ["Journal", "Progress", "Record", "decide", "run", "summary", "wanted", "write"]
