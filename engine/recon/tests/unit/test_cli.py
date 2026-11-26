# SPDX-License-Identifier: AGPL-3.0-or-later
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REQ = {
    "protocol": 1, "requestId": "t1", "command": "solve",
    "packet": {"functions": [{"rva": "0x10", "size": 40}, {"rva": "0x80", "size": 8}], "unit": "U", "allowedPaths": ["reconstruction/u/U.cpp"]},
    "carriedUnitState": [{"path": "reconstruction/u/U.cpp", "content": "// x\n"}],
}


def run(request, *, raw=None):
    return subprocess.run(
        [sys.executable, "-s", "-B", "-m", "recon", "serve"],
        input=raw if raw is not None else json.dumps(request) + "\n",
        capture_output=True, text=True, cwd=ROOT, timeout=60,
        env={"PYTHONPATH": str(ROOT), "PYTHONHASHSEED": "0", "PATH": "/usr/bin:/bin"},
    )


def lines(p):
    return [json.loads(x) for x in p.stdout.splitlines()]


def test_solve_round_trip_is_one_result_after_progress():
    p = run(REQ)
    assert p.returncode == 0, p.stderr
    msgs = lines(p)
    assert [m["type"] for m in msgs] == ["progress", "result"]
    res = msgs[-1]
    assert res["requestId"] == "t1" and res["command"] == "solve" and res["edits"] == []
    assert [(f["rva"], f["status"], f["reasonCode"]) for f in res["functions"]] == [
        ("0x10", "blocked", "NO_WORKTREE"), ("0x80", "blocked", "NO_WORKTREE")]
    assert res["inputDigest"].startswith("sha256:")


def test_same_request_gives_identical_bytes():
    assert run(REQ).stdout == run(REQ).stdout


def test_a_different_carried_unit_changes_the_input_digest():
    other = json.loads(json.dumps(REQ))
    other["carriedUnitState"][0]["content"] = "// y\n"
    assert lines(run(REQ))[-1]["inputDigest"] != lines(run(other))[-1]["inputDigest"]


def test_request_id_does_not_change_the_input_digest():
    other = {**REQ, "requestId": "t2"}
    assert lines(run(REQ))[-1]["inputDigest"] == lines(run(other))[-1]["inputDigest"]


def test_malformed_requests_exit_2_and_write_no_result():
    for raw in ["", "not json\n", json.dumps({**REQ, "surprise": 1}) + "\n", json.dumps({**REQ, "protocol": 9}) + "\n"]:
        p = run(None, raw=raw)
        assert p.returncode == 2 and p.stdout == ""


def test_doctor_runs_without_a_checkout():
    p = run({"protocol": 1, "requestId": "d1", "command": "doctor"})
    assert p.returncode == 0, p.stderr
    res = lines(p)[-1]
    checks = {c["id"]: c for c in res["report"]["checks"]}
    assert {"python", "machine", "upstream.worktree"} <= set(checks)
    assert checks["upstream.worktree"]["status"] == "missing"


def test_the_request_can_come_from_a_file(tmp_path):
    f = tmp_path / "request.json"
    f.write_text(json.dumps(REQ) + "\n", encoding="utf-8")
    p = subprocess.run([sys.executable, "-s", "-B", "-m", "recon", "serve", "--request", str(f)], capture_output=True, text=True, cwd=ROOT, timeout=60,
                       stdin=subprocess.DEVNULL, env={"PYTHONPATH": str(ROOT), "PYTHONHASHSEED": "0", "PATH": "/usr/bin:/bin"})
    assert p.returncode == 0, p.stderr
    assert p.stdout == run(REQ).stdout
    missing = subprocess.run([sys.executable, "-s", "-B", "-m", "recon", "serve", "--request", str(tmp_path / "none.json")], capture_output=True, text=True,
                             cwd=ROOT, timeout=60, stdin=subprocess.DEVNULL, env={"PYTHONPATH": str(ROOT), "PATH": "/usr/bin:/bin"})
    assert missing.returncode == 2 and missing.stdout == ""
