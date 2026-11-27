# SPDX-License-Identifier: AGPL-3.0-or-later
"""Compute lanes (WORKSTREAMS.md section 5, contract C8): when and where work runs, never what it computes.

The machine is shared by four workstreams. Work runs in one of three lanes:

* `authoritative`: P7's prewarm and campaigns at a checkpoint, on the authoritative store (`phase7/`). Up to 3 workers, 4
  for a run that had already started (resumed).
* `heavy` (development): a targeted campaign, a profile, more than 50 compiles. **One at a time across all streams**,
  serialised by the shared lock `ws/locks/dev-heavy.lock` (the same `flock(2)` lock the command-line `flock` takes, so a
  run wrapped by hand and a run that takes the lane itself exclude each other). Niceness 19. While an authoritative lease
  is live (D-065: `analysis.lease` in `phase7/`, naming a running process): 1 worker, at most 1.5 GiB. Otherwise up to 2.
* `light` (development): unit tests, synthetic fixtures, single functions. One processor; niceness 19 while an
  authoritative lease is live.

Within its lane's limit a run takes as many workers as memory allows (the pool grows one at a time while what is
available stays above its reserve, `core/workers.py`); a worker that grows past the lane's cap is retired after its task.
A lease that appears while a heavy run is under way lowers its limit to one worker at the pool's next step (a worker is
retired between tasks, never in the middle of one): a lane decides when and where, so a task is never ended because of it.

The plan is a pure function of the lane, the request, the lease and the memory (`plan`), so it is tested without a
machine; `enter` applies it to this process (inherited by every worker it starts) and holds the lock for the run.
"""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterator

from recon.core.knowledge import _alive

AUTHORITATIVE, HEAVY, LIGHT = "authoritative", "heavy", "light"
LANES = (AUTHORITATIVE, HEAVY, LIGHT)
MIB, GIB = 1 << 20, 1 << 30

#: the lease file of D-065 (`core/workload.py` once it lands: the format is its)
LEASE = "analysis.lease"
#: under the recon data root: the authoritative store's directory, and the shared lock of the heavy lane
AUTHORITATIVE_DIR = "phase7"
LOCK = "ws/locks/dev-heavy.lock"
#: the lane limits of section 5
AUTHORITATIVE_WORKERS, AUTHORITATIVE_RESUMED = 3, 4
HEAVY_WORKERS, HEAVY_CAP_LEASED = 2, 3 * GIB // 2
#: what one campaign worker has measured at most (D-060 campaign: 2,269 MiB); the first estimate before any is measured
WORKER_PEAK = 2269 * MIB


def root_of(checkout: str | Path) -> Path:
    """The recon data root of a checkout: where `phase7/`, `ws/` and the lock live."""
    return Path(checkout) / ".local/orchestrator/recon"


