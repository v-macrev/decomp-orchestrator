# SPDX-License-Identifier: AGPL-3.0-or-later
"""The function inventory upstream publishes: the offered targets (RVA and size), and which of them
data/progress.json already records as matched. Read-only; everything here is upstream's published data.

A target without a progress entry is the common case (the majority of offered targets): it is unmatched
and has no recorded name, owner or status. The engine treats RVA and size as the validated inventory entry
(specification section 8: prefer validated inventory entries).
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

    def unmatched(self) -> list[Target]:
        return [t for t in self.targets if not t.matched]

    def by_rva(self) -> dict[int, Target]:
        return {t.rva: t for t in self.targets}


def size_bucket(size: int) -> str:
    for b in SIZE_BUCKETS:
        if size <= b:
            return f"<={b}"
    return ">1024"


def load_inventory(worktree: str | Path) -> Inventory:
    root = Path(worktree)
    progress = json.loads((root / "data/progress.json").read_text())
    status = {f["rva"]: f.get("status") for f in progress["functions"]}
    targets: list[Target] = []
    seen: set[int] = set()
    for path in sorted(glob.glob(str(root / "data/target-hashes/contributor-targets-part-*.json"))):
        for f in json.loads(Path(path).read_text())["functions"]:
            if f["rva"] in seen:
                continue  # a function listed twice is one function
            seen.add(f["rva"])
            targets.append(Target(f["rva"], f["size"], f.get("extent_source", ""), status.get(f["rva"])))
    targets.sort(key=lambda t: t.rva)
    build = progress.get("target_build_id", "")
    return Inventory(build, tuple(targets), len(status), sum(1 for s in status.values() if s == "matched"))
