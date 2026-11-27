# SPDX-License-Identifier: AGPL-3.0-or-later
"""Which work yields to which (D-065): the whole-program analysis and the campaigns hold a lease in their data directory while
they run; a diagnostic (a probe, a measurement) that starts while one is held runs at the lowest priority on one processor,
so that it cannot slow them down for more than that processor, and a lease whose process has ended is no lease.

Nothing here changes what is computed: only when and where a process runs.
"""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from recon.core.knowledge import _alive

LEASE = "analysis.lease"


def holder(data: Path) -> dict | None:
    """The live lease of `data`, or None (none, unreadable, or its process has ended)."""
    try:
        d = json.loads((Path(data) / LEASE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and isinstance(d.get("pid"), int) and _alive(d["pid"]) else None


@contextmanager
def analysis(data: Path, what: str) -> Iterator[None]:
    """Hold the lease of `data` while the block runs (`what`: "prewarm", "campaign"). A live lease of another process is
    left as it is: two analyses may share a store (they lease their units of work there), and the first lease stands."""
    path = Path(data) / LEASE
    mine = holder(data) is None
    if mine:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{LEASE}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"pid": os.getpid(), "what": what, "since": int(time.time())}), encoding="utf-8")
        os.replace(tmp, path)
    try:
        yield
    finally:
        if mine:
            try:
                d = json.loads(path.read_text(encoding="utf-8"))
                if d.get("pid") == os.getpid():
                    path.unlink()
            except (OSError, ValueError):
                pass


def diagnostic(data: Path) -> str:
    """Make this process a diagnostic of `data`: when an analysis holds its lease, lowest priority on one processor.
    Returns "yielding" or "free"."""
    if holder(data) is None:
        return "free"
    if hasattr(os, "nice"):
        try:
            os.nice(19)
        except OSError:
            pass
    if hasattr(os, "sched_setaffinity") and hasattr(os, "sched_getaffinity"):
        cpus = sorted(os.sched_getaffinity(0))
        if len(cpus) > 1:
            os.sched_setaffinity(0, {cpus[-1]})
    return "yielding"


__all__ = ["LEASE", "analysis", "diagnostic", "holder"]