def lease(d: str | Path) -> dict | None:
    """The live lease of directory `d` (D-065), or None: no lease, an unreadable one, or one whose process has ended."""
    try:
        x = json.loads((Path(d) / LEASE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return x if isinstance(x, dict) and isinstance(x.get("pid"), int) and _alive(x["pid"]) else None


def authoritative_lease(root: str | Path) -> dict | None:
    return lease(Path(root) / AUTHORITATIVE_DIR)


def auto(root: str | Path, *paths: str | Path) -> str:
    """The lane a heavy command runs in when none is named: authoritative when every store or data directory it writes is
    the authoritative one (`phase7/`), the development-heavy lane otherwise."""
    a = (Path(root) / AUTHORITATIVE_DIR).resolve()
    inside = [p for p in paths if p]
    return AUTHORITATIVE if inside and all(a == Path(p).resolve() or a in Path(p).resolve().parents for p in inside) else HEAVY


@dataclass(frozen=True)
class Plan:
    lane: str
    workers: int                 # at most this many worker processes
    nice: int                    # this process's niceness (its workers inherit it)
    cpus: int | None             # pinned to this many processors; None: not pinned
    cap: int | None              # a worker past this many resident bytes is retired after its task; None: the pool's share
    leased: bool                 # an authoritative lease was live when the plan was made
    reserve: int | None = None   # memory the pool leaves available; None: the pool's default

    def line(self) -> str:
        return (f"lane {self.lane}: at most {self.workers} worker{'s' if self.workers != 1 else ''}, nice {self.nice}"
                + (f", {self.cpus} processor{'s' if self.cpus != 1 else ''}" if self.cpus else "")
                + (f", a worker retired past {self.cap // MIB} MiB" if self.cap else "")
                + (" (an authoritative run holds its lease)" if self.leased else ""))


def plan(lane: str, requested: int, leased: bool, memory: tuple[int, int] | None, resumed: bool = False,
         peak: int = WORKER_PEAK) -> Plan:
    """The limits of `lane` for a run that asks for `requested` workers. `leased`: an authoritative lease is live (it does
    not bind the authoritative lane itself, whose own runs hold it). `memory`: (available, total) bytes, or None where it
    cannot be read. `peak`: the largest worker measured so far. Never fewer than one worker: the lane slows a run, it
    never refuses one."""
    if lane not in LANES:
        raise ValueError(f"unknown lane {lane!r}")
    requested = max(1, int(requested))
    if lane == AUTHORITATIVE:
        return Plan(lane, min(requested, AUTHORITATIVE_RESUMED if resumed else AUTHORITATIVE_WORKERS), 0, None, None, leased)
    if lane == LIGHT:
        return Plan(lane, 1, 19 if leased else 0, 1, None, leased)
    if leased:
        return Plan(lane, 1, 19, None, HEAVY_CAP_LEASED, True, reserve=_reserve(memory))
    n = min(requested, HEAVY_WORKERS)
    if memory is not None:          # start no more workers than fit next to the reserve, each of the largest size measured
        n = max(1, min(n, (memory[0] - _reserve(memory)) // max(peak, GIB)))
    return Plan(lane, n, 19, None, None, False, reserve=_reserve(memory))


def _reserve(memory: tuple[int, int] | None) -> int | None:
    """What a development run leaves available: a quarter of the machine, at least 2 GiB (the pool's own rule), so that
    an authoritative run starting later still finds it."""
    return None if memory is None else max(2 * GIB, memory[1] // 4)


def limit(p: Plan, root: str | Path) -> int:
    """The workers `p`'s run may have now: a heavy run drops to one while an authoritative lease is live."""
    if p.lane == HEAVY and authoritative_lease(root) is not None:
        return 1
    return p.workers


#: the plan of the run this process is in, read by `workers.Pool` (None: no lane was entered, the pool's own limits)
_CURRENT: tuple[Plan, Path] | None = None


def current() -> tuple[Plan, Path] | None:
    return _CURRENT


def _apply(p: Plan) -> None:
    if hasattr(os, "nice") and p.nice > 0:
        try:
            now = os.nice(0)
            if p.nice > now:
                os.nice(p.nice - now)
        except OSError:
            pass
    if p.cpus and hasattr(os, "sched_setaffinity") and hasattr(os, "sched_getaffinity"):
        cpus = sorted(os.sched_getaffinity(0))
        if len(cpus) > p.cpus:
            os.sched_setaffinity(0, set(cpus[-p.cpus:]))


@contextmanager
def enter(lane: str, root: str | Path, requested: int = 1, what: str = "", resumed: bool = False, wait: bool = True,
          memory: Callable[[], tuple[int, int] | None] | None = None, log: Callable[[str], None] = lambda s: None) -> Iterator[Plan]:
    """Run the block in `lane`: the heavy lane's lock taken (waiting for it when `wait`, else BlockingIOError), this
    process's niceness and processors set, and the plan published for the pool. `what` names the run in the lock's note."""
    import fcntl                                   # POSIX only: the lanes are the WSL machine's

    from recon.core.workers import meminfo

    global _CURRENT
    root = Path(root)
    held = None
    if lane == HEAVY:
        path = root / LOCK
        path.parent.mkdir(parents=True, exist_ok=True)
        held = open(path, "a+")
        note = path.with_name(path.name + ".holder")
        try:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if not wait:
                held.close()
                raise
            try:
                who = note.read_text(encoding="utf-8").strip()
            except OSError:
                who = ""
            log(f"lane heavy: waiting for the development-heavy lock{' (' + who + ')' if who else ''}")
            t0 = time.monotonic()
            fcntl.flock(held, fcntl.LOCK_EX)
            log(f"lane heavy: lock taken after {time.monotonic() - t0:.0f} s")
        try:
            note.write_text(json.dumps({"pid": os.getpid(), "what": what, "since": int(time.time())}), encoding="utf-8")
        except OSError:
            pass
    try:
        p = plan(lane, requested, authoritative_lease(root) is not None, (memory or meminfo)(), resumed)
        _apply(p)
        log(p.line())
        before, _CURRENT = _CURRENT, (p, root)
        try:
            yield p
        finally:
            _CURRENT = before
    finally:
        if held is not None:
            try:
                note = root / (LOCK + ".holder")
                if json.loads(note.read_text(encoding="utf-8")).get("pid") == os.getpid():
                    note.unlink()
            except (OSError, ValueError):
                pass
            fcntl.flock(held, fcntl.LOCK_UN)
            held.close()


def light(root: str | Path) -> Plan:
    """Make this process a light development run (a test, a fixture, a single function): one processor, and niceness 19
    while an authoritative lease is live. Returns the plan applied."""
    p = plan(LIGHT, 1, authoritative_lease(root) is not None, None)
    _apply(p)
    return p


def with_workers(p: Plan, n: int) -> Plan:
    return replace(p, workers=max(1, n))


__all__ = ["AUTHORITATIVE", "AUTHORITATIVE_DIR", "HEAVY", "LANES", "LEASE", "LIGHT", "LOCK", "Plan", "authoritative_lease", "auto",
           "current", "enter", "lease", "light", "limit", "plan", "root_of", "with_workers"]
