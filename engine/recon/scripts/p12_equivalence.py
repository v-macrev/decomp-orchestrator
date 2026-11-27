# SPDX-License-Identifier: AGPL-3.0-or-later
"""The equivalence check of WORKSTREAMS.md section 6 for P12's optimisations: one population run by two engines (or one
engine two ways) gives identical per-function states, blockers, source digests and comparator verdicts, and an identical
store digest.

Run with PYTHONPATH naming the engine tree under test (this file imports nothing of its own tree), so the unoptimised
path is the engine as it was, not a configuration of the new one. Each function is done exactly as a campaign worker does
it (`campaign._init` once per process, `campaign._work` per function, levels and resumption by `campaign.wanted`); on top,
in the same process, what `solve` decided is captured: the digest of the source of a solved function (its definition,
declaration and placeholder prototypes) and every comparator verdict with the digest of the source it judged (the
temporary header's name, which the unit's include line carries and which differs between runs, left out).

    p12_equivalence.py sample --final F --next N --size K --out S.json      a fixed stratified sample plus every matched function
    p12_equivalence.py run --worktree W --checkout C --next N --population S.json --store DB --data D [--jobs J] [--levels 0-5]
    p12_equivalence.py compare A.jsonl B.jsonl                              exit 1 on any difference
    p12_equivalence.py store-digest DB

Records name functions: everything is written under the private data directory; what is printed is counts and digests.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

FIELDS = ("state", "blockers", "solve", "reach", "reach_codes", "level", "source", "verdicts")
_INCLUDE_TEMP = re.compile(r'^#include "\.recon-[^"]+\.h"\n', re.M)


def _sha(s: str | bytes) -> str:
    return hashlib.sha256(s.encode("utf-8") if isinstance(s, str) else s).hexdigest()


# ------------------------------------------------------------------------------------------------ the sample

def sample(final: Path, nxt: Path, size: int) -> dict:
    """Every function the earlier campaign matched (the regression corpus) plus `size` others, spread over the strata
    (state, primary blocker, size band) in proportion, each stratum's members taken in the order of a digest of their
    address: the same sample for the same records."""
    recs = [json.loads(x) for x in final.read_text(encoding="utf-8").splitlines() if x.strip()]
    startable = _startable(nxt)
    corpus = sorted(r["rva"] for r in recs if r["state"] == "BYTE_MATCHED")
    rest = [r for r in recs if r["state"] != "BYTE_MATCHED" and r["rva"] in startable]
    band = lambda n: 0 if n <= 32 else 1 if n <= 64 else 2    # noqa: E731
    strata: dict[tuple, list] = {}
    for r in rest:
        strata.setdefault((r["state"], (r["blockers"] or ["-"])[0], band(r["size"])), []).append(r)
    order = sorted(strata, key=lambda k: (-len(strata[k]), k))
    take: list[int] = []
    for k in order:
        n = max(1, round(size * len(strata[k]) / len(rest)))
        take += [r["rva"] for r in sorted(strata[k], key=lambda r: _sha(f"p12-sample-v1:{r['rva']}"))[:n]]
    take = sorted(set(take[:size]))
    return {"schema": 1, "corpus": corpus, "sample": take, "strata": len(strata),
            "sizes": {r["rva"]: r["size"] for r in recs if r["rva"] in set(corpus) | set(take)}}


def _startable(nxt: Path) -> dict[int, dict]:
    out = {}
    for c in json.loads(nxt.read_text(encoding="utf-8"))["candidates"]:
        out[int(c["rva"], 16) if isinstance(c["rva"], str) else int(c["rva"])] = c
    return out


# ------------------------------------------------------------------------------------------------ one function, captured

_CAPTURE: dict = {}


def _patch() -> None:
    """Capture, in this process, the solve outcome's source and every comparator verdict."""
    from recon.adapters.skyrim import solve as S
    from recon.adapters.skyrim import verify as V

    if getattr(V.Verifier, "_p12", False):
        return
    real_verify, real_solve = V.Verifier.verify, S.solve

    def verify(self, rva, size, symbol, source, obj, symbols, path="unit.cpp"):
        report = real_verify(self, rva, size, symbol, source, obj, symbols, path)
        text = _INCLUDE_TEMP.sub("", source.decode("utf-8", "replace"), count=1)
        _CAPTURE.setdefault("verdicts", []).append([_sha(text)[:16], str(report.get("result")), str(report.get("reason"))])
        return report

    def solve(req, progress):
        out = real_solve(req, progress)
        for o in out[0]:
            if o.definition is not None:
                _CAPTURE["source"] = _sha("\0".join([o.definition, o.declaration or "", o.prototypes or ""]))[:16]
        return out

    V.Verifier.verify, S.solve = verify, solve
    V.Verifier._p12 = True


def _init(*args):
    from recon.adapters.skyrim import campaign as cp

    _patch()
    return cp._init(*args)


def _work(st, task):
    from recon.adapters.skyrim import campaign as cp

    _CAPTURE.clear()
    t0 = time.monotonic()
    d = cp._work(st, task)
    d["source"] = _CAPTURE.get("source", "")
    d["verdicts"] = _CAPTURE.get("verdicts", [])
    d["wall_ms"] = int(1000 * (time.monotonic() - t0))
    try:
        from recon.adapters.x64_msvc import ccache

        c = ccache.active()
        d["cache"] = c.stats.as_dict() if c else None
    except ImportError:
        d["cache"] = None
    return d


# ------------------------------------------------------------------------------------------------ a run

def _latest(path: Path) -> dict[int, dict]:
    out: dict[int, dict] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue                       # the line being written when the process was killed
            out[d["rva"]] = d
    return out


