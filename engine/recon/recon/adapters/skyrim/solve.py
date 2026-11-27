# SPDX-License-Identifier: AGPL-3.0-or-later
"""The protocol's `solve` on the real target: one packet of one unit, in the slot's worktree.

For each function: the candidates of its code (Phase 5), each written as a member of the class the unit's header declares
(`core/emitter/member.py`, the class read by the pinned compiler), compiled next to that header with the unit's recipe,
ranked against the target and verified by upstream's comparator. A function is solved only when the comparator passed it.

What is read: the image and upstream's inventory and tools at the pinned base, the recipe, and the unit's header as the
worktree has it after the repository's own tooling prepared the packet (the base revision only, when the server says a
model may have written in the unit). Never a pack, a listing, a decompiler's output, the unit's source, a stored candidate
or any text a model wrote.

Edits are returned only when every function of the packet is solved: a unit with a function left as the skeleton's
placeholder does not compile, so a partial answer would only fail at the Gate Keeper.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from recon.adapters.skyrim.image import PinnedImage, locate_image
from recon.adapters.skyrim.inventory import extents, load_inventory, with_unwind_entries
from recon.adapters.skyrim.manifest import frontier_key, inputs
from recon.adapters.skyrim.pack import Pack
from recon.adapters.skyrim.packfacts import SCN_MEM_EXECUTE
from recon.adapters.skyrim.verify import PASS, Verifier
from recon.adapters.x64_msvc import coff
from recon.adapters.x64_msvc import declarations as D
from recon.adapters.x64_msvc import unwind as uw
from recon.adapters.x64_msvc.headers import import_signatures
from recon.adapters.x64_msvc.imports import iat_range, import_slots
from recon.adapters.x64_msvc.batch import distance
from recon.adapters.x64_msvc.cl import CompilerFailed, Toolchain, ToolchainUnavailable, diagnostics, discover
from recon.adapters.x64_msvc.symbols import SymbolMap
from recon.adapters.x64_msvc.validate import load_validated
from recon.core import budget as bg
from recon.core import knowledge as kn
from recon.core.emitter.member import Declared, MemberUnit, member_form
from recon.core.inference.signature import NotReconstructed
from recon.core.synthesis import search
from recon.core.synthesis.candidates import Candidate

DEFAULT_RECIPE = "reconstruction/recipes/msvc-19.16.27054-o2.json"
CODE_ORIGIN = ("produced by a deterministic reconstruction tool from the compared function's behaviour in the pinned image "
               "and the declarations of its class in this unit's header; no model wrote it")
ADAPTED = "none"
PLAIN = re.compile(r"^([A-Za-z_]\w*)::([A-Za-z_]\w*)$")


@dataclass
class Outcome:
    rva: int
    status: str                    # solved | unsolved | unsupported | blocked
    reason: str
    counters: dict[str, int] = field(default_factory=dict)
    trail: list[str] = field(default_factory=list)
    definition: str | None = None
    declaration: str | None = None
    name: str | None = None
    #: prototypes of the placeholder callees the definition calls, for the unit to carry after its includes
    prototypes: str = ""


class UnitWorkshop:
    """Compiles, ranks and verifies the member forms of one function's candidates next to the unit's header."""

    def __init__(self, ctx: "Context", rva: int, cls: str, method: str) -> None:
        self.ctx, self.rva, self.cls, self.method = ctx, rva, cls, method
        self.size = ctx.pack.size[rva]
        self.target = ctx.pack.image.read(rva, self.size)
        self.declared = Declared(cls, method, ctx.facts.members)
        self.forms: dict[str, MemberUnit | str] = {}
        self.built: dict[str, tuple[coff.Function, bytes, str] | None] = {}
        self.compiles = 0
        self.chosen: MemberUnit | None = None

    def form(self, c: Candidate) -> MemberUnit | str:
        if c.digest not in self.forms:
            try:
                self.forms[c.digest] = member_form(c.body, c.types, self.ctx.pack.image.image_base, self.rva, self.declared,
                                                   self.ctx.unnamed, self.ctx.unnamed_data)
            except NotReconstructed as e:
                self.forms[c.digest] = e.code
        return self.forms[c.digest]

    def build(self, c: Candidate) -> tuple[coff.Function, bytes, str] | None | str:
        f = self.form(c)
        if isinstance(f, str):
            return f
        if c.digest in self.built:
            return self.built[c.digest]
        header, _old = D.with_declaration(self.ctx.header_text, self.cls, self.method, f.declaration)
        source = f'#include "{self.ctx.temp_header.name}"\n\n' + (f.prototypes + "\n" if f.prototypes else "") + f.definition
        self.compiles += 1
        got = self.ctx.compile(header, source)
        if isinstance(got, list):
            self.built[c.digest] = None
            return ",".join(got[:3]) or "DOES_NOT_COMPILE"
        fns = [x for x in got[0].functions().values() if coff.plain(x.symbol) == self.method]
        self.built[c.digest] = (fns[0], got[1], source) if len(fns) == 1 else None
        return self.built[c.digest]

    def _callee(self, c: Candidate, symbol: str) -> int | None:
        """The RVA of the placeholder (a callee or an object) the candidate's member form names `symbol`, or None."""
        f = self.form(c)
        return None if isinstance(f, str) else (dict(f.callees) | dict(f.data)).get(coff.plain(symbol))

    def _extent(self, c: Candidate, at: int) -> int | None:
        """A placeholder callee's size, so that the comparator checks the call lands at its start; None for an object."""
        f = self.form(c)
        return None if isinstance(f, str) or at not in dict(f.callees).values() else self.ctx.pack.extent(at)

    def resolve(self, own: str, c: Candidate):
        """The function itself under its own name, a placeholder callee at the address its call was made to, else what the
        names upstream records say; nothing from the bytes."""
        def r(rel: coff.Reloc) -> int | None:
            if rel.symbol == own:
                return self.rva
            at = self._callee(c, rel.symbol)
            return at if at is not None else self.ctx.symbols.resolve(rel.symbol)
        return r

    def judge(self, candidates: list[Candidate]) -> list[search.Judged]:
        out = []
        for c in candidates:
            b = self.build(c)
            if b is None or isinstance(b, str):
                out.append(search.Judged(None, 0, (b,) if isinstance(b, str) else ("DOES_NOT_COMPILE",)))
                continue
            fn, _obj, _src = b
            d = distance(fn, self.target, self.rva, self.resolve(fn.symbol, c))
            out.append(search.Judged(fn.key(coff.plain), d.total, (), d.unknown))
        return out

    def verify(self, c: Candidate) -> tuple[bool, str]:
        b = self.build(c)
        if b is None or isinstance(b, str):
            return False, "EXACT_UNIT_DOES_NOT_COMPILE"
        fn, obj, src = b
        symbols: dict[str, tuple[int, int | None]] = {}
        for r in fn.relocs:
            at = self._callee(c, r.symbol)
            got = (self.rva, self.size) if r.symbol == fn.symbol else (at, self._extent(c, at)) if at is not None else self.ctx.symbols.lookup(r.symbol)
            if got is not None:
                symbols[r.symbol] = got
        report = self.ctx.verifier.verify(self.rva, self.size, fn.symbol, src.encode("utf-8"), obj, symbols)
        ok = report["result"] == "pass" and report["reason"] == PASS
        if ok:
            self.chosen = self.form(c)  # type: ignore[assignment]
        return ok, str(report["reason"])


