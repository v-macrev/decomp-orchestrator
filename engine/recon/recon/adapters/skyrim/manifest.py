# SPDX-License-Identifier: AGPL-3.0-or-later
"""What a result depends on, and what the denominator is (convergence plan, section 2 and defect D6).

* `heldout(rva)`: the fixed held-out split. A function whose `sha256("heldout-v1" || rva_le32)` falls in the lowest 5%
  of the hash space is held out: while rules are developed only its aggregate counts and codes may be seen.
* `coverage(...)`: the frozen denominator of one upstream revision, written privately under the engine's data directory:
  the image, the upstream revision, the inventory's file digests, the comparator's version, each recipe's compiler, and
  per function its extent, its source, its unit when known, and its populations.
* `inputs(...)`: the content-addressed inputs of one `solve` request: image, upstream revision, compiler and recipe, the
  include closure of the unit's header, the declaration knowledge, rule store, engine and lockfile, budgets, and the
  frontiers it resumes from. No timestamps, no temporary paths.
"""
from __future__ import annotations

import glob
import hashlib
import json
import re
import subprocess
from pathlib import Path

from recon import ENGINE_VERSION, RULE_STORE_VERSION
from recon.core.canonical import digest
from recon.core.knowledge import code_digest

HELDOUT_SALT = b"heldout-v1"
HELDOUT_PERCENT = 5
INCLUDE = re.compile(r'^\s*#\s*include\s*"([^"]+)"', re.M)


def heldout(rva: int, salt: bytes = HELDOUT_SALT) -> bool:
    h = int.from_bytes(hashlib.sha256(salt + (rva & 0xFFFF_FFFF).to_bytes(4, "little")).digest(), "big")
    return h * 100 < HELDOUT_PERCENT << 256


