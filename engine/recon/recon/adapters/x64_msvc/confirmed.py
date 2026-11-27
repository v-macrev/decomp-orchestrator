# SPDX-License-Identifier: AGPL-3.0-or-later
"""Under which recipes each rule of the knowledge base (core/synthesis/rules.py) is confirmed.

A recipe is named as upstream names it (`reconstruction/recipes/<name>.json`). A rule is listed for a recipe only after
its experiments (`tests/fixtures/cpp/p9_rules.cpp`) were compiled under that recipe and every positive pair differed
in a kind of the rule's `effect` and every negative pair did not (`tests/unit/test_p9_rules.py`, which fails when a
listed rule no longer holds). A rule confirmed under one recipe is not confirmed under another until its experiments
pass there: the search then never chooses it by a mismatch kind, though it stays reachable.
"""
from __future__ import annotations

from recon.core.synthesis import rules as RL

O2 = "msvc-19.16.27054-o2"

#: recipe -> the ids of the rules confirmed under it
CONFIRMED: dict[str, frozenset[str]] = {
    O2: frozenset(r.id for r in RL.RULES),
}


def confirmed(recipe: str | None) -> frozenset[str]:
    """The rules confirmed under `recipe` (a recipe file's name or path); none for a recipe with no experiments."""
    if not recipe:
        return frozenset()
    name = recipe.replace("\\", "/").rsplit("/", 1)[-1]
    return CONFIRMED.get(name[:-5] if name.endswith(".json") else name, frozenset())


__all__ = ["CONFIRMED", "O2", "confirmed"]
