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
    input_digest = digest({**base, "packet": packet, "model": req.get("modelName", ""), "budgets": req.get("budgets", {}),
                           "options": req.get("options", {}), "carried": [[c["path"], digest(c["content"])] for c in req.get("carriedUnitState", [])]})
    if command == "solve":
        _emit(out, progress("analyze", {"functions": len(packet["functions"])}))
        # Phase 1 has no reconstruction yet: say so per function, produce no edits (docs/recon/IMPLEMENTATION_ROADMAP.md).
        fns = [function_result(f["rva"], "unsupported", "ENGINE_NOT_IMPLEMENTED", counters={"candidates": 0, "compiles": 0}) for f in packet["functions"]]
        return result(req["requestId"], command, input_digest, functions=fns)
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
    sub.add_parser("serve", help="answer one request on stdin (JSON Lines)")
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
    v = sub.add_parser("validate-lift", help="run the execution-based differential tests of the lifter; --write records the coverage table")
    v.add_argument("--only", help="forms whose name starts with this")
    v.add_argument("--instances", type=int, default=24)
    v.add_argument("--states", type=int, default=16)
    v.add_argument("--write", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "serve":
        return serve(sys.stdin, sys.stdout, sys.stderr)
    if args.cmd in ("inventory", "survey", "crosscheck", "rtti", "analyze", "measure-compare", "validate-lift", "coverage"):
        from recon.cli import commands

        return getattr(commands, "cmd_" + args.cmd.replace("-", "_"))(args)
    from recon.adapters.skyrim.environment import run_doctor

    report = run_doctor(args.worktree, args.checkout, args.data_dir)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
