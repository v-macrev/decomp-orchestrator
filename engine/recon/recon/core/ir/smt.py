# SPDX-License-Identifier: AGPL-3.0-or-later
"""Proofs with Z3: that a rewrite rule holds for all values, and that two loop-free functions mean the same.

Z3 runs single-threaded with a fixed seed and a resource limit (never a time limit), so an answer is reproducible.
An answer that is not a proof is never taken for one: `unknown` is its own result.

Functions are compared over all their paths: conditions, the order and operands of effects, exits and memory must agree.
The memory model is the IR's own claim: a private region is a memory of its own. (That the claim holds is tested by
execution, where memory is one.) Floating-point operations that are not on constants are uninterpreted when functions are compared; rules about
them are proved with the theory of floating point.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from recon.core import budget
from recon.core.evaluate import apply as compute
from recon.core.ir.model import FRAME, Arg, Const, Fn, Op
from recon.core.ir import rules as ru
from recon.core.sem import OPAQUE, OPS

RLIMIT = 40_000_000
SEED = 20261125

PROVED, REFUTED, UNKNOWN = "proved", "refuted", "unknown"


def z3():
    import z3 as z
    return z


def _solver():
    z = z3()
    s = z.Solver()
    s.set("rlimit", RLIMIT)
    s.set("random_seed", SEED)
    s.set("threads", 1)
    return s


def check(claim) -> str:
    """Whether the claim holds for all values."""
    z = z3()
    claim = z.simplify(claim)
    if z.is_true(claim):
        return PROVED
    budget.spend("solverUnits")      # one check; its own resource limit bounds what one costs
    s = _solver()
    s.add(z.Not(claim))
    r = s.check()
    return PROVED if r == z.unsat else REFUTED if r == z.sat else UNKNOWN


# ---------------------------------------------------------------------------------------- operations

def _amount(z, a, w: int):
    """A shift amount as a value of the shifted width, saturating (z3 wants equal widths)."""
    k = a.size()
    if k == w:
        return a
    if k < w:
        return z.ZeroExt(w - k, a)
    return z.If(z.ULT(a, z.BitVecVal(w, k)), z.Extract(w - 1, 0, a), z.BitVecVal(w if w > 1 else 1, w))


def _bit(z, b):
    return z.If(b, z.BitVecVal(1, 1), z.BitVecVal(0, 1))


def _sort(z, w: int):
    return z.Float32() if w == 32 else z.Float64()


def apply(op: str, a: list, out: int, *, floats: bool = False):
    """The operation on z3 bit vectors. Without `floats`, a floating-point operation is an uninterpreted function."""
    z = z3()
    if op in OPAQUE or not floats and (op[0] == "f" or op == "sitof"):
        known = [z.simplify(x) for x in a]
        if op not in OPAQUE and all(z.is_bv_value(x) for x in known):  # on constants it is computed, as transformations do
            return z.BitVecVal(compute(op, [x.as_long() for x in known], [x.size() for x in known], out), out)
        f = z.Function(f"{op}.{'.'.join(str(x.size()) for x in a)}.{out}", *(x.sort() for x in a), z.BitVecSort(out))
        return f(*a)
    if op[0] == "f" or op == "sitof":
        return _float(z, op, a, out)
    x = a[0]
    w = x.size()
    if op == "ite":
        return z.If(x == 1, a[1], a[2])
    if op == "not":
        return ~x
    if op == "neg":
        return -x
    if op == "zext":
        return z.ZeroExt(out - w, x)
    if op == "sext":
        return z.SignExt(out - w, x)
    if op == "trunc":
        return z.Extract(out - 1, 0, x)
    if op == "popcount":
        r = z.BitVecVal(0, w)
        for k in range(w):
            r = r + z.ZeroExt(w - 1, z.Extract(k, k, x)) if w > 1 else x
        return r
    if op in ("clz", "ctz"):
        r = z.BitVecVal(w, w)
        for k in range(w) if op == "clz" else range(w - 1, -1, -1):
            r = z.If(z.Extract(k, k, x) == 1, z.BitVecVal(w - 1 - k if op == "clz" else k, w), r)
        return r
    y = a[1]
    if op == "shl":
        return x << _amount(z, y, w)
    if op == "lshr":
        return z.LShR(x, _amount(z, y, w))
    if op == "ashr":
        return x >> _amount(z, y, w)
    if op == "cat":
        return z.Concat(x, y)
    return {"add": lambda: x + y, "sub": lambda: x - y, "mul": lambda: x * y, "udiv": lambda: z.UDiv(x, y), "urem": lambda: z.URem(x, y), "sdiv": lambda: x / y,
            "srem": lambda: z.SRem(x, y), "and": lambda: x & y, "or": lambda: x | y, "xor": lambda: x ^ y, "eq": lambda: _bit(z, x == y), "ne": lambda: _bit(z, x != y),
            "ult": lambda: _bit(z, z.ULT(x, y)), "ule": lambda: _bit(z, z.ULE(x, y)), "slt": lambda: _bit(z, x < y), "sle": lambda: _bit(z, x <= y)}[op]()


def _float(z, op: str, a: list, out: int):
    x = a[0]
    w = x.size()
    rm = z.RNE()

    def fp(v):
        return z.fpBVToFP(v, _sort(z, v.size()))

    def nan(v):
        return z.fpIsNaN(fp(v))

    def quiet(v):
        return v | z.BitVecVal(1 << (22 if v.size() == 32 else 51), v.size())

    def bits(f, n: int):
        default = z.BitVecVal(0xFFC00000 if n == 32 else 0xFFF8 << 48, n)
        return z.If(z.fpIsNaN(f), default, z.fpToIEEEBV(f))
    if op in ("flt", "fle", "feq", "funo"):
        y = a[1]
        c = {"flt": lambda: z.fpLT(fp(x), fp(y)), "fle": lambda: z.fpLEQ(fp(x), fp(y)), "feq": lambda: z.fpEQ(fp(x), fp(y)), "funo": lambda: z.Or(nan(x), nan(y))}[op]()
        return _bit(z, c)
    if op in ("fadd", "fsub", "fmul", "fdiv"):
        y = a[1]
        r = {"fadd": z.fpAdd, "fsub": z.fpSub, "fmul": z.fpMul, "fdiv": z.fpDiv}[op](rm, fp(x), fp(y))
        return z.If(nan(x), quiet(x), z.If(nan(y), quiet(y), bits(r, w)))
    if op == "fsqrt":
        return z.If(nan(x), quiet(x), bits(z.fpSqrt(rm, fp(x)), w))
    if op.startswith("fround_"):
        mode = {"near": z.RNE(), "zero": z.RTZ(), "down": z.RTN(), "up": z.RTP()}[op[7:]]
        return z.If(nan(x), quiet(x), z.fpToIEEEBV(z.fpRoundToIntegral(mode, fp(x))))
    if op == "fcvt":
        s = z.Extract(w - 1, w - 1, x)
        m = z.Extract(22, 0, x) if w == 32 else z.Extract(51, 0, x)
        if out == 64 and w == 32:
            payload = z.Concat(s, z.BitVecVal(0x7FF, 11), z.Concat(m, z.BitVecVal(0, 29)))
        elif out == 32 and w == 64:
            payload = z.Concat(s, z.BitVecVal(0xFF, 8), z.Extract(51, 29, x))
        else:
            payload = x
        return z.If(nan(x), quiet(payload), z.fpToIEEEBV(z.fpFPToFP(rm, fp(x), _sort(z, out))))
    if op == "sitof":
        return z.fpToIEEEBV(z.fpSignedToFP(rm, x, _sort(z, out)))
    if op.startswith("ftosi_"):
        mode = z.RTZ() if op.endswith("zero") else z.RNE()
        r = z.fpRoundToIntegral(mode, fp(x))
        lo = z.fpSignedToFP(z.RTZ(), z.BitVecVal(1 << (out - 1), out), _sort(z, w))  # a power of two: exact
        ok = z.And(z.Not(nan(x)), z.Not(z.fpIsInf(fp(x))), z.fpGEQ(r, lo), z.fpLT(r, z.fpNeg(lo)))
        return z.If(ok, z.fpToSBV(z.RTZ(), r, z.BitVecSort(out)), z.BitVecVal(1 << (out - 1), out))
    raise AssertionError(op)


# ---------------------------------------------------------------------------------------- rules

def term(x: ru.Term, env: dict):
    z = z3()
    if isinstance(x, ru.N):
        return z.BitVecVal(x.value, x.width)
    if isinstance(x, (ru.V, ru.K)):
        return env.setdefault(x.name, z.BitVec(x.name, x.width))
    return apply(x.op, [term(a, env) for a in x.args], x.width, floats=True)


def prove_rule(r: ru.Rule) -> str:
    z = z3()
    env: dict = {}
    lhs, rhs = term(r.lhs, env), term(r.rhs, env)
    when = [term(c, env) == 1 for c in r.when]
    return check(z.Implies(z.And(*when), lhs == rhs) if when else lhs == rhs)


# ---------------------------------------------------------------------------------------- functions

class CannotEncode(ValueError):
    pass


@dataclass
class _Path:
    block: int
    prev: int
    env: dict
    shared: object                       # memory outside private regions
    private: dict
    conds: list = field(default_factory=list)
    effects: list = field(default_factory=list)   # (kind and fixed parts, z3 values)
    calls: int = 0
    steps: int = 0


@dataclass(frozen=True)
class Ending:
    conds: tuple
    effects: tuple
    exit: tuple                          # (kind and fixed parts, z3 values)


def paths(fn: Fn, limit: int = 64) -> list[Ending]:
    """Every way through a loop-free function. The frame is at a symbolic address; its private regions are memories of their own."""
    z = z3()
    BV8, BV64 = z.BitVecSort(8), z.BitVecSort(64)
    base = z.BitVec("frame", 64)
    by_region = {r.name: r for r in fn.regions}
    private = {r.name for r in fn.regions if r.private}
    place = {o.defs[0]: int(o.attr("off")) for _b, o in fn.ops() if o.kind == FRAME}  # type: ignore[call-overload]

    def start() -> _Path:
        env = {v: z.BitVec(f"in.{n}", fn.width(v)) for n, v in fn.params}
        return _Path(0, -1, env, z.Array("memory", BV64, BV8), {n: z.Array(f"slot.{by_region[n].lo}", BV64, BV8) for n in sorted(private)})

    def val(p: _Path, a: Arg):
        return z.BitVecVal(a.value, a.width) if isinstance(a, Const) else p.env[a]

    def mem_read(m, a, size: int):
        parts = [z.Select(m, a + k) for k in range(size)]
        return parts[0] if size == 1 else z.Concat(*reversed(parts))

    def mem_write(m, a, v, size: int):
        for k in range(size):
            m = z.Store(m, a + k, z.Extract(8 * k + 7, 8 * k, v))
        return m

    def where(p: _Path, o: Op):
        """(private region or None, address within its memory)."""
        r = o.attr("region")
        a = val(p, o.args[0])
        if r not in private:
            return None, a
        from recon.core.ir import memory as mm
        d = {v: x for v, (_b, x) in fn.defining().items()}
        got = mm.resolve(o.args[0], d.get, {v: n for n, v in fn.params})
        if got is None or got[0] != "frame":
            raise CannotEncode("private access")
        return r, z.BitVecVal(got[1] & (2**64 - 1), 64)

    done: list[Ending] = []
    work = [start()]
    while work:
        p = work.pop()
        p.steps += 1
        if p.steps > len(fn.blocks) + 1:
            raise CannotEncode("loop")
        b = fn.blocks[p.block]
        new = {q.id: val(p, dict(q.args)[p.prev]) for q in b.phis if q.region is None}
        p.env.update(new)
        for o in b.ops:
            if o.kind == FRAME:
                p.env[o.defs[0]] = base + z.BitVecVal(int(o.attr("off")) & (2**64 - 1), 64)  # type: ignore[call-overload]
            elif o.kind == "undef":
                p.env[o.defs[0]] = z.BitVec(f"undef.{o.defs[0]}", fn.width(o.defs[0]))
            elif o.kind in OPS:
                p.env[o.defs[0]] = apply(o.kind, [val(p, a) for a in o.args], fn.width(o.defs[0]))
            elif o.kind == "load":
                r, a = where(p, o)
                n = fn.width(o.defs[0]) // 8
                p.env[o.defs[0]] = mem_read(p.shared if r is None else p.private[r], a, n)
                if o.attr("atomic"):
                    p.effects.append((("atomic-load", n), (a, p.shared)))
            elif o.kind == "store":
                r, a = where(p, o)
                n = fn.width(o.args[1]) // 8
                if r is None:
                    p.shared = mem_write(p.shared, a, val(p, o.args[1]), n)
                    if o.attr("atomic"):
                        p.effects.append((("atomic-store", n), (a, p.shared)))
                else:
                    p.private[r] = mem_write(p.private[r], a, val(p, o.args[1]), n)
            elif o.kind == "fence":
                p.effects.append((("fence", o.attr("why")), (p.shared,)))
            elif o.kind == "trap":
                p.effects.append((("trap", o.attr("why")), (val(p, o.args[0]), p.shared)))
                p.conds.append(val(p, o.args[0]) == 0)
            elif o.kind == "call":
                # a callee reads the shared memory and the private regions it is told it may read
                seen = [p.private[m.region] for m in o.mem if m.region in private and m.after is None]
                names = [m.region for m in o.mem if m.region in private and m.after is None]
                p.effects.append((("call", o.attr("args"), tuple(names)), (*(val(p, a) for a in o.args), p.shared, *seen)))
                p.calls += 1
                for n, v in zip(o.attr("defs"), o.defs):  # type: ignore[arg-type]
                    p.env[v] = z.BitVec(f"call{p.calls}.{n}", fn.width(v))
                p.shared = z.Array(f"memory{p.calls}", BV64, BV8)
                for m in o.mem:
                    if m.region in private and m.after is not None:
                        p.private[m.region] = z.Array(f"slot{p.calls}.{by_region[m.region].lo}", BV64, BV8)
            else:
                raise CannotEncode(o.kind)
        t = b.term
        if t.kind == "goto":
            p.prev, p.block = p.block, t.targets[0]
            work.append(p)
        elif t.kind == "branch":
            c = val(p, t.args[0])
            for k, want in ((0, 1), (1, 0)):
                q = _Path(t.targets[k], b.id, dict(p.env), p.shared, dict(p.private), [*p.conds, c == want], list(p.effects), p.calls, p.steps)
                work.append(q)
        elif t.kind in ("return", "tail"):
            names = [m.region for m in t.mem if m.region in private]
            done.append(Ending(tuple(p.conds), tuple(p.effects), ((t.kind, tuple(t.attrs), tuple(names)), (*(val(p, a) for a in t.args), p.shared, *(p.private[n] for n in names)))))
        elif t.kind == "unreachable":
            done.append(Ending(tuple(p.conds), tuple(p.effects), (("unreachable",), (p.shared,))))
        else:
            raise CannotEncode(t.kind)
        if len(done) + len(work) > limit:
            raise CannotEncode("too many paths")
    return done


def equivalent(a: Fn, b: Fn) -> str:
    """Whether two loop-free functions mean the same for every input. Undefined values keep their names, so they must be used alike."""
    z = z3()
    pa, pb = paths(a), paths(b)
    unknown = False
    for x in pa:
        for y in pb:
            both = [*x.conds, *y.conds]
            ex, ey = x.effects, y.effects
            alike = [e[0] for e in ex] == [e[0] for e in ey] and x.exit[0] == y.exit[0] and all(len(p[1]) == len(q[1]) for p, q in zip((*ex, x.exit), (*ey, y.exit)))
            if not alike:
                # fine only when no input takes both paths; an effect before they part is compared on the paths that are alike
                r = check(z.Not(z.And(*both)) if both else z.BoolVal(False))
            else:
                same = [p == q for e, f in zip((*ex, x.exit), (*ey, y.exit)) for p, q in zip(e[1], f[1]) if not p.eq(q)]
                if not same:
                    continue
                r = check(z.Implies(z.And(*both), z.And(*same)) if both else z.And(*same))
            if r == REFUTED:
                return REFUTED
            unknown |= r == UNKNOWN
    return UNKNOWN if unknown else PROVED
