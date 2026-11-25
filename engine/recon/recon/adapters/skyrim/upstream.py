# SPDX-License-Identifier: AGPL-3.0-or-later
"""Upstream's own Python modules, imported at run time from the pinned worktree and never vendored.

The digest of every imported file is returned so that cache keys change when upstream's code does
(specification section 4.5). Importing never executes upstream's command-line entry points.
"""
from __future__ import annotations

import importlib
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

from recon.core.canonical import file_sha256

# module name -> path inside the worktree
MODULES = {"pecoff": "tools/pecoff.py", "x64": "tools/analysis/x64.py"}
PATHS = ("tools", "tools/analysis")


class UpstreamUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Upstream:
    root: Path
    pecoff: ModuleType
    x64: ModuleType
    digests: dict[str, str]  # worktree-relative path -> sha256


_cache: dict[str, Upstream] = {}


def load(worktree: str | Path) -> Upstream:
    root = Path(worktree).resolve()
    key = str(root)
    if key in _cache:
        return _cache[key]
    missing = [rel for rel in MODULES.values() if not (root / rel).is_file()]
    if missing:
        raise UpstreamUnavailable(f"upstream worktree lacks {', '.join(missing)}")
    for rel in reversed(PATHS):
        p = str(root / rel)
        if p not in sys.path:
            sys.path.insert(0, p)
    mods = {}
    for name, rel in MODULES.items():
        m = importlib.import_module(name)
        if Path(m.__file__).resolve() != (root / rel).resolve():
            raise UpstreamUnavailable(f"module {name} resolved to a file outside the pinned worktree")
        mods[name] = m
    up = Upstream(root, mods["pecoff"], mods["x64"], {rel: file_sha256(str(root / rel)) for rel in MODULES.values()})
    _cache[key] = up
    return up
