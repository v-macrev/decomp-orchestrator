# SPDX-License-Identifier: AGPL-3.0-or-later
"""Not a pytest file: run real functions from random states, as lifted instructions and as IR before and after normalisation, and
count agreements. Prints counts only.

    python tests/image_check.py --worktree W --checkout C [--every N] [--states K]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]

import irlab as L  # noqa: E402

from recon.adapters.skyrim import survey as sv  # noqa: E402
from recon.adapters.x64_msvc import eh  # noqa: E402
from recon.adapters.x64_msvc import program as pg  # noqa: E402
from recon.adapters.x64_msvc import unwind as uw  # noqa: E402
from recon.adapters.x64_msvc import validate as v  # noqa: E402
from recon.adapters.x64_msvc.abi import CALLING  # noqa: E402
from recon.cli import commands as cm  # noqa: E402
from recon.core.ir import passes as ps  # noqa: E402
from recon.core.ir.interp import ClaimBroken  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worktree", required=True)
    ap.add_argument("--checkout", required=True)
    ap.add_argument("--every", type=int, default=100)
    ap.add_argument("--states", type=int, default=4)
    args = ap.parse_args()
    img = cm._image(args)
    L.BASE = img.image_base  # the harness runs the function where it lies
    pdata = img.runtime_functions()
    starts = [p[0] for p in pdata]
    ok = v.load_validated()
    c: Counter = Counter()
    for t in sorted(cm.load_inventory(args.worktree).by_rva().values(), key=lambda t: t.rva)[:: args.every]:
        entries = [(b, e, uw.read_unwind(img.read, u)) for b, e, u in sv._pdata_overlapping(pdata, starts, t.rva, t.rva + t.size)]
        if sv.analyse_function(img, t.rva, t.size, _pdata=pdata, _starts=starts).status != sv.DECODED:
            continue
        r = pg.analyse(img.read(t.rva, t.size), t.rva, img.image_base, ok, entries)
        fn = pg.to_ir(r, img.image_base, entries, img.read) if isinstance(r, pg.Analysis) else r
        if isinstance(fn, pg.Refusal):
            c["functions not represented"] += 1
            continue
        c["functions"] += 1
        out = ps.normalise(fn, CALLING)
        L.HIDDEN[:] = [(x.lo, x.hi) for x in fn.regions if x.keeps]
        if any(o.kind == "unwind-help" for o in fn.observations):
            h = eh.unwinding(img.read, entries, t.rva, []).help
            L.HIDDEN.append((h, h + 8))
        for s in range(args.states):
            want = L.run_lifted(r, s)
            c["end: " + (want[0][0] if isinstance(want[0], tuple) else "out of steps")] += 1
            for name, f in (("raw", fn), ("normal", out)):
                try:
                    c[f"{name}: " + ("agree" if L.agree(L.run_ir(f, s), want) else "DIFFER")] += 1
                except ClaimBroken:
                    c[f"{name}: claim broken"] += 1
    print(json.dumps(dict(sorted(c.items())), indent=1))
    return int(any("DIFFER" in k for k in c))


if __name__ == "__main__":
    raise SystemExit(main())
