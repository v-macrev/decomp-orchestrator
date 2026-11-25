# SPDX-License-Identifier: AGPL-3.0-or-later
"""Synthetic targets: original C++ compiled and linked with the supported toolchain into an image of its own.

`build` runs in the test harness, which may read the fixtures. What it leaves for the engine is a pack: the image and
a list of function extents. Names, sources, objects and the map stay with the harness."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures" / "cpp"


@dataclass
class Synthetic:
    pack: Path                           # what the engine gets
    names: dict[str, tuple[int, int]]    # what only the harness knows: function name -> (rva, size)
    data: dict[str, int]                 # and where the linker put the constants the compiler named
    sizes: dict[int, int]                # every function's size, by rva


def build(tool, flags: list[str], work: Path, out: Path, sources=("targets.cpp", "callees.cpp"), targets: str = "targets.cpp") -> Synthetic:
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    for s in sources:
        (work / s).write_bytes((FIXTURES / s).read_bytes())
    (work / "runtime.cpp").write_text('extern "C" int _fltused = 0;\n')
    tool.run("cl", [*flags, *sources, "runtime.cpp"], work)
    objs = [s.replace(".cpp", ".obj") for s in (*sources, "runtime.cpp")]
    tool.run("link", ["/nologo", "/DLL", "/NOENTRY", "/NODEFAULTLIB", "/OPT:NOREF", "/OPT:NOICF", "/INCREMENTAL:NO", "/MACHINE:X64", "/Brepro",
                      "/MAP:image.map", "/OUT:image.dll", *objs], work)
    blob = (work / "image.dll").read_bytes()
    starts: list[tuple[int, str, str]] = []
    data: dict[str, int] = {}
    base = 0
    for line in (work / "image.map").read_text(errors="replace").splitlines():
        m = re.match(r"\s*Preferred load address is ([0-9a-f]+)", line)
        if m:
            base = int(m.group(1), 16)
        m = re.match(r"[ ]*[0-9a-f]{4}:[0-9a-f]{8}[ ]+(__(?:real|xmm)@[0-9a-f]+)[ ]+([0-9a-f]{16})[ ]", line)
        if m:
            data[m.group(1)] = int(m.group(2), 16) - base
        m = re.match(r"\s*[0-9a-f]{4}:[0-9a-f]{8}\s+(\S+)\s+([0-9a-f]{16}) f\s+(?:i\s+)?(\S+)", line)
        if m:
            starts.append((int(m.group(2), 16) - base, m.group(1), m.group(3)))
    starts.sort()
    sizes = _sizes(tool, work, objs)
    names = {}
    fns = []
    for rva, name, obj in starts:
        size = sizes[name]
        plain = re.match(r"\?(\w+)@@", name)
        fns.append((rva, size))
        if obj == targets.replace(".cpp", ".obj"):
            names[plain.group(1) if plain else name] = (rva, size)
    (out / "image.bin").write_bytes(blob)
    (out / "pack.json").write_text(json.dumps({"schema": 1, "build_id": "synthetic", "image": "image.bin", "image_sha256": hashlib.sha256(blob).hexdigest(),
                                               "functions": [{"rva": r, "size": s} for r, s in sorted(fns)]}, indent=1))
    return Synthetic(out / "pack.json", names, data, dict(fns))


def _sizes(tool, work: Path, objs: list[str]) -> dict[str, int]:
    """Each function's size: its COMDAT section's."""
    import pecoff

    out = {}
    for o in objs:
        c = pecoff.CoffObject((work / o).read_bytes())
        for s in c.symbols.values():
            if s.storage == pecoff.STORAGE_EXTERNAL and s.section > 0 and c.section(s.section).flags & pecoff.SCN_CNT_CODE:
                out[s.name] = c.section(s.section).raw_size
    return out


__all__ = ["FIXTURES", "Synthetic", "build"]
