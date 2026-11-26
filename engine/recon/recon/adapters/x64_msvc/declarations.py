# SPDX-License-Identifier: AGPL-3.0-or-later
"""What a header declares about a class, as the pinned compiler reads it, and where a method is declared in its text.

Two small translation units include the header. The compiler's report of the class layout gives each data member's offset
and name; a table of compile-time constants (one row per member: a type code, the offset, the size, the element count)
gives the types, read back from the object. C++ is not parsed here beyond the report's lines and, for the declaration of
one method, the braces and semicolons of the header's text with its comments and strings blanked out.

Nothing of a target is read: only the project's own declarations.
"""
from __future__ import annotations

import hashlib
import re
import struct
from dataclasses import dataclass
from pathlib import Path

from recon.adapters.x64_msvc import coff
from recon.adapters.x64_msvc.cl import Toolchain, diagnostics
from recon.core.emitter.member import Member
from recon.core.inference import types as ty
from recon.core.inference.signature import NotReconstructed

TABLE = "recon_probe_table"
COLUMNS = 4                       # type code, offset, size, element count

#: compile-time type codes (see PROBE) and the types they stand for; a pointer adds 1000 to what it points to
CODES: dict[int, ty.CType] = {
    1: ty.BOOL, 2: ty.Int(8, True), 3: ty.Int(8, False), 4: ty.Int(8, True), 5: ty.Int(16, True), 6: ty.Int(16, False),
    7: ty.Int(32, True), 8: ty.Int(32, False), 9: ty.Int(32, True), 10: ty.Int(32, False), 11: ty.Int(64, True),
    12: ty.Int(64, False), 13: ty.Float(32), 14: ty.Float(64), 15: ty.Int(16, False),
}
PROBE = """namespace recon_probe {
template <class T> struct K { static const long long v = std::is_class<T>::value ? 900 : std::is_enum<T>::value ? 800 : 0; };
template <class T> struct K<const T> : K<T> {};
template <class T> struct K<volatile T> : K<T> {};
template <class T> struct K<T*> { static const long long v = std::is_void<T>::value ? 1999 : 1000 + K<T>::v; };
template <> struct K<bool> { static const long long v = 1; };
template <> struct K<signed char> { static const long long v = 2; };
template <> struct K<unsigned char> { static const long long v = 3; };
template <> struct K<char> { static const long long v = 4; };
template <> struct K<short> { static const long long v = 5; };
template <> struct K<unsigned short> { static const long long v = 6; };
template <> struct K<int> { static const long long v = 7; };
template <> struct K<unsigned int> { static const long long v = 8; };
template <> struct K<long> { static const long long v = 9; };
template <> struct K<unsigned long> { static const long long v = 10; };
template <> struct K<long long> { static const long long v = 11; };
template <> struct K<unsigned long long> { static const long long v = 12; };
template <> struct K<float> { static const long long v = 13; };
template <> struct K<double> { static const long long v = 14; };
template <> struct K<wchar_t> { static const long long v = 15; };
}
"""


@dataclass(frozen=True)
class ClassFacts:
    cls: str
    size: int
    members: tuple[Member, ...]           # the ones a body can use: scalars, arrays of scalars, pointers to scalars
    names: tuple[str, ...]                # every data member the report lists
    virtual_bases: bool


_HEAD = re.compile(r"^class (?P<name>\S+)\tsize\((?P<size>\d+)\):$")
_ROW = re.compile(r"^\s*(?P<off>\d+)?\s*\t(?P<rest>\|.*)$")


