# SPDX-License-Identifier: AGPL-3.0-or-later
"""`recon doctor`: what is present, what is missing and how to add it.

Nothing here reads the image beyond hashing it, nothing is written, and the report carries no path,
byte or listing: names, booleans, versions and digests of files upstream publishes.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from recon.core.canonical import file_sha256

# Upstream modules the engine will import at run time from the pinned worktree (never vendored).
UPSTREAM_MODULES = (
    "tools/pecoff.py",
    "tools/compare.py",
    "tools/compare_internal.py",
    "tools/compare_runtime.py",
    "tools/analysis/x64.py",
    "tools/analysis/imagemodel.py",
    "tools/verifier/bind.py",
    "tools/verifier/align.py",
    "tools/verifier/disasm.py",
    "tools/verifier/permute.py",
    "tools/verifier/unit_build.py",
)
OPTIONAL_PACKAGES = (
    ("iced_x86", "instruction decoding, upstream's own pin (1.21.0)"),
    ("z3", "SMT checks of IR transformations"),
    ("capstone", "independent decoder for differential tests"),
)


def _check(check_id: str, status: str, detail: str, fix: str | None = None) -> dict:
    c = {"id": check_id, "status": status, "detail": detail[:200]}
    if fix:
        c["fix"] = fix[:300]
    return c


def _mem_total_mb() -> int | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


def run_doctor(worktree: str | None, checkout: str | None, data_dir: str | None) -> dict:
    checks: list[dict] = []

    v = sys.version_info
    checks.append(_check("python", "ok" if v >= (3, 11) else "error", f"Python {v.major}.{v.minor}.{v.micro}",
                         None if v >= (3, 11) else "the engine needs Python 3.11 or newer"))
    checks.append(_check("machine", "ok", f"{os.cpu_count()} CPUs, {_mem_total_mb()} MB memory"))

    for name, why in OPTIONAL_PACKAGES:
        have = importlib.util.find_spec(name) is not None
        checks.append(_check(f"package.{name}", "ok" if have else "missing", why,
                             None if have else "create the private venv under the data directory and install the pinned, hashed requirement (docs/recon/TECHNICAL_DECISIONS.md)"))

    expected_hash = None
    wt = Path(worktree) if worktree else None
    if wt is None or not wt.is_dir():
        checks.append(_check("upstream.worktree", "missing", "no upstream worktree was given or it does not exist",
                             "pass the worktree of the pinned base in the request"))
    else:
        try:
            target = json.loads((wt / "builds/target.json").read_text())
            expected_hash = target.get("image_sha256")
            checks.append(_check("upstream.target", "ok", f"build {target.get('build_id')}, image sha256 {str(expected_hash)[:12]}…"))
        except (OSError, ValueError) as e:
            checks.append(_check("upstream.target", "error", f"builds/target.json unreadable: {type(e).__name__}"))
        try:
            rev = subprocess.run(["git", "-C", str(wt), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=20)
            checks.append(_check("upstream.revision", "ok" if rev.returncode == 0 else "error", rev.stdout.strip()[:40] or "git could not read HEAD"))
        except (OSError, subprocess.SubprocessError):
            checks.append(_check("upstream.revision", "error", "git is not available"))
        digests: dict[str, str] = {}
        missing = []
        for rel in UPSTREAM_MODULES:
            p = wt / rel
            if p.is_file():
                digests[rel] = file_sha256(str(p))[:16]
            else:
                missing.append(rel)
        checks.append(_check("upstream.modules", "ok" if not missing else "missing",
                             f"{len(digests)} of {len(UPSTREAM_MODULES)} present" + (f"; missing {', '.join(missing)}" if missing else "")))
        # The modules must import in this interpreter, from the worktree, with nothing else on the path.
        if (wt / "tools/pecoff.py").is_file() and (wt / "tools/compare.py").is_file():
            probe = ("import sys; sys.path.insert(0, sys.argv[1]); import pecoff, compare; "
                     "print(compare.CONTRACT_VERSION, compare.COMPARATOR_VERSION)")
            r = subprocess.run([sys.executable, "-I", "-c", probe, str(wt / "tools")], capture_output=True, text=True, timeout=60)
            checks.append(_check("upstream.import", "ok" if r.returncode == 0 else "error",
                                 f"comparator contract {r.stdout.strip()}" if r.returncode == 0 else f"import failed: {r.stderr.strip().splitlines()[-1][:120] if r.stderr.strip() else r.returncode}"))

    cfg: dict = {}
    if checkout:
        try:
            cfg = json.loads((Path(checkout) / ".local/contrib/config.json").read_text())
        except (OSError, ValueError):
            checks.append(_check("contrib.config", "missing", "the checkout's private contrib config is absent or unreadable",
                                 "run ./sr setup in the checkout"))
    exe = cfg.get("exe")
    if exe and Path(exe).is_file():
        got = file_sha256(exe)
        if expected_hash is None:
            checks.append(_check("image", "skipped", "image present; no expected hash to compare (upstream target unreadable)"))
        elif got == expected_hash:
            checks.append(_check("image", "ok", "image present and its sha256 equals builds/target.json"))
        else:
            checks.append(_check("image", "mismatch", "image present but its sha256 differs from builds/target.json",
                                 "point the checkout at the pinned Steam 1.7.104 executable"))
    elif checkout:
        checks.append(_check("image", "missing", "the configured game image is not readable", "set exe in the checkout's .local/contrib/config.json"))

    msvc = cfg.get("msvc")
    if msvc:
        checks.append(_check("toolchain.msvc", "ok" if Path(msvc).is_dir() else "missing", "MSVC toolchain directory " + ("present" if Path(msvc).is_dir() else "absent")))
    elif checkout:
        checks.append(_check("toolchain.msvc", "missing", "no MSVC toolchain configured", "run ./sr setup in the checkout"))
    wine = shutil.which("wine64") or shutil.which("wine")
    if wine:
        try:
            w = subprocess.run([wine, "--version"], capture_output=True, text=True, timeout=30)
            checks.append(_check("toolchain.wine", "ok", w.stdout.strip()[:60] or "wine present"))
        except (OSError, subprocess.SubprocessError):
            checks.append(_check("toolchain.wine", "error", "wine did not answer"))
    else:
        checks.append(_check("toolchain.wine", "missing", "wine is not on PATH (the toolchain host compiles through Wine or a native cl)"))

    if data_dir:
        d = Path(data_dir)
        try:
            d.mkdir(parents=True, exist_ok=True)
            probe_file = d / ".doctor-write-test"
            probe_file.write_text("x")
            probe_file.unlink()
            checks.append(_check("data.dir", "ok", "private data directory writable"))
        except OSError:
            checks.append(_check("data.dir", "error", "private data directory is not writable"))

    bad = [c["id"] for c in checks if c["status"] in ("error", "mismatch")]
    absent = [c["id"] for c in checks if c["status"] == "missing"]
    return {"checks": checks, "errors": bad, "missing": absent}
