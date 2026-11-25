# SPDX-License-Identifier: AGPL-3.0-or-later
"""Upstream's comparator and unit build, called in process.

`sr compare` decides with `tools/compare_runtime.py` (on both of its paths: `contrib.compare_with_local_dir` and
`verify_function.run`), not with `tools/compare.py` directly; the two share code but are distinct engines with
distinct digests. This module loads the same engine, the same build step (`contrib.compile_unit`, which writes
the build record) and the same binder, so that a local verdict is the Gate Keeper's verdict for equal inputs.
Nothing is decided here.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from recon.core.canonical import file_sha256

IMPORT_PATHS = ("tools", "tools/verifier", "tools/analysis")
DIGESTED = ("tools/compare_runtime.py", "tools/compare.py", "tools/compare_internal.py", "tools/pecoff.py", "tools/source_digest.py",
            "tools/contrib.py", "tools/verifier/unit_build.py", "tools/verifier/bind.py", "tools/verifier/verify_function.py")


class ComparatorUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Built:
    object_path: Path
    record: dict
    source_revision: str
    recipe_sha256: str


class LocalComparator:
    def __init__(self, worktree: str | Path, local_dir: str | Path, image_path: str | Path):
        self.root = Path(worktree).resolve()
        for rel in reversed(IMPORT_PATHS):
            p = str(self.root / rel)
            if p not in sys.path:
                sys.path.insert(0, p)
        self.contrib = importlib.import_module("contrib")
        self.runtime = importlib.import_module("compare_runtime")
        self.verify = importlib.import_module("verify_function")
        self.binder = importlib.import_module("bind")
        for m in (self.contrib, self.runtime, self.verify, self.binder):
            if self.root not in Path(m.__file__).resolve().parents:
                raise ComparatorUnavailable("an upstream module resolved outside the pinned worktree")
        self.digests = {rel: file_sha256(str(self.root / rel)) for rel in DIGESTED}
        env = {"SR_LOCAL_DIR": str(local_dir), "SR_CONTRIB_OFFLINE": "1", "SR_NO_SIBLING_NAMES": "1"}
        self.ctx = self.contrib.Ctx(repo=self.root, env={**os.environ, **env}, interactive=False)
        self.manifest = json.loads((self.root / "builds/target.json").read_text())
        self.image_path = Path(image_path)
        self.image_bytes = self.image_path.read_bytes()
        self.tool = self.contrib.check_toolchain(self.ctx)
        self.objdump = self.contrib.find_objdump(self.ctx)

    def compile(self, compiled: str, recipe: str, out_dir: str | Path) -> Built:
        b = self.contrib.compile_unit(self.ctx, self.root, compiled, recipe, out_dir, self.tool)
        return Built(Path(b["object"]), json.loads(Path(b["build_record"]).read_text()), b["digest"], b["recipe_sha256"])

    def bind(self, task_dir: str | Path, built: Built) -> None:
        """Upstream's binder: updates task.json and symbols.json of a private task directory in place."""
        self.binder.bind(Path(task_dir), built.object_path, self.image_path, self.objdump, repo=self.root)

    def task(self, task_id: str, rva: int, size: int, symbol: str, source_path: str, built: Built) -> dict:
        return {"task_id": f"{task_id}-{rva:x}", "build_id": self.manifest["build_id"], "target_image_sha256": self.manifest["image_sha256"],
                "rva": rva, "size": size, "symbol": symbol, "source_revision": built.source_revision, "source_path": source_path,
                "recipe_sha256": built.recipe_sha256}

    def compare(self, task: dict, recipe_bytes: bytes, built: Built, symbols: bytes | dict, object_bytes: bytes | None = None) -> dict:
        """The sanitized report. No diagnostics file is written: the report alone leaves this call."""
        report = self.runtime.compare(task, self.manifest, recipe_bytes, built.record,
                                      object_bytes if object_bytes is not None else built.object_path.read_bytes(),
                                      self.image_bytes, symbols, diagnostics=None)
        return self.verify.check_report(report)
