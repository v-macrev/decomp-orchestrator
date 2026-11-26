# SPDX-License-Identifier: AGPL-3.0-or-later
import copy

import pytest

from recon.protocol import ProtocolError, function_result, progress, result, validate_request

GOOD = {
    "protocol": 1, "requestId": "req-1", "command": "solve",
    "packet": {"functions": [{"rva": "0x1234", "size": 24, "name": "A::B"}], "unit": "A_1234", "allowedPaths": ["reconstruction/a/A_1234.cpp"]},
    "modelName": "recon-engine-0.1.0", "budgets": {"candidates": 10, "compiles": 5},
}


def bad(mutate):
    r = copy.deepcopy(GOOD)
    mutate(r)
    return r


def test_good_request_is_accepted():
    assert validate_request(copy.deepcopy(GOOD))["requestId"] == "req-1"


@pytest.mark.parametrize("mutate", [
    lambda r: r.update(extra=1),
    lambda r: r.update(protocol=2),
    lambda r: r.update(command="decompile"),
    lambda r: r["packet"]["functions"].clear(),
    lambda r: r["packet"]["functions"].extend([{"rva": "0x1", "size": 1}] * 4),
    lambda r: r["packet"]["functions"][0].update(rva="1234"),
    lambda r: r["packet"]["functions"][0].update(size=0),
    lambda r: r["packet"]["functions"][0].update(listing="mov eax, 1"),
    lambda r: r.update(budgets={"candidates": -1}),
    lambda r: r.update(budgets={"wall": 5}),
    lambda r: r.update(modelName="has space"),
    lambda r: r.update(options={"k": [1]}),
    lambda r: r.pop("packet"),
])
def test_bad_requests_are_refused(mutate):
    with pytest.raises(ProtocolError):
        validate_request(bad(mutate))


def test_doctor_needs_no_packet():
    assert validate_request({"protocol": 1, "requestId": "d", "command": "doctor"})["command"] == "doctor"


def test_progress_carries_a_stage_and_integers_only():
    assert progress("analyze", {"functions": 2})["counters"] == {"functions": 2}
    with pytest.raises(ProtocolError):
        progress("analyze", {"functions": 1.5})  # type: ignore[dict-item]
    with pytest.raises(ProtocolError):
        progress("mov eax, 1")
    with pytest.raises(ProtocolError):
        progress("analyze", {"48 89 5c 24": 1})


def test_function_result_has_no_free_text_field():
    f = function_result("0x10", "solved", "MATCHED", rule_trail=["r34.one-result-local@1"], origin_labels=["EXE_RTTI"])
    assert set(f) == {"rva", "status", "reasonCode", "counters", "ruleTrail", "originLabels", "evidenceSummary"}
    with pytest.raises(ProtocolError):
        function_result("0x10", "matched", "X1")  # a word of a later state
    with pytest.raises(ProtocolError):
        function_result("0x10", "solved", "mov eax, 1")
    with pytest.raises(ProtocolError):
        function_result("0x10", "solved", "OK_X", rule_trail=["mov eax, 1"])
    with pytest.raises(ProtocolError):
        function_result("0x10", "solved", "OK_X", evidence=[{"kind": "k", "evidence": "PROVEN", "count": 1, "bytes": "90"}])


def test_result_digest_form_is_checked():
    with pytest.raises(ProtocolError):
        result("r", "solve", "deadbeef")
    r = result("r", "solve", "sha256:" + "0" * 64)
    assert r["type"] == "result" and r["edits"] == [] and r["functions"] == []
