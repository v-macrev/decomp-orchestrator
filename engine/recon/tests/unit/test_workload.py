# SPDX-License-Identifier: AGPL-3.0-or-later
"""Which work yields to which (D-065): a diagnostic yields while an analysis holds its lease, and an ended process holds none."""
import json
import os
import subprocess
import sys

from recon.core import workload as wl


def test_an_analysis_holds_the_lease_while_it_runs_and_leaves_none(tmp_path):
    assert wl.holder(tmp_path) is None
    with wl.analysis(tmp_path, "prewarm"):
        h = wl.holder(tmp_path)
        assert h is not None and h["pid"] == os.getpid() and h["what"] == "prewarm"
        with wl.analysis(tmp_path, "campaign"):          # a second one shares it; the first lease stands
            assert wl.holder(tmp_path)["what"] == "prewarm"
        assert wl.holder(tmp_path) is not None
    assert wl.holder(tmp_path) is None and not (tmp_path / wl.LEASE).exists()


def test_the_lease_of_an_ended_process_is_none(tmp_path):
    p = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"], capture_output=True, text=True, check=True)
    (tmp_path / wl.LEASE).write_text(json.dumps({"pid": int(p.stdout), "what": "prewarm", "since": 0}), encoding="utf-8")
    assert wl.holder(tmp_path) is None
    assert wl.diagnostic(tmp_path) == "free"


def test_a_diagnostic_yields_while_an_analysis_runs(tmp_path):
    code = ("import sys, os; from recon.core import workload as wl; print(wl.diagnostic(sys.argv[1]));"
            "print(os.getpriority(os.PRIO_PROCESS, 0) if hasattr(os, 'getpriority') else 19)")
    with wl.analysis(tmp_path, "campaign"):
        out = subprocess.run([sys.executable, "-c", code, str(tmp_path)], capture_output=True, text=True, check=True, cwd=os.getcwd()).stdout.split()
    assert out[0] == "yielding" and int(out[1]) >= 19
    free = subprocess.run([sys.executable, "-c", code, str(tmp_path)], capture_output=True, text=True, check=True).stdout.split()
    assert free[0] == "free"
