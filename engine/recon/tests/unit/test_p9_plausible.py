# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plausibility before compilation: deliberate defects are refused, the candidates the generator makes are not."""
from recon.core.inference.types import Int
from recon.core.structuring import ast as A
from recon.core.synthesis import plausible as P
from recon.core.taxonomy import family

I32 = Int(32, True)
X = A.Local(0, I32)


def body(*stmts):
    return A.Body((X,), I32, tuple(stmts))


def test_plain_code_is_plausible():
    b = body(A.If(A.Binary("<", X, A.Num(3, I32), I32), (A.Return(A.Num(1, I32)),)), A.Return(X))
    assert P.check(b, "int f(int a) { if (a < 3) return 1; return a; }") is None


def test_code_after_a_return_is_dead_unless_a_label_reaches_it():
    assert P.check(body(A.Return(X), A.Assign(X, A.Num(1, I32))), "") == P.DEAD_CODE
    assert P.check(body(A.Goto(1), A.Label(1), A.Return(X)), "") is None
    assert P.check(body(A.If(A.Num(1, I32), (A.Return(X),)), A.Return(X)), "") == P.DEAD_CODE
    assert P.check(body(A.Loop("while", X, (A.Break(), A.Assign(X, X))), A.Return(X)), "") == P.DEAD_CODE


def test_a_cast_that_converts_nothing_is_refused():
    assert P.check(body(A.Return(A.Cast(X, I32))), "") == P.CAST
    assert P.check(body(A.Return(A.Cast(X, I32, implicit=True))), "") is None
    assert P.check(body(A.Return(A.Cast(X, Int(64, True)))), "") is None


def test_steering_constructs_are_refused():
    for t in ("volatile int x;", "__asm { nop }", "#pragma optimize(\"\", off)", "__declspec(noinline) int g();", "register int r;"):
        assert P.check(body(A.Return(X)), t) == P.CONSTRUCT, t


def test_every_code_has_a_family():
    assert all(family(c) == "Search" for c in P.CODES)
