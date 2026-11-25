# SPDX-License-Identifier: AGPL-3.0-or-later
"""Local compare against `sr compare`: are the reports equal, and what does each cost?

Units are upstream's accepted ones, opened with `sr start --practice` (no claim, no branch) in a private
SR_LOCAL_DIR of its own, so nothing of the real task list is touched. This measures upstream's tools; it is not
a reconstruction, and no source of it reaches the engine. Only counts, times and equality are returned.
"""
from __future__ import annotations

import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

from recon import ENGINE_VERSION


def scratch_local(checkout: str | Path, base: Path) -> Path:
    """A private SR_LOCAL_DIR holding only the parts of the contrib configuration a compare needs."""
    if ".local" not in base.parts:
        raise SystemExit("refusing: the measurement directory must be under a .local directory")
    d = base / "measure-local"
    shutil.rmtree(d, ignore_errors=True)
    (d / "contrib").mkdir(parents=True)
    cfg = json.loads((Path(checkout) / ".local/contrib/config.json").read_text())
    cfg = {k: cfg[k] for k in ("exe", "msvc", "microsoft_licence_accepted", "profile") if k in cfg}
    cfg["model"] = f"recon-engine-{ENGINE_VERSION}"  # never the checkout's own default model
    (d / "contrib/config.json").write_text(json.dumps(cfg))
    return d


def candidate_units(worktree: Path, lo: int, hi: int) -> list[tuple[str, list[int]]]:
    by_class: dict[str, list[int]] = defaultdict(list)
    for f in json.loads((worktree / "data/progress.json").read_text())["functions"]:
        parts = (f.get("name") or "").split("::")
        if f["status"] == "matched" and len(parts) == 2 and f["size"] >= 48 and all(p.isidentifier() for p in parts):
            by_class[parts[0]].append(f["rva"])
    return sorted((c, sorted(r)) for c, r in by_class.items() if lo <= len(r) <= hi)


def _sr(worktree: Path, env: dict, *args: str) -> tuple[int, dict | None, float]:
    t = time.monotonic()
    p = subprocess.run(["./sr", "--json", *args], cwd=worktree, env=env, capture_output=True, text=True, timeout=600)
    dt = time.monotonic() - t
    try:
        return p.returncode, json.loads(p.stdout), dt
    except ValueError:
        return p.returncode, None, dt


def _comparable(report: dict) -> dict:
    return json.loads(json.dumps(report, sort_keys=True))


#: a separate compile of the same source is a separate object file (its header carries a time), so this digest differs by construction
OBJECT_IDENTITY = "candidate.object_sha256"


def differing_paths(a, b, at: str = "") -> list[str]:
    """Dotted key paths at which two reports differ. Names only, never values."""
    if isinstance(a, dict) and isinstance(b, dict):
        return [p for k in sorted(set(a) | set(b)) for p in (differing_paths(a[k], b[k], f"{at}.{k}" if at else k) if k in a and k in b else [f"{at}.{k}" if at else k])]
    return [] if a == b else [at]


