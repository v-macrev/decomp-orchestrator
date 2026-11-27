# SPDX-License-Identifier: AGPL-3.0-or-later
"""Compute lanes (C8): the limits of section 5, the shared lock, the lease, and a pool that follows them."""
import json
import os
import subprocess
import sys

import pytest

from recon.core import lanes as ln

GIB = ln.GIB
posix = pytest.mark.skipif(os.name == "nt", reason="the lanes are the POSIX machine's (flock, nice, affinity)")


def test_the_authoritative_lane_takes_three_workers_and_four_for_a_run_already_started():
    assert ln.plan(ln.AUTHORITATIVE, 4, True, (6 * GIB, 8 * GIB)).workers == 3
    assert ln.plan(ln.AUTHORITATIVE, 4, True, (6 * GIB, 8 * GIB), resumed=True).workers == 4
    assert ln.plan(ln.AUTHORITATIVE, 2, False, None).workers == 2
    assert ln.plan(ln.AUTHORITATIVE, 4, True, None).nice == 0


def test_a_heavy_development_run_is_one_niced_worker_capped_at_1_5_gib_while_a_lease_is_live():
    p = ln.plan(ln.HEAVY, 4, True, (6 * GIB, 8 * GIB))
    assert (p.workers, p.nice, p.cap) == (1, 19, 3 * GIB // 2)
    q = ln.plan(ln.HEAVY, 4, False, (7 * GIB, 8 * GIB), peak=GIB)
    assert (q.workers, q.nice, q.cap) == (2, 19, None)             # otherwise up to two
    assert ln.plan(ln.HEAVY, 4, False, (3 * GIB, 8 * GIB), peak=2 * GIB).workers == 1    # what memory allows, never 0
    assert ln.plan(ln.HEAVY, 1, False, (7 * GIB, 8 * GIB)).workers == 1


def test_a_light_run_is_one_processor_and_yields_while_a_lease_is_live():
    assert (ln.plan(ln.LIGHT, 3, True, None).workers, ln.plan(ln.LIGHT, 3, True, None).nice, ln.plan(ln.LIGHT, 3, True, None).cpus) == (1, 19, 1)
    assert ln.plan(ln.LIGHT, 3, False, None).nice == 0
    with pytest.raises(ValueError):
        ln.plan("fast", 1, False, None)


def test_a_lease_counts_only_while_its_process_runs(tmp_path):
    d = tmp_path / ln.AUTHORITATIVE_DIR
    d.mkdir()
    assert ln.authoritative_lease(tmp_path) is None
    (d / ln.LEASE).write_text(json.dumps({"pid": os.getpid(), "what": "prewarm", "since": 0}))
    assert ln.authoritative_lease(tmp_path)["what"] == "prewarm"
    gone = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"], capture_output=True, text=True).stdout.strip()
    (d / ln.LEASE).write_text(json.dumps({"pid": int(gone), "what": "prewarm", "since": 0}))
    assert ln.authoritative_lease(tmp_path) is None
    (d / ln.LEASE).write_text("not json")
    assert ln.authoritative_lease(tmp_path) is None


def test_the_lane_of_a_command_follows_where_it_writes(tmp_path):
    a = tmp_path / ln.AUTHORITATIVE_DIR
    assert ln.auto(tmp_path, a / "knowledge.db", a) == ln.AUTHORITATIVE
    assert ln.auto(tmp_path, tmp_path / "ws/p12/knowledge.db", a) == ln.HEAVY      # one private path is enough
    assert ln.auto(tmp_path, tmp_path / "ws/p12") == ln.HEAVY
    assert ln.auto(tmp_path) == ln.HEAVY


_HOLD = """
import sys, time
from recon.core import lanes
with lanes.enter("heavy", sys.argv[1], what="holder"):
    print("held", flush=True)
    time.sleep(float(sys.argv[2]))
print("released", flush=True)
"""


@posix
def test_one_heavy_run_at_a_time_across_processes_and_with_the_command_line_flock(tmp_path):
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)}
    holder = subprocess.Popen([sys.executable, "-c", _HOLD, str(tmp_path), "3"], stdout=subprocess.PIPE, text=True, env=env)
    assert holder.stdout.readline().strip() == "held"
    with pytest.raises(BlockingIOError):
        with ln.enter(ln.HEAVY, tmp_path, wait=False):
            pass
    said = []
    with ln.enter(ln.HEAVY, tmp_path, log=said.append):             # waits for the holder, then runs
        assert holder.stdout.readline().strip() == "released"
    assert any("waiting for the development-heavy lock" in s and "holder" in s for s in said)
    holder.wait(30)
    # the same lock as `flock <lock> <command>`
    import fcntl

    with open(tmp_path / ln.LOCK, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        with pytest.raises(BlockingIOError):
            with ln.enter(ln.HEAVY, tmp_path, wait=False):
                pass
    with ln.enter(ln.HEAVY, tmp_path, wait=False):
        pass


def double(st, task):
    return 2 * task + st


@posix
def test_the_pool_follows_the_lane_and_drops_to_one_worker_when_a_lease_appears(tmp_path, monkeypatch):
    from recon.core import workers as wk

    monkeypatch.setattr(wk, "meminfo", lambda: (64 * GIB, 64 * GIB))
    big = lambda: (64 * GIB, 64 * GIB)    # noqa: E731
    with ln.enter(ln.HEAVY, tmp_path, requested=4, memory=big) as p:
        assert p.workers == 2 and ln.current()[0] is p
        pool = wk.Pool(int, (0,), double, most=4, step_s=0)
        assert pool.most == 2
        got = {}
        pool.run(range(30), lambda t, k, v, m: got.__setitem__(t, v))
        assert got == {t: 2 * t for t in range(30)} and pool.stats.most <= 2
        d = tmp_path / ln.AUTHORITATIVE_DIR
        d.mkdir()
        (d / ln.LEASE).write_text(json.dumps({"pid": os.getpid(), "what": "campaign", "since": 0}))
        pool = wk.Pool(int, (0,), double, most=4, step_s=0)
        got = {}
        pool.run(range(30), lambda t, k, v, m: got.__setitem__(t, v))
        assert got == {t: 2 * t for t in range(30)} and pool.stats.most == 1     # the same answers, one worker
    assert ln.current() is None
    assert wk.Pool(int, (0,), double, most=4).most == 4                           # outside a lane: the pool's own limits


@posix
def test_a_worker_past_the_lane_cap_is_retired_after_its_task_and_its_answer_kept(tmp_path, monkeypatch):
    from recon.core import workers as wk

    d = tmp_path / ln.AUTHORITATIVE_DIR
    d.mkdir()
    (d / ln.LEASE).write_text(json.dumps({"pid": os.getpid(), "what": "campaign", "since": 0}))
    with ln.enter(ln.HEAVY, tmp_path, memory=lambda: (64 * GIB, 64 * GIB)) as p:
        assert p.cap == 3 * GIB // 2
        pool = wk.Pool(int, (0,), double, most=1, step_s=0)
        pool.cap = 1                                 # every worker is past it: each is retired after one task
        got = {}
        pool.run(range(4), lambda t, k, v, m: got.__setitem__(t, v))
        assert got == {t: 2 * t for t in range(4)} and pool.stats.started == 4
