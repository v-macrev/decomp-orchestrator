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
    ok = res["functions"] > 0 and res["equal"] == res["functions"] and res["cross_equal"] == res["cross_pairs"]
    return 0 if ok else 1
