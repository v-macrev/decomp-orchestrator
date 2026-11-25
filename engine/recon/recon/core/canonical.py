# SPDX-License-Identifier: AGPL-3.0-or-later
"""Canonical serialisation and content digests (docs/recon/ARCHITECTURE.md, determinism contract).

Equal values give equal bytes and an equal digest: keys sorted, no insignificant whitespace, UTF-8,
integers only (a float has no canonical text here, so it is refused rather than rounded).
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


def _check(value: Any, path: str) -> None:
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return
    if isinstance(value, float):
        raise TypeError(f"{path}: floats have no canonical form; use an integer or a string")
    if isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            _check(v, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise TypeError(f"{path}: object keys must be strings, got {type(k).__name__}")
            _check(v, f"{path}.{k}")
        return
    raise TypeError(f"{path}: {type(value).__name__} is not serialisable")


def canonical_bytes(value: Any) -> bytes:
    _check(value, "$")
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value: Any) -> str:
    """`sha256:<hex>` of the canonical bytes."""
    return "sha256:" + hashlib.sha256(canonical_bytes(value)).hexdigest()


def file_sha256(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()
