# SPDX-License-Identifier: AGPL-3.0-or-later
"""The semantics language: ill-typed semantics cannot be built, and the evaluator follows the definitions."""
import random

import pytest

from recon.core import evaluate as ev
from recon.core.analysis.values import Values
from recon.core.sem import OPS, Builder, Const, Lifted, Loc, SemanticsError

A, F = Loc("a", 64), Loc("f", 1)


def lifted(b):
    return Lifted(0, 1, "t", tuple(b.stmts))


@pytest.mark.parametrize("bad", [
    lambda b: b.op("add", Const(1, 8), Const(1, 16)),
    lambda b: b.op("ite", Const(1, 8), Const(1, 8), Const(1, 8)),
    lambda b: b.op("trunc", Const(1, 8), width=16),
    lambda b: b.op("zext", Const(1, 16), width=8),
    lambda b: b.op("nonsense", Const(1, 8)),
    lambda b: b.op("not", Const(1, 8), Const(1, 8)),
    lambda b: b.put(A, Const(1, 32)),
    lambda b: b.load(Const(1, 32), 8),
    lambda b: b.load(Const(1, 64), 7),
    lambda b: b.trap("x", Const(1, 8)),
    lambda b: b.branch(Const(1, 8), Const(0, 64), Const(0, 64)),
    lambda b: (b.ret(Const(0, 64)), b.put(A, Const(0, 64))),
    lambda b: Const(256, 8),
])
def test_ill_typed_semantics_cannot_be_built(bad):
    with pytest.raises(SemanticsError):
        bad(Builder())


def test_undefined_spreads_but_an_unselected_arm_does_not():
    b = Builder()
    u = b.undef(64)
    b.put(A, b.op("ite", Const(1, 1), Const(7, 64), u))
    m = ev.Machine(lambda a, n: 0, lambda a, n, v: None, {"a": 0})
    ev.run(lifted(b), m)
    assert m.locs["a"] == 7
    b = Builder()
    b.put(A, b.op("add", b.undef(64), Const(1, 64)))
    ev.run(lifted(b), m)
    assert m.locs["a"] is ev.UNDEF


def test_undefined_control_and_addresses_are_refused_not_guessed():
    for use in (lambda b: b.trap("t", b.undef(1)), lambda b: b.goto(b.undef(64)), lambda b: b.load(b.undef(64), 8), lambda b: b.store(b.undef(64), Const(0, 8))):
        b = Builder()
        use(b)
        with pytest.raises(ev.UndefinedControl):
            ev.run(lifted(b), ev.Machine(lambda a, n: 0, lambda a, n, v: None, {}))


def test_a_trap_stops_before_later_effects():
    b = Builder()
    b.trap("t", Const(1, 1))
    b.put(A, Const(1, 64))
    m = ev.Machine(lambda a, n: 0, lambda a, n, v: None, {"a": 0})
    with pytest.raises(ev.Trapped):
        ev.run(lifted(b), m)
    assert m.locs["a"] == 0


def test_signed_division_truncates_toward_zero():
    for x, y, q, r in ((-7, 2, -3, -1), (7, -2, -3, 1), (-7, -2, 3, -1)):
        assert ev.signed(ev.apply("sdiv", [x & 255, y & 255], [8, 8], 8), 8) == q
        assert ev.signed(ev.apply("srem", [x & 255, y & 255], [8, 8], 8), 8) == r


def test_a_load_is_the_same_value_only_while_memory_cannot_have_changed():
    def loads(middle):
        b = Builder()
        x = b.load(Const(64, 64), 64)
        middle(b)
        y = b.load(Const(64, 64), 64)
        b.put(A, b.op("sub", x, y))
        v = Values().run([lifted(b)])
        return v.nodes[v.env["a"]].kind == "const"

    assert loads(lambda b: None)
    assert not loads(lambda b: b.store(Const(0, 64), Const(0, 8)))
    assert not loads(lambda b: b.fence("full"))
    assert not loads(lambda b: b.block_fill(Const(0, 64), Const(0, 8), Const(1, 64), Const(0, 1)))


def test_value_numbering_never_changes_a_value():
    """Random expression trees: the simplified node evaluates to what the statements compute."""
    r = random.Random(3)
    ops = [n for n, (a, k) in OPS.items() if k in ("same", "cmp", "un", "shift") and n not in ("udiv", "urem", "sdiv", "srem")]
    for _ in range(400):
        b = Builder()
        pool = [b.get(Loc("a", 32)), b.get(Loc("b", 32)), b.get(Loc("c", 32)), b.const(0, 32), b.const(r.getrandbits(32), 32), b.const(r.randrange(40), 32)]
        for _ in range(14):
            kind = r.random()
            x = r.choice(pool)
            if kind < 0.2:
                w = r.choice((8, 16, 32, 64))
                y = b.op("trunc" if w <= x.width else r.choice(("zext", "sext")), x, width=w)
                if w < 32 and r.random() < 0.5:  # narrow, widen past the final width, narrow again
                    y = b.op(r.choice(("zext", "sext")), y, width=64)
                elif w == 64:
                    y = b.op(r.choice(("add", "sub", "mul", "and", "or", "xor", "shl", "lshr", "ashr")), y, b.op("zext", r.choice(pool), width=64) if r.random() < 0.5 else b.const(r.randrange(40), 64))
                y = y if y.width == 32 else b.op(r.choice(("zext", "sext")), y, width=32) if y.width < 32 else b.op("trunc", y, width=32)
            elif kind < 0.3:
                y = b.op("ite", b.op("ult", x, r.choice(pool)), r.choice(pool), r.choice(pool))
            else:
                n = r.choice(ops)
                y = b.op(n, *[x, r.choice(pool)][: OPS[n][0]])
                if y.width == 1:
                    y = b.op("zext", y, width=32)
            pool.append(y)
        b.put(Loc("out", 32), pool[-1])
        ins = lifted(b)
        v = Values().run([ins])
        for _ in range(4):
            st = {n: r.choice((0, 1, 0xFFFFFFFF, 0x80000000, r.getrandbits(32))) for n in "abc"}
            m = ev.Machine(lambda a, n: 0, lambda a, n, x: None, dict(st))
            ev.run(ins, m)

            def val(k):
                n = v.nodes[k]
                if n.kind == "const":
                    return n.value
                if n.kind == "entry":
                    return st[n.op]
                return ev.apply(n.op, [val(x) for x in n.args], [v.nodes[x].width for x in n.args], n.width)

            assert val(v.env["out"]) == m.locs["out"]
