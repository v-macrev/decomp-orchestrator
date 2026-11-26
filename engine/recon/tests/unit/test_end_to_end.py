# SPDX-License-Identifier: AGPL-3.0-or-later
"""From an image to verified source, with the pinned compiler and upstream's comparator.

The engine is a process of its own that gets a pack and may not open the fixtures or the harness's build directory (an
audit hook enforces it). The harness then takes nothing from the engine but the source text: it compiles that itself,
makes its own symbol map from what it knows of the image, and lets upstream's comparator judge.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
pytest.importorskip("z3", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

ROOT = Path(__file__).resolve().parents[2]

GUARD = r"""
import os, sys
forbidden = [os.path.normcase(os.path.abspath(p)) for p in {forbidden!r}]
def guard(event, args):
    if event in ("open", "os.listdir", "os.scandir") and args and isinstance(args[0], (str, bytes, os.PathLike)):
        p = os.path.normcase(os.path.abspath(os.fsdecode(args[0])))
        if any(p == f or p.startswith(f + os.sep) for f in forbidden):
            raise PermissionError("the engine may not read this")
    if event.startswith("socket."):
        raise PermissionError("the engine is offline")
sys.addaudithook(guard)
"""
RUN = GUARD + """
sys.argv = ["recon"] + {argv!r}
from recon.cli.main import main
raise SystemExit(main())
"""


def engine(target, toolchain, worktree, out: Path, functions=(), seed="0", forbidden=None, extra=()):
    argv = ["reconstruct", "--pack", str(target.s.pack), "--worktree", str(worktree), "--recipe", str(toolchain.path), *toolchain.location,
            "--work", str(out / "work"), "--out", str(out / "out"), *extra]
    for rva in functions:
        argv += ["--function", hex(rva)]
    code = RUN.format(forbidden=[str(ROOT / "tests"), str(target.work)] if forbidden is None else forbidden, argv=argv)
    import os

    env = {**os.environ, "PYTHONHASHSEED": seed}
    p = subprocess.run([sys.executable, "-B", "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return p, (json.loads((out / "out/result.json").read_text()) if (out / "out/result.json").is_file() else None)


class Target:
    def __init__(self, s, work, image):
        self.s, self.work, self.image = s, work, image
        self.at = {rva: n for n, (rva, _s) in s.names.items()}


def _build(toolchain, worktree, base: Path, sources, targets, declared=None) -> Target:
    sys.path[:0] = [str(worktree / "tools/verifier"), str(worktree / "tools")]
    import synth

    s = synth.build(toolchain.tool, toolchain.flags, base / "build", base / "pack", sources, targets, declared)
    return Target(s, base / "build", (base / "pack/image.bin").read_bytes())


@pytest.fixture(scope="module")
def target(toolchain, upstream_worktree, tmp_path_factory):
    return _build(toolchain, upstream_worktree, tmp_path_factory.mktemp("targets"), ("targets.cpp", "callees.cpp"), "targets.cpp")


@pytest.fixture(scope="module")
def held(toolchain, upstream_worktree, tmp_path_factory):
    return _build(toolchain, upstream_worktree, tmp_path_factory.mktemp("held"), ("heldout.cpp", "heldout_callees.cpp"), "heldout.cpp")


@pytest.fixture(scope="module")
def done(target, toolchain, upstream_worktree, tmp_path_factory):
    out = tmp_path_factory.mktemp("engine")
    p, res = engine(target, toolchain, upstream_worktree, out)
    assert p.returncode in (0, 1), p.stderr
    return out / "out", res


def judge(target, toolchain, worktree, rva, text: str, where: Path, size=None, wrong=()):
    """Upstream's verdict on a source text, by the harness's own means; None when it does not compile."""
    import pecoff

    from recon.adapters.skyrim.verify import Verifier

    where.mkdir(parents=True, exist_ok=True)
    (where / "unit.cpp").write_bytes(text.encode("ascii"))
    code, _out = toolchain.tool.run("cl", [*toolchain.flags, "unit.cpp"], where)
    if code:
        return None
    blob = (where / "unit.obj").read_bytes()
    own = None
    symbols = {}
    for s in pecoff.CoffObject(blob).symbols.values():
        m = re.match(r"\?(?:Function|g_data)([0-9A-F]+)@@", s.name)
        if m:
            at = int(m.group(1), 16)
            if at == rva:
                own = s.name
            symbols[s.name] = (at + dict(wrong).get(at, 0), target.s.sizes.get(at))
        elif s.name in target.s.data:
            symbols[s.name] = (target.s.data[s.name], None)
        elif s.name in target.s.decorated:      # the linker map's own name: the harness's evidence, not the engine's
            at = target.s.decorated[s.name]
            symbols[s.name] = (at + dict(wrong).get(at, 0), target.s.sizes.get(at))
    assert own is not None
    v = Verifier(worktree, "synthetic", target.image, toolchain.recipe)
    return v.verify(rva, size or target.s.sizes[rva], own, text.encode("ascii"), blob, symbols)


def by_name(target, res) -> dict:
    return {target.at[int(f["rva"], 0)]: f for f in res["functions"] if int(f["rva"], 0) in target.at}


#: what the header of external.cpp's callees says of them: plain name -> (params, result), each [kind, width, sign]
EXTERNAL = {"Scaled": ([["i", 32, "signed"]], ["i", 32, "signed"]),
            "Mixed": ([["i", 32, "unsigned"], ["i", 32, "signed"]], ["i", 32, "unsigned"])}


@pytest.fixture(scope="module")
def external(toolchain, upstream_worktree, tmp_path_factory):
    return _build(toolchain, upstream_worktree, tmp_path_factory.mktemp("external"), ("external.cpp", "external_callees.cpp"), "external.cpp", EXTERNAL)


# ------------------------------------------------------------------------------------ the gate

@pytest.mark.parametrize("name", ["Total", "Withdraw"])
def test_a_function_with_branches_members_and_a_call_is_reconstructed_and_verified(name, done, target, toolchain, upstream_worktree, tmp_path):
    out, res = done
    f = by_name(target, res)[name]
    assert f["state"] == "BYTE_MATCHED" and f["reason"] == "all-checks-passed"
    text = (out / f["source"]).read_text()
    assert re.search(r"\b(if|while)\b", text) and "->" in text and len(re.findall(r"\bFunction[0-9A-F]+\(", text)) >= 3
    rep = judge(target, toolchain, upstream_worktree, target.s.names[name][0], text, tmp_path)
    assert rep["result"] == "pass" and rep["reason"] == "all-checks-passed"


def test_every_match_the_engine_reports_is_one_for_the_harness(done, target, toolchain, upstream_worktree, tmp_path):
    out, res = done
    fs = by_name(target, res)
    assert len(fs) == 18 and all(f["state"] == "BYTE_MATCHED" for f in fs.values()), {n: f["reason"] for n, f in fs.items() if f["state"] != "BYTE_MATCHED"}
    for n, f in fs.items():
        rep = judge(target, toolchain, upstream_worktree, int(f["rva"], 0), (out / f["source"]).read_text(), tmp_path / n)
        assert rep["result"] == "pass", (n, rep["reason"])


def test_the_held_out_functions_are_matched_or_refused_by_name(held, toolchain, upstream_worktree, tmp_path):
    """No number is asked of these but the ones reached: what is claimed must hold, what is not must have a reason, and nothing may break."""
    p, res = engine(held, toolchain, upstream_worktree, tmp_path)
    assert p.returncode == 1, p.stderr
    fs = by_name(held, res)
    assert len(fs) == 16
    for n, f in fs.items():
        assert f["reason"] != "ENGINE_ERROR", n
        if f["state"] == "BYTE_MATCHED":
            rep = judge(held, toolchain, upstream_worktree, int(f["rva"], 0), (tmp_path / "out" / f["source"]).read_text(), tmp_path / n)
            assert rep["result"] == "pass", (n, rep["reason"])
        else:
            assert re.fullmatch(r"[A-Z_]+", f["reason"]), f["reason"]
    assert sum(f["state"] == "BYTE_MATCHED" for f in fs.values()) >= 11


@pytest.mark.parametrize("name,callee", [("Halved", "Scaled"), ("Offset", "Scaled"), ("Stir", "Mixed")])
def test_a_function_calling_a_declared_external_function_is_matched(name, callee, external, toolchain, upstream_worktree, tmp_path):
    """Phase 7 gate (D1): the call is to the declared name, bound by the declaration and the linker map, and the
    harness's comparator, with the map's own decorated names, passes it."""
    rva = external.s.names[name][0]
    p, res = engine(external, toolchain, upstream_worktree, tmp_path, [rva])
    f = res["functions"][0]
    assert f["state"] == "BYTE_MATCHED" and f["reason"] == "all-checks-passed", (f, p.stderr[-2000:])
    text = (tmp_path / "out" / f["source"]).read_text()
    assert re.search(rf"\b{callee}\(", text) and not re.search(r"\bFunction[0-9A-F]+\(", text.replace(f["source"][:-4] + "(", ""))
    rep = judge(external, toolchain, upstream_worktree, rva, text, tmp_path / "judge")
    assert rep["result"] == "pass" and rep["reason"] == "all-checks-passed"
    # the harness's binding of the declared name is what passes it: moved elsewhere, it fails
    callee_rva = external.s.decorated[next(n for n in external.s.decorated if n.startswith(f"?{callee}@@"))]
    rep = judge(external, toolchain, upstream_worktree, rva, text, tmp_path / "wrong", wrong=[(callee_rva, 16)])
    assert rep["result"] != "pass"


@pytest.mark.parametrize("where", ["Offset", "Mixed"])
def test_a_declaration_names_only_the_function_it_is_placed_at(where, external, toolchain, upstream_worktree, tmp_path):
    """A declaration is evidence, not a fit. Placed at another function (one of its own, or one another declaration
    already names, which makes both ambiguous), it does not name the function the code calls, whatever the bytes."""
    d = json.loads(external.s.pack.read_text())
    rva, size = external.s.names[where] if where in external.s.names else next((x["rva"], x["size"]) for x in d["declarations"] if x["symbol"].startswith(f"?{where}@@"))
    d["declarations"] = [{**x, "rva": rva, "size": size} if x["symbol"].startswith("?Scaled@@") else x for x in d["declarations"]]
    e = tmp_path / "pack"
    e.mkdir()
    (e / "image.bin").write_bytes(external.image)
    (e / "pack.json").write_text(json.dumps(d))
    from types import SimpleNamespace

    t = SimpleNamespace(s=SimpleNamespace(pack=e / "pack.json"), work=external.work)
    fns = [external.s.names["Halved"][0], external.s.names["Stir"][0]]
    _p, res = engine(t, toolchain, upstream_worktree, tmp_path, fns)
    for f in res["functions"]:
        assert f["reason"] != "ENGINE_ERROR", f
        text = (tmp_path / "out" / f["source"]).read_text() if f.get("source") else ""
        assert "Scaled(" not in text, text
        if where == "Mixed":
            assert "Mixed(" not in text, text
        if f["state"] == "BYTE_MATCHED":       # under the names the code gives callees, which the harness checks too
            assert judge(external, toolchain, upstream_worktree, int(f["rva"], 0), text, tmp_path / f["rva"])["result"] == "pass"


BUDGETED = ("Total", "Withdraw", "Clamp")


@pytest.mark.parametrize("kind", ["candidates", "compiles", "expansions", "irNodes"])
def test_each_budget_set_to_one_bounds_its_counter(kind, target, toolchain, upstream_worktree, tmp_path):
    """Phase 7 gate (D3), through the command and the real compiler."""
    rvas = [target.s.names[n][0] for n in BUDGETED]
    p, res = engine(target, toolchain, upstream_worktree, tmp_path, rvas, extra=["--budget", f"{kind}=1"])
    assert p.returncode in (0, 1), p.stderr
    for f in res["functions"]:
        assert f["counters"][f"budget_{kind}"] <= 1 and f["counters"][f"limit_{kind}"] == 1, f
        assert f["state"] == "BYTE_MATCHED" or (f["reason"] == "BUDGET_EXHAUSTED" and f["exhausted"] == kind), f
    assert any(f["reason"] == "BUDGET_EXHAUSTED" for f in res["functions"])


def test_a_search_resumed_from_its_saved_frontier_equals_an_uninterrupted_one(done, target, toolchain, upstream_worktree, tmp_path):
    _out, whole = done
    rva = target.s.names["Withdraw"][0]
    _p, cut = engine(target, toolchain, upstream_worktree, tmp_path / "cut", [rva], extra=["--budget", "compiles=1", "--frontiers", str(tmp_path / "f")])
    assert cut["functions"][0]["reason"] == "BUDGET_EXHAUSTED" and cut["functions"][0]["frontier"]
    _p, resumed = engine(target, toolchain, upstream_worktree, tmp_path / "resumed", [rva], extra=["--frontiers", str(tmp_path / "f")])
    a = dict(resumed["functions"][0])
    assert a.pop("resumed") == cut["functions"][0]["frontier"]
    b = next(f for f in whole["functions"] if int(f["rva"], 0) == rva)
    assert a == b


@pytest.fixture(scope="module")
def filtered(toolchain, upstream_worktree, tmp_path_factory):
    return _build(toolchain, upstream_worktree, tmp_path_factory.mktemp("filtered"), ("filtered.cpp", "filtered_callees.cpp"), "filtered.cpp")


def test_the_execution_check_rejects_nothing_the_comparator_passes(target, held, external, filtered, toolchain, upstream_worktree, tmp_path):
    """D8: every tree the execution check rejects, on every synthetic corpus, compiled and compared. Kept as a regression
    test: a false rejection fails it."""
    import os

    total = {}
    for name, t in (("targets", target), ("heldout", held), ("external", external), ("filtered", filtered)):
        argv = ["measure-filter", "--pack", str(t.s.pack), "--worktree", str(upstream_worktree), "--recipe", str(toolchain.path), *toolchain.location,
                "--work", str(tmp_path / name / "work"), "--out", str(tmp_path / name)]
        code = RUN.format(forbidden=[str(ROOT / "tests"), str(t.work)], argv=argv)
        p = subprocess.run([sys.executable, "-B", "-c", code], cwd=ROOT, env={**os.environ, "PYTHONHASHSEED": "0"}, capture_output=True, text=True, timeout=1800)
        rep = json.loads((tmp_path / name / "filter-audit.json").read_text())
        assert p.returncode == 0 and rep["false_rejections"] == 0, (name, rep, p.stderr[-2000:])
        for k in ("functions", "accepted", "rejected", "compiled", "no_known_difference", "false_rejections"):
            total[k] = total.get(k, 0) + rep[k]
        for k, n in rep["rejected_why"].items():
            total["why:" + k] = total.get("why:" + k, 0) + n
    print("D8 synthetic", json.dumps(total, sort_keys=True))
    # the measurement ran on what the check rejected (measured at Phase 7: 1 rejected tree of 279, which does not compile)
    assert total["rejected"] >= 1 and total["accepted"] > 100 * total["rejected"] // 2, total


# ------------------------------------------------------------------------------------ that it could fail

def test_the_engine_cannot_read_the_fixtures(target, toolchain, upstream_worktree, tmp_path):
    code = GUARD.format(forbidden=[str(ROOT / "tests")]) + f"open({str(ROOT / 'tests/fixtures/cpp/targets.cpp')!r})"
    p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert p.returncode and "may not read this" in p.stderr
    p = subprocess.run([sys.executable, "-c", GUARD.format(forbidden=[]) + "import socket; socket.socket()"], capture_output=True, text=True)
    assert p.returncode and "offline" in p.stderr
    # the hook is on the engine itself: with its pack forbidden it cannot start
    p, res = engine(target, toolchain, upstream_worktree, tmp_path, forbidden=[str(target.s.pack.parent)])
    assert p.returncode == 2 and res is None


WRONG = [("Total", r"\b(\d+)\b(?= *[);])", lambda m: str(int(m.group(1)) + 1)), ("Withdraw", r"\|= 8", lambda m: "|= 16"), ("Withdraw", r"return true", lambda m: "return false"),
         ("Withdraw", r"<= 0", lambda m: "< 0"), ("Withdraw", r"-arg2", lambda m: "arg2"), ("Withdraw", r"member8", lambda m: "member4"),
         ("Clamp", r">", lambda m: ">="), ("Hash", r"(\d+)u?(?=;)", lambda m: "7"), ("Weigh", r"\*", lambda m: "+")]


@pytest.mark.parametrize("k", range(len(WRONG)))
def test_a_wrong_source_does_not_pass(k, done, target, toolchain, upstream_worktree, tmp_path):
    name, what, by = WRONG[k]
    out, res = done
    f = by_name(target, res)[name]
    text = (out / f["source"]).read_text()
    head, body = text.rsplit("\n{\n", 1)
    wrong = re.sub(what, by, body, count=1)
    if wrong == body:
        pytest.skip("this source has nothing of the kind to change")
    rep = judge(target, toolchain, upstream_worktree, int(f["rva"], 0), head + "\n{\n" + wrong, tmp_path)
    assert rep is None or rep["result"] != "pass"


def test_a_call_to_another_function_does_not_pass(done, target, toolchain, upstream_worktree, tmp_path):
    out, res = done
    f = by_name(target, res)["Withdraw"]
    text = (out / f["source"]).read_text()
    callee = int(re.search(r"Function([0-9A-F]+)\(Class1\* arg1, \w+ ?\w* arg2\);", text).group(1), 16)
    rep = judge(target, toolchain, upstream_worktree, int(f["rva"], 0), text, tmp_path, wrong=[(callee, 16)])
    assert rep["result"] != "pass"


def test_the_engine_does_not_claim_a_match_for_an_extent_that_is_wrong(target, toolchain, upstream_worktree, tmp_path):
    """A function cut short is refused or fails; it never passes."""
    p = target.s.pack
    d = json.loads(p.read_text())
    rva, size = target.s.names["Withdraw"]
    for cut in (1, 5, size // 2):
        e = tmp_path / f"cut{cut}"
        e.mkdir()
        (e / "image.bin").write_bytes(target.image)
        (e / "pack.json").write_text(json.dumps({**d, "functions": [{**x, "size": x["size"] - (cut if x["rva"] == rva else 0)} for x in d["functions"]]}))
        from types import SimpleNamespace

        t = SimpleNamespace(s=SimpleNamespace(pack=e / "pack.json"), work=target.work)
        _p, res = engine(t, toolchain, upstream_worktree, e, [rva])
        assert res["functions"][0]["state"] != "BYTE_MATCHED" and res["functions"][0]["reason"] != "ENGINE_ERROR", res["functions"][0]


# ------------------------------------------------------------------------------------ determinism and form

def test_the_same_input_gives_the_same_bytes(done, target, toolchain, upstream_worktree, tmp_path):
    out, _res = done
    rvas = [target.s.names[n][0] for n in ("Total", "Withdraw", "Root", "Clamp")]
    _p, a = engine(target, toolchain, upstream_worktree, tmp_path / "a", rvas, seed="1")
    _p, b = engine(target, toolchain, upstream_worktree, tmp_path / "b", rvas, seed="2")
    assert a == b
    for r in rvas:
        n = f"Function{r:X}.cpp"
        assert (tmp_path / "a/out" / n).read_bytes() == (tmp_path / "b/out" / n).read_bytes() == (out / n).read_bytes()


def test_what_is_written_is_ordinary_source(done):
    out, res = done
    bad = re.compile(r"__asm|_emit|#pragma|volatile|reinterpret_cast|__declspec|naked|param_\d|iVar|local_[0-9a-f]+|undefined\d?\b|goto|//|/\*|\(\w+ ?\*\)")
    for f in res["functions"]:
        if f["state"] == "BYTE_MATCHED":
            text = (out / f["source"]).read_text()
            assert not bad.search(text), (f["source"], bad.search(text))


def test_a_pinned_real_image_is_refused(real_image, toolchain, upstream_worktree, tmp_path):
    from types import SimpleNamespace

    import os

    image = real_image.origin[0]
    d = tmp_path / "pack"
    d.mkdir()
    (d / "pack.json").write_text(json.dumps({"schema": 1, "build_id": "x", "image": os.path.relpath(image, d) if os.path.splitdrive(image)[0] == os.path.splitdrive(str(d))[0] else image,
                                             "image_sha256": real_image.sha256, "functions": []}))
    p, res = engine(SimpleNamespace(s=SimpleNamespace(pack=d / "pack.json"), work=tmp_path / "none"), toolchain, upstream_worktree, tmp_path)
    assert p.returncode == 2 and res is None and "synthetic" in p.stderr


# ------------------------------------------------------------------------------------ the compiler as an oracle

def compiler(toolchain, work):
    from recon.adapters.x64_msvc.batch import Compiler

    return Compiler(toolchain.tool, toolchain.flags, work)


GOOD = "int FunctionA(int arg1)\n{\n    return arg1 + 1;\n}\n"


def test_a_candidate_that_does_not_compile_does_not_lose_the_batch(toolchain, tmp_path):
    from recon.adapters.x64_msvc import coff

    c = compiler(toolchain, tmp_path)
    bad = "int FunctionA(int arg1)\n{\n    return arg2;\n}\n"
    open_brace = "int FunctionA(int arg1)\n{\n    if (arg1) {\n    return 1;\n}\n"
    other = GOOD.replace("+ 1", "* 5")
    r = c.batch([("FunctionA", x) for x in (GOOD, bad, other, open_brace, GOOD)])
    assert [x.function is not None for x in r] == [True, False, True, False, True]
    assert r[1].errors == ("C2065",) and r[3].errors
    assert r[0].function.key(coff.plain) == r[4].function.key(coff.plain) != r[2].function.key(coff.plain)
    assert c.batch([("FunctionB", GOOD)])[0].function is None       # it does not define what it should
    assert c.batch([]) == []


def test_a_namespace_changes_nothing_of_the_code(done, toolchain, tmp_path):
    """The batch form and the exact form of every source the engine wrote."""
    from recon.adapters.x64_msvc import coff

    out, res = done
    c = compiler(toolchain, tmp_path)
    units = [(f["source"][:-4], (out / f["source"]).read_text()) for f in res["functions"] if f["state"] == "BYTE_MATCHED"]
    for (name, text), b in zip(units, c.batch(units)):
        e = c.exact(name, text)
        assert e.function.key(coff.plain) == b.function.key(coff.plain), name
    assert c.exact("FunctionA", "int FunctionA(") is None


def test_distance_is_zero_only_for_the_same_code(toolchain, tmp_path):
    from recon.adapters.x64_msvc.batch import distance

    c = compiler(toolchain, tmp_path)
    a, b, d = (x.function for x in c.batch([("FunctionA", GOOD), ("FunctionA", GOOD.replace("+ 1", "+ 2")), ("FunctionA", "int FunctionC(int);\nint FunctionA(int arg1)\n{\n    return FunctionC(arg1) + 1;\n}\n")]))
    assert distance(a, a.code, 0x1000, lambda r: None).total == 0
    assert distance(b, a.code, 0x1000, lambda r: None).total == 1
    code = bytearray(d.code)
    o = d.relocs[0].offset
    code[o:o + 4] = (0x2000 - (0x1000 + o + 4)).to_bytes(4, "little", signed=True)
    assert distance(d, bytes(code), 0x1000, lambda r: 0x2000).total == 0
    assert distance(d, bytes(code), 0x1000, lambda r: 0x2010).references == 1
    # a reference nothing names is not a known difference: it is counted apart, and the verifier decides
    assert (distance(d, bytes(code), 0x1000, lambda r: None).total, distance(d, bytes(code), 0x1000, lambda r: None).unknown) == (0, 1)
    assert distance(d, bytes(code[:-1]) + b"\xcc", 0x1000, lambda r: None).total >= 1     # and one that is, is
    assert distance(d, a.code, 0x1000, lambda r: 0x2000).total > 1


def test_reason_codes_are_read_from_upstream(upstream_worktree):
    from recon.adapters.skyrim.verify import SOURCES, reason_codes

    codes = reason_codes(str(upstream_worktree))
    assert "all-checks-passed" in codes and len(codes) > 20 and all(re.fullmatch(r"[a-z0-9-]+", c) for c in codes), codes
    # every literal that looks like a reason in a raise is in the list
    for rel in SOURCES:
        for m in re.finditer(r"raise Reject\(\s*[\"']([^\"']+)[\"']", (upstream_worktree / rel).read_text(encoding="utf-8")):
            assert m.group(1) in codes