#: packs a process has opened, by worktree, checkout and store: a worker that solves one function after another opens the
#: image and reads the inventory once
_PACKS: dict[tuple[str, str, str], tuple[Pack, frozenset[int]]] = {}


def pack_of(worktree: Path, checkout: Path, knowledge: str | None) -> tuple[Pack, frozenset[int]]:
    """The pack of every function the engine may analyse as a callee (D4), and the offered ones."""
    k = (str(worktree), str(checkout), knowledge or "")
    if k not in _PACKS:
        image = PinnedImage(locate_image(checkout), worktree)
        inv = load_inventory(worktree)
        validated = load_validated()
        if not validated:
            raise NotReconstructed("LIFT_COVERAGE_MISSING")
        pack = Pack("pinned", image, unwind_extents(image, extents(inv)[0]), validated)
        with_imports(pack, checkout)
        if knowledge:
            pack.open_store(knowledge)
        _PACKS[k] = (pack, frozenset(t.rva for t in inv.targets))
    return _PACKS[k]


def with_imports(pack: Pack, checkout: Path) -> Pack:
    """What the image imports, slot by slot, and the signatures the platform's headers declare of those functions (D-052).
    The signatures are derived once for an image, a compiler and the code that derives them, and kept (privately, under
    the checkout's recon data) for every later process. Without a compiler nothing is declared: the imports stay unknown."""
    image = pack.image
    pack.imports = import_slots(image.pe.blob, image.read)
    pack.iat = iat_range(image.pe.blob)
    names = sorted({i.name for i in pack.imports.values() if i.name})
    try:
        tool = discover(checkout)
    except ToolchainUnavailable:
        return pack
    code = kn.code_digest(files={"adapters/x64_msvc/headers.py", "adapters/x64_msvc/cl.py", "adapters/x64_msvc/coff.py"})
    key = hashlib.sha256(json.dumps([image.sha256, tool.digest(), code, names]).encode()).hexdigest()[:32]
    where = Path(checkout) / ".local/orchestrator/recon/imports"
    path = where / f"{key}.json"
    if path.is_file():
        found = {n: kn.signature_of(d) for n, d in json.loads(path.read_text(encoding="utf-8")).items()}
    else:
        found = import_signatures(tool, where / f"work-{os.getpid()}", names)
        write_atomically(path, json.dumps({n: kn.signature_data(s) for n, s in sorted(found.items())}, sort_keys=True))
        shutil.rmtree(where / f"work-{os.getpid()}", ignore_errors=True)
    pack.import_signatures = {n: s for n, s in found.items() if s is not None}
    return pack