def sha(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def revision(worktree: str | Path) -> str:
    p = subprocess.run(["git", "-C", str(worktree), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=60)
    return p.stdout.strip() if p.returncode == 0 else "unknown"


def comparator_version(worktree: str | Path) -> str:
    m = re.search(r"^COMPARATOR_VERSION\s*=\s*['\"]([^'\"]+)", (Path(worktree) / "tools/compare_runtime.py").read_text(encoding="utf-8"), re.M)
    return m.group(1) if m else "unknown"


def lockfile_digest() -> str:
    p = Path(__file__).resolve().parents[3] / "requirements.lock"
    return sha(p) if p.is_file() else "none"


def include_closure(worktree: str | Path, rel: str, text: str | None = None, roots: tuple[str, ...] = ()) -> dict[str, str]:
    """Digest of every project file the header includes, directly or not, by path relative to the worktree. An include
    found nowhere is recorded as such; system headers (`<...>`) are the compiler's, whose digest is recorded apart."""
    wt = Path(worktree).resolve()
    out: dict[str, str] = {}
    work = [(rel, text)]
    while work:
        r, t = work.pop()
        if r in out:
            continue
        p = wt / r
        if t is None:
            if not p.is_file():
                out[r] = "missing"
                continue
            t = p.read_text(encoding="utf-8", errors="replace")
        out[r] = hashlib.sha256(t.encode("utf-8")).hexdigest()
        for name in INCLUDE.findall(t):
            for base in (p.parent, wt, *(wt / x for x in roots)):
                q = (base / name).resolve()
                if q.is_file() and wt in q.parents:
                    work.append((q.relative_to(wt).as_posix(), None))
                    break
            else:
                out.setdefault(f"unresolved:{name}", "missing")
    return dict(sorted(out.items()))


def frontier_key(build: str | None, recipe_digest: str, header_text: str, rva: int, name: str) -> str:
    """What a saved frontier of `solve` is filed under: it is resumed only with the same inputs, whatever the budget."""
    return digest({"engine": ENGINE_VERSION, "code": code_digest(), "rules": RULE_STORE_VERSION, "build": build, "recipe": recipe_digest,
                   "header": hashlib.sha256(header_text.encode("utf-8")).hexdigest(), "rva": rva, "name": name})[:32]


def inputs(worktree: Path, data: Path | None, header_rel: str, header_text: str, recipe_rel: str, req: dict) -> dict:
    """The input manifest of one `solve` request (D6)."""
    target = json.loads((worktree / "builds/target.json").read_text(encoding="utf-8"))
    recipe_bytes = (worktree / recipe_rel).read_bytes()
    recipe = json.loads(recipe_bytes)
    roots = tuple(f[2:] for f in recipe.get("flags", []) if f.startswith("/I") and len(f) > 2)
    recipe_digest = hashlib.sha256(recipe_bytes).hexdigest()
    resumed = {}
    for f in req["packet"]["functions"]:
        rva = int(f["rva"], 16)
        key = frontier_key(target.get("build_id"), recipe_digest, header_text, rva, f.get("name") or "")
        saved = data / "frontiers" / f"{key}.json" if data else None
        if saved is not None and saved.is_file():
            resumed[f["rva"]] = sha(saved)
    return {
        "engine": ENGINE_VERSION, "rules": RULE_STORE_VERSION, "lockfile": lockfile_digest(),
        "image": target.get("image_sha256"), "build": target.get("build_id"), "upstream": revision(worktree),
        "recipe": {"path": recipe_rel, "sha256": recipe_digest, "compiler": recipe.get("compiler", {}).get("binary_sha256")},
        "header": include_closure(worktree, header_rel, header_text, roots),
        "declarations": sha(worktree / "data/progress.json"),
        "budgets": req.get("budgets", {}), "options": req.get("options", {}),
        "packet": [[f["rva"], f.get("size"), f.get("name")] for f in req["packet"]["functions"]],
        "resumed": resumed,
    }


def coverage(worktree: str | Path, inv, startable: dict[int, dict] | None = None) -> dict:
    """The frozen denominator of the worktree's upstream revision. `startable`: what `sr next` (offline) offers, by RVA, with
    each one's unit, when it was asked."""
    wt = Path(worktree)
    target = json.loads((wt / "builds/target.json").read_text(encoding="utf-8"))
    recipes = {}
    for p in sorted(glob.glob(str(wt / "reconstruction/recipes/*.json"))):
        r = json.loads(Path(p).read_text(encoding="utf-8"))
        recipes[Path(p).name] = {"sha256": sha(p), "compiler": r.get("compiler", {}).get("binary_sha256")}
    files = {"data/progress.json": sha(wt / "data/progress.json")}
    for p in sorted(glob.glob(str(wt / "data/target-hashes/contributor-targets-part-*.json"))):
        files[Path(p).relative_to(wt).as_posix()] = sha(p)
    startable = startable or {}
    fns = []
    for t in inv.targets:
        s = startable.get(t.rva)
        fns.append({"rva": t.rva, "size": t.size, "extent": t.extent_source, "matched": t.matched, "heldout": heldout(t.rva),
                    "startable": s is not None, "unit": (s or {}).get("unit"), "unit_exists": (s or {}).get("unit_exists")})
    return {"schema": 1, "image": target.get("image_sha256"), "build": target.get("build_id"), "upstream": revision(wt),
            "comparator": comparator_version(wt), "inventory": files, "recipes": recipes, "engine": ENGINE_VERSION, "functions": fns,
            "recorded_unmatched": [{"rva": t.rva, "size": t.size, "heldout": heldout(t.rva)} for t in inv.recorded_unmatched],
            "recorded_not_offered": len(inv.recorded)}


def counts(m: dict) -> dict:
    """What may be said of a coverage manifest in public: counts and bytes by population, development and held-out apart."""
    fns = m["functions"]

    def tally(xs) -> dict:
        xs = list(xs)
        return {"functions": len(xs), "bytes": sum(x["size"] for x in xs)}
    primary = [f for f in fns if not f["matched"]]
    return {
        "upstream": m["upstream"][:12], "comparator": m["comparator"], "offered": tally(fns),
        "primary": tally(primary), "primary_development": tally(f for f in primary if not f["heldout"]),
        "primary_heldout": tally(f for f in primary if f["heldout"]),
        "recorded_unmatched": tally(m["recorded_unmatched"]), "recorded_not_offered": m["recorded_not_offered"],
        "startable": tally(f for f in primary if f["startable"]), "startable_existing_unit": tally(f for f in primary if f["startable"] and f["unit_exists"]),
    }


__all__ = ["HELDOUT_PERCENT", "HELDOUT_SALT", "counts", "coverage", "frontier_key", "heldout", "include_closure", "inputs", "revision"]
