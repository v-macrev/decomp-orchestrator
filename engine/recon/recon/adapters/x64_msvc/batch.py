# SPDX-License-Identifier: AGPL-3.0-or-later
"""Compiling candidates: many in one process, each in a namespace of its own, and the one that counts in its exact unit.

A namespace changes the decorated names of what a candidate declares and nothing of its code; `exact` shows it each time,
because what is verified is always the exact unit. A candidate that does not compile is found by the lines of the errors
and left out; when the errors name no candidate, the batch is halved.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from recon.adapters.x64_msvc import coff
from recon.adapters.x64_msvc.cl import CompilerFailed, Toolchain, diagnostics
from recon.adapters.x64_msvc.decode import _iced

MAX_BATCH = 64


@dataclass(frozen=True)
class Compiled:
    function: coff.Function | None
    errors: tuple[str, ...] = ()         # diagnostic codes
    texts: tuple[str, ...] = ()


@dataclass(frozen=True)
class Exact:
    object: bytes
    function: coff.Function
    source: str


class Compiler:
    def __init__(self, tool: Toolchain, flags: list[str], work: Path) -> None:
        self.tool = tool
        self.flags = list(flags)
        self.work = Path(work)
        self.work.mkdir(parents=True, exist_ok=True)
        self.processes = 0
        self.candidates = 0

    def _cl(self, name: str, text: str) -> tuple[bytes | None, str]:
        src, obj = self.work / f"{name}.cpp", self.work / f"{name}.obj"
        obj.unlink(missing_ok=True)
        src.write_bytes(text.encode("ascii"))
        self.processes += 1
        code, out = self.tool.run("cl", [*self.flags, src.name], self.work)
        if code == 0 and not obj.is_file():
            raise CompilerFailed("no object")
        return (obj.read_bytes() if code == 0 else None), out

    def batch(self, units: list[tuple[str, str]]) -> list[Compiled]:
        """(function name, text) -> what became of each, in order."""
        out: list[Compiled] = []
        for k in range(0, len(units), MAX_BATCH):
            out += self._some(units[k:k + MAX_BATCH])
        self.candidates += len(units)
        return out

    def _some(self, units: list[tuple[str, str]]) -> list[Compiled]:
        done: dict[int, Compiled] = {}
        left = list(range(len(units)))
        while left:
            lines: list[str] = []
            where: list[tuple[int, int, int]] = []
            for k in left:
                first = len(lines) + 1
                lines += [f"namespace candidate{k} {{", *units[k][1].splitlines(), "}"]
                where.append((first, len(lines), k))
            blob, text = self._cl("batch", "\n".join(lines) + "\n")
            if blob is not None:
                fns = coff.Object(blob).functions()
                for k in left:
                    tail = re.compile(rf"\?{re.escape(units[k][0])}@candidate{k}@@")
                    mine = [f for n, f in sorted(fns.items()) if tail.match(n)]
                    done[k] = Compiled(mine[0] if len(mine) == 1 else None, () if len(mine) == 1 else ("NO_SUCH_FUNCTION",))
                break
            found: dict[int, list] = {}
            for d in diagnostics(text):
                for a, b, k in where:
                    if a <= d.line <= b:
                        found.setdefault(k, []).append(d)
            if found:
                for k, ds in found.items():
                    done[k] = Compiled(None, tuple(sorted({d.code for d in ds})), tuple(d.text for d in ds))
                left = [k for k in left if k not in found]
            elif len(left) == 1:
                done[left[0]] = Compiled(None, tuple(sorted({d.code for d in diagnostics(text)})) or ("UNKNOWN",))
                left = []
            else:
                half = len(left) // 2
                for part in (left[:half], left[half:]):
                    for k, c in zip(part, self._some([units[k] for k in part])):
                        done[k] = c
                left = []
        return [done[k] for k in range(len(units))]

    def exact(self, name: str, text: str, file: str = "unit") -> Exact | None:
        blob, _out = self._cl(file, text)
        if blob is None:
            return None
        mine = [f for n, f in coff.Object(blob).functions().items() if coff.plain(n) == name]
        return Exact(blob, mine[0], text) if len(mine) == 1 else None


# ---------------------------------------------------------------------------------------- distance

@dataclass(frozen=True)
class Distance:
    """How far a candidate's function is from the target's bytes. `total` 0: nothing differs that this looks at, apart
    from the `unknown` references, which no evidence names and which only the comparator can settle."""

    total: int
    size: int                # difference in bytes
    instructions: int        # instructions to change, insert or remove
    references: int          # references that evidence names and that lead elsewhere than the target's
    unknown: int = 0         # references that no evidence names: never counted as wrong, never as right


def _rows(code: bytes, holes: dict[int, str]) -> list[tuple]:
    """Each instruction as its bytes, with referenced fields replaced by what they refer to."""
    out = []
    for i in _iced().Decoder(64, code, ip=0):
        b = bytearray(code[i.ip:i.ip + i.len])
        ref = ""
        for o, r in holes.items():
            if i.ip <= o < i.ip + i.len:
                b[o - i.ip:o - i.ip + 4] = b"\0\0\0\0"
                ref = r
        out.append((bytes(b), ref))
    return out


def distance(f: coff.Function, target: bytes, rva: int, resolve) -> Distance:
    """`resolve(reloc)`: the RVA a reference of the candidate means by the evidence, or None when no evidence names it.

    A named reference counts as wrong when the target's field leads elsewhere. An unnamed one is masked like a named one
    and counted apart: whether it is right is the comparator's question, so a candidate that differs only there has
    distance 0 and goes to the comparator."""
    import difflib

    wrong = unknown = 0
    holes: dict[int, str] = {}
    for r in f.relocs:
        meant = resolve(r)
        if meant is None:
            unknown += 1
            holes[r.offset] = "?"
            continue
        holes[r.offset] = f"{meant}"
        if r.kind in coff.REL32 and r.offset + 4 <= len(target):
            disp = int.from_bytes(target[r.offset:r.offset + 4], "little", signed=True)
            add = int.from_bytes(f.code[r.offset:r.offset + 4], "little", signed=True)
            wrong += rva + r.offset + 4 + coff.REL32[r.kind] + disp - add != meant
        else:
            wrong += 1
    if len(f.code) == len(target):
        a, b = bytearray(f.code), bytearray(target)
        for o in holes:
            a[o:o + 4] = b[o:o + 4] = b"\0\0\0\0"
        if a == b:
            return Distance(wrong, 0, 0, wrong, unknown)
    theirs = _branches(target, rva)
    for o, v in holes.items():
        if v == "?" and o in theirs:
            theirs[o] = "?"             # an unnamed reference stands for whatever the target's field leads to
    mine = [x for x, _r in _rows(f.code, holes)]
    other = [x for x, _r in _rows(target, theirs)]
    same = sum(m.size for m in difflib.SequenceMatcher(None, mine, other, autojunk=False).get_matching_blocks())
    n = max(len(mine), len(other)) - same
    return Distance(max(1, n + wrong), abs(len(f.code) - len(target)), n, wrong, unknown)


def _branches(code: bytes, rva: int) -> dict[int, str]:
    """Fields of calls, jumps and data references that lead out of the code, at their offsets."""
    ix = _iced()
    out = {}
    for i in ix.Decoder(64, code, ip=0):
        inside = i.near_branch_target if i.is_call_near or i.is_jmp_near or i.is_jcc_short_or_near else None
        if inside is not None and i.len >= 5 and not 0 <= inside < len(code):
            out[i.ip + i.len - 4] = str(rva + inside)
        elif i.is_ip_rel_memory_operand:
            offs = ix.Decoder(64, code[i.ip:i.ip + i.len], ip=0)
            j = offs.decode()
            c = offs.get_constant_offsets(j)
            if c.has_displacement:
                out[i.ip + c.displacement_offset] = str(rva + i.ip_rel_memory_address)
    return out


__all__ = ["Compiled", "Compiler", "Distance", "Exact", "MAX_BATCH", "distance"]
