# SPDX-License-Identifier: AGPL-3.0-or-later
"""Entry point: `python -m recon serve` speaks the JSON Lines protocol; `python -m recon doctor` prints the report.

Exit codes: 0 a result was written; 2 the request was malformed (the server's defect, never the packet's);
3 an internal error. A result line is the only thing the server accepts as success.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import TextIO

from recon import ENGINE_VERSION, PROTOCOL_VERSION, RULE_STORE_VERSION
from recon.core.canonical import digest
from recon.protocol import MAX_LINE_BYTES, ProtocolError, function_result, progress, result, validate_request


def _emit(out: TextIO, message: dict) -> None:
    out.write(json.dumps(message, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n")
    out.flush()


def handle(req: dict, out: TextIO) -> dict:
    """Answer one validated request; progress lines go to `out`, the result is returned."""
    command = req["command"]
    base = {"engine": ENGINE_VERSION, "protocol": PROTOCOL_VERSION, "rules": RULE_STORE_VERSION, "command": command}
    if command == "doctor":
        from recon.adapters.skyrim.environment import run_doctor

        _emit(out, progress("doctor"))
        report = run_doctor(req.get("worktree"), req.get("checkout"), req.get("dataDir"))
        return result(req["requestId"], command, digest(base), report=report)

    packet = req["packet"]
    inputs = None
    if command == "solve":
        from recon.adapters.skyrim import solve as S

        inputs = S.input_manifest(req)   # image, upstream, recipe, header closure, declarations, lockfile, frontiers (D6)
    input_digest = digest({**base, "packet": packet, "model": req.get("modelName", ""), "budgets": req.get("budgets", {}),
                           "options": req.get("options", {}), "carried": [[c["path"], digest(c["content"])] for c in req.get("carriedUnitState", [])],
                           "inputs": inputs})
    if command == "solve":

        _emit(out, progress("analyze", {"functions": len(packet["functions"])}))
        outcomes, header_rel, text = S.solve(req, lambda stage, counters: _emit(out, progress(stage, counters)))
        fns = []
        for f, o in zip(packet["functions"], outcomes):
            solved = o.status == "solved"
            fns.append(function_result(f["rva"], o.status, o.reason, counters=o.counters, rule_trail=o.trail,
                                       origin_labels=["members and class as the unit header declares them"] if solved else [],
                                       evidence=[{"kind": "comparator", "evidence": "PROVEN", "count": 1}] if solved else []))
        cpp_rel = next((p for p in packet["allowedPaths"] if p.endswith(".cpp")), packet["unit"])
        eds = S.edits(outcomes, header_rel, cpp_rel, text)
        if not eds:
            return result(req["requestId"], command, input_digest, functions=fns)
        return result(req["requestId"], command, input_digest, functions=fns, edits=eds, code_origin=S.CODE_ORIGIN, adapted_bodies=S.ADAPTED)
    return result(req["requestId"], command, input_digest, report={"implemented": False})


def serve(stdin: TextIO, stdout: TextIO, stderr: TextIO) -> int:
    line = stdin.readline(MAX_LINE_BYTES + 1)
    if not line or len(line) > MAX_LINE_BYTES:
        stderr.write("no request line, or it exceeds the size limit\n")
        return 2
    try:
        req = validate_request(json.loads(line))
    except (ValueError, ProtocolError) as e:
        stderr.write(f"bad request: {e}\n")
        return 2
    try:
        res = handle(req, stdout)
    except Exception as e:  # noqa: BLE001 - the server treats any non-zero exit as an infrastructure failure
        stderr.write(f"internal error: {type(e).__name__}: {e}\n")
        return 3
    _emit(stdout, res)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="recon")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sv = sub.add_parser("serve", help="answer one request (JSON Lines): from --request FILE, else one line on stdin")
    sv.add_argument("--request", help="a file holding the request line (the server's way, so stdin stays free for cancelling)")
    d = sub.add_parser("doctor", help="check the environment and print a JSON report")
    d.add_argument("--worktree")
    d.add_argument("--checkout")
    d.add_argument("--data-dir")
    def common(p, with_select=True):
        p.add_argument("--worktree", required=True, help="upstream worktree at the pinned base")
        p.add_argument("--checkout", required=True, help="the checkout holding the private contrib config")
        if with_select:
            p.add_argument("--unmatched", action="store_true")
            p.add_argument("--limit", type=int, default=0)

    i = sub.add_parser("inventory", help="counts over the offered targets (needs no image)")
    i.add_argument("--worktree", required=True)
    i.add_argument("--unmatched", action="store_true")
    s = sub.add_parser("survey", help="decode and classify every selected target; counts, and rows under --out (a .local directory)")
    common(s)
    s.add_argument("--out")
    c = sub.add_parser("crosscheck", help="compare the decoder with upstream's and capstone's")
    common(c)
    c.add_argument("--capstone-every", type=int, default=0)
    common(sub.add_parser("rtti", help="count RTTI locators and vtables"), with_select=False)
    a = sub.add_parser("analyze", help="counts-only facts of one target")
    common(a, with_select=False)
    a.add_argument("--address", required=True)
    m = sub.add_parser("measure-compare", help="in-process compare against sr compare on accepted units: equality and cost")
    common(m, with_select=False)
    m.add_argument("--out", required=True, help="private working directory under .local")
    m.add_argument("--units", type=int, default=5)
    k = sub.add_parser("coverage", help="lift and analyse every selected target: counts; the demand by instruction form goes under --out (a .local directory)")
    common(k)
    k.add_argument("--out")
    k.add_argument("--ir", action="store_true", help="also build, validate and normalise the IR and prove compiler-undo hypotheses")
    k.add_argument("--jobs", type=int, default=1)
    k.add_argument("--every", type=int, default=1, help="every n-th selected target only")
    v = sub.add_parser("validate-lift", help="run the execution-based differential tests of the lifter; --write records the coverage table")
    v.add_argument("--only", help="forms whose name starts with this")
    v.add_argument("--instances", type=int, default=24)
    v.add_argument("--states", type=int, default=16)
    v.add_argument("--write", action="store_true")
    h = sub.add_parser("reach", help="how far source generation reaches over the selected targets: counts, nothing compiled")
    common(h)
    h.add_argument("--jobs", type=int, default=1)
    h.add_argument("--every", type=int, default=1)
    r = sub.add_parser("reconstruct", help="reconstruct functions of a synthetic pack: source, states and counts under --out")
    r.add_argument("--pack", required=True, help="pack.json beside its image")
    r.add_argument("--worktree", required=True, help="upstream worktree at the pinned base: the comparator")
    r.add_argument("--recipe", required=True, help="the recipe file, which pins the compiler and its flags")
    r.add_argument("--checkout", help="the checkout whose toolchain to use")
    r.add_argument("--toolset", help="the toolset directory, when it is elsewhere")
    r.add_argument("--work", required=True, help="scratch directory of the compiler")
    r.add_argument("--out", required=True)
    r.add_argument("--function", action="append", default=[], help="RVA; every function of the pack when not given")
    r.add_argument("--budget", action="append", default=[], metavar="KIND=N", help="an operation budget of each function's search (candidates, compiles, solverUnits, irNodes, expansions)")
    r.add_argument("--frontiers", help="where a search that exhausts a budget saves its frontier, and resumes from it")
    f = sub.add_parser("measure-filter", help="D8: compile and compare every tree the execution check rejects; counts (exit 1: a false rejection)")
    f.add_argument("--pack", help="a synthetic pack; without it, a sample of the real target's unmatched functions")
    f.add_argument("--worktree", required=True, help="upstream worktree at the pinned base: the comparator")
    f.add_argument("--checkout", help="the checkout whose toolchain (and, for the real target, image) to use")
    f.add_argument("--toolset", help="the toolset directory, when it is elsewhere")
    f.add_argument("--recipe", help="the recipe file (synthetic), or its path in the worktree (real; the default recipe if not given)")
    f.add_argument("--work", required=True, help="scratch directory of the compiler")
    f.add_argument("--out", help="where filter-audit.json goes (a .local directory for the real target)")
    f.add_argument("--want", type=int, default=100, help="real target: stop after this many functions the generator made trees for (the check ran)")
    f.add_argument("--scan-limit", type=int, default=4000)
    f.add_argument("--max-bytes", type=int, default=1024)
    mn = sub.add_parser("manifest", help="the frozen denominator of the worktree's revision: a private file, counts on stdout")
    mn.add_argument("--worktree", required=True)
    mn.add_argument("--out", required=True, help="a .local directory")
    mn.add_argument("--next", help="the JSON of `sr next --offline` (startable functions and their units), when asked")
    cg = sub.add_parser("campaign", help="every function of a population gets a state and blockers: private records, counts on stdout")
    common(cg, with_select=False)
    cg.add_argument("--data", required=True, help="a .local directory for the records")
    cg.add_argument("--next", required=True, help="the JSON of `sr next --offline`")
    cg.add_argument("--solve-set", help="a JSON list of RVAs that also go to solve")
    cg.add_argument("--max-bytes", type=int, default=128)
    cg.add_argument("--jobs", type=int, default=1, help="at most this many workers; fewer while memory is short")
    cg.add_argument("--name", default="campaign")
    cg.add_argument("--levels", default="0-5", help="the budget levels to run, FIRST-LAST (each resumes from the one below)")
    cg.add_argument("--knowledge", help="the knowledge store (default: knowledge.db under --data)")
    cg.add_argument("--every", type=float, default=60.0, help="seconds between progress lines")
    cg.add_argument("--from", dest="earlier", help="records of an earlier campaign to select from (its -final.jsonl)")
    cg.add_argument("--blockers", default="", help="with --from: functions whose primary blocker is one of these codes or plan names")
    cg.add_argument("--families", default="", help="with --from: functions whose primary blocker is of one of these families")
    cg.add_argument("--states", default="", help="with --from: functions left in one of these states")
    cg.add_argument("--corpus", help="a JSON list of RVAs that are always run (a regression corpus)")
    cg.add_argument("--regression", action="store_true", help="with --from: also every function it matched; any it loses fails the run")
    pw = sub.add_parser("prewarm", help="the whole-program analysis, kept in the knowledge store: counts and times")
    common(pw, with_select=False)
    pw.add_argument("--knowledge", required=True, help="the knowledge store, under a .local directory")
    pw.add_argument("--jobs", type=int, default=1, help="at most this many workers; fewer while memory is short")
    pw.add_argument("--every", type=float, default=60.0)
    pw.add_argument("--phases", default="normal,signature", help="normal (normal forms and calls) and/or signature (callers, signatures)")
    pf = sub.add_parser("profile", help="what the whole-program analysis costs, cold, warm and incremental, on a store of its own: counts and times")
    common(pf, with_select=False)
    pf.add_argument("--out", required=True, help="a directory under .local for the profile's own store")
    pf.add_argument("--sample", type=int, default=64, help="functions spread evenly over the pack's (0: all)")
    pf.add_argument("--workloads", default="cold,warm,incremental")
    pf.add_argument("--against", help="a knowledge store the cold workload's facts are compared with (read-only)")
    pf.add_argument("--callers", action="store_true", help="index every function's callers too (reads every normal form)")
    ce = sub.add_parser("ceiling", help="the early ceiling estimate over a stratified sample of startable development functions: counts")
    common(ce, with_select=False)
    ce.add_argument("--next", required=True, help="the JSON of `sr next --offline`")
    ce.add_argument("--sample", type=int, default=200)
    args = ap.parse_args(argv)
    if args.cmd == "serve":
        if args.request:
            try:
                with open(args.request, encoding="utf-8") as f:
                    return serve(f, sys.stdout, sys.stderr)
            except OSError as e:
                sys.stderr.write(f"the request file cannot be read: {type(e).__name__}\n")
                return 2
        return serve(sys.stdin, sys.stdout, sys.stderr)
    if args.cmd in ("inventory", "survey", "crosscheck", "rtti", "analyze", "measure-compare", "validate-lift", "coverage", "reconstruct", "reach",
                    "measure-filter", "manifest", "campaign", "ceiling", "prewarm", "profile"):
        from recon.cli import commands

        return getattr(commands, "cmd_" + args.cmd.replace("-", "_"))(args)
    from recon.adapters.skyrim.environment import run_doctor

    report = run_doctor(args.worktree, args.checkout, args.data_dir)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
