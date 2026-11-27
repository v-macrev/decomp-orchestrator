# SPDX-License-Identifier: AGPL-3.0-or-later
"""The cost of the whole-program analysis, measured: cold, warm and incremental workloads on a store of their own, with
reads, writes, hits and each part's own time, and the facts they leave unchanged by measuring."""
import time

import pytest

pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")

from test_knowledge import BASE, chain, program  # noqa: E402

from recon.adapters.skyrim import profile as pf  # noqa: E402
from recon.core import knowledge as kn  # noqa: E402
from recon.core.inference import whole  # noqa: E402

NS = {"normal": "n", **dict.fromkeys(kn.SITE_KINDS, "s"), "*": "a"}


class Pack:
    def __init__(self, fns, store=None):
        self.fns, self.store = fns, store

    def program(self):
        return program(*self.fns, store=self.store, universe=True)

    def functions(self):
        return sorted(BASE + f.rva for f in self.fns)


def test_a_sample_is_spread_over_the_functions_and_is_the_same_each_time():
    fns = list(range(100))
    assert pf.sample(fns, 4) == [0, 25, 50, 75] == pf.sample(fns, 4)
    assert pf.sample(fns, 0) == fns == pf.sample(fns, 500)


def test_a_part_is_charged_its_own_time_and_not_that_of_the_parts_it_calls():
    clock = pf.Clock()
    inner = clock.wrap("inner", lambda: time.sleep(0.05))
    outer = clock.wrap("outer", lambda: (time.sleep(0.02), inner(), inner()))
    outer()
    assert clock.calls == {"outer": 1, "inner": 2}
    assert 0.09 <= clock.own["inner"] < 0.2 and 0.015 <= clock.own["outer"] < 0.06


def test_cold_warm_and_incremental_are_measured_and_leave_the_same_facts(tmp_path):
    fns = chain(5)
    db = tmp_path / "profile.db"
    pack = Pack(fns)
    cold_store = kn.SqliteStore(db, NS)
    cold = pf.measure(pack, cold_store, pack.functions())
    facts = {k: {key: cold_store.get(k, key) for key in cold_store.keys(k)} for k in ("signature", "alternatives")}
    cold_store.close()
    assert cold["stats"]["signature_computed"] == 5 and cold["store_writes"]["signature"]["new"] == 5
    assert set(cold["parts_own_s"]) >= {"normal_forms", "scc_walk", "signature_inference"}
    assert whole.Program.signature is not None and not hasattr(whole.Program.normal, "__wrapped__")

    warm_store = kn.SqliteStore(db, NS)
    warm = pf.measure(pack, warm_store, pack.functions())
    warm_store.close()
    assert warm["stats"].get("signature_computed", 0) == 0 and warm["hit_ratio"]["signature"] == 1.0
    assert "signature" not in warm["store_writes"] or warm["store_writes"]["signature"]["new"] == 0
    assert warm["decode"]["signature"]["n"] >= 5

    inc_store = kn.SqliteStore(db, {**NS, "*": "a:incremental"})
    inc = pf.measure(pack, inc_store, pack.functions())
    again = {k: {key: inc_store.get(k, key) for key in inc_store.keys(k)} for k in ("signature", "alternatives")}
    inc_store.close()
    assert inc["stats"]["signature_computed"] == 5 and inc["stats"].get("normal_computed", 0) <= 5
    assert inc["hit_ratio"].get("callees", 1.0) == 1.0
    assert again == facts


def test_the_facts_of_a_sample_are_compared_with_another_store_read_only(tmp_path):
    fns = chain(4)
    pack = Pack(fns)
    full = kn.SqliteStore(tmp_path / "knowledge.db", NS)
    pf.measure(pack, full, pack.functions())
    full.close()
    sampled = kn.SqliteStore(tmp_path / "profile.db", NS)
    pf.measure(pack, sampled, pf.sample(pack.functions(), 2))
    sampled.close()
    agree = pf.agreement(str(tmp_path / "profile.db"), NS, str(tmp_path / "knowledge.db"))
    assert agree["signature"]["equal"] >= 2 and not any(r["different"] or r["absent"] for r in agree.values())

    other = kn.SqliteStore(tmp_path / "other.db", NS)
    other.put("signature", "nobody", None)
    other.close()
    assert pf.agreement(str(tmp_path / "other.db"), NS, str(tmp_path / "knowledge.db"))["signature"]["absent"] == 1


def test_leases_and_commits_are_counted(tmp_path):
    store = pf.MeteredStore(kn.SqliteStore(tmp_path / "k.db", NS))
    assert store.lease("scc", "x")
    store.release("scc", "x")
    with store.transaction():
        store.put("signature", "k", None)
        with store.transaction():
            store.put("signature", "j", None)
    assert store.writes["lease:scc"]["n"] == 1 and store.writes["release:scc"]["n"] == 1
    assert store.writes["commit"]["n"] == 1 and store.writes["signature"]["new"] == 2
