# SPDX-License-Identifier: AGPL-3.0-or-later
"""The compiler as a process: where it is, how it is called, what it says.

Two hosts can run the same binary: Windows itself, or the wrapper scripts the checkout installs for Linux. The binary's
digest is what a recipe pins, so it is checked before the first compile. Nothing is linked to judge a candidate.
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

#: where the checkout keeps the toolchain, and the toolset's directory inside it
CONTRIB = ".local/contrib/msvc"
TOOLSETS = "VC/Tools/MSVC"
MAX_OUTPUT = 1 << 20


class ToolchainUnavailable(RuntimeError):
    pass


class CompilerFailed(RuntimeError):
    """The process did not do its work for a reason that is not the source's (it could not start, or it ran too long)."""


@dataclass(frozen=True)
class Diagnostic:
    code: str                    # C2065, or D8021 and the like
    file: str                    # base name, "" when it names none
    line: int
    text: str


_LINE = re.compile(r"^(?:(?P<file>[^()\r\n]+)\((?P<line>\d+)\)\s*:\s*)?(?:fatal )?(?:error|Command line error) (?P<code>[A-Z]+\d+)\s*:\s*(?P<text>.*)$")


def diagnostics(output: str, limit: int = 100) -> list[Diagnostic]:
    """The errors a compile printed, in order, at most `limit`."""
    out = []
    for raw in output.splitlines():
        m = _LINE.match(re.sub(r"^cl : ", "", raw.strip()))
        if m and len(out) < limit:
            out.append(Diagnostic(m["code"], re.split(r"[\\/]", m["file"])[-1] if m["file"] else "", int(m["line"] or 0), m["text"][:300]))
    return out


@dataclass(frozen=True)
class Toolchain:
    root: Path                   # the toolset directory, with bin/ inside
    wrappers: Path | None        # directory of the wrapper scripts; None: the binaries run directly

    def binary(self, name: str) -> Path:
        return self.root / "bin/Hostx64/x64" / f"{name}.exe"

    def digest(self) -> str:
        return hashlib.sha256(self.binary("cl").read_bytes()).hexdigest()

    def include_dirs(self) -> list[Path]:
        """The toolset's headers, then the SDK's, in the order the checkout's wrappers give them."""
        out = [self.root / "include"]
        base = self.root.parents[3]            # <base>/VC/Tools/MSVC/<version>
        for kits in (base / "Windows Kits/10/Include", base / "kits/10/include", base.parent / "kits/10/include"):
            if kits.is_dir():
                for sdk in sorted(kits.iterdir())[-1:]:
                    out += [sdk / d for d in ("shared", "ucrt", "um", "winrt")]
                break
        return out

    def run(self, name: str, args: list[str], cwd: Path, timeout: float = 120.0) -> tuple[int, str]:
        """Exit code and output. The compiler sees the working directory and nothing of this machine's own settings."""
        exe = str(self.binary(name) if self.wrappers is None else self.wrappers / name)
        keep = ("SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "PATH", "HOME", "WINEPREFIX", "USER")
        env = {k: os.environ[k] for k in keep if k in os.environ}
        if sys.platform == "win32":
            env["VSLANG"] = "1033"
            env["PATH"] = os.path.join(env.get("SYSTEMROOT") or env.get("SystemRoot", r"C:\Windows"), "System32")
        if self.wrappers is None:
            # The wrappers set the toolset's and the SDK's headers themselves; the binaries run directly need them said.
            env["INCLUDE"] = os.pathsep.join(str(p) for p in self.include_dirs())
        try:
            p = subprocess.run([exe, *args], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise CompilerFailed("timeout") from None
        except OSError as e:
            raise CompilerFailed(f"cannot start: {type(e).__name__}") from None
        return p.returncode, p.stdout[:MAX_OUTPUT].decode("utf-8", "replace")


def discover(checkout: str | Path | None, expected_sha256: str | None = None, toolset: str | Path | None = None) -> Toolchain:
    """The toolchain of a checkout (`toolset`: its directory, when it is elsewhere), or ToolchainUnavailable. With a digest, only that compiler."""
    roots: list[Path] = [Path(toolset)] if toolset else []
    if checkout and not roots:
        base = Path(checkout) / CONTRIB / TOOLSETS
        roots = sorted(base.iterdir()) if base.is_dir() else []
    found = False
    for r in roots:
        t = Toolchain(r, None if sys.platform == "win32" else (Path(checkout) / CONTRIB / "bin/x64" if checkout else r.parents[3] / "bin/x64"))
        if not t.binary("cl").is_file() or t.wrappers is not None and not (t.wrappers / "cl").is_file():
            continue
        found = True
        if expected_sha256 is None or t.digest() == expected_sha256:
            return t
    raise ToolchainUnavailable("the compiler is not the one the recipe pins" if found else "no compiler")


__all__ = ["CompilerFailed", "Diagnostic", "Toolchain", "ToolchainUnavailable", "diagnostics", "discover"]
