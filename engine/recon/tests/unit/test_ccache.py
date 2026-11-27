# SPDX-License-Identifier: AGPL-3.0-or-later
"""The compile cache (C5, D12-004): what is keyed, what is never cached, and that an answer equals a fresh compile."""
import os
import subprocess
import sys

import pytest

from recon.adapters.x64_msvc import ccache as cc


def test_only_one_source_and_known_flags_are_cached(tmp_path):
    c = cc.parse(["/nologo", "/c", "/O2", "/GS-", "/EHsc", "/Fo" + str(tmp_path / "x.obj"), "a.cpp"], tmp_path)
    assert isinstance(c, cc.Command) and c.source == tmp_path / "a.cpp" and c.obj == tmp_path / "x.obj"
    assert cc.parse(["/c", "a.cpp"], tmp_path).obj == tmp_path / "a.obj"                     # the compiler's default name
    assert cc.parse(["/c", "/d1reportSingleClassLayoutK", "/Fok.obj", "k.cpp"], tmp_path).obj == tmp_path / "k.obj"
    assert cc.parse(["/c", "a.cpp", "b.cpp"], tmp_path) == "sources:2"
    assert cc.parse(["/c", "/I", "inc", "a.cpp"], tmp_path) == "include-directory"           # a pair, not a source
    assert cc.parse(["/c", "/Iinc", "a.cpp"], tmp_path) == "include-directory"
    assert cc.parse(["/c", "/Zi", "a.cpp"], tmp_path).startswith("flag:")                    # writes a PDB too
    assert cc.parse(["/c", "/E", "a.cpp"], tmp_path).startswith("flag:")
    assert cc.parse(["/c", "/Fo" + str(tmp_path) + "/", "a.cpp"], tmp_path) == "object-directory"
    assert cc.parse(["/c", "/D", "X=1", "a.cpp"], tmp_path).flags == ["/c", "/DX=1"]


def test_the_closure_holds_every_place_an_include_may_resolve_to(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "a.h").write_text('#include "sub/b.h"\n#include <cstdint>\n')
    (tmp_path / "sub/b.h").write_text('#pragma once\n  #  include "c.h"\n')
    (tmp_path / "c.h").write_text("int c;\n")              # found from b.h only through its includer's directory
    src = tmp_path / "u.cpp"
    src.write_bytes(b'#include "a.h"\nint f();\n')
    got = cc.closure(src, src.read_bytes(), [])
    assert got[str(tmp_path / "a.h")] != "absent" and got[str(tmp_path / "sub/b.h")] != "absent"
    assert got[str(tmp_path / "c.h")] != "absent" and got[str(tmp_path / "sub/c.h")] == "absent"
    assert not any("cstdint" in k for k in got)            # the toolchain's, keyed by its digest
    (tmp_path / "sub/c.h").write_text("int shadow;\n")      # a file earlier in the search order: another key
    again = cc.closure(src, src.read_bytes(), [])
    assert again != got and again[str(tmp_path / "sub/c.h")] != "absent"
    (tmp_path / "c.h").write_text("int changed;\n")
    assert cc.closure(src, src.read_bytes(), []) != again


@pytest.mark.parametrize("text", [b'#define H "a.h"\n#include H\n', b"const char* d = __DATE__;\n", b"#if __has_include(<x>)\n#endif\n",
                                  b'#import "x.tlb"\n', b"#pragma include_alias(\"a.h\", \"b.h\")\n", b"const char* t = __TIME__;\n"])
def test_what_the_closure_cannot_see_is_never_cached(tmp_path, text):
    src = tmp_path / "u.cpp"
    src.write_bytes(text)
    assert isinstance(cc.closure(src, text, []), str)


def test_a_torn_entry_is_no_entry(tmp_path):
    c = cc.Cache(tmp_path)
    c.put("ab" * 32, 0, "out", b"OBJECT", 1.0)
    assert c.get("ab" * 32) == (0, "out", b"OBJECT", 1.0)
    (tmp_path / "ab" / f"{'ab' * 32}.obj").write_bytes(b"OBJEC")
    assert c.get("ab" * 32) is None
    c.put("cd" * 32, 2, "error C2065", None, 0.5)
    assert c.get("cd" * 32) == (2, "error C2065", None, 0.5)


_HOLD = """
import sys, time
from recon.adapters.x64_msvc import ccache
with ccache.held(sys.argv[1]):
    print("held", flush=True)
    time.sleep(2)
print("released", flush=True)
"""


def test_the_unit_lock_excludes_other_processes(tmp_path):
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)}
    p = subprocess.Popen([sys.executable, "-c", _HOLD, str(tmp_path / "u.lock")], stdout=subprocess.PIPE, text=True, env=env)
    assert p.stdout.readline().strip() == "held"
    with cc.held(tmp_path / "u.lock"):
        assert p.stdout.readline().strip() == "released"
    p.wait(30)


UNIT = "struct K { int a; int b; long long c; };\n"


def test_an_answer_from_the_cache_equals_a_fresh_compile(toolchain, tmp_path, monkeypatch):
    monkeypatch.setenv(cc.ENV, str(tmp_path / "cache"))
    monkeypatch.setattr(cc, "_CACHES", {})
    tool, flags = toolchain.tool, [f for f in toolchain.flags if f != "/c"]
    (tmp_path / "k.h").write_text(UNIT)
    src = tmp_path / "u.cpp"
    src.write_text('#include "k.h"\nint f(K* k) { return k->a + k->b * 3; }\n')
    obj = tmp_path / "out.obj"
    args = [*flags, "/c", f"/Fo{obj}", "u.cpp"]
    code, out = tool.run("cl", args, tmp_path)
    first = obj.read_bytes()
    assert code == 0 and cc.last() == "miss"
    obj.unlink()
    assert tool.run("cl", args, tmp_path) == (code, out) and cc.last() == "hit" and obj.read_bytes() == first
    assert tool.run("cl", args, tmp_path, fresh=True)[0] == 0 and cc.last() == "fresh"
    assert cc.stampless(obj.read_bytes()) == cc.stampless(first)          # a fresh compile differs in the time stamp only
    (tmp_path / "k.h").write_text(UNIT.replace("int b;", "short b;"))      # an included file changed: compiled again
    assert tool.run("cl", args, tmp_path)[0] == 0 and cc.last() == "miss"
    assert cc.stampless(obj.read_bytes()) != cc.stampless(first)
    src.write_text('#include "k.h"\nint f(K* k) { return k->a + nothing; }\n')
    bad = tool.run("cl", args, tmp_path)
    assert bad[0] != 0 and cc.last() == "miss"
    assert tool.run("cl", args, tmp_path) == bad and cc.last() == "hit"   # the same diagnostics, word for word
    st = cc.active().stats
    assert (st.hits, st.misses, st.fresh) == (2, 3, 1)


def test_without_a_cache_directory_nothing_is_cached(toolchain, tmp_path, monkeypatch):
    monkeypatch.delenv(cc.ENV, raising=False)
    tool, flags = toolchain.tool, [f for f in toolchain.flags if f != "/c"]
    (tmp_path / "u.cpp").write_text("int g(int x) { return x + 1; }\n")
    assert tool.run("cl", [*flags, "/c", "u.cpp"], tmp_path)[0] == 0 and cc.last() == "uncached"
