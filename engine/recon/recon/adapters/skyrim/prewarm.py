# SPDX-License-Identifier: AGPL-3.0-or-later
"""The whole-program analysis, done once and kept: every function's normal form and calls, the index of callers, and every
signature, bottom-up over the call graph's components, with what callers leave open.

It has no budget: it is the knowledge every later search reads instead of computing. It is resumable at any point, since
every unit is committed to the store as it is finished: run again, it reads back what is there and does the rest. Workers
share the store and lease what they compute, so no unit is computed twice. What is printed is counts and times.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable

from recon.adapters.skyrim import solve as S
from recon.core.workers import Pool

#: functions per task
CHUNK = 256


def _init(worktree: str, checkout: str, knowledge: str) -> dict:
    pack, _offered = S.pack_of(Path(worktree), Path(checkout), knowledge)
    return {"pack": pack}


def _work(st: dict, task: tuple[str, list[int]]) -> dict:
    phase, chunk = task
    p = st["pack"].program()          # afresh for each chunk: memory holds one chunk's walk, the store holds everything
    for at in chunk:
        if phase == "normal":
            p.edges(at)
        else:
            p.signature(at)
            p.alternatives(at)
    return {k: v for k, v in p.stats.items() if v}


def run(worktree: Path, checkout: Path, knowledge: str, jobs: int = 1, log: Callable[[str], None] = print, every_s: float = 60.0,
        phases: tuple[str, ...] = ("normal", "signature")) -> dict:
    pack, _offered = S.pack_of(worktree, checkout, knowledge)
    everything = pack.functions()
    report: dict = {"functions": len(everything)}
    for phase in phases:
        if phase == "signature":
            t0 = time.monotonic()
            p = pack.program()
            if p.callers(everything[0]) is None:
                p.index_callers()
            report["callers_s"] = round(time.monotonic() - t0, 1)
            log(f"prewarm: callers indexed in {report['callers_s']} s")
        chunks = [everything[k:k + CHUNK] for k in range(0, len(everything), CHUNK)]
        sums: dict[str, int] = {}
        state = {"n": 0, "last": time.monotonic(), "t0": time.monotonic()}

        def done(task, kind, value, measure, phase=phase, sums=sums, state=state, chunks=chunks) -> None:
            state["n"] += 1
            if kind == "ok":
                for k, v in value.items():
                    sums[k] = sums.get(k, 0) + v
            else:
                sums[f"chunk_{kind}"] = sums.get(f"chunk_{kind}", 0) + 1
            if time.monotonic() - state["last"] >= every_s or state["n"] == len(chunks):
                state["last"] = time.monotonic()
                el = time.monotonic() - state["t0"]
                left = el / state["n"] * (len(chunks) - state["n"])
                log(f"prewarm {phase}: {state['n']}/{len(chunks)} chunks, {el / 60:.0f} min, about {left / 60:.0f} min left | "
                    f"workers {measure.get('workers', 1)}, rss {measure.get('rss', 0) >> 20} MiB | "
                    + " ".join(f"{k} {v}" for k, v in sorted(sums.items())))

        pool = Pool(_init, (str(worktree), str(checkout), knowledge), _work, most=jobs, log=log)
        pool.run([(phase, c) for c in chunks], done)
        report[phase] = {"s": round(time.monotonic() - state["t0"], 1), **sums, "workers_most": pool.stats.most,
                         "workers_died": pool.stats.died, "worker_largest_mib": pool.stats.largest >> 20}
    store = pack.store
    report["store"] = {k: store.count(k) for k in ("normal", "callees", "sites", "signature", "alternatives", "callers")}  # type: ignore[union-attr]
    return report


__all__ = ["CHUNK", "run"]