def unwind_extents(image: PinnedImage, size: dict[int, int]) -> dict[int, int]:
    """The extents, and those the image's exception directory gives the functions upstream does not list (D-049)."""
    entries = []
    for b, e, u in image.runtime_functions():
        try:
            chained = bool(uw.read_unwind(image.read, u).flags & uw.UNW_FLAG_CHAININFO)
        except (ValueError, IndexError):
            chained = True                       # unreadable: it starts nothing the engine can tell
        entries.append((b, e, chained))
    return with_unwind_entries(size, entries)[0]


def write_atomically(path: Path, text: str) -> None:
    """A file that is either the old one or the new one, also after the machine ends abruptly."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Context:
    """What every function of one request shares: the image, the program, the compiler, the comparator, the header."""

    def __init__(self, worktree: Path, checkout: Path, data: Path, header_rel: str, header_text: str, recipe_rel: str,
                 knowledge: str | None = None) -> None:
        self.worktree, self.data = worktree, data
        recipe_bytes = (worktree / recipe_rel).read_bytes()
        recipe = json.loads(recipe_bytes)
        self.flags = [f for f in recipe["flags"] if f != "/c"]
        self.tool: Toolchain = discover(checkout, recipe["compiler"]["binary_sha256"])
        # every function the engine may analyse as a callee, not only the offered ones (D4); facts kept in `knowledge`
        self.pack, self.offered = pack_of(worktree, checkout, knowledge)
        image = self.pack.image
        self.symbols = recorded_symbols(worktree)
        self._named = self.symbols.addresses() | public_addresses(worktree, image.build_id)
        self.recipe_digest = hashlib.sha256(recipe_bytes).hexdigest()
        self.verifier = Verifier(worktree, image.build_id, image.pe.blob, recipe_bytes)
        self.header_rel, self.header_text = header_rel, header_text
        tag = hashlib.sha256(f"{header_rel}\0{time.monotonic_ns()}".encode()).hexdigest()[:10]
        self.temp_header = worktree / Path(header_rel).parent / f".recon-{tag}.h"
        self.temp_source = self.temp_header.with_suffix(".cpp")
        self.work = data / "work" / tag
        self.work.mkdir(parents=True, exist_ok=True)
        self.temp_header.write_text(header_text, encoding="utf-8", newline="\n")
        self.facts: D.ClassFacts | None = None

    def unnamed(self, at: int) -> bool:
        """Whether the function at address `at` is one the project has not named: a function of the image that no record
        and no declaration names. Such a callee is called by its placeholder (`member.placeholder`)."""
        rva = at - self.pack.image.image_base
        return rva not in self._named and self.pack.declared(at) is None and self.pack.extent(rva) is not None

    def unnamed_data(self, at: int) -> bool:
        """Whether address `at` holds an object of the image the project has not named: in a section that is not code, not
        an import slot (the loader writes those; the unit names them by their import), and named by no record and no entry
        of the project's symbol map. Such an object is read and written by its placeholder (`member.data_placeholder`)."""
        rva = at - self.pack.image.image_base
        if rva in self._named or rva in self.pack.imports or self.pack.iat[0] <= rva < self.pack.iat[1]:
            return False
        try:
            return not self.pack.image.pe.section_for(rva).flags & SCN_MEM_EXECUTE
        except self.pack.image.up.pecoff.Reject:
            return False

    def compile(self, header: str, source: str) -> tuple[coff.Object, bytes] | list[str]:
        """The object of `source` compiled with `header` as the unit's header, or the compiler's error codes."""
        self.temp_header.write_text(header, encoding="utf-8", newline="\n")
        self.temp_source.write_text(source, encoding="utf-8", newline="\n")
        obj = self.work / "candidate.obj"
        obj.unlink(missing_ok=True)
        try:
            code, out = self.tool.run("cl", [*self.flags, "/c", f"/Fo{obj}", str(self.temp_source.relative_to(self.worktree))], self.worktree)
        except CompilerFailed:
            return ["COMPILER_FAILED"]
        if code != 0 or not obj.is_file():
            return sorted({d.code for d in diagnostics(out)}) or ["DOES_NOT_COMPILE"]
        blob = obj.read_bytes()
        return coff.Object(blob), blob

    def close(self) -> None:
        for p in (self.temp_header, self.temp_source):
            p.unlink(missing_ok=True)
        shutil.rmtree(self.work, ignore_errors=True)


