# SPDX-License-Identifier: AGPL-3.0-or-later
"""Versioned JSON Lines protocol between the orchestrator server and the engine (docs/recon/INTEGRATION_CONTRACT.md).

The server writes one request line to stdin; the engine writes any number of `progress` lines and then
exactly one `result` line to stdout and exits 0. Nothing else is ever written to stdout. The response
schema has no field that can carry bytes, listings, operands or addresses inside code: every string is
bounded and most are patterns, and an unknown field is an error.
"""
from __future__ import annotations

import re
from typing import Any

from recon import ENGINE_VERSION, PROTOCOL_VERSION, RULE_STORE_VERSION

COMMANDS = ("solve", "doctor", "analyze", "explain")
STATUSES = ("solved", "unsolved", "unsupported", "blocked")
EVIDENCE = ("PROVEN", "CONSTRAINED", "INFERRED", "AMBIGUOUS", "UNKNOWN")
BUDGET_KEYS = ("candidates", "compiles", "solverUnits", "irNodes", "expansions")
MAX_LINE_BYTES = 8 * 1024 * 1024

_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_RVA = re.compile(r"^0x[0-9a-f]{1,8}$")
_CODE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
_RULE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,62}@[0-9]{1,6}$")
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_STAGE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_COUNTER = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,47}$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class ProtocolError(ValueError):
    """A request or response that does not match the contract."""


def _fail(path: str, msg: str) -> None:
    raise ProtocolError(f"{path}: {msg}")


def _obj(v: Any, path: str, required: set[str], optional: set[str]) -> dict:
    if not isinstance(v, dict):
        _fail(path, "expected an object")
    unknown = set(v) - required - optional
    if unknown:
        _fail(path, f"unknown field(s): {', '.join(sorted(unknown))}")
    missing = required - set(v)
    if missing:
        _fail(path, f"missing field(s): {', '.join(sorted(missing))}")
    return v


def _str(v: Any, path: str, max_len: int, pattern: re.Pattern | None = None) -> str:
    if not isinstance(v, str) or not (1 <= len(v) <= max_len):
        _fail(path, f"expected a string of 1 to {max_len} characters")
    if pattern is not None and not pattern.match(v):
        _fail(path, "does not match the allowed form")
    return v


