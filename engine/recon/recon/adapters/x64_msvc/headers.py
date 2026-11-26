# SPDX-License-Identifier: AGPL-3.0-or-later
"""The signatures of imported functions, as the platform's own headers declare them (D-052).

An imported function is known by its name only. Its declaration is in the headers of the toolchain and the SDK the build
compiles against, and the compiler is what reads them: one translation unit includes the headers and, for each name the
headers declare, has the compiler encode the function's type (each parameter's and the result's kind and width) into a
constant of the object, which is read back. Nothing is written by hand about any function: a name no header declares, an
overloaded one, a variadic one, or one that takes or returns an aggregate by value has no signature here, and stays unknown.

The headers come in groups that each compile on their own; a name is looked up in the first group that declares it.
"""
from __future__ import annotations

import re
from pathlib import Path

from recon.adapters.x64_msvc import coff
from recon.adapters.x64_msvc.cl import CompilerFailed, Toolchain, diagnostics
from recon.core.inference.signature import FLOAT, INT, Signature, Slot

#: the header groups, in order; each is compiled on its own
GROUPS: tuple[tuple[str, ...], ...] = (
    ("windows.h", "stdlib.h", "stdio.h", "string.h", "wchar.h", "math.h", "time.h", "locale.h", "signal.h", "setjmp.h",
     "malloc.h", "errno.h", "ctype.h", "wctype.h", "process.h", "io.h", "direct.h", "fcntl.h", "sys/stat.h", "conio.h",
     "float.h", "mbstring.h", "search.h", "corecrt_startup.h"),
    ("winsock2.h", "ws2tcpip.h", "windows.h"),
    ("windows.h", "shlobj.h", "shellapi.h", "shlwapi.h"),
    ("windows.h", "dbghelp.h", "psapi.h", "tlhelp32.h"),
    ("windows.h", "mmsystem.h", "objbase.h", "oleauto.h"),
    ("windows.h", "bcrypt.h", "wincrypt.h", "wininet.h", "winhttp.h"),
    ("windows.h", "xinput.h", "d3d11.h", "dxgi.h"),
)
FLAGS = ["/nologo", "/c", "/std:c++17", "/Zc:externConstexpr", "/EHsc", "/W0", "/DNOMINMAX"]
#: bytes of each encoding: [is a function, variadic, parameter count, result kind, result width, (kind, width) per parameter]
SIZE = 128

PRELUDE = r"""
#include <type_traits>
namespace recon_probe {
using B = unsigned char;
struct Out { B v[%(size)d]; };
template<class T> constexpr B kind() {
  using U = std::remove_cv_t<T>;
  if constexpr (std::is_void_v<U>) return 0;
  else if constexpr (std::is_reference_v<U> || std::is_pointer_v<U> || std::is_integral_v<U> || std::is_enum_v<U> || std::is_null_pointer_v<U>) return 1;
  else if constexpr (std::is_floating_point_v<U>) return 2;
  else return 3;
}
template<class T> constexpr B width() {
  if constexpr (std::is_void_v<T>) return 0;
  else if constexpr (std::is_reference_v<T>) return 64;
  else return sizeof(T) <= 16 ? (B)(sizeof(T) * 8) : (B)255;
}
template<class R, class... A> constexpr Out make(B variadic) {
  Out o{};
  o.v[0] = 1; o.v[1] = variadic; o.v[2] = (B)sizeof...(A); o.v[3] = kind<R>(); o.v[4] = width<R>();
  const B ks[] = {kind<A>()..., 0}; const B ws[] = {width<A>()..., 0};
  for (unsigned i = 0; i < sizeof...(A) && 6 + 2 * i < %(size)d; ++i) { o.v[5 + 2 * i] = ks[i]; o.v[6 + 2 * i] = ws[i]; }
  return o;
}
template<class F> struct E { static constexpr Out get() { return Out{}; } };
template<class R, class... A> struct E<R(A...)> { static constexpr Out get() { return make<R, A...>(0); } };
template<class R, class... A> struct E<R(A..., ...)> { static constexpr Out get() { return make<R, A...>(1); } };
template<class R, class... A> struct E<R(A...) noexcept> { static constexpr Out get() { return make<R, A...>(0); } };
template<class R, class... A> struct E<R(A..., ...) noexcept> { static constexpr Out get() { return make<R, A...>(1); } };
}
"""
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


