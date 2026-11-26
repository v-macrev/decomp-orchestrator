# SPDX-License-Identifier: AGPL-3.0-or-later
"""The operation budgets of one search, read from the request and spent by the component that does the work.

Each budget counts operations, never time, so the same request does the same work everywhere:

* `candidates`: candidates kept by the generator (trees that do what the function does)
* `expansions`: choices the generator tries, kept or not
* `compiles`: compilations the search asks of the compiler, ranking and the exact unit alike
* `solverUnits`: solver checks (each one bounded by the solver's own resource limit)
* `irNodes`: IR operations of the functions analysed, the target and the callees whose signatures are inferred

A budget that runs out raises `BudgetExhausted`; the search answers `BUDGET_EXHAUSTED` with a frontier from which a
larger budget continues. A wall-clock limit is not a budget: the server enforces it and calls it an infrastructure failure.
"""
from __future__ import annotations

import contextvars
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator

KINDS = ("candidates", "compiles", "solverUnits", "irNodes", "expansions")
#: what a request that names no budget gets: the limits the generator had as constants, and room for the rest
DEFAULTS = {"candidates": 48, "expansions": 160, "compiles": 400, "solverUnits": 2_000, "irNodes": 200_000}


#: the levels a campaign gives a function, each a multiple of the defaults (L0 is the defaults). A level is a segment of
#: work, never a limit of the reconstruction: a function whose budget ran out at one level is taken up at the next, and
#: what the lower level computed (normal forms, signatures, compiles, verdicts) is read back, not computed again. Past the
#: last level it stays RESUMABLE, for a campaign with more levels.
LEVELS = (1, 4, 16, 64, 256, 1024)


def level(n: int, base: dict[str, int] | None = None) -> dict[str, int]:
    """The budgets of level `n`: every kind `LEVELS[n]` times its base (the defaults unless given)."""
    if not 0 <= n < len(LEVELS):
        raise ValueError(f"levels are 0 to {len(LEVELS) - 1}")
    b = {**DEFAULTS, **(base or {})}
    return {k: b[k] * LEVELS[n] for k in KINDS}


class BudgetExhausted(Exception):
    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


@dataclass
class Budget:
    limits: dict[str, int] = field(default_factory=dict)
    used: dict[str, int] = field(default_factory=lambda: dict.fromkeys(KINDS, 0))

    @staticmethod
    def of(request: dict | None) -> "Budget":
        """The budgets a request names, the defaults for the others. Unknown names are the protocol's to refuse."""
        given = request or {}
        return Budget({k: int(given.get(k, DEFAULTS[k])) for k in KINDS})

    def limit(self, kind: str) -> int:
        return self.limits.get(kind, DEFAULTS[kind])

    def left(self, kind: str) -> int:
        return max(0, self.limit(kind) - self.used[kind])

    def spend(self, kind: str, n: int = 1) -> None:
        """Take `n` operations of `kind`, or raise without taking any when fewer are left."""
        if self.used[kind] + n > self.limit(kind):
            raise BudgetExhausted(kind)
        self.used[kind] += n

    def counters(self) -> dict[str, int]:
        return {f"budget_{k}": self.used[k] for k in KINDS} | {f"limit_{k}": self.limit(k) for k in KINDS}


_active: contextvars.ContextVar[Budget | None] = contextvars.ContextVar("recon_budget", default=None)


@contextmanager
def active(b: Budget) -> Iterator[Budget]:
    """`b` is the budget the components below spend from until the block ends."""
    token = _active.set(b)
    try:
        yield b
    finally:
        _active.reset(token)


def spend(kind: str, n: int = 1) -> None:
    """Spend from the active budget; outside a search (tests, proofs of rules) nothing is counted."""
    b = _active.get()
    if b is not None:
        b.spend(kind, n)


def current() -> Budget | None:
    return _active.get()


__all__ = ["DEFAULTS", "KINDS", "LEVELS", "Budget", "BudgetExhausted", "active", "current", "level", "spend"]
