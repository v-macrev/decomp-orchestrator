# SPDX-License-Identifier: AGPL-3.0-or-later
"""Compiler experiments: two spellings of one function compiled under a recipe, and the kind of what differs.

A rule of the compiler knowledge base (core/synthesis/rules.py) is confirmed under a recipe only by experiments like
these, on original synthetic source: the spelling before and after the rule's transformation must compile to code that
differs in one of the kinds the rule claims (a positive case), and where the rule's precondition fails, the rule must
change nothing or not apply (a negative case). Nothing here reads a target.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from recon.adapters.x64_msvc import coff
from recon.adapters.x64_msvc.cl import Toolchain, diagnostics
from recon.adapters.x64_msvc.mismatch import Mismatch, compare, decode


class ExperimentFailed(RuntimeError):
    pass


@dataclass(frozen=True)
class Pair:
    """Two functions of one experiment: `before` and `after` the transformation."""

    before: str
    after: str
    equal: bool
    mismatch: Mismatch | None


def compile_functions(tool: Toolchain, flags: list[str], work: Path, name: str, text: str) -> dict[str, coff.Function]:
    """The external functions of `text` compiled under `flags`, by plain name."""
    work.mkdir(parents=True, exist_ok=True)
    src, obj = work / f"{name}.cpp", work / f"{name}.obj"
    obj.unlink(missing_ok=True)
    src.write_bytes(text.encode("ascii"))
    code, out = tool.run("cl", [*[f for f in flags if f != "/c"], "/c", src.name], work)
    if code != 0 or not obj.is_file():
        raise ExperimentFailed(",".join(sorted({d.code for d in diagnostics(out)})) or "DOES_NOT_COMPILE")
    fns: dict[str, coff.Function] = {}
    for sym, f in sorted(coff.Object(obj.read_bytes()).functions().items()):
        fns.setdefault(coff.plain(sym), f)
    return fns


def same(a: coff.Function, b: coff.Function) -> bool:
    """The same code and references (by plain name), whatever the functions are called."""
    def refs(f: coff.Function) -> list[tuple[int, int, str]]:
        return [(r.offset, r.kind, coff.plain(r.symbol)) for r in f.relocs]
    return a.code == b.code and refs(a) == refs(b)


def kind_between(a: coff.Function, b: coff.Function) -> Mismatch:
    """The kind of difference between two compiled functions, references named by plain name (a call to the same
    function is the same reference)."""
    ra = {r.offset: coff.plain(r.symbol) for r in a.relocs}
    rb = {r.offset: coff.plain(r.symbol) for r in b.relocs}
    return compare(decode(a.code, ra, None), decode(b.code, rb, None))


def run(tool: Toolchain, flags: list[str], work: Path, name: str, text: str, pairs: list[tuple[str, str]]) -> list[Pair]:
    fns = compile_functions(tool, flags, work, name, text)
    out = []
    for before, after in pairs:
        if before not in fns or after not in fns:
            raise ExperimentFailed(f"no function {before if before not in fns else after}")
        a, b = fns[before], fns[after]
        eq = same(a, b)
        out.append(Pair(before, after, eq, None if eq else kind_between(a, b)))
    return out


__all__ = ["ExperimentFailed", "Pair", "compile_functions", "kind_between", "run", "same"]
