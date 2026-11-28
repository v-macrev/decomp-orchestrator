# SPDX-License-Identifier: AGPL-3.0-or-later
"""Upstream's comparator for an image of our own: same engine, same checks, inputs stated here.

Nothing of the comparison is reimplemented or relaxed. The reason codes are upstream's; which ones there are is read from
its source (`reason_codes`), so that an unknown code is noticed instead of passed on.
"""
from __future__ import annotations

import ast
import hashlib
import importlib
import json
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from recon.adapters.skyrim.comparator import ComparatorUnavailable

SOURCES = ("tools/compare.py", "tools/compare_internal.py", "tools/compare_runtime.py", "tools/pecoff.py")
PASS = "all-checks-passed"
#: the kind of a symbol-map entry that places a thread-local variable by its offset in the TLS template
THREAD_LOCAL = "thread-local"


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


@lru_cache(maxsize=4)
def reason_codes(worktree: str) -> frozenset[str]:
    """Every reason the comparator can give: the first argument of `Reject`, the second of `need`, the fourth of `field`, and the pass."""
    out = {PASS}
    position = {"Reject": 0, "need": 1, "field": 3}
    for rel in SOURCES:
        for n in ast.walk(ast.parse((Path(worktree) / rel).read_text(encoding="utf-8"))):
            if isinstance(n, ast.Call):
                name = n.func.id if isinstance(n.func, ast.Name) else n.func.attr if isinstance(n.func, ast.Attribute) else ""
                k = position.get(name)
                if k is not None and len(n.args) > k:
                    a = n.args[k]
                    if isinstance(a, ast.Constant) and isinstance(a.value, str):
                        out.add(a.value)
                    elif isinstance(a, ast.IfExp):
                        out |= {x.value for x in (a.body, a.orelse) if isinstance(x, ast.Constant) and isinstance(x.value, str)}
    return frozenset(out)


class UnknownReason(RuntimeError):
    """The comparator gave a reason its source was not seen to contain: a defect here, never a verdict."""


@dataclass(frozen=True)
class Verifier:
    worktree: Path
    build_id: str
    image: bytes
    recipe: bytes

    def _engine(self):
        for rel in ("tools/verifier", "tools"):
            p = str((self.worktree / rel).resolve())
            if p not in sys.path:
                sys.path.insert(0, p)
        m = importlib.import_module("compare_runtime")
        if self.worktree.resolve() not in Path(m.__file__).resolve().parents:
            raise ComparatorUnavailable("an upstream module resolved outside the pinned worktree")
        return m

    def verify(self, rva: int, size: int, symbol: str, source: bytes, obj: bytes, symbols: dict[str, tuple[int, int | None]], path: str = "unit.cpp",
               thread: dict[str, int] | None = None) -> dict:
        """The comparator's report. `symbols`: decorated name -> (RVA, size or None); `thread`: decorated name of a
        thread-local variable -> its offset in the image's template (D-074), which the comparator checks a SECREL against."""
        revision = sha256(source)
        task = {"task_id": f"recon-{rva:x}", "build_id": self.build_id, "target_image_sha256": sha256(self.image), "rva": rva, "size": size, "symbol": symbol,
                "source_revision": revision, "source_path": path, "recipe_sha256": sha256(self.recipe)}
        manifest = {"status": "pinned", "build_id": self.build_id, "image_sha256": sha256(self.image)}
        record = {"source_revision": revision, "source_path": path, "recipe_sha256": sha256(self.recipe), "object_sha256": sha256(obj)}
        entries: dict[str, dict] = {n: {"rva": r, "size": s} for n, (r, s) in sorted(symbols.items())}
        entries |= {n: {"kind": THREAD_LOCAL, "tls_offset": off, "size": None} for n, off in sorted((thread or {}).items())}
        smap = json.dumps({"schema": 1, "build_id": self.build_id, "symbols": dict(sorted(entries.items()))}).encode()
        report = self._engine().compare(task, manifest, self.recipe, record, obj, self.image, smap, diagnostics=None)
        if report["reason"] not in reason_codes(str(self.worktree)):
            raise UnknownReason(str(report["reason"]))
        return report


__all__ = ["PASS", "UnknownReason", "Verifier", "reason_codes"]
