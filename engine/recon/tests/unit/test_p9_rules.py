# SPDX-License-Identifier: AGPL-3.0-or-later
"""The compiler knowledge base: its shape, its kind-to-family map, and its rules confirmed by compiling their experiments."""
import json
import re
from dataclasses import dataclass
from pathlib import Path

import pytest

from recon.core.synthesis import kinds as K
from recon.core.synthesis import rules as R
from recon.core.synthesis.candidates import Choice
from recon.adapters.x64_msvc import confirmed

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "cpp" / "p9_rules.cpp"


def cases_in_fixture() -> set[str]:
    return {m.group(1) for m in re.finditer(r"\b(\w+)Before\(", FIXTURE.read_text())}


def test_every_rule_is_complete_and_unique():
    assert len({r.id for r in R.RULES}) == len(R.RULES)
    have = cases_in_fixture()
    for r in R.RULES:
        assert r.preconditions and r.transformation and r.meaning and r.codegen and r.limits, r.id
        assert r.effect and all(k in K.KINDS for k in (*r.effect, *r.related)), r.id
        assert len(r.positive) >= 2, f"{r.id}: a rule needs a second synthetic case"
        assert r.negative, r.id
        assert set(r.positive) | set(r.negative) <= have, r.id


def test_every_kind_has_families_and_the_map_is_ordered():
    for k in K.KINDS:
        assert R.directed(k), k
        assert set(R.directed(k)).isdisjoint(R.rest(k))
        assert set(R.directed(k)) | set(R.rest(k)) == set(R.FAMILY_ORDER)
    # confirmed families come before related ones
    assert R.FAMILIES[K.POLARITY][0] == "exit-arrangement"
    assert R.directed(None) == R.FAMILY_ORDER and R.rest(None) == ()


def test_the_digest_moves_with_any_rule():
    from dataclasses import replace

    d = R.digest()
    assert d == R.digest()
    old = R.RULES
    try:
        R.RULES = (replace(old[0], preconditions="other"), *old[1:])
        assert R.digest() != d
    finally:
        R.RULES = old


@dataclass
class Ctx:
    open: int = 2
    compared: int = 2
    results: int = 2
    readings: tuple = (1, 0, 2)


def test_rules_apply_once_and_in_a_fixed_order():
    c = Choice()
    first = list(R.expand(c, R.FAMILY_ORDER, Ctx()))
    assert first == list(R.expand(c, R.FAMILY_ORDER, Ctx()))
    steps = [s for _c, s in first]
    assert len(steps) == len(set(steps))
    assert {s.split(":")[0] for s in steps} == {r.id for r in R.RULES}
    # a rule already applied does not apply again
    for child, step in first:
        assert step not in [s for _c, s in R.expand(child, R.FAMILY_ORDER, Ctx())]
    # the changes a rule makes are those the generator names it by
    for child, step in first:
        name = R.BY_ID[step.split(":")[0]].name
        made = {x.split(":")[0] for x in child.changes()}
        assert name in made or name.rsplit("-", 1)[0] in made, step


def test_every_change_the_generator_can_make_is_a_rule():
    names = {r.name for r in R.RULES}
    from recon.core.structuring.regions import Style

    c = Choice(1, Style(False, "if", True, (0,)), False, False, True, (0,), ((0, 0),))
    for x in c.changes():
        n = x.split(":")[0]
        n = {"mirror": "mirror-one" if x != "mirror:all" else "mirror"}.get(n, n)
        assert n in names or x.split(":")[0] in names, x


# ------------------------------------------------------------------------------------------- experiments

@pytest.fixture(scope="module")
def compiled(toolchain, tmp_path_factory):
    pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
    from recon.adapters.x64_msvc import experiments as ex

    recipe = Path(toolchain.path).stem
    pairs = sorted({c for r in R.RULES for c in (*r.positive, *r.negative)})
    out = ex.run(toolchain.tool, toolchain.flags, tmp_path_factory.mktemp("rules"), "p9_rules", FIXTURE.read_text(),
                 [(f"{c}Before", f"{c}After") for c in pairs])
    return recipe, {p.before[:-len("Before")]: p for p in out}


@pytest.mark.parametrize("rule", [r.id for r in R.RULES])
def test_each_rule_is_confirmed_under_its_recipe(rule, compiled):
    recipe, pairs = compiled
    r = R.BY_ID[rule]
    assert rule in confirmed.CONFIRMED.get(recipe, ()), f"{rule} is not claimed for {recipe}"
    for c in r.positive:
        p = pairs[c]
        assert not p.equal, f"{rule}: {c} compiles identically"
        assert p.mismatch.kind in r.effect, (rule, c, p.mismatch)
    for c in r.negative:
        assert pairs[c].equal, f"{rule}: negative {c} compiles differently ({pairs[c].mismatch})"
    seen = {pairs[c].mismatch.kind for c in r.positive}
    assert set(r.effect) <= seen, f"{rule}: effect {sorted(set(r.effect) - seen)} not shown by any positive case"


def test_experiments_report_counts_only(compiled):
    _recipe, pairs = compiled
    text = json.dumps({c: [p.equal, p.mismatch.kind if p.mismatch else None] for c, p in pairs.items()})
    assert "0x" not in text


def test_a_rule_not_confirmed_under_the_recipe_is_never_directed_but_stays_reachable():
    head, tail = R.tiers(K.POLARITY, frozenset({"P9-R005"}))
    assert [r.id for r in head] == ["P9-R005"]
    assert {r.id for r in tail} == {r.id for r in R.RULES} - {"P9-R005"}
    head, tail = R.tiers(K.POLARITY, None)
    assert {r.family for r in head} == set(R.directed(K.POLARITY)) and head[0].family == "exit-arrangement"
    assert confirmed.confirmed("reconstruction/recipes/msvc-19.16.27054-o2.json") == frozenset(r.id for r in R.RULES)
    assert confirmed.confirmed("reconstruction/recipes/o2-os.json") == frozenset() and confirmed.confirmed(None) == frozenset()
