# SPDX-License-Identifier: AGPL-3.0-or-later
"""Import direction (docs/recon/ARCHITECTURE.md): skyrim -> x64_msvc -> core; core imports neither.
Also: the engine is offline and uses no AI client (docs/DETERMINISTIC_WORKER_PROMPT.md, section 3)."""
import ast
from pathlib import Path

PKG = Path(__file__).resolve().parents[2] / "recon"
FORBIDDEN_ROOTS = {"anthropic", "openai", "requests", "httpx", "aiohttp", "urllib3", "socket", "http", "ftplib", "smtplib", "websockets"}


def imports(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            yield node.module


def files(sub: str):
    return sorted((PKG / sub).rglob("*.py")) if (PKG / sub).is_dir() else []


def test_core_imports_no_adapter():
    for f in files("core"):
        for m in imports(f):
            assert not m.startswith("recon.adapters"), f"{f.name} imports {m}"


def test_x64_msvc_does_not_import_skyrim():
    for f in files("adapters/x64_msvc"):
        for m in imports(f):
            assert not m.startswith("recon.adapters.skyrim"), f"{f.name} imports {m}"


def test_no_network_or_ai_client_anywhere():
    for f in sorted(PKG.rglob("*.py")):
        for m in imports(f):
            assert m.split(".")[0] not in FORBIDDEN_ROOTS, f"{f.relative_to(PKG)} imports {m}"


def test_every_file_has_an_spdx_line():
    for f in sorted(PKG.rglob("*.py")):
        head = "\n".join(f.read_text(encoding="utf-8").split("\n")[:3])
        assert "SPDX-License-Identifier: AGPL-3.0-or-later" in head, f


def test_core_names_no_register_flag_or_compiler():
    import re

    forbidden = re.compile(r"\b(rax|rbx|rcx|rdx|rsi|rdi|rsp|rbp|eax|ebx|ecx|edx|xmm\d+|msvc|/O2|/EHsc)\b", re.IGNORECASE)
    for f in files("core"):
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            assert not forbidden.search(line), f"{f.name}:{n}: {line.strip()}"
