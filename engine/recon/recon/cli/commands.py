# SPDX-License-Identifier: AGPL-3.0-or-later
"""Developer commands over the pinned image. Every command prints counts only; a command that writes a report
writes it under a private `.local` directory and refuses any other place (specification sections 18, 26).
"""
from __future__ import annotations

import bisect
import json
import sys
import time
from collections import Counter
from pathlib import Path

from recon.adapters.skyrim.image import PinnedImage, locate_image
from recon.adapters.skyrim.inventory import load_inventory, size_bucket


def _private_dir(out: str) -> Path:
    p = Path(out)
    if ".local" not in p.parts:
        raise SystemExit("refusing to write: the output directory must be under a .local directory (game-derived data stays private)")
    p.mkdir(parents=True, exist_ok=True)
    return p


def _image(args) -> PinnedImage:
    return PinnedImage(locate_image(args.checkout), args.worktree)


def _select(args, inv):
    ts = inv.unmatched() if args.unmatched else list(inv.targets)
    if args.limit:
        ts = ts[: args.limit]
    return ts


def cmd_inventory(args) -> int:
    inv = load_inventory(args.worktree)
    ts = inv.unmatched() if args.unmatched else list(inv.targets)
    with_entry = sum(1 for t in ts if t.progress_status is not None)
    buckets = Counter(size_bucket(t.size) for t in ts)
    print(json.dumps({
        "build_id": inv.build_id, "targets": len(inv.targets), "selected": len(ts), "selected_bytes": sum(t.size for t in ts),
        "selected_with_progress_entry": with_entry, "selected_without_progress_entry": len(ts) - with_entry,
        "progress_entries": inv.progress_entries, "progress_matched": inv.progress_matched,
        "recorded_unmatched_not_offered": len(inv.recorded_unmatched),
        "by_size_bucket": dict(sorted(buckets.items(), key=lambda kv: (len(kv[0]), kv[0]))),
    }, indent=2, sort_keys=True))
    return 0


def cmd_survey(args) -> int:
    from recon.adapters.skyrim import survey as sv

    inv = load_inventory(args.worktree)
    img = _image(args)
    ts = _select(args, inv)
    t0 = time.monotonic()
    report, rows = sv.survey(img, ts, progress=lambda n: print(f"  {n}/{len(ts)}", file=sys.stderr))
    report["seconds"] = round(time.monotonic() - t0, 1)
    report["image_sha256_checked"] = True
    report["upstream_digests"] = {k: v[:16] for k, v in img.up.digests.items()}
    if args.out:
        d = _private_dir(args.out)
        (d / "survey.json").write_text(json.dumps(report, indent=1, sort_keys=True))
        with open(d / "survey-rows.jsonl", "w") as f:
            for r in rows:
                f.write(json.dumps(r.__dict__, sort_keys=True) + "\n")
    summary = {k: v for k, v in report.items() if k != "mnemonic_functions"}
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def cmd_crosscheck(args) -> int:
    from recon.adapters.skyrim import crosscheck as cc

    inv = load_inventory(args.worktree)
    img = _image(args)
    ts = _select(args, inv)
    res = cc.run(img, ts, capstone_every=args.capstone_every)
    print(json.dumps(res, indent=2, sort_keys=True))
    return 0


def cmd_rtti(args) -> int:
    from recon.adapters.x64_msvc import rtti

    img = _image(args)
    t0 = time.monotonic()
    vts = rtti.find_vtables(img.segments, img.image_base)
    named = sum(1 for v in vts if rtti.type_name(img.read_cstr, v.type_descriptor))
    inv = load_inventory(args.worktree)
    starts = {b for b, _e, _u in img.runtime_functions()} | inv.known_starts
    slots = [s for v in vts for s in v.slots]
    unknown = sorted(set(slots) - starts)
    # an unknown slot target inside a known function would mean the scan ran past a vtable's end (or a wrong boundary)
    extents = sorted([(b, e) for b, e, _u in img.runtime_functions()] + [(t.rva, t.rva + t.size) for t in inv.targets + inv.recorded_unmatched])
    begins = [b for b, _e in extents]
    inside = sum(1 for s in unknown if (k := bisect.bisect_right(begins, s) - 1) >= 0 and extents[k][0] < s < extents[k][1])
    print(json.dumps({"vtables": len(vts), "with_class_name": named, "slots": len(slots), "slots_at_known_function_start": sum(1 for s in slots if s in starts), "distinct_slot_targets": len(set(slots)),
                      "distinct_targets_at_known_function_start": len(set(slots) & starts), "distinct_targets_unknown": len(unknown), "unknown_inside_a_known_function": inside,
                      "secondary_base_vtables": sum(1 for v in vts if v.offset), "seconds": round(time.monotonic() - t0, 1)}, indent=2, sort_keys=True))
    return 0