def probe_text(headers: tuple[str, ...], names: list[str]) -> tuple[str, int]:
    """The translation unit, and the line of its first name (one name per line after it)."""
    head = "".join(f"#include <{h}>\n" for h in headers) + PRELUDE % {"size": SIZE}
    first = head.count("\n") + 1
    body = "".join(f"__if_exists(::{n}) {{ extern \"C\" constexpr recon_probe::Out recon_import_{k} = recon_probe::E<decltype(::{n})>::get(); }}\n"
                   for k, n in enumerate(names))
    return head + body, first


def _slot(kind: int, width: int) -> Slot | None | bool:
    """A parameter's or result's slot; None for void; False when it has none the convention passes in a register."""
    if kind == 0:
        return None
    if kind == 1 and width in (8, 16, 32, 64):
        return Slot(INT, width)
    if kind == 2 and width in (32, 64):
        return Slot(FLOAT, width)
    return False


def decode(v: bytes) -> Signature | None:
    """The signature an encoding says, or None when the name is no plain function the convention passes in registers."""
    if len(v) < 5 or v[0] != 1 or v[1]:
        return None
    n = v[2]
    if 5 + 2 * n > len(v):
        return None
    result = _slot(v[3], v[4])
    params = [_slot(v[5 + 2 * k], v[6 + 2 * k]) for k in range(n)]
    if result is False or any(p is None or p is False for p in params):
        return None
    return Signature(tuple(params), result, (("declared", "import"),))  # type: ignore[arg-type]


def _compile(tool: Toolchain, work: Path, headers: tuple[str, ...], names: list[str]) -> dict[str, Signature]:
    """What one group of headers declares of `names`; names the compiler rejects are left out, one by one."""
    work.mkdir(parents=True, exist_ok=True)
    left = list(names)
    while left:
        text, first = probe_text(headers, left)
        src, obj = work / "imports.cpp", work / "imports.obj"
        obj.unlink(missing_ok=True)
        src.write_bytes(text.encode("ascii"))
        try:
            code, out = tool.run("cl", [*FLAGS, src.name], work)
        except CompilerFailed:
            return {}
        if code == 0 and obj.is_file():
            o = coff.Object(obj.read_bytes())
            got: dict[str, Signature] = {}
            for s in o.symbols.values():
                m = re.fullmatch(r"recon_import_(\d+)", s.name)
                if m and s.section > 0:
                    sec = o.sections[s.section - 1]
                    sig = decode(sec.data[s.value:s.value + SIZE])
                    if sig is not None:
                        got[left[int(m.group(1))]] = sig
            return got
        bad = {d.line - first for d in diagnostics(out, limit=10_000) if first <= d.line < first + len(left)}
        if not bad:
            return {}                                 # the headers themselves do not compile together: this group says nothing
        left = [n for k, n in enumerate(left) if k not in bad]
    return {}


def import_signatures(tool: Toolchain, work: Path, names: list[str]) -> dict[str, Signature]:
    """The signature of every name some group of headers declares as a plain function."""
    want = sorted({n for n in names if IDENT.match(n)})
    found: dict[str, Signature] = {}
    for k, headers in enumerate(GROUPS):
        left = [n for n in want if n not in found]
        if not left:
            break
        found.update(_compile(tool, work / f"group{k}", headers, left))
    return found


__all__ = ["FLAGS", "GROUPS", "decode", "import_signatures", "probe_text"]
