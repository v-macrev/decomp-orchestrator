# SPDX-License-Identifier: AGPL-3.0-or-later
"""Controlled synthetic mismatches (Phase 9 gate): each target's canonical candidate compiles to a known MISMATCH kind,
and the directed search resolves it with a rule trail that starts in a family that kind maps to. Every match is judged
by upstream's comparator through the engine's verifier; the harness builds the image from original fixtures."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
pytest.importorskip("z3", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

from recon.core.synthesis import kinds as K  # noqa: E402
from recon.core.synthesis import rules as RL  # noqa: E402
from recon.core.synthesis import search  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ("p9_mismatch.cpp", "p9_mismatch_callees.cpp")

#: target -> the kind of its canonical candidate's difference (each resolved by a rule)
RESOLVED = {"OneExit": K.POLARITY, "OneExitValue": K.POLARITY, "Mirrored": K.POLARITY, "ArmsSwapped": K.REGISTERS,
            "UnsignedShift": K.BLOCKS, "Remainder": K.CONSTANT, "ArmsTail": K.CALL, "ShiftFirst": K.CALL}
#: target -> its kind, where no rule resolves it yet: it stays a MISMATCH of that kind
UNRESOLVED = {"CountChain": K.SELECTION}


def _setup(toolchain, worktree, base: Path):
    sys.path[:0] = [str(worktree / "tools/verifier"), str(worktree / "tools"), str(ROOT / "tests")]
    import synth

    from recon.adapters.skyrim import pack as pk
    from recon.adapters.skyrim.verify import Verifier
    from recon.adapters.x64_msvc import validate as v

    s = synth.build(toolchain.tool, toolchain.flags, base / "build", base / "pack", SOURCES, SOURCES[0])
    pack = pk.Pack.load(str(s.pack), str(worktree), v.load_validated())
    return s, pack, Verifier(worktree, pack.build_id, pack.image.pe.blob, toolchain.recipe)


@pytest.fixture(scope="module")
def built(toolchain, upstream_worktree, tmp_path_factory):
    return (*_setup(toolchain, upstream_worktree, tmp_path_factory.mktemp("p9")), toolchain)


def solve(built, name: str, work: Path):
    from recon.adapters.skyrim import pack as pk
    from recon.adapters.x64_msvc.batch import Compiler

    s, pack, verifier, toolchain = built
    rva = s.names[name][0]
    shop = pk.Workshop(pack, rva, Compiler(toolchain.tool, toolchain.flags, work), verifier)
    judged: list[search.Judged] = []
    real = shop.judge

    def judge(cs):
        out = real(cs)
        judged.extend(out)
        return out
    shop.judge = judge
    r = search.reconstruct(pack.program(), pack.image.image_base + rva, shop)
    return r, judged, shop


@pytest.mark.parametrize("name", sorted(RESOLVED))
def test_a_controlled_mismatch_is_resolved_with_its_rule_trail(name, built, tmp_path):
    r, judged, shop = solve(built, name, tmp_path)
    kind = RESOLVED[name]
    assert judged[0].distance > 0 and judged[0].kind == kind, judged[0]
    assert r.state == search.BYTE_MATCHED and r.reason == "all-checks-passed", (r.state, r.reason, r.trail)
    assert shop.report["result"] == "pass"
    assert r.trail and all(s.split(":")[0] in RL.BY_ID for s in r.trail)
    assert RL.BY_ID[r.trail[0].split(":")[0]].family in RL.directed(kind), r.trail
    assert r.counters["expanded_directed"] >= 1


@pytest.mark.parametrize("name", sorted(UNRESOLVED))
def test_a_mismatch_no_rule_resolves_keeps_its_kind(name, built, tmp_path):
    r, judged, _shop = solve(built, name, tmp_path)
    assert r.state == search.COMPILED and r.reason == K.code(UNRESOLVED[name]) and r.kind == UNRESOLVED[name]
    assert r.counters["grammar_exhausted"] == 1 and r.nearest and r.nearest > 0


ORDER = """
import json, sys
sys.path[:0] = {paths!r}
from pathlib import Path
import test_p9_synthesis as t
from types import SimpleNamespace
tc = SimpleNamespace(**json.loads({tc!r}))
from recon.adapters.x64_msvc import cl
tc.tool = cl.discover(None if tc.toolset else tc.checkout, tc.sha, tc.toolset)
tc.recipe = Path(tc.path).read_bytes()
built = (*t._setup(tc, Path({wt!r}), Path({base!r})), tc)
r, judged, _ = t.solve(built, {name!r}, Path({base!r}) / "work")
print(json.dumps([r.state, list(r.trail), [[j.key, j.distance, j.kind] for j in judged]]))
"""


def test_candidate_order_is_the_same_under_any_hash_seed(toolchain, upstream_worktree, tmp_path):
    """Contract C4: the same inputs give the same candidates in the same order in another process and hash seed."""
    tc = json.dumps({"flags": toolchain.flags, "path": str(toolchain.path), "checkout": str(os.environ.get("RECON_CHECKOUT", Path.home() / "skyrim_decomp")),
                     "toolset": os.environ.get("RECON_MSVC"), "sha": json.loads(Path(toolchain.path).read_bytes())["compiler"]["binary_sha256"]})
    outs = []
    for seed in ("0", "77"):
        code = ORDER.format(paths=[str(ROOT / "tests" / "unit"), str(ROOT / "tests")], tc=tc, wt=str(upstream_worktree), base=str(tmp_path / seed),
                            name="ArmsSwapped")
        p = subprocess.run([sys.executable, "-B", "-c", code], cwd=ROOT, env={**os.environ, "PYTHONHASHSEED": seed}, capture_output=True, text=True,
                           timeout=900)
        assert p.returncode == 0, p.stderr[-2000:]
        outs.append(p.stdout.strip().splitlines()[-1])
    assert outs[0] == outs[1]
    assert json.loads(outs[0])[0] == search.BYTE_MATCHED