def recorded_symbols(worktree: Path) -> SymbolMap:
    """The names upstream's data/progress.json records, by address: plain or scoped names, so overloads are ambiguous."""
    out = SymbolMap()
    for f in json.loads((worktree / "data/progress.json").read_text(encoding="utf-8"))["functions"]:
        name = f.get("name") or ""
        if name and all(p.isidentifier() for p in name.split("::")):
            rva = f["rva"]
            out.add(name, int(rva, 16) if isinstance(rva, str) else int(rva), f.get("size"), "recorded")
    return out


def public_addresses(worktree: Path, build_id: str | None) -> frozenset[int]:
    """The addresses the project's public symbol map names (`reports/<build id>/symbol-map.json`); none without one."""
    path = worktree / "reports" / str(build_id) / "symbol-map.json"
    if not build_id or not path.is_file():
        return frozenset()
    d = json.loads(path.read_text(encoding="utf-8"))
    return frozenset(int(v["rva"], 16) if isinstance(v["rva"], str) else int(v["rva"]) for v in d.get("symbols", {}).values())


def base_text(worktree: Path, rel: str) -> str | None:
    """The file as the worktree's base revision has it, or None when the base has no such file."""
    p = subprocess.run(["git", "-C", str(worktree), "show", f"HEAD:{rel}"], capture_output=True, timeout=60)
    return p.stdout.decode("utf-8") if p.returncode == 0 else None