def _int(v: Any, path: str, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not (lo <= v <= hi):
        _fail(path, f"expected an integer from {lo} to {hi}")
    return v


def _list(v: Any, path: str, lo: int, hi: int) -> list:
    if not isinstance(v, list) or not (lo <= len(v) <= hi):
        _fail(path, f"expected a list of {lo} to {hi} items")
    return v


def validate_request(req: Any) -> dict:
    r = _obj(
        req, "request",
        {"protocol", "requestId", "command"},
        {"packet", "worktree", "taskDir", "packDirs", "carriedUnitState", "modelName", "budgets", "options", "dataDir", "checkout"},
    )
    if r["protocol"] != PROTOCOL_VERSION:
        _fail("request.protocol", f"this engine speaks protocol {PROTOCOL_VERSION}")
    _str(r["requestId"], "request.requestId", 64, _ID)
    if r["command"] not in COMMANDS:
        _fail("request.command", f"expected one of {', '.join(COMMANDS)}")
    for key in ("worktree", "taskDir", "dataDir", "checkout"):
        if key in r:
            _str(r[key], f"request.{key}", 1024)
    if "modelName" in r:
        _str(r["modelName"], "request.modelName", 64, _MODEL)
    if "packDirs" in r:
        for i, p in enumerate(_list(r["packDirs"], "request.packDirs", 0, 8)):
            _str(p, f"request.packDirs[{i}]", 1024)
    if "packet" in r:
        p = _obj(r["packet"], "request.packet", {"functions", "unit", "allowedPaths"}, set())
        _str(p["unit"], "request.packet.unit", 200)
        for i, f in enumerate(_list(p["functions"], "request.packet.functions", 1, 4)):
            f = _obj(f, f"request.packet.functions[{i}]", {"rva", "size"}, {"name"})
            _str(f["rva"], f"request.packet.functions[{i}].rva", 10, _RVA)
            _int(f["size"], f"request.packet.functions[{i}].size", 1, 1_000_000)
            if "name" in f:
                _str(f["name"], f"request.packet.functions[{i}].name", 300)
        for i, a in enumerate(_list(p["allowedPaths"], "request.packet.allowedPaths", 1, 8)):
            _str(a, f"request.packet.allowedPaths[{i}]", 260)
    if "carriedUnitState" in r:
        for i, c in enumerate(_list(r["carriedUnitState"], "request.carriedUnitState", 0, 8)):
            c = _obj(c, f"request.carriedUnitState[{i}]", {"path", "content"}, set())
            _str(c["path"], f"request.carriedUnitState[{i}].path", 260)
            if not isinstance(c["content"], str) or len(c["content"]) > 400_000:
                _fail(f"request.carriedUnitState[{i}].content", "expected a string of at most 400000 characters")
    if "budgets" in r:
        b = _obj(r["budgets"], "request.budgets", set(), set(BUDGET_KEYS))
        for k, v in b.items():
            _int(v, f"request.budgets.{k}", 0, 2**40)
    if "options" in r:
        o = r["options"]
        if not isinstance(o, dict) or len(o) > 32:
            _fail("request.options", "expected an object of at most 32 entries")
        for k, v in o.items():
            _str(k, "request.options key", 64, _ID)
            if not (isinstance(v, (bool, int)) or (isinstance(v, str) and len(v) <= 1024)):
                _fail(f"request.options.{k}", "expected a boolean, an integer or a short string")
    if r["command"] in ("solve", "analyze", "explain") and "packet" not in r:
        _fail("request.packet", f"required for {r['command']}")
    return r


def progress(stage: str, counters: dict[str, int] | None = None) -> dict:
    """A progress line: a stage name and integers, nothing from the target."""
    m = {"type": "progress", "protocol": PROTOCOL_VERSION, "stage": _str(stage, "progress.stage", 32, _STAGE), "counters": {}}
    for k, v in (counters or {}).items():
        m["counters"][_str(k, "progress.counters key", 48, _COUNTER)] = _int(v, f"progress.counters.{k}", 0, 2**53)
    return m


def function_result(rva: str, status: str, reason_code: str, *, counters: dict[str, int] | None = None,
                    rule_trail: list[str] | None = None, origin_labels: list[str] | None = None,
                    evidence: list[dict] | None = None) -> dict:
    f = {
        "rva": _str(rva, "function.rva", 10, _RVA),
        "status": status if status in STATUSES else _fail("function.status", f"expected one of {', '.join(STATUSES)}"),
        "reasonCode": _str(reason_code, "function.reasonCode", 64, _CODE),
        "counters": {},
        "ruleTrail": [_str(x, "function.ruleTrail", 64, _RULE) for x in (rule_trail or [])][:200],
        "originLabels": [_str(x, "function.originLabels", 200) for x in (origin_labels or [])][:64],
        "evidenceSummary": [],
    }
    for k, v in (counters or {}).items():
        f["counters"][_str(k, "function.counters key", 48, _COUNTER)] = _int(v, f"function.counters.{k}", 0, 2**53)
    for e in (evidence or [])[:64]:
        e = _obj(e, "function.evidenceSummary", {"kind", "evidence", "count"}, set())
        f["evidenceSummary"].append({
            "kind": _str(e["kind"], "evidenceSummary.kind", 48, _COUNTER),
            "evidence": e["evidence"] if e["evidence"] in EVIDENCE else _fail("evidenceSummary.evidence", f"expected one of {', '.join(EVIDENCE)}"),
            "count": _int(e["count"], "evidenceSummary.count", 0, 2**31),
        })
    return f


def result(request_id: str, command: str, input_digest: str, *, functions: list[dict] | None = None,
           edits: list[dict] | None = None, code_origin: str | None = None, adapted_bodies: str | None = None,
           report: dict | None = None) -> dict:
    """The one result line. `edits` holds only solved functions; `report` is the payload of the other commands."""
    if not _DIGEST.match(input_digest):
        _fail("result.inputDigest", "expected sha256:<64 hex>")
    m: dict[str, Any] = {
        "type": "result", "protocol": PROTOCOL_VERSION, "requestId": _str(request_id, "result.requestId", 64, _ID),
        "command": command, "inputDigest": input_digest, "engineVersion": ENGINE_VERSION, "ruleStoreVersion": RULE_STORE_VERSION,
        "functions": functions or [], "edits": edits or [],
    }
    if code_origin is not None:
        m["codeOrigin"] = _str(code_origin, "result.codeOrigin", 300)
    if adapted_bodies is not None:
        m["adaptedBodies"] = _str(adapted_bodies, "result.adaptedBodies", 300)
    if report is not None:
        m["report"] = report
    return m