def run(a) -> int:
    from recon.adapters.skyrim import campaign as cp
    from recon.core import budget as bg
    from recon.core import taxonomy as tx
    from recon.core.workers import Pool, resident

    pop = json.loads(Path(a.population).read_text(encoding="utf-8"))
    sizes = {int(k): v for k, v in pop["sizes"].items()}
    rvas = sorted(set(pop["corpus"]) | set(pop["sample"]))
    startable = _startable(Path(a.next))
    data = Path(a.data)
    data.mkdir(parents=True, exist_ok=True)
    journal = data / "p12.jsonl"
    latest = _latest(journal)
    if journal.is_file() and journal.stat().st_size and not journal.read_bytes().endswith(b"\n"):
        with open(journal, "ab") as f:
            f.write(b"\n")                     # a line cut short by a kill stays one bad line
    first, _d, last = a.levels.partition("-")
    t_start = time.monotonic()
    args = (a.worktree, a.checkout, str(data), a.store, startable, frozenset())
    peak = 0
    for level in range(int(first), int(last or first) + 1):
        retried: set[int] = set()
        todo = [r for r in rvas if cp.wanted(cp.Record.of(latest[r]) if r in latest else None, level, retried)]
        print(f"level {level} (x{bg.LEVELS[level]}): {len(todo)}", file=sys.stderr, flush=True)
        if not todo:
            continue

        def done(task, kind, value, measure, level=level):
            nonlocal peak
            if kind == "ok":
                d = value
            else:
                code = "WORKER_DIED" if kind == "died" else "ENGINE_ERROR"
                d = {"rva": task[0], "size": sizes[task[0]], "state": tx.INFRA, "blockers": [code], "reach": f"failed: {value}",
                     "reach_codes": [code], "solve": None, "level": level, "source": "", "verdicts": []}
            peak = max(peak, int(measure.get("peak", 0)))
            with open(journal, "a", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps(d, sort_keys=True) + "\n")
                f.flush()
                os.fsync(f.fileno())
            latest[d["rva"]] = d

        if a.jobs == 0:                        # in this process, sequentially: no pool at all
            st = _init(*args)
            for r in todo:
                done((r, sizes[r], level), "ok", _work(st, (r, sizes[r], level)), {"peak": resident()[1]})
        else:
            Pool(_init, args, _work, most=a.jobs).run([(r, sizes[r], level) for r in todo], done)
    wall = time.monotonic() - t_start
    out = [latest[r] for r in rvas if r in latest]
    (data / "p12-final.jsonl").write_text("".join(json.dumps(d, sort_keys=True) + "\n" for d in out), encoding="utf-8")
    cache = [d.get("cache") for d in out if d.get("cache")]
    report = {"functions": len(out), "states": dict(Counter(d["state"] for d in out)), "wall_s": round(wall, 1),
              "task_ms": sum(d.get("counters", {}).get("ms", d.get("wall_ms", 0)) for d in out),
              "worker_peak_mib": peak >> 20, "verdicts": sum(len(d["verdicts"]) for d in out)}
    print(json.dumps(report, sort_keys=True))
    (data / "p12-report.json").write_text(json.dumps(report, sort_keys=True, indent=1), encoding="utf-8")
    return 0


# ------------------------------------------------------------------------------------------------ compare

def compare(a: Path, b: Path) -> int:
    A, B = _latest(a), _latest(b)
    diff: Counter = Counter()
    for r in sorted(set(A) | set(B)):
        if r not in A or r not in B:
            diff["missing"] += 1
            continue
        for f in FIELDS:
            if A[r].get(f) != B[r].get(f):
                diff[f] += 1
    print(json.dumps({"functions": len(set(A) | set(B)), "differences": dict(diff),
                      "matched": [sum(d["state"] == "BYTE_MATCHED" for d in X.values()) for X in (A, B)],
                      "verdicts": [sum(len(d.get("verdicts", [])) for d in X.values()) for X in (A, B)]}, sort_keys=True))
    return 1 if diff else 0


def store_digest(db: Path) -> str:
    """A digest of every fact of a knowledge store, in key order (leases are not facts)."""
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    h = hashlib.sha256()
    n = 0
    for row in c.execute("SELECT ns, kind, key, value FROM facts ORDER BY ns, kind, key"):
        for x in row:
            b = x if isinstance(x, bytes) else str(x).encode()
            h.update(len(b).to_bytes(8, "little") + b)
        n += 1
    c.close()
    return f"{h.hexdigest()} facts {n}"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--final", required=True)
    s.add_argument("--next", required=True)
    s.add_argument("--size", type=int, default=100)
    s.add_argument("--out", required=True)
    r = sub.add_parser("run")
    for k in ("worktree", "checkout", "next", "population", "store", "data"):
        r.add_argument("--" + k, required=True)
    r.add_argument("--jobs", type=int, default=0, help="0: in this process; N: a pool of at most N workers")
    r.add_argument("--levels", default="0-5")
    c = sub.add_parser("compare")
    c.add_argument("a")
    c.add_argument("b")
    d = sub.add_parser("store-digest")
    d.add_argument("db")
    a = ap.parse_args(argv)
    if a.cmd == "sample":
        out = sample(Path(a.final), Path(a.next), a.size)
        Path(a.out).write_text(json.dumps(out, sort_keys=True), encoding="utf-8")
        print(json.dumps({"corpus": len(out["corpus"]), "sample": len(out["sample"]), "strata": out["strata"]}))
        return 0
    if a.cmd == "run":
        return run(a)
    if a.cmd == "compare":
        return compare(Path(a.a), Path(a.b))
    print(store_digest(Path(a.db)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
