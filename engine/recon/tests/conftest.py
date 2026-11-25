# SPDX-License-Identifier: AGPL-3.0-or-later
import json
import os
from pathlib import Path

import pytest

# Where the pinned upstream worktree and the checkout are. Tests that need them are skipped, with the reason, where absent.
WORKTREE = Path(os.environ.get("RECON_UPSTREAM_WORKTREE", "/nonexistent"))
CHECKOUT = Path(os.environ.get("RECON_CHECKOUT", str(Path.home() / "skyrim_decomp")))


@pytest.fixture(scope="session")
def upstream_worktree() -> Path:
    if not (WORKTREE / "tools/pecoff.py").is_file():
        pytest.skip("needs the pinned upstream worktree (set RECON_UPSTREAM_WORKTREE)")
    return WORKTREE


@pytest.fixture(scope="session")
def real_image(upstream_worktree):
    from recon.adapters.skyrim.image import PinnedImage, locate_image

    try:
        exe = locate_image(CHECKOUT)
    except (OSError, ValueError, FileNotFoundError):
        pytest.skip("needs the checkout's private contrib config (set RECON_CHECKOUT)")
    if not exe.is_file():
        pytest.skip("needs the configured game image")
    return PinnedImage(exe, upstream_worktree)


@pytest.fixture(scope="session")
def iced():
    return pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")


@pytest.fixture
def synthetic_inventory(tmp_path) -> Path:
    """A tiny upstream-shaped worktree: three offered targets, one matched, one with a 'mapped' entry."""
    (tmp_path / "data/target-hashes").mkdir(parents=True)
    (tmp_path / "data/progress.json").write_text(json.dumps({
        "target_build_id": "synthetic",
        "functions": [{"rva": 0x1000, "size": 16, "status": "matched"}, {"rva": 0x9000, "size": 8, "status": "mapped"}],
    }))
    part = {"functions": [
        {"rva": 0x1000, "size": 16, "extent_source": "x"},
        {"rva": 0x1100, "size": 40, "extent_source": "x"},
        {"rva": 0x1100, "size": 40, "extent_source": "x"},  # listed twice: one function
        {"rva": 0x1200, "size": 300, "extent_source": "x"},
    ]}
    (tmp_path / "data/target-hashes/contributor-targets-part-000.json").write_text(json.dumps(part))
    return tmp_path