def layout_report(text: str, cls: str) -> tuple[int, list[tuple[int, str]], bool] | None:
    """(size, [(offset, name)], has virtual bases) of `cls` in the compiler's layout report, or None when it is not there."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = _HEAD.match(line.strip("\r"))
        if not m or m["name"] != cls:
            continue
        out: list[tuple[int, str]] = []
        virtual = False
        for row in lines[i + 2:]:
            row = row.rstrip("\r")
            r = _ROW.match(row)
            if not r:
                break
            body = r["rest"].lstrip("|").strip()
            while body.startswith("|"):
                body = body[1:].strip()
            if body.startswith("+---"):
                if not r["off"] and body == "+---" and row.startswith("\t+---"):
                    break
                virtual = virtual or "(virtual base" in body
                continue
            if r["off"] is None or not body or body.startswith(("{vfptr}", "{vbptr}", "<alignment member>")) or "(bitstart" in body:
                continue
            out.append((int(r["off"]), body.split()[-1]))
        return int(m["size"]), out, virtual
    return None


def _probe_table(header: str, cls: str, names: list[str]) -> tuple[str, int]:
    """The probe's text, and the line of its first row. One declaration per member, each on a line of its own: the
    compiler reports an error at the end of the declaration, so a member it refuses is found by its line."""
    rows = [f'extern "C" const long long {TABLE}_{k}[{COLUMNS}] = {{recon_probe::K<std::remove_all_extents<decltype({cls}::{n})>::type>::v, '
            f"offsetof({cls}, {n}), sizeof({cls}::{n}), std::rank<decltype({cls}::{n})>::value == 1 ? "
            f"std::extent<decltype({cls}::{n})>::value : std::rank<decltype({cls}::{n})>::value ? -1 : 0}};"
            for k, n in enumerate(names)]
    head = "\n".join([f'#include "{header}"', "#include <cstddef>", "#include <type_traits>", PROBE])
    return "\n".join([head, *rows, ""]), head.count("\n") + 2


def class_facts(tool: Toolchain, flags: list[str], root: Path, header_rel: str, cls: str, work: Path) -> ClassFacts:
    """The class as the header declares it. `root`: where the recipe compiles from; `header_rel`: the header, relative to it.
    The probe files are written next to the header (so its own relative includes resolve) and removed again."""
    probe_dir = (root / header_rel).parent
    stem = ".recon-probe-" + hashlib.sha256(f"{header_rel}\0{cls}".encode()).hexdigest()[:12]
    work.mkdir(parents=True, exist_ok=True)
    hdr = Path(header_rel).name
    src = probe_dir / f"{stem}.cpp"
    try:
        src.write_text(f'#include "{hdr}"\nstatic_assert(sizeof({cls}) > 0, "complete");\n', encoding="utf-8", newline="\n")
        code, out = tool.run("cl", [*flags, "/c", f"/d1reportSingleClassLayout{cls}", f"/Fo{work / (stem + '.obj')}", str(src.relative_to(root))], root)
        if code != 0:
            raise NotReconstructed("UNIT_HEADER_DOES_NOT_COMPILE")
        got = layout_report(out, cls)
        if got is None:
            raise NotReconstructed("CLASS_NOT_IN_UNIT_HEADER")
        size, rows, virtual = got
        names = [n for _o, n in rows if re.fullmatch(r"[A-Za-z_]\w*", n)]
        members: list[Member] = []
        for _attempt in range(3):
            if not names:
                break
            text, first = _probe_table(hdr, cls, names)
            src.write_text(text, encoding="utf-8", newline="\n")
            obj = work / (stem + ".obj")
            code, out = tool.run("cl", [*flags, "/c", f"/Fo{obj}", str(src.relative_to(root))], root)
            if code != 0:
                # a member this unit cannot name (private, ambiguous): leave it out, by the line of its row
                bad = {d.line - first for d in diagnostics(out) if d.file.endswith(".cpp") and d.line >= first}
                keep = [n for k, n in enumerate(names) if k not in bad]
                if len(keep) == len(names):
                    raise NotReconstructed("UNIT_HEADER_DOES_NOT_COMPILE")
                names = keep
                continue
            members = _members(coff.Object(obj.read_bytes()), names)
            break
        return ClassFacts(cls, size, tuple(members), tuple(n for _o, n in rows), virtual)
    finally:
        for p in probe_dir.glob(f"{stem}.*"):
            p.unlink(missing_ok=True)


def _members(o: coff.Object, names: list[str]) -> list[Member]:
    syms = {s.name: s for s in o.symbols.values() if s.name.startswith(TABLE) and s.section > 0}
    out = []
    for k, n in enumerate(names):
        sym = syms.get(f"{TABLE}_{k}")
        if sym is None:
            raise NotReconstructed("UNIT_HEADER_DOES_NOT_COMPILE")
        code, off, size, count = struct.unpack(f"<{COLUMNS}q", o.sections[sym.section - 1].data[sym.value:sym.value + 8 * COLUMNS])
        t = CODES.get(code) or (ty.Ptr(CODES[code - 1000]) if code - 1000 in CODES else None)
        if t is None or count < 0:
            continue
        if size != (t.width // 8) * max(1, count):
            continue
        out.append(Member(off, n, t, count))
    return out


# ------------------------------------------------------------------------------------------------ the header's text

def blank(text: str) -> str:
    """The text with comments, strings and character literals replaced by spaces, offsets kept."""
    out = list(text)
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
        elif c in "\"'":
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            j = min(n, j + 1)
        else:
            i += 1
            continue
        for k in range(i, j):
            if out[k] != "\n":
                out[k] = " "
        i = j
    return "".join(out)


@dataclass(frozen=True)
class Declaration:
    start: int
    end: int                     # one past the semicolon
    text: str


def class_body(code: str, cls: str) -> tuple[int, int] | None:
    """(the opening brace, the closing brace) of the definition of `cls` in blanked text."""
    for m in re.finditer(rf"\b(?:class|struct)\s+{re.escape(cls)}\b", code):
        j = m.end()
        while j < len(code) and code[j] not in "{;(":
            j += 1
        if j >= len(code) or code[j] != "{":
            continue
        depth = 0
        for k in range(j, len(code)):
            if code[k] == "{":
                depth += 1
            elif code[k] == "}":
                depth -= 1
                if depth == 0:
                    return j, k
    return None


def method_declarations(text: str, cls: str, method: str) -> list[Declaration] | None:
    """Every declaration of `method` directly inside the class (None when the class is not defined in the text)."""
    code = blank(text)
    span = class_body(code, cls)
    if span is None:
        return None
    a, b = span
    out = []
    for m in re.finditer(rf"(?<![\w~:]){re.escape(method)}\s*\(", code[a + 1:b]):
        at = a + 1 + m.start()
        depth = sum(1 if ch == "{" else -1 if ch == "}" else 0 for ch in code[a:at])
        if depth != 1:
            continue
        s = at
        while s > a + 1 and code[s - 1] not in ";{}":
            s -= 1
        label = re.match(r"\s*(?:public|protected|private)\s*:", code[s:at])
        if label:
            s += label.end()
        while code[s].isspace():
            s += 1
        e, par = at, 0
        while e < b:
            ch = code[e]
            if ch == "(":
                par += 1
            elif ch == ")":
                par -= 1
            elif par == 0 and ch in ";{":
                break
            e += 1
        if e >= b or code[e] == "{":
            raise NotReconstructed("INLINE_DEFINITION")
        out.append(Declaration(s, e + 1, text[s:e + 1]))
    return out


def with_declaration(text: str, cls: str, method: str, declaration: str) -> tuple[str, Declaration | None]:
    """The header with `declaration;` in place of the method's one declaration (or added at the end of the class),
    and the declaration it replaced (None: added)."""
    found = method_declarations(text, cls, method)
    if found is None:
        raise NotReconstructed("CLASS_NOT_IN_UNIT_HEADER")
    if len(found) > 1:
        raise NotReconstructed("OVERLOADED_METHOD")
    if found:
        d = found[0]
        flat = " ".join(blank(d.text).split())
        if re.match(r"(?:virtual|explicit)\b", flat) or re.search(r"\b(?:override|final)\b|=\s*(?:0|default|delete)\s*;$", flat):
            raise NotReconstructed("VIRTUAL_DECLARATION")
        if text.count(d.text) != 1:
            raise NotReconstructed("DECLARATION_NOT_UNIQUE")
        return text[:d.start] + declaration + ";" + text[d.end:], d
    a, b = class_body(blank(text), cls)  # type: ignore[misc]
    return text[:b] + f"public:\n    {declaration};\n" + text[b:], None


__all__ = ["ClassFacts", "Declaration", "blank", "class_body", "class_facts", "layout_report", "method_declarations", "with_declaration"]
