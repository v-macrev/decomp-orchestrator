# SPDX-License-Identifier: AGPL-3.0-or-later
"""Worker processes, as many as memory allows and no more.

The pool starts with one worker and adds one at a time while the memory left after another worker of the largest size
measured so far would stay above a reserve; when what is available falls below the reserve it retires a worker. A worker
whose resident memory grows past its share is retired after its task (what it learnt is in the store, not in its memory). A
worker that dies takes its task back to the queue and the pool shrinks; a task that has killed its worker twice is
answered `died`, which the caller records as an infrastructure state, never as a result of the reconstruction. Nothing
here has a wall-clock limit: the operation budgets bound the work.
"""
from __future__ import annotations

import multiprocessing as mp
import time
from collections import deque
from dataclasses import dataclass, field
from multiprocessing.connection import Connection, wait
from typing import Any, Callable, Iterable

GIB = 1 << 30


def meminfo() -> tuple[int, int] | None:
    """(available, total) bytes of the machine, or None where it cannot be read."""
    try:
        with open("/proc/meminfo", encoding="ascii") as f:
            d = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in f}
        return d["MemAvailable"], d["MemTotal"]
    except (OSError, KeyError, ValueError, IndexError):
        return None


def resident(pid: int | str = "self") -> tuple[int, int]:
    """(resident, peak resident) bytes of a process, (0, 0) where it cannot be read."""
    try:
        with open(f"/proc/{pid}/status", encoding="ascii") as f:
            d = {line.split(":")[0]: line.split()[1:] for line in f}
        return int(d["VmRSS"][0]) * 1024, int(d["VmHWM"][0]) * 1024
    except (OSError, KeyError, ValueError, IndexError):
        return 0, 0


def _main(conn: Connection, init: Callable, init_args: tuple, work: Callable) -> None:
    state = init(*init_args)
    while True:
        task = conn.recv()
        if task is None:
            return
        try:
            out = ("ok", work(state, task))
        except Exception as e:  # noqa: BLE001 - a defect of the work, answered so that it is recorded
            out = ("error", type(e).__name__)
        conn.send((out, resident()))


@dataclass
class _Worker:
    proc: Any
    conn: Connection
    task: Any = None
    since: float = 0.0
    rss: int = 0
    peak: int = 0
    retiring: bool = False


@dataclass
class Stats:
    started: int = 0
    retired: int = 0
    died: int = 0
    largest: int = 0              # the largest peak resident size of a worker, bytes
    most: int = 0                 # the most workers at once
    grew: list[tuple[float, int]] = field(default_factory=list)


class Pool:
    """`work(state, task)` in worker processes, `state = init(*init_args)` once per worker."""

    def __init__(self, init: Callable, init_args: tuple, work: Callable, most: int = 1, reserve: int | None = None,
                 share: float = 0.5, step_s: float = 20.0, log: Callable[[str], None] = lambda s: None) -> None:
        """`most`: never more workers than this. `reserve`: memory to leave free (a quarter of the machine, at least 2 GiB,
        unless given). `share`: the part of the machine one worker may grow to before it is retired after its task."""
        self.init, self.init_args, self.work, self.most = init, init_args, work, max(1, most)
        m = meminfo()
        self.total = m[1] if m else 0
        self.reserve = reserve if reserve is not None else (max(2 * GIB, self.total // 4) if m else 0)
        self.share, self.step_s, self.log = share, step_s, log
        self.allowed = 1
        self.ctx = mp.get_context("spawn")
        self.workers: list[_Worker] = []
        self.stats = Stats()
        self._last = 0.0

    def _spawn(self) -> None:
        here, there = self.ctx.Pipe()
        p = self.ctx.Process(target=_main, args=(there, self.init, self.init_args, self.work), daemon=True)
        p.start()
        there.close()
        self.workers.append(_Worker(p, here))
        self.stats.started += 1
        self.stats.most = max(self.stats.most, len(self.workers))

    def _retire(self, w: _Worker) -> None:
        try:
            w.conn.send(None)
        except (OSError, BrokenPipeError):
            pass
        w.proc.join(60)
        if w.proc.is_alive():
            w.proc.kill()
            w.proc.join()
        self.workers.remove(w)
        self.stats.retired += 1

    def _adjust(self, pending: int) -> None:
        now = time.monotonic()
        if now - self._last < self.step_s:
            return
        self._last = now
        m = meminfo()
        if m is None:
            return
        avail = m[0]
        per = max([w.peak for w in self.workers] + [self.stats.largest, GIB])
        if avail < self.reserve and self.allowed > 1:
            self.allowed -= 1
            self.log(f"workers: memory available {avail // (1 << 20)} MiB is below the reserve; at most {self.allowed}")
        elif pending > len(self.workers) and self.allowed < self.most and avail - self.reserve > 1.5 * per and len(self.workers) == self.allowed:
            self.allowed += 1
            self.stats.grew.append((round(now, 1), self.allowed))
            self.log(f"workers: memory available {avail // (1 << 20)} MiB, a worker takes up to {per // (1 << 20)} MiB; at most {self.allowed}")

    def run(self, tasks: Iterable, done: Callable[[Any, str, Any, dict], None]) -> None:
        """Every task, answered through `done(task, kind, value, measures)`: kind "ok" (value: what `work` returned), "error"
        (value: the exception's kind) or "died" (the worker died twice on it)."""
        queue = deque(tasks)
        deaths: dict[int, int] = {}
        try:
            while queue or any(w.task is not None for w in self.workers):
                self._adjust(len(queue))
                for w in [w for w in self.workers if w.task is None and (w.retiring or len(self.workers) > self.allowed)]:
                    self._retire(w)
                while queue and len(self.workers) < self.allowed:
                    self._spawn()
                for w in self.workers:
                    if w.task is None and queue:
                        w.task, w.since = queue.popleft(), time.monotonic()
                        w.conn.send(w.task)
                ready = wait([w.conn for w in self.workers if w.task is not None] + [w.proc.sentinel for w in self.workers if w.task is not None], 5)
                for w in list(self.workers):
                    if w.task is None:
                        continue
                    got = None
                    if w.conn in ready:
                        try:
                            got = w.conn.recv()
                        except (EOFError, OSError):
                            got = None
                    elif w.proc.sentinel not in ready:
                        continue
                    if got is None:                   # the worker died with the task
                        task, w.task = w.task, None
                        w.proc.join(5)
                        self.workers.remove(w)
                        self.stats.died += 1
                        self.allowed = max(1, self.allowed - 1)
                        n = deaths[id(task)] = deaths.get(id(task), 0) + 1
                        self.log(f"workers: a worker died (exit {w.proc.exitcode}); at most {self.allowed}")
                        if n >= 2:
                            done(task, "died", w.proc.exitcode, {"ms": int(1000 * (time.monotonic() - w.since))})
                        else:
                            queue.appendleft(task)
                        continue
                    (kind, value), (rss, peak) = got
                    task, w.task = w.task, None
                    w.rss, w.peak = rss, peak
                    self.stats.largest = max(self.stats.largest, peak)
                    if self.total and rss > self.share * self.total:
                        w.retiring = True
                    done(task, kind, value, {"ms": int(1000 * (time.monotonic() - w.since)), "rss": rss, "peak": peak,
                                              "workers": len(self.workers)})
        finally:
            for w in list(self.workers):
                if w.task is None:
                    self._retire(w)
                else:
                    w.proc.kill()
                    w.proc.join()
                    self.workers.remove(w)


__all__ = ["GIB", "Pool", "Stats", "meminfo", "resident"]