def recipe_of(worktree: Path, cpp_rel: str) -> str:
    """The unit's recipe: its `// Recipe:` line in the base revision, else the project's default."""
    text = base_text(worktree, cpp_rel) or ""
    m = re.search(r"^// Recipe: (reconstruction/recipes/[\w.-]+\.json)\s*$", text, re.M)
    return m.group(1) if m else DEFAULT_RECIPE


def unit_of(req: dict) -> tuple[str, str, str | None]:
    """The unit's source and header (relative paths) and the header's text, as the edits will apply to it: the base revision
    plus what the repository's own tooling wrote when the packet was prepared; when a model may have written in the unit,
    only the base revision."""
    packet, worktree = req["packet"], Path(req["worktree"])
    cpp_rel = next((p for p in packet["allowedPaths"] if p.endswith(".cpp")), packet["unit"])
    header_rel = next((p for p in packet["allowedPaths"] if p.endswith(".h")), cpp_rel[:-4] + ".h")
    if req.get("options", {}).get("modelTextInUnit"):
        text = base_text(worktree, header_rel)
    else:
        text = (worktree / header_rel).read_text(encoding="utf-8") if (worktree / header_rel).is_file() else None
    return cpp_rel, header_rel, text


def input_manifest(req: dict) -> dict | None:
    """The content-addressed inputs of the request (D6), or None when it has no worktree to read them from."""
    if not req.get("worktree") or not req.get("dataDir"):
        return None
    try:
        cpp_rel, header_rel, text = unit_of(req)
        if text is None:
            return None
        return inputs(Path(req["worktree"]), Path(req["dataDir"]), header_rel, text, recipe_of(Path(req["worktree"]), cpp_rel), req)
    except (OSError, ValueError, KeyError):
        return None


