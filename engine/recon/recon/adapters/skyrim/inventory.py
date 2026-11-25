# SPDX-License-Identifier: AGPL-3.0-or-later
"""The function inventory upstream publishes: the offered targets (RVA and size), and which of them
data/progress.json already records as matched. Read-only; everything here is upstream's published data.

The offered list is, by construction (tools/target_hash_offers.py `collect`: `(wanted|next_)-known`), the functions
that had **no** progress entry when it was written. So an offered target without an entry is unmatched, and one
with an entry has been recorded since. The 40,000 other recorded functions are not in the list; the recorded but
unmatched ones (`mapped`) are a separate population here. RVA and size are the validated inventory entry
(specification section 8); entries that contradict each other are refused, never chosen between.
"""
from __future__ import annotations

import glob
import json
from dataclasses import dataclass
from pathlib import Path

SIZE_BUCKETS = (16, 32, 64, 128, 256, 512, 1024)


@dataclass(frozen=True)
class Target:
    rva: int
    size: int
    extent_source: str
    progress_status: str | None  # None: no progress entry

    @property
    def matched(self) -> bool:
        return self.progress_status == "matched"


@dataclass(frozen=True)
class Inventory:
    build_id: str
    targets: tuple[Target, ...]
    progress_entries: int
    progress_matched: int
    #: recorded in data/progress.json but not matched, and not in the offered list
    recorded_unmatched: tuple[Target, ...] = ()
    #: every function start upstream records or offers
    known_starts: frozenset[int] = frozenset()

    def unmatched(self) -> list[Target]:
        return [t for t in self.targets if not t.matched]

    def by_rva(self) -> dict[int, Target]:
        return {t.rva: t for t in self.targets}


def size_bucket(size: int) -> str:
    for b in SIZE_BUCKETS:
        if size <= b:
            return f"<={b}"
    return ">1024"


class InventoryConflict(RuntimeError):
    """The published list contradicts itself: the same function with two sizes, or two functions that overlap."""


def load_inventory(worktree: str | Path) -> Inventory:
    root = Path(worktree)
    progress = json.loads((root / "data/progress.json").read_text())
    status = {f["rva"]: f.get("status") for f in progress["functions"]}
    targets: list[Target] = []
    seen: dict[int, int] = {}
    for path in sorted(glob.glob(str(root / "data/target-hashes/contributor-targets-part-*.json"))):
        for f in json.loads(Path(path).read_text())["functions"]:
            if f["rva"] in seen:
                if seen[f["rva"]] != f["size"]:
                    raise InventoryConflict("a function is listed with two sizes")
                continue  # a function listed twice alike is one function
            seen[f["rva"]] = f["size"]
            targets.append(Target(f["rva"], f["size"], f.get("extent_source", ""), status.get(f["rva"])))
    targets.sort(key=lambda t: t.rva)
    if any(a.rva + a.size > b.rva for a, b in zip(targets, targets[1:])):
        raise InventoryConflict("two listed functions overlap")
    build = progress.get("target_build_id", "")
    recorded = tuple(sorted((Target(f["rva"], f["size"], "progress", f.get("status")) for f in progress["functions"]
                             if f.get("status") != "matched" and f["rva"] not in seen), key=lambda t: t.rva))
    return Inventory(build, tuple(targets), len(status), sum(1 for s in status.values() if s == "matched"), recorded,
                     frozenset(seen) | frozenset(status))
