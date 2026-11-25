# SPDX-License-Identifier: AGPL-3.0-or-later
import pytest

from recon.core.canonical import canonical_bytes, digest


def test_key_order_does_not_matter():
    assert canonical_bytes({"b": 1, "a": [2, {"d": 1, "c": 2}]}) == canonical_bytes({"a": [2, {"c": 2, "d": 1}], "b": 1})
    assert digest({"b": 1, "a": 2}) == digest({"a": 2, "b": 1})


def test_bytes_are_compact_and_utf8():
    assert canonical_bytes({"a": "é"}) == '{"a":"é"}'.encode("utf-8")


def test_different_values_differ():
    assert digest({"a": 1}) != digest({"a": 2})
    assert digest([1, 2]) != digest([2, 1])


@pytest.mark.parametrize("bad", [1.5, {"a": 0.1}, [object()], {1: "x"}])
def test_unrepresentable_values_are_refused(bad):
    with pytest.raises(TypeError):
        canonical_bytes(bad)


def test_digest_form():
    d = digest({})
    assert d.startswith("sha256:") and len(d) == 7 + 64