def solve(req: dict, progress: Callable[[str, dict[str, int]], None]) -> tuple[list[Outcome], str, str]:
    """The outcome of each function of the packet, the header (relative path) the declarations live in, and its text."""
    packet = req["packet"]
    fns = packet["functions"]
    options = req.get("options", {})
    blocked = lambda code: [Outcome(int(f["rva"], 16), "blocked", code) for f in fns]  # noqa: E731
    if not req.get("worktree") or not req.get("checkout") or not req.get("dataDir"):
        return blocked("NO_WORKTREE"), "", ""
    worktree, checkout, data = Path(req["worktree"]), Path(req["checkout"]), Path(req["dataDir"])
    cpp_rel, header_rel, text = unit_of(req)
    if text is None:
        return blocked("UNIT_HEADER_NOT_READABLE"), header_rel, ""
    names = [PLAIN.match(f.get("name") or "") for f in fns]
    classes = {m.group(1) for m in names if m}
    limit = options.get("maxFunctionBytes")
    try:
        ctx = Context(worktree, checkout, data, header_rel, text, recipe_of(worktree, cpp_rel), options.get("knowledge"))
    except (ToolchainUnavailable, FileNotFoundError) as e:
        return blocked("TOOLCHAIN_UNAVAILABLE" if isinstance(e, ToolchainUnavailable) else "INPUT_MISSING"), header_rel, text
    except NotReconstructed as e:
        return blocked(e.code), header_rel, text
    out: list[Outcome] = []
    try:
        facts: D.ClassFacts | None = None
        if len(classes) == 1:
            try:
                facts = D.class_facts(ctx.tool, ctx.flags, worktree, str(ctx.temp_header.relative_to(worktree)), next(iter(classes)), ctx.work)
            except NotReconstructed as e:
                return [Outcome(int(f["rva"], 16), "blocked", e.code) for f in fns], header_rel, text
            if facts.virtual_bases:
                return blocked("VIRTUAL_BASES"), header_rel, text
        ctx.facts = facts
        for f, m in zip(fns, names):
            rva = int(f["rva"], 16)
            if m is None or facts is None:
                out.append(Outcome(rva, "unsupported", "NAME_NOT_PLAIN" if m is None else "SEVERAL_CLASSES"))
                continue
            if rva not in ctx.offered:
                out.append(Outcome(rva, "unsupported", "NOT_IN_INVENTORY"))
                continue
            if limit and ctx.pack.size[rva] > int(limit):
                out.append(Outcome(rva, "unsupported", "SIZE_LIMIT"))
                continue
            cls, method = m.group(1), m.group(2)
            shop = UnitWorkshop(ctx, rva, cls, method)
            t0 = time.monotonic()
            # a frontier is resumed by the same engine, rules, image, recipe, header and function, whatever the budget
            key = frontier_key(ctx.pack.image.build_id, ctx.recipe_digest, ctx.header_text, rva, f"{cls}::{method}")
            saved = data / "frontiers" / f"{key}.json"
            try:
                past = search.Frontier.from_json(json.loads(saved.read_text(encoding="utf-8"))) if saved.is_file() else None
            except (ValueError, KeyError, TypeError):
                past = None
            try:
                r = search.reconstruct(ctx.pack.program(), ctx.pack.image.image_base + rva, shop, bg.Budget.of(req.get("budgets")), past)
            except NotReconstructed as e:
                out.append(Outcome(rva, "unsupported", e.code))
                continue
            if r.reason == search.BUDGET_EXHAUSTED and r.frontier is not None:
                write_atomically(saved, json.dumps(r.frontier.to_json(), sort_keys=True))
            counters = {k: int(v) for k, v in r.counters.items()} | {"compiles": shop.compiles, "ms": int(1000 * (time.monotonic() - t0)),
                                                                     "resumed": int(past is not None)}
            progress("function", {"done": len(out) + 1, "of": len(fns), "compiles": shop.compiles})
            refused = sorted({x for x in shop.forms.values() if isinstance(x, str)})
            if r.state == search.BYTE_MATCHED and shop.chosen is not None:
                trail = ["candidates@1", f"member-form-{shop.chosen.form.replace('_', '-')}@1", "comparator@1"]
                out.append(Outcome(rva, "solved", "BYTE_MATCHED", counters, trail, shop.chosen.definition, shop.chosen.declaration, f"{cls}::{method}",
                                   shop.chosen.prototypes))
            elif r.state == search.NONE:
                out.append(Outcome(rva, "unsupported", r.reason or "NO_CANDIDATE", counters))
            elif r.state == search.SEMANTICALLY_VALID:
                out.append(Outcome(rva, "unsolved", (refused[0] if refused and r.reason == "DOES_NOT_COMPILE" else r.reason) or "DOES_NOT_COMPILE", counters))
            else:
                out.append(Outcome(rva, "unsolved", r.reason or "NO_MATCH", counters))
    finally:
        ctx.close()
    return out, header_rel, text


def edits(outcomes: list[Outcome], header_rel: str, cpp_rel: str, text: str) -> list[dict]:
    """The packet's edits when every function is solved, else none."""
    if not outcomes or any(o.status != "solved" for o in outcomes):
        return []
    replace, members = [], []
    for o in outcomes:
        cls, method = o.name.split("::")  # type: ignore[union-attr]
        _new, old = D.with_declaration(text, cls, method, o.declaration)  # type: ignore[arg-type]
        if old is None:
            members.append({"class": cls, "code": f"{o.declaration};"})
        else:
            replace.append({"find": old.text, "with": f"{o.declaration};"})
    protos = list(dict.fromkeys(x for o in outcomes for x in o.prototypes.splitlines() if x.strip()))
    declared = [m.group(1) for x in protos if (m := re.search(r"(\w+)\s*[(;]", x))]
    if len(set(declared)) != len(declared):
        return []              # two functions declare one placeholder differently: the unit would not compile
    out = [{"path": cpp_rel, **({"declarations": "\n".join(protos)} if protos else {}),
            "functions": [{"name": o.name, "code": o.definition} for o in outcomes]}]
    if replace or members:
        out.append({"path": header_rel, **({"replace": replace} if replace else {}), **({"members": members} if members else {}), "functions": []})
    return out


__all__ = ["ADAPTED", "CODE_ORIGIN", "Context", "Outcome", "UnitWorkshop", "edits", "solve"]