def cmd_analyze(args) -> int:
    from recon.adapters.skyrim import survey as sv

    inv = load_inventory(args.worktree)
    rva = int(args.address, 16)
    t = inv.by_rva().get(rva)
    if t is None:
        print(json.dumps({"error": "not an offered target of the inventory"}))
        return 2
    f = sv.analyse_function(_image(args), t.rva, t.size)
    d = dict(f.__dict__)
    d["mnemonics"] = len(f.mnemonics)  # counts only: the distinct forms, not their names
    print(json.dumps(d, indent=2, sort_keys=True))
    return 0


def cmd_measure_compare(args) -> int:
    from recon.adapters.skyrim import measure as ms

    base = _private_dir(args.out)
    res = ms.measure(args.worktree, args.checkout, locate_image(args.checkout), base, args.units)
    print(json.dumps(res, indent=2, sort_keys=True))
    ok = res["functions"] > 0 and res["equal"] == res["functions"] and res["equal_on_their_object"] == res["their_object_seen"] and res["cross_equal"] == res["cross_pairs"]
    return 0 if ok else 1


def cmd_validate_lift(args) -> int:
    import datetime

    from recon.adapters.x64_msvc import validate as v

    if args.write and args.only:
        raise SystemExit("--write needs every form: run it without --only")
    t0 = time.monotonic()
    r = v.run_all(args.instances, args.states, args.only)
    out = {"passed": len(r["passed"]), "vectors": sum(x["vectors"] for x in r["passed"].values()), "failed": r["failed"], "traps_confirmed": r["traps_confirmed"],
           "traps_unplaced": r["traps_unplaced"], "refused": dict(sorted(Counter(r["refused"].values()).items())), "seconds": round(time.monotonic() - t0, 1)}
    print(json.dumps(out, indent=2, sort_keys=True))
    if args.write and not r["failed"]:
        v.write_table(r, datetime.date.today().isoformat())
    return 1 if r["failed"] else 0


