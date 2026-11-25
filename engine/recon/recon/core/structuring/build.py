# SPDX-License-Identifier: AGPL-3.0-or-later
"""From SSA to statements: what is written where it is used, what gets a variable, and which values share one.

A value is written at its use unless that would move a read of memory or a call across something it depends on, or would
compute something twice. Values that flow into one phi share a variable when they are never needed at the same time;
otherwise the edge copies. The result is a graph of statement lists, with conditions on the branches.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from recon.core.analysis import graph
from recon.core.inference import types as ty
from recon.core.inference.signature import NotReconstructed
from recon.core.ir.model import Arg, Block, Const, Fn, Op
from recon.core.structuring import ast as A

INT32 = ty.Int(32, True)
CASTS = frozenset({"trunc", "zext", "sext"})
COMPARE = {"eq": "==", "ne": "!=", "ult": "<", "ule": "<=", "slt": "<", "sle": "<=", "flt": "<", "fle": "<=", "feq": "=="}
ARITH = {"add": "+", "sub": "-", "mul": "*", "and": "&", "or": "|", "xor": "^", "shl": "<<"}
DIVIDE = {"udiv": "/", "urem": "%", "sdiv": "/", "srem": "%", "lshr": ">>", "ashr": ">>"}
FLOAT = {"fadd": "+", "fsub": "-", "fmul": "*", "fdiv": "/"}

Place = tuple[int, float]        # (block, position in it)


@dataclass
class Node:
    stmts: list[A.Stmt] = field(default_factory=list)
    #: ("goto", target) ("branch", cond, yes, no) ("return", value or None) ("stop",)
    term: tuple = ("stop",)


@dataclass
class Flow:
    """The statements of a function as a graph. Node 0 is the entry."""

    nodes: dict[int, Node]
    params: tuple[A.Local, ...]
    result: ty.CType
    assumptions: tuple[str, ...] = ()

    def targets(self, n: int) -> list[int]:
        t = self.nodes[n].term
        return [t[1]] if t[0] == "goto" else [t[2], t[3]] if t[0] == "branch" else []


def negate(e: A.Expr) -> A.Expr:
    flip = {"==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<"}
    if isinstance(e, A.Binary) and e.op in flip and (e.op in ("==", "!=") or not isinstance(e.left.type, ty.Float)):
        return A.Binary(flip[e.op], e.left, e.right, e.type)
    if isinstance(e, A.Unary) and e.op == "!":
        return e.arg
    return A.Unary("!", e, ty.BOOL)


class Builder:
    def __init__(self, fn: Fn, types: ty.Types, constant=None, read_again: bool = False) -> None:
        """`constant(address, width)`: the bit pattern of read-only memory, or None. `read_again`: memory read once and used
        more than once is written as a read at each use, where nothing can have changed it in between."""
        self.read_again = read_again
        self.fn = fn
        self.t = types
        self.constant = constant or (lambda _a, _w: None)
        self.order = graph.reverse_postorder(fn.succ, 0)
        self.where: dict[int, tuple[int, int]] = {}      # value -> (block, position); parameters and phis at -1
        self.op: dict[int, Op] = {}
        self.assumed: set[str] = set()
        self._collect()
        self._decide()
        self._webs()

    # -- uses -----------------------------------------------------------------------------------
    def _collect(self) -> None:
        self.users: dict[int, list[tuple[str, int, int, int]]] = {}    # value -> (what, block, position, operand)
        fn = self.fn
        for _n, v in fn.params:
            self.where[v] = (0, -1)
        for b in self.order:
            blk = fn.blocks[b]
            for p in blk.phis:
                if p.region is None:
                    self.where[p.id] = (b, -1)
                    for k, a in p.args:
                        if isinstance(a, int):
                            self.users.setdefault(a, []).append(("phi", k, len(fn.blocks[k].ops) + 1, 0))
            for i, o in enumerate(blk.ops):
                for v in o.defs:
                    self.where[v] = (b, i)
                    self.op[v] = o
                for j, a in enumerate(o.args):
                    if isinstance(a, int):
                        self.users.setdefault(a, []).append(("op", b, i, j))
            for a in blk.term.args:
                if isinstance(a, int):
                    self.users.setdefault(a, []).append(("term", b, len(blk.ops), 0))

    def _user(self, u: tuple[str, int, int, int]) -> Op | None:
        return self.fn.blocks[u[1]].ops[u[2]] if u[0] == "op" else None

    # -- named or written at the use ------------------------------------------------------------
    def _decide(self) -> None:
        self.named: set[int] = {v for _n, v in self.fn.params} | {p.id for b in self.order for p in self.fn.blocks[b].phis if p.region is None}
        self.anchors: dict[int, set[Place]] = {}
        self._chosen: set[int] = set()
        for b in reversed(self.order):
            for i, o in reversed(list(enumerate(self.fn.blocks[b].ops))):
                if not o.defs:
                    continue
                v = o.defs[0]
                at: set[Place] = set()
                chosen = False           # reached through one arm of a conditional expression
                for u in self.users.get(v, []):
                    w = self._user(u)
                    if w is None or not w.pure and w.kind != "load" or w.defs and w.defs[0] in self.named:
                        at.add((u[1], u[2]))
                    else:
                        at |= self.anchors.get(w.defs[0], set())
                    if w is not None and (w.kind == "ite" and u[3] > 0 or w.defs and w.defs[0] in self._chosen):
                        chosen = True
                if not at:
                    continue             # nothing uses it
                if self._stays(v, o, (b, i), at, chosen):
                    self.named.add(v)
                else:
                    self.anchors[v] = at
                    if chosen:
                        self._chosen.add(v)

    def _stays(self, v: int, o: Op, here: tuple[int, int], at: set[Place], chosen: bool) -> bool:
        if o.pure:
            return not (len(self.users[v]) == 1 or o.kind in CASTS or self.fn.width(v) == 1 or self._only_addresses(v))
        if chosen:
            return True
        if len(at) > 1:
            return not (self.read_again and o.kind == "load" and all(self._unchanged(o, here, p) for p in sorted(at)))
        (b, i), = at
        if b != here[0]:
            return True
        between = self.fn.blocks[b].ops[here[1] + 1:int(min(i, len(self.fn.blocks[b].ops)))]
        if o.kind == "load":
            mine = {m.region for m in o.mem}
            return any(not x.pure and any(m.after is not None and m.region in mine for m in x.mem) or x.kind == "call" for x in between)
        return any(not x.pure for x in between)

    def _unchanged(self, o: Op, here: tuple[int, int], place: Place) -> bool:
        """Whether nothing between the read and the place, on any way from one to the other, may write what was read."""
        b, i = here
        c, k = place
        ops = self.fn.blocks[b].ops
        mine = {m.region for m in o.mem}

        def quiet(some) -> bool:
            return not any(x.kind == "call" or not x.pure and any(m.after is not None and m.region in mine for m in x.mem) for x in some)
        if c == b:
            return k > i and quiet(ops[i + 1:int(min(k, len(ops)))])
        idom = graph.immediate_dominators(self.fn.succ, 0)
        if not graph.dominates(idom, b, c):
            return False

        def reach(start: list[int], step) -> set[int]:
            seen: set[int] = set()
            work = [s for s in start if s != b]
            while work:
                n = work.pop()
                if n not in seen:
                    seen.add(n)
                    work += [s for s in step(n) if s != b]
            return seen
        preds = self.fn.preds()
        between = reach(list(self.fn.succ[b]), lambda n: self.fn.succ[n]) & reach(preds[c], lambda n: preds[n])
        return quiet(ops[i + 1:]) and all(quiet(self.fn.blocks[n].ops) for n in between) and quiet(self.fn.blocks[c].ops[:int(min(k, len(self.fn.blocks[c].ops)))])

    def _only_addresses(self, v: int) -> bool:
        """Only used in the addresses of accesses."""
        for u in self.users.get(v, []):
            w = self._user(u)
            if w is None:
                return False
            if w.kind in ("load", "store") and u[3] == 0:
                continue
            if w.kind in ("add", "shl", "mul") and self.fn.width(w.defs[0]) == 64 and self._only_addresses(w.defs[0]):
                continue
            return False
        return True

    # -- variables ------------------------------------------------------------------------------
    def leaves(self, a: Arg) -> set[int]:
        if not isinstance(a, int):
            return set()
        if a in self.named:
            return {a}
        o = self.op.get(a)
        out: set[int] = set()
        for x in o.args if o is not None else ():
            out |= self.leaves(x)
        return out

    def _events(self, b: int) -> list[tuple[list[int], set[int]]]:
        out = []
        for o in self.fn.blocks[b].ops:
            v = o.defs[0] if o.defs else None
            if v is not None and v in self.named:
                out.append(([v], set().union(*map(self.leaves, o.args)) if o.args else set()))
            elif o.kind in ("store", "call") and (v is None or not self.users.get(v)):
                out.append(([], set().union(*map(self.leaves, o.args)) if o.args else set()))
        out.append(([], set().union(*map(self.leaves, self.fn.blocks[b].term.args)) if self.fn.blocks[b].term.args else set()))
        return out

    def _webs(self) -> None:
        fn = self.fn
        phis = {b: [p for p in fn.blocks[b].phis if p.region is None] for b in self.order}
        live_in: dict[int, set[int]] = {b: set() for b in self.order}
        events = {b: self._events(b) for b in self.order}

        def edge(b: int, s: int) -> set[int]:
            out = live_in[s] - {p.id for p in phis[s]}
            for p in phis[s]:
                out |= self.leaves(dict(p.args)[b])
            return out

        changed = True
        while changed:
            changed = False
            for b in reversed(self.order):
                live = set().union(*(edge(b, s) for s in fn.succ[b])) if fn.succ[b] else set()
                for defs, uses in reversed(events[b]):
                    live = live - set(defs) | uses
                if live != live_in[b]:
                    live_in[b] = live
                    changed = True
        clash: dict[int, set[int]] = {}

        def mark(v: int, others: set[int]) -> None:
            for x in others - {v}:
                clash.setdefault(v, set()).add(x)
                clash.setdefault(x, set()).add(v)

        params = {v for _n, v in fn.params}
        for v in params:
            mark(v, live_in[0] | params)
        for b in self.order:
            live = set().union(*(edge(b, s) for s in fn.succ[b])) if fn.succ[b] else set()
            for defs, uses in reversed(events[b]):
                for v in defs:
                    mark(v, live)
                live = live - set(defs) | uses
            for p in phis[b]:
                mark(p.id, live_in[b] | {q.id for q in phis[b]})
        self.web: dict[int, int] = {v: v for v in self.named}
        members: dict[int, set[int]] = {v: {v} for v in self.named}

        def join(a: int, b: int) -> None:
            x, y = self.web[a], self.web[b]
            if x == y or any(clash.get(m, set()) & members[y] for m in members[x]):
                return
            if any(self.fn.width(m) != self.fn.width(a) for m in members[x] | members[y]):
                return
            for m in members[y]:
                self.web[m] = x
            members[x] |= members.pop(y)

        for b in self.order:
            for p in phis[b]:
                for _k, a in p.args:
                    if isinstance(a, int) and a in self.named:
                        join(p.id, a)
        self.local: dict[int, A.Local] = {}
        by_web: dict[int, A.Local] = {}
        slots = {v: int(n[1:]) for n, v in fn.params}
        taken = max(len(self.t.sig.params), 1 + max(slots.values(), default=-1))
        for v in sorted(slots, key=lambda x: slots[x]):
            by_web[self.web[v]] = A.Local(slots[v], self.t.ctype(self.t.of(v)))
        for v in sorted(self.named, key=lambda x: (self.order.index(self.where[x][0]) if self.where[x][0] in self.order else 0, self.where[x][1], x)):
            w = self.web[v]
            if w not in by_web:
                by_web[w] = A.Local(taken, self.t.ctype(self.t.of(v)))
                taken += 1
            self.local[v] = by_web[w]
        self.next_local = taken

    # -- expressions ----------------------------------------------------------------------------
    def num(self, c: Const, t: ty.CType | None = None) -> A.Expr:
        if t is None or t.width != c.width and not isinstance(t, ty.Bool):
            t = ty.BOOL if c.width == 1 else ty.Int(c.width, True)
        return A.Num(c.value, t)

    def type_of(self, v: int) -> ty.CType:
        return self.t.ctype(self.t.of(v))

    def expr(self, a: Arg, want: ty.CType | None = None) -> A.Expr:
        """The value as an expression; a constant takes the type that is wanted."""
        if isinstance(a, Const):
            return self.num(a, want)
        if a in self.named:
            return self.local[a]
        return self.write(self.op[a], want)

    def as_int(self, e: A.Expr, w: int, sign: bool) -> A.Expr:
        """The same bits as an integer of that sign."""
        t = ty.Int(w, sign)
        if e.type == t:
            return e
        if isinstance(e, A.Num) and isinstance(e.type, ty.Int):
            return A.Num(e.value, t)
        if isinstance(e.type, (ty.Ptr, ty.Float)):
            raise NotReconstructed("INTEGER_VIEW_OF_ANOTHER_TYPE")
        return A.Cast(e, t)

    def pair(self, a: Arg, b: Arg) -> tuple[A.Expr, A.Expr]:
        if isinstance(a, Const):
            y = self.expr(b)
            return self.expr(a, y.type), y
        x = self.expr(a)
        return x, self.expr(b, x.type)

    def write(self, o: Op, want: ty.CType | None = None) -> A.Expr:
        k = o.kind
        w = self.fn.width(o.defs[0])
        if k == "load":
            return self.lvalue(o.args[0], w, self.type_of(o.defs[0]))
        if k == "call":
            return self.call(o)
        if k in COMPARE:
            if w != 1:
                raise NotReconstructed("COMPARISON_WIDTH")
            x, y = self.pair(*o.args)
            if k[0] in "us" and k not in ("eq", "ne"):
                n = self.fn.width(o.args[0])
                if not (isinstance(x.type, ty.Ptr) and k[0] == "u"):
                    x, y = self.as_int(x, n, k[0] == "s"), self.as_int(y, n, k[0] == "s")
            elif k in ("eq", "ne") and isinstance(x.type, (ty.Bool, ty.Int)) and x.type != y.type and x.type.width < 32:
                n = self.fn.width(o.args[0])
                if n == 1:
                    raise NotReconstructed("COMPARISON_OF_TRUTH_VALUES")
                y = self.as_int(y, n, isinstance(x.type, ty.Int) and x.type.signed) if not isinstance(x.type, ty.Bool) else y
            return A.Binary(COMPARE[k], x, y, ty.BOOL)
        if k == "funo":
            x, y = self.pair(*o.args)
            if x == y:
                return A.Binary("!=", x, x, ty.BOOL)
            raise NotReconstructed("UNORDERED_COMPARISON")
        if w == 1 and k in ("and", "or", "xor", "not"):
            if k == "not":
                return negate(self.expr(o.args[0]))
            if k == "xor" and isinstance(o.args[1], Const):
                x = self.expr(o.args[0])
                return negate(x) if o.args[1].value else x
            x, y = self.expr(o.args[0]), self.expr(o.args[1])
            return A.Binary({"and": "&&", "or": "||", "xor": "!="}[k], x, y, ty.BOOL)
        if k in ("add", "sub") and w == 64:
            p = self.pointer_value(o)
            if p is not None:
                return p
        if k in ARITH:
            return self.arithmetic(o, k, w)
        if k in DIVIDE:
            sign = k in ("sdiv", "srem", "ashr")
            x = self.as_int(self.expr(o.args[0]), w, sign)
            y = self.expr(o.args[1]) if k in ("lshr", "ashr") else self.as_int(self.expr(o.args[1], x.type), w, sign)
            return self.small(A.Binary(DIVIDE[k], x, y, self.promoted(x.type)), w, sign)
        if k in ("neg", "not"):
            x = self.int_of(self.expr(o.args[0]))
            if k == "neg" and isinstance(x.type, ty.Int) and x.type.signed:
                self.assumed.add("no-signed-overflow")
            return self.small(A.Unary("-" if k == "neg" else "~", x, self.promoted(x.type)), w, True)
        if k in FLOAT:
            x, y = self.float_of(o.args[0], w), self.float_of(o.args[1], w)
            return A.Binary(FLOAT[k], x, y, ty.Float(w))
        if k == "fcvt":
            x = self.float_of(o.args[0], self.fn.width(o.args[0]))
            return A.Cast(x, ty.Float(w), w > self.fn.width(o.args[0]))
        if k == "sitof":
            n = self.fn.width(o.args[0])
            return A.Cast(self.as_int(self.expr(o.args[0]), n, True), ty.Float(w), True)
        if k == "ftosi_zero":
            return A.Cast(self.float_of(o.args[0], self.fn.width(o.args[0])), ty.Int(w, True))
        if k == "zext":
            return self.extend(o.args[0], w, False)
        if k == "sext":
            return self.extend(o.args[0], w, True)
        if k == "trunc":
            x = self.expr(o.args[0])
            if isinstance(x.type, (ty.Ptr, ty.Float)):
                raise NotReconstructed("INTEGER_VIEW_OF_ANOTHER_TYPE")
            if w == 1:
                return A.Binary("!=", A.Binary("&", x, A.Num(1, x.type), self.promoted(x.type)), A.Num(0, self.promoted(x.type)), ty.BOOL)
            t = self.type_of(o.defs[0])
            return A.Cast(x, t if isinstance(t, ty.Int) else ty.Int(w, False))
        if k == "ite":
            c = self.expr(o.args[0])
            t = self.type_of(o.defs[0])
            x, y = self.expr(o.args[1], t), self.expr(o.args[2], t)
            return A.Choose(c, x, y, x.type if not isinstance(x, A.Num) else y.type if not isinstance(y, A.Num) else t)
        raise NotReconstructed("OPERATION_" + k.upper())

    def int_of(self, e: A.Expr) -> A.Expr:
        if isinstance(e.type, (ty.Ptr, ty.Float)):
            raise NotReconstructed("INTEGER_VIEW_OF_ANOTHER_TYPE")
        return e

    def float_of(self, a: Arg, w: int) -> A.Expr:
        e = self.expr(a, ty.Float(w))
        if e.type != ty.Float(w):
            raise NotReconstructed("FLOAT_VIEW_OF_ANOTHER_TYPE")
        return e

    @staticmethod
    def promoted(t: ty.CType) -> ty.CType:
        return INT32 if isinstance(t, ty.Bool) or isinstance(t, ty.Int) and t.width < 32 else t

    def small(self, e: A.Expr, w: int, sign: bool) -> A.Expr:
        """Arithmetic on narrow integers happens at 32 bits; the result is cut back."""
        return e if e.type.width == w else A.Cast(e, ty.Int(w, sign))

    def arithmetic(self, o: Op, k: str, w: int) -> A.Expr:
        a, b = o.args
        if k == "sub" and isinstance(a, Const) and a.value == 0:
            k = "neg"
            return self.write(Op("neg", o.defs, (b,)), None)
        x, y = self.pair(a, b)
        x, y = self.int_of(x), self.int_of(y)
        if k == "add" and isinstance(y, A.Num) and isinstance(y.type, ty.Int) and y.value >> (w - 1) & 1:
            k, y = "sub", A.Num(-y.value & (1 << w) - 1, y.type)
        px, py = self.promoted(x.type), self.promoted(y.type)
        if k == "shl":
            t = px
        else:
            t = px if px == py else ty.Int(w, False) if w >= 32 else INT32
        if k in ("add", "sub", "mul") and w >= 32 and isinstance(t, ty.Int) and t.signed:
            self.assumed.add("no-signed-overflow")
        e = A.Binary(ARITH[k], x, y, t)
        if k in ("and", "or", "xor") and w < 32 and x.type == y.type:
            return A.Cast(e, x.type, True)  # of two promoted values: the same bits whether cut back or not
        return self.small(e, w, isinstance(x.type, ty.Int) and x.type.signed)

    def extend(self, a: Arg, w: int, sign: bool) -> A.Expr:
        e = self.expr(a)
        n = self.fn.width(a)
        if n == 1:
            if sign:
                raise NotReconstructed("SIGN_EXTENDED_TRUTH_VALUE")
            return A.Cast(e, ty.Int(w, True) if w == 32 else ty.BOOL if w == 8 else ty.Int(w, False), True)
        if isinstance(e.type, ty.Bool) and not sign:
            return A.Cast(e, ty.Int(w, w == 32), True)
        e = self.as_int(e, n, sign)
        return A.Cast(e, ty.Int(w, sign or w == 32 and n < 32), n < w <= 32)

    # -- memory ---------------------------------------------------------------------------------
    def base(self, a: Arg) -> tuple[A.Expr, ty.Pointee]:
        assert isinstance(a, int)
        v = self.t.of(a)
        if v.kind != "pointer" or v.to is None:
            raise NotReconstructed("ADDRESS_FORM")
        return self.expr(a), self.t.target(v.to)

    def index_of(self, i: int) -> A.Expr:
        o = self.op.get(i)
        if o is not None and i not in self.named and o.kind in ("sext", "zext") and self.fn.width(o.args[0]) == 32:
            e = self.expr(o.args[0])
            return self.as_int(e, 32, o.kind == "sext")
        return self.int_of(self.expr(i))

    def lvalue(self, a: Arg, w: int, t: ty.CType, more: int = 0) -> A.Expr:
        x = self.t.address(a)
        if x.base is None:
            c = self.constant(x.offset, w)
            if c is not None:
                return A.Num(c, t)
            return A.Global(x.offset, t)
        base, p = self.base(x.base)
        off = x.offset + more
        if base.type == ty.Ptr(ty.VOID):
            raise NotReconstructed("ADDRESS_FORM")
        step = self.t.step(p)
        scalar = self.t.is_scalar(p)
        if x.index is not None:
            if step != x.scale or off and not scalar:
                raise NotReconstructed("ARRAY_FORM")
            i = self.index_of(x.index)
            if scalar:
                if off % step:
                    raise NotReconstructed("ARRAY_FORM")
                if off:
                    i = A.Binary("+", i, A.Num(off // step & 0xFFFFFFFF, INT32), i.type)
                return A.Index(base, i, t)
            return A.Index(base, i, t, off)
        if scalar:
            size = w // 8
            if off % size:
                raise NotReconstructed("ARRAY_FORM")
            return A.Index(base, A.Num(off // size & 0xFFFFFFFF, INT32) if off else None, t)
        if step is not None and not 0 <= off < step:
            return A.Index(base, A.Num(off // step & 0xFFFFFFFF, INT32), t, off % step)
        return A.Field(base, off, t)

    def pointer_value(self, o: Op) -> A.Expr | None:
        """p + n, or the address of a member, when the sum is a pointer."""
        a, b = o.args
        if not isinstance(a, int) or self.t.of(a).kind != "pointer":
            return None
        v, r = self.t.of(a), self.t.of(o.defs[0])
        assert v.to is not None
        p = self.t.target(v.to)
        if not isinstance(b, Const) or r is not v:
            raise NotReconstructed("ADDRESS_VALUE")
        n = ty.signed(b.value, 64) * (1 if o.kind == "add" else -1)
        step = self.t.step(p)
        if not step or n % step:
            raise NotReconstructed("ADDRESS_VALUE")
        e = self.expr(a)
        n //= step
        return A.Binary("+" if n >= 0 else "-", e, A.Num(abs(n), INT32), e.type)

    def call(self, o: Op) -> A.Expr:
        target = o.args[0]
        assert isinstance(target, Const)
        s = self.t.callees[target.value]
        args = []
        for k, (a, slot) in enumerate(zip(o.args[1:], s.params)):
            t = self.t.ctype(self.t.slot(target.value, k, slot))
            e = self.expr(a, t)
            args.append(self.converted(e, t))
        r = ty.VOID if s.result is None else self.t.ctype(self.t.slot(target.value, -1, s.result))
        return A.Call(target.value, tuple(args), r)

    def converted(self, e: A.Expr, t: ty.CType) -> A.Expr:
        """The expression where a value of type `t` is expected: integers of one width convert by themselves."""
        if e.type == t:
            return e
        if isinstance(e, A.Num) and e.type.width == t.width:
            return A.Num(e.value, t)
        ints = (ty.Int, ty.Bool)
        if isinstance(e.type, ints) and isinstance(t, ints):
            if isinstance(t, ty.Bool) and not isinstance(e.type, ty.Bool):
                return A.Binary("!=", e, A.Num(0, e.type), ty.BOOL)
            return A.Cast(e, t, True)
        if isinstance(e.type, ty.Ptr) and t == ty.Ptr(ty.VOID):
            return A.Cast(e, t, True)
        raise NotReconstructed("CONVERSION")

    # -- statements -----------------------------------------------------------------------------
    def block(self, blk: Block) -> list[A.Stmt]:
        out: list[A.Stmt] = []
        for o in blk.ops:
            v = o.defs[0] if o.defs else None
            if v is not None and v in self.named:
                out.append(A.Assign(self.local[v], self.converted(self.write(o), self.local[v].type)))
            elif o.kind == "store":
                w = self.fn.width(o.args[1])
                n = self.t.split(o)
                if n:
                    c = o.args[1]
                    assert isinstance(c, Const)
                    for j in range(n):
                        part = w // n
                        t = self.t.ctype(self.t._member_at(o.args[0], j * part // 8, part))
                        out.append(A.Assign(self.lvalue(o.args[0], part, t, j * part // 8), A.Num(c.value >> j * part & (1 << part) - 1, t)))
                    continue
                t = self.t.ctype(self.t.access(o.args[0], w))
                to = self.lvalue(o.args[0], w, t)
                if isinstance(to, A.Num):
                    raise NotReconstructed("STORE_TO_READ_ONLY_MEMORY")
                out.append(A.Assign(to, self.converted(self.expr(o.args[1], t), t)))
            elif o.kind == "call" and (v is None or not self.users.get(v)):
                out.append(A.Do(self.call(o)))
            elif not o.pure and o.kind not in ("load", "call"):
                raise NotReconstructed("EFFECT_" + o.kind.upper())
        return out

    def flow(self) -> Flow:
        fn = self.fn
        nodes: dict[int, Node] = {}
        fresh = len(fn.blocks)
        result = ty.VOID if self.t.sig.result is None else self.t.ctype(self.t.slot(-1, -1, self.t.sig.result))
        for b in self.order:
            blk = fn.blocks[b]
            n = nodes[b] = Node(self.block(blk))
            t = blk.term
            if t.kind == "return":
                n.term = ("return", self.converted(self.expr(t.args[0], result), result) if t.args else None)
                continue
            if t.kind not in ("goto", "branch"):
                raise NotReconstructed("EXIT_" + t.kind.upper())
            targets = []
            for s in dict.fromkeys(t.targets):
                moves = self.moves(b, s)
                if not moves:
                    targets.append(s)
                elif t.kind == "goto":
                    n.stmts += moves
                    targets.append(s)
                else:
                    nodes[fresh] = Node(moves, ("goto", s))
                    targets.append(fresh)
                    fresh += 1
            n.term = ("goto", targets[0]) if t.kind == "goto" else ("branch", self.expr(t.args[0]), targets[0], targets[1])
        params = []
        local = {x.id: x for x in self.local.values()}
        for k, s in enumerate(self.t.sig.params):
            params.append(local.get(k) or A.Local(k, self.t.ctype(self.t.slot(-1, k, s))))
        return Flow(nodes, tuple(params), result, tuple(sorted(self.assumed)))

    def moves(self, b: int, s: int) -> list[A.Stmt]:
        """The copies of an edge, in an order in which none overwrites what a later one reads."""
        todo: list[tuple[A.Local, A.Expr]] = []
        for p in self.fn.blocks[s].phis:
            if p.region is None:
                to = self.local[p.id]
                e = self.converted(self.expr(dict(p.args)[b], to.type), to.type)
                if e != to:
                    todo.append((to, e))
        out: list[A.Stmt] = []
        while todo:
            for k, (to, _e) in enumerate(todo):
                if not any(to in A.walk(e) for j, (_t, e) in enumerate(todo) if j != k):
                    out.append(A.Assign(*todo.pop(k)))
                    break
            else:
                to, _e = todo[0]
                keep = A.Local(self.next_local, to.type)
                self.next_local += 1
                out.append(A.Assign(keep, to))
                todo = [(t, _swap(e, to, keep)) if k else (t, e) for k, (t, e) in enumerate(todo)]
        return out


def _swap(e, old, new):
    return new if e == old else A.rebuild(e, lambda x: _swap(x, old, new))


__all__ = ["Builder", "Flow", "Node", "negate"]