def measure(worktree: str | Path, checkout: str | Path, image: Path, base: Path, units: int) -> dict:
    from recon.adapters.skyrim.comparator import LocalComparator

    wt = Path(worktree).resolve()
    local = scratch_local(checkout, base)
    build = base / "measure-build"
    env = {**os.environ, "SR_LOCAL_DIR": str(local), "SR_CONTRIB_OFFLINE": "1", "SR_NO_SIBLING_NAMES": "1", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    model = f"recon-engine-{ENGINE_VERSION}"
    t = time.monotonic()
    lc = LocalComparator(wt, local, image)
    out: dict = {"startup_s": round(time.monotonic() - t, 2), "toolchain": lc.tool["status"], "units": 0, "skipped": {}, "functions": 0, "equal": 0, "equal_on_their_object": 0, "their_object_seen": 0,
                 "pass_both": 0, "cross_pairs": 0, "cross_equal": 0, "cross_rejected_both": 0, "differences": {}}
    times: dict[str, list[float]] = defaultdict(list)

    def skip(why: str) -> None:
        out["skipped"][why] = out["skipped"].get(why, 0) + 1

    pool = candidate_units(wt, 3, 8)
    step = max(1, len(pool) // (units * 3))
    for _cls, rvas in pool[::step]:
        if out["units"] >= units:
            break
        code, res, _ = _sr(wt, env, "start", *[f"0x{r:x}" for r in rvas], "--practice", "--no-branch", "--model", model, "--drafted-by", model)
        tid = (res.get("data") or res).get("task") if res else None
        tdir = local / "contrib/tasks" / str(tid)
        if code != 0 or not tid or not tdir.is_dir():
            skip("practice-start-refused")
            continue
        _code, _res, dt = _sr(wt, env, "compare", tid, "--no-retry")
        runs = sorted((tdir / "runs").glob("[0-9][0-9][0-9]")) if (tdir / "runs").is_dir() else []
        if not runs or not (runs[-1] / "summary.json").is_file():
            skip("sr-compare-did-not-finish")
            continue
        times["sr_compare_unit"].append(dt)
        recipe = json.loads((runs[-1] / "summary.json").read_text())["recipe"]
        compiled = json.loads((tdir / "task.json").read_text())["compiled"]
        t = time.monotonic()
        built = lc.compile(compiled, recipe, build)
        times["local_compile_unit"].append(time.monotonic() - t)
        t = time.monotonic()
        lc.bind(tdir, built)
        times["local_bind_unit"].append(time.monotonic() - t)
        symbols = (tdir / "symbols.json").read_bytes()
        task = json.loads((tdir / "task.json").read_text())
        recipe_bytes = (wt / recipe).read_bytes()
        obj = built.object_path.read_bytes()
        fns = [(int(f["rva"], 16), f["size"], f["symbol"]) for f in task["functions"]]
        # the very object sr compare judged: there the reports must be equal in every field
        their_dir = next((p.parent for p in sorted(tdir.rglob("build-record.json")) if (p.parent / "candidate.obj").is_file()), None)
        theirs_built = None
        if their_dir is not None:
            theirs_built = type(built)(their_dir / "candidate.obj", json.loads((their_dir / "build-record.json").read_text()), built.source_revision, built.recipe_sha256)
        for rva, size, sym in fns:
            theirs = json.loads((runs[-1] / f"0x{rva:x}" / "report.json").read_text())
            t = time.monotonic()
            ours = lc.compare(lc.task(task["task_id"], rva, size, sym, compiled, built), recipe_bytes, built, symbols, obj)
            times["local_compare_fn"].append(time.monotonic() - t)
            out["functions"] += 1
            a, b = _comparable(theirs), _comparable(ours)
            paths = differing_paths(a, b)
            out["equal"] += paths in ([], [OBJECT_IDENTITY])
            for k in paths:
                out["differences"][k] = out["differences"].get(k, 0) + 1
            if theirs_built is not None:
                out["their_object_seen"] += 1
                same = lc.compare(lc.task(task["task_id"], rva, size, sym, compiled, theirs_built), recipe_bytes, theirs_built, symbols)
                out["equal_on_their_object"] += _comparable(same) == a
            out["verdicts"] = out.get("verdicts", {})
            out["verdicts"][f"{theirs['result']}/{ours['result']}"] = out["verdicts"].get(f"{theirs['result']}/{ours['result']}", 0) + 1
            out["pass_both"] += theirs["result"] == "pass" and ours["result"] == "pass"
        # Negatives: a function of the unit against its neighbour's range, by the comparator's command line and in process.
        for (_r, _s, sym), (rva2, size2, _s2) in list(zip(fns, fns[1:]))[:2]:
            vt = lc.task(task["task_id"], rva2, size2, sym, compiled, built)
            (build / "cross-task.json").write_text(json.dumps(vt))
            (build / "cross-record.json").write_text(json.dumps(built.record))
            (build / "cross-symbols.json").write_bytes(symbols)
            t = time.monotonic()
            subprocess.run([sys.executable, str(wt / "tools/compare_runtime.py"), "--task", str(build / "cross-task.json"), "--recipe", str(wt / recipe),
                            "--build-record", str(build / "cross-record.json"), "--object", str(built.object_path), "--image", str(image),
                            "--symbols", str(build / "cross-symbols.json"), "--report", str(build / "cross-report.json")],
                           capture_output=True, env=env, timeout=300)
            times["comparator_cli_fn"].append(time.monotonic() - t)
            theirs = json.loads((build / "cross-report.json").read_text())
            ours = lc.compare(vt, recipe_bytes, built, symbols, obj)
            out["cross_pairs"] += 1
            out["cross_equal"] += _comparable(theirs) == _comparable(ours)
            out["cross_rejected_both"] += theirs["result"] == "fail" and ours["result"] == "fail"
        out["units"] += 1
    out["seconds"] = {k: {"n": len(v), "median": round(statistics.median(v), 3), "max": round(max(v), 3)} for k, v in sorted(times.items())}
    shutil.rmtree(local, ignore_errors=True)
    shutil.rmtree(build, ignore_errors=True)
    return out