def cmd_coverage(args) -> int:
    from recon.adapters.skyrim import coverage as cv
    from recon.adapters.x64_msvc import validate as v

    validated = v.load_validated()
    if not validated:
        raise SystemExit("no usable lift_coverage.json: it is absent or was made by other sources; run validate-lift --write")
    inv = load_inventory(args.worktree)
    img = _image(args)
    ts = _select(args, inv)
    t0 = time.monotonic()
    ts = ts[:: args.every]
    rows = cv.run(img, ts, validated, progress=lambda n: print(f"  {n}/{len(ts)}", file=sys.stderr), ir=args.ir, jobs=args.jobs)
    report = cv.aggregate(rows)
    report["validated_forms"] = len(validated)
    report["seconds"] = round(time.monotonic() - t0, 1)
    if args.out:
        d = _private_dir(args.out)
        (d / "lift-demand.json").write_text(json.dumps(cv.demand(rows), indent=1, sort_keys=False), encoding="utf-8")
        with open(d / "coverage-rows.jsonl", "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r.__dict__, sort_keys=True) + "\n")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


def cmd_reconstruct(args) -> int:
    """Exit codes: 0 every function asked for is BYTE_MATCHED; 1 not every one is; 2 an input cannot be used; 3 an engine error."""
    from recon import ENGINE_VERSION
    from recon.adapters.skyrim import pack as pk
    from recon.adapters.skyrim.verify import Verifier
    from recon.adapters.x64_msvc import cl
    from recon.adapters.x64_msvc import validate as v
    from recon import RULE_STORE_VERSION
    from recon.core import budget as bg
    from recon.core.canonical import digest
    from recon.core.synthesis.search import BUDGET_EXHAUSTED, BYTE_MATCHED, Frontier

    try:
        limits = {}
        for x in args.budget:
            kind, _eq, n = x.partition("=")
            if kind not in bg.KINDS or not n.isdigit():
                raise ValueError(f"a budget is KIND=N with KIND one of {', '.join(bg.KINDS)}")
            limits[kind] = int(n)
        recipe = Path(args.recipe).read_bytes()
        rec = json.loads(recipe)
        validated = v.load_validated()
        if not validated:
            raise ValueError("no usable lift_coverage.json: run validate-lift --write")
        pack = pk.Pack.load(args.pack, args.worktree, validated)
        pinned = json.loads((Path(args.worktree) / "builds/target.json").read_text(encoding="utf-8"))["image_sha256"]
        if pack.image.sha256 == pinned:
            raise ValueError("this command is for synthetic images; its output is not private")
        tool = cl.discover(args.checkout, rec["compiler"]["binary_sha256"], args.toolset)
        wanted = sorted(int(x, 0) for x in args.function) or sorted(pack.size)
        if any(r not in pack.size for r in wanted):
            raise ValueError("not a function of the pack")
    except (OSError, ValueError, KeyError, cl.ToolchainUnavailable) as e:
        print(f"cannot use the input: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    verifier = Verifier(Path(args.worktree), pack.build_id, pack.image.pe.blob, recipe)
    frontiers = Path(args.frontiers) if args.frontiers else None
    rows = []
    broken = 0
    for rva in wanted:
        row: dict = {"rva": f"0x{rva:x}", "size": pack.size[rva]}
        rows.append(row)
        # what a frontier may be resumed by: the same engine, rules, image, recipe and function, whatever the budget
        key = digest({"engine": ENGINE_VERSION, "rules": RULE_STORE_VERSION, "image": pack.image.sha256, "recipe": digest(rec), "rva": rva})[:32]
        saved = frontiers / f"{key}.json" if frontiers else None
        try:
            past = Frontier.from_json(json.loads(saved.read_text(encoding="utf-8"))) if saved and saved.is_file() else None
            r, shop = pk.reconstruct(pack, rva, tool, rec["flags"], verifier, Path(args.work), bg.Budget.of(limits), past)
        except Exception as e:  # noqa: BLE001 - a defect of the engine, which must not lose the other functions
            broken += 1
            row.update(state="NONE", reason="ENGINE_ERROR", detail=type(e).__name__)
            continue
        row.update(state=r.state, reason=r.reason, counters=r.counters, refused=r.refused, disagreed=r.disagreed, errors=r.errors, nearest=r.nearest,
                   evidence=[list(e) for e in r.evidence])
        if past is not None:
            row["resumed"] = key
        if r.reason == BUDGET_EXHAUSTED:
            row["exhausted"] = r.exhausted
            if saved is not None and r.frontier is not None:
                saved.parent.mkdir(parents=True, exist_ok=True)
                saved.write_text(json.dumps(r.frontier.to_json(), sort_keys=True), encoding="utf-8", newline="\n")
                row["frontier"] = key
        if r.candidate is not None:
            c = r.candidate
            name = f"{c.unit.name}.cpp"
            (out / name).write_bytes(c.unit.text.encode("ascii"))
            row.update(source=name, tree=c.digest, changes=list(c.choice.changes()), assumptions=list(c.assumptions), function_assumptions=list(c.function_assumptions),
                       rules=sorted(set(c.history)),
                       execution={"runs": c.verdict.runs, "complete": c.verdict.complete, "signed_wraps": c.verdict.signed_wraps})
    states = Counter(r["state"] for r in rows)
    report = {"engine": ENGINE_VERSION, "build_id": pack.build_id, "functions": rows, "states": dict(sorted(states.items()))}
    report["digest"] = digest(report)
    (out / "result.json").write_text(json.dumps(report, indent=1, sort_keys=True), encoding="utf-8", newline="\n")
    print(json.dumps({"states": report["states"], "functions": len(rows), "engine_errors": broken, "digest": report["digest"]}, sort_keys=True))
    return 3 if broken else 0 if states == Counter({BYTE_MATCHED: len(rows)}) else 1


def cmd_measure_filter(args) -> int:
    """D8: the execution check's false rejections, over a synthetic pack or a sample of the real target (counts only)."""
    from recon import ENGINE_VERSION
    from recon.adapters.skyrim import filter_audit as fa
    from recon.adapters.skyrim.pack import Pack
    from recon.adapters.skyrim.verify import Verifier
    from recon.adapters.x64_msvc import cl
    from recon.adapters.x64_msvc import validate as v
    from recon.adapters.x64_msvc.batch import Compiler

    try:
        validated = v.load_validated()
        if not validated:
            raise ValueError("no usable lift_coverage.json: run validate-lift --write")
        if args.pack:
            recipe = Path(args.recipe).read_bytes()
            pack = Pack.load(args.pack, args.worktree, validated)
            population = sorted(pack.size)
        else:
            from recon.adapters.skyrim.image import PinnedImage, locate_image
            from recon.adapters.skyrim.inventory import load_inventory
            from recon.adapters.skyrim.solve import DEFAULT_RECIPE

            if not args.out or ".local" not in Path(args.out).resolve().parts:
                raise ValueError("a measurement of the real target writes under a .local directory (--out)")
            recipe = (Path(args.worktree) / (args.recipe or DEFAULT_RECIPE)).read_bytes()
            image = PinnedImage(locate_image(args.checkout), args.worktree)
            inv = load_inventory(args.worktree)
            pack = Pack("pinned", image, {t.rva: t.size for t in inv.targets}, validated)
            population = [t.rva for t in inv.unmatched() if t.size <= args.max_bytes]
        rec = json.loads(recipe)
        tool = cl.discover(args.checkout, rec["compiler"]["binary_sha256"], args.toolset)
    except (OSError, ValueError, KeyError, cl.ToolchainUnavailable) as e:
        print(f"cannot use the input: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    flags = [f for f in rec["flags"] if f != "/c"]
    compiler = Compiler(tool, flags, Path(args.work))
    verifier = Verifier(Path(args.worktree), pack.build_id or "pinned", pack.image.pe.blob, recipe)
    a = fa.Audit()
    scanned = 0
    for rva in fa.sample(population, 0 if args.pack else len(population)):
        if args.want and a.with_trees >= args.want or args.scan_limit and scanned >= args.scan_limit:
            break
        scanned += 1
        fa.audit_function(pack, rva, compiler, verifier, a)
    report = {"engine": ENGINE_VERSION, "population": len(population), "scanned": scanned, **a.to_json()}
    if args.out:
        Path(args.out).mkdir(parents=True, exist_ok=True)
        (Path(args.out) / "filter-audit.json").write_text(json.dumps(report, indent=1, sort_keys=True), encoding="utf-8")
    print(json.dumps(report, sort_keys=True))
    return 0 if a.false_rejections == 0 else 1


def cmd_reach(args) -> int:
    from recon.adapters.skyrim import reach as rc
    from recon.adapters.skyrim.pack import Pack
    from recon.adapters.x64_msvc import validate as v

    validated = v.load_validated()
    if not validated:
        raise SystemExit("no usable lift_coverage.json: run validate-lift --write")
    inv = load_inventory(args.worktree)
    img = _image(args)
    pack = Pack("pinned", img, {t.rva: t.size for t in inv.targets}, validated)
    ts = _select(args, inv)[:: args.every]
    t0 = time.monotonic()
    rows = rc.run(pack, ts, progress=lambda n: print(f"  {n}/{len(ts)}", file=sys.stderr), jobs=args.jobs)
    report = rc.report(rows)
    report["seconds"] = round(time.monotonic() - t0, 1)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0
