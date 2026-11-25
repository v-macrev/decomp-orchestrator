# SPDX-License-Identifier: AGPL-3.0-or-later
"""Structured statements from a reducible graph of statement lists.

The dominator tree gives the nesting: a node reached by one forward edge is written where that edge leaves; a node
several edges reach follows the statement of the node that dominates it, outside every loop it is not part of. An edge
is then nothing (it falls through), `break`, `continue`, or, when none of these, `goto`. Short-circuit conditions are
joined first. Nothing is duplicated except, when asked for, returns.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from recon.core.analysis import graph
from recon.core.inference import types as ty
from recon.core.inference.signature import NotReconstructed
from recon.core.structuring import ast as A
from recon.core.structuring.build import Flow, Node, negate


@dataclass(frozen=True)
class Style:
    """Choices of form, each of which leaves the meaning as it is."""

    split_returns: bool = True       # a return that only hands a variable on is written where the variable is known
    select: str = "expr"             # a conditional value as ?: ("expr") or as statements ("if")
    invert: bool = False             # two-way branches with the arms exchanged
    mirror: tuple[int, ...] = ()     # comparisons written from the other side, by position; (-1,) is all of them


# ---------------------------------------------------------------------------------------- the graph

class _Graph:
    def __init__(self, flow: Flow) -> None:
        self.n = {k: Node(list(v.stmts), v.term) for k, v in flow.nodes.items()}
        self.flow = flow

    def succ(self, k: int) -> list[int]:
        t = self.n[k].term
        return [t[1]] if t[0] == "goto" else [t[2], t[3]] if t[0] == "branch" else []

    def preds(self) -> dict[int, list[int]]:
        out: dict[int, list[int]] = {k: [] for k in self.n}
        for k in sorted(self.n):
            for s in dict.fromkeys(self.succ(k)):
                out[s].append(k)
        return out

    def retarget(self, k: int, old: int, new: int) -> None:
        t = self.n[k].term
        if t[0] == "goto":
            self.n[k].term = ("goto", new if t[1] == old else t[1])
        elif t[0] == "branch":
            y, f = (new if x == old else x for x in t[2:])
            self.n[k].term = ("branch", t[1], y, f) if y != f else ("goto", y)

    def prune(self) -> None:
        seen = {0}
        work = [0]
        while work:
            for s in self.succ(work.pop()):
                if s not in seen:
                    seen.add(s)
                    work.append(s)
        self.n = {k: v for k, v in self.n.items() if k in seen}

    def simplify(self) -> None:
        """Skip empty nodes, join straight lines, make equal nodes one."""
        changed = True
        while changed:
            changed = False
            self.prune()
            for k in sorted(self.n):
                t = self.n[k].term
                if t[0] == "branch" and t[2] == t[3]:
                    self.n[k].term = ("goto", t[2])
                    changed = True
                for s in self.succ(k):
                    m = self.n[s]
                    if not m.stmts and m.term[0] == "goto" and m.term[1] != s and s != k:
                        self.retarget(k, s, m.term[1])
                        changed = True
            same: dict[tuple, int] = {}
            for k in sorted(self.n):
                if k == 0 or self.n[k].term[0] == "branch":
                    continue
                key = (tuple(self.n[k].stmts), self.n[k].term)
                if key in same and self.n[k].term[0] == "goto":
                    for j in self.n:
                        self.retarget(j, k, same[key])
                    changed = True
                else:
                    same.setdefault(key, k)
            self.prune()
            preds = self.preds()
            for k in sorted(self.n):
                t = self.n[k].term
                if t[0] == "goto" and t[1] != k and t[1] != 0 and preds[t[1]] == [k]:
                    m = self.n.pop(t[1])
                    self.n[k].stmts += m.stmts
                    self.n[k].term = m.term
                    changed = True
                    break


def join_conditions(g: _Graph) -> None:
    """a branch into a node that is only a condition and shares a target with it becomes one condition."""
    changed = True
    while changed:
        changed = False
        preds = g.preds()
        for k in sorted(g.n):
            t = g.n[k].term
            if t[0] != "branch":
                continue
            for side in (0, 1):
                m, shared = t[2 + side], t[3 - side]
                x = g.n[m]
                if m == k or m == 0 or x.stmts or x.term[0] != "branch" or preds[m] != [k] or shared not in x.term[2:] or m in x.term[2:]:
                    continue
                c, d = t[1], x.term[1]
                if side == 1:
                    c = negate(c)
                other = x.term[3] if x.term[2] == shared else x.term[2]
                if x.term[2] == shared:
                    d = negate(d)
                # c and d leads on, anything else to the shared target
                g.n[k].term = ("branch", A.Binary("&&", c, d, ty.BOOL), other, shared)
                del g.n[m]
                changed = True
                break
            if changed:
                break
    for k in sorted(g.n):           # !(a && b) reads better as !a || !b where the branch was taken for failing
        t = g.n[k].term
        if t[0] == "branch" and isinstance(t[1], A.Binary) and t[1].op == "&&" and _negative(t[1]):
            g.n[k].term = ("branch", _not(t[1]), t[3], t[2])


def _negative(e: A.Expr) -> bool:
    return isinstance(e, A.Unary) and e.op == "!" or isinstance(e, A.Binary) and (e.op == "!=" or e.op == "&&" and _negative(e.left) and _negative(e.right))


def _not(e: A.Expr) -> A.Expr:
    if isinstance(e, A.Binary) and e.op in ("&&", "||"):
        return A.Binary("||" if e.op == "&&" else "&&", _not(e.left), _not(e.right), e.type)
    return negate(e)


def split_returns(g: _Graph) -> None:
    """Where a return hands on a variable the edge has just set, the edge returns that value itself."""
    for k in sorted(g.n):
        if k not in g.n:
            continue
        x = g.n[k]
        if x.stmts or x.term[0] != "return" or not isinstance(x.term[1], (A.Local, A.Num)) or k == 0:
            continue
        v = x.term[1]
        for p in g.preds()[k]:
            n = g.n[p]
            if n.term[0] != "goto":
                continue
            if n.stmts and isinstance(n.stmts[-1], A.Assign) and n.stmts[-1].to == v and isinstance(v, A.Local):
                value = n.stmts[-1].value
                if v.type == value.type or isinstance(value, (A.Num, A.Cast)):
                    n.stmts.pop()
                    n.term = ("return", value)
            elif isinstance(v, A.Num) or not n.stmts:
                n.term = ("return", v)
    g.prune()


# ---------------------------------------------------------------------------------------- structure

@dataclass(frozen=True, slots=True)
class _Jump:
    to: int


@dataclass(frozen=True, slots=True)
class _Mark:
    id: int


class _Structurer:
    def __init__(self, g: _Graph) -> None:
        self.ids = sorted(g.n)
        at = {k: j for j, k in enumerate(self.ids)}
        self.g = g
        self.succ = [[at[s] for s in g.succ(k)] for k in self.ids]
        self.order = graph.reverse_postorder(self.succ, 0)
        self.pos = {n: j for j, n in enumerate(self.order)}
        self.idom = graph.immediate_dominators(self.succ, 0)
        loops, reducible = graph.natural_loops(self.succ, 0)
        if not reducible:
            raise NotReconstructed("IRREDUCIBLE_CONTROL_FLOW")
        self.loops = {lp.header: set(lp.body) for lp in loops}
        self.parent = {lp.header: lp.parent for lp in loops}
        self.latches = {lp.header: lp.latches for lp in loops}
        forward = [0] * len(self.ids)
        for n, ss in enumerate(self.succ):
            for s in ss:
                if self.pos[s] > self.pos[n]:
                    forward[s] += 1
        self.merge = {n for n in range(len(self.ids)) if forward[n] > 1}
        self._follows()
        self.placed: dict[int, list[int]] = {}
        for n in self.order:
            if n in self.merge:
                self.placed.setdefault(self._home(n), []).append(n)

    def _inner(self, n: int) -> int | None:
        """The innermost loop of a node."""
        best = None
        for h, body in self.loops.items():
            if n in body and (best is None or len(body) < len(self.loops[best])):
                best = h
        return best

    def _follows(self) -> None:
        """One exit of each loop is written after it."""
        for h, body in self.loops.items():
            exits = []
            for n in [h, *self.latches[h], *sorted(body, key=lambda x: self.pos[x])]:
                exits += [s for s in self.succ[n] if s not in body and s not in exits]
            own = [s for s in exits if self.idom[s] in body and s not in self.merge]
            if own and not any(s in self.merge and self.idom[s] in body for s in exits[:1]):
                self.merge.add(own[0])

    def _home(self, n: int) -> int:
        p = self.idom[n]
        assert p is not None
        inner = [h for h, body in self.loops.items() if p in body and n not in body]
        return max(inner, key=lambda h: len(self.loops[h])) if inner else p  # out of the largest such loop

    def tree(self, n: int) -> list:
        node = self.g.n[self.ids[n]]
        mine = self.placed.get(n, [])
        inside = [m for m in mine if n in self.loops and m in self.loops[n]]
        after = [m for m in mine if m not in inside]
        if n not in self.loops:
            inside, after = after, []
        out: list = list(node.stmts) + self.ending(n, node)
        for m in inside:
            out += [_Mark(m), *self.tree(m)]
        if n in self.loops:
            out = [A.Loop("ever", None, tuple(out))]
            for m in after:
                out += [_Mark(m), *self.tree(m)]
        return out

    def ending(self, n: int, node: Node) -> list:
        t = node.term
        if t[0] == "return":
            return [A.Return(t[1])]
        if t[0] == "goto":
            return self.edge(n, self.succ[n][0])
        if t[0] == "branch":
            return [A.If(t[1], tuple(self.edge(n, self.succ[n][0])), tuple(self.edge(n, self.succ[n][1])))]
        raise NotReconstructed("NO_RETURN")

    def edge(self, n: int, s: int) -> list:
        if s in self.merge or self.pos[s] <= self.pos[n]:
            return [_Jump(s)]
        return self.tree(s)

    # -- jumps ----------------------------------------------------------------------------------
    def resolve(self, body: list) -> tuple[A.Stmt, ...]:
        used: set[int] = set()
        # labels that stay: found first, so that marks can be dropped
        out = self._seq(body, None, None, None, used)
        return _labels(out, used)

    def _seq(self, body, then: int | None, again: int | None, leave: int | None, used: set[int]) -> list:
        """`then`: where control goes after the list; `again`: the loop's header; `leave`: what follows the loop."""
        out: list = []
        for j, s in enumerate(body):
            rest = body[j + 1:]
            last = not rest
            nxt = then if last else (rest[0].id if isinstance(rest[0], _Mark) else None)
            if isinstance(s, _Mark):
                out.append(A.Label(s.id))
            elif isinstance(s, _Jump):
                if nxt is not None and s.to == nxt:
                    continue
                if again is not None and s.to == again:
                    out.append(A.Continue())
                elif leave is not None and s.to == leave:
                    out.append(A.Break())
                else:
                    used.add(s.to)
                    out.append(A.Goto(s.to))
            elif isinstance(s, A.If):
                out.append(A.If(s.cond, tuple(self._seq(s.then, nxt, again, leave, used)), tuple(self._seq(s.other, nxt, again, leave, used))))
            elif isinstance(s, A.Loop):
                head = self._header_of(s)
                out.append(A.Loop(s.form, s.cond, tuple(self._seq(s.body, head, head, nxt, used))))
            else:
                out.append(s)
        return out

    def _header_of(self, s: A.Loop) -> int:
        return self._heads[id(s)]

    def go(self) -> tuple[A.Stmt, ...]:
        self._heads: dict[int, int] = {}
        body = self._tree_with_heads(0)
        return self.resolve(body)

    def _tree_with_heads(self, n: int) -> list:
        # loops are found again by identity, so the tree is built once and each loop remembered as it is made
        plain = self.tree

        def tree(k: int) -> list:
            out = plain(k)
            if k in self.loops:
                first = out[0]
                assert isinstance(first, A.Loop)
                self._heads[id(first)] = k
                self._keep.append(first)
            return out
        self._keep: list = []
        self.tree = tree  # type: ignore[method-assign]
        return tree(n)


def _labels(body, used: set[int]) -> tuple[A.Stmt, ...]:
    out: list[A.Stmt] = []
    for s in body:
        if isinstance(s, A.Label):
            if s.label in used:
                out.append(s)
        elif isinstance(s, A.If):
            out.append(A.If(s.cond, _labels(s.then, used), _labels(s.other, used)))
        elif isinstance(s, A.Loop):
            out.append(A.Loop(s.form, s.cond, _labels(s.body, used)))
        else:
            out.append(s)
    return tuple(out)


# ---------------------------------------------------------------------------------------- tidying the tree

def ends(body: tuple[A.Stmt, ...]) -> bool:
    """Whether control never runs off the end of the list."""
    if not body:
        return False
    s = body[-1]
    if isinstance(s, (A.Return, A.Break, A.Continue, A.Goto)):
        return True
    return isinstance(s, A.If) and ends(s.then) and ends(s.other)


def _has(body: tuple[A.Stmt, ...], kind) -> bool:
    """Whether a statement of the kind belongs to this list's own loop."""
    for s in body:
        if isinstance(s, kind):
            return True
        if isinstance(s, A.If) and (_has(s.then, kind) or _has(s.other, kind)):
            return True
    return False


def _any(body: tuple[A.Stmt, ...], kind) -> bool:
    return any(isinstance(x, kind) for s in body for x in A.walk(s))


def tidy(body: tuple[A.Stmt, ...], style: Style) -> tuple[A.Stmt, ...]:
    out: list[A.Stmt] = []
    for j, s in enumerate(body):
        if isinstance(s, A.If):
            then, other = tidy(s.then, style), tidy(s.other, style)
            c = s.cond
            if not then and not other:
                if any(isinstance(x, A.Call) for x in A.walk(c)):
                    out.append(A.Do(c))
                continue
            if not then:
                c, then, other = _not(c), other, ()
            elif other and style.invert:
                c, then, other = _not(c), other, then
            if other and ends(then):
                out += [A.If(c, then), *other]
            elif other and ends(other):
                out += [A.If(_not(c), other), *then]
            else:
                out.append(A.If(c, then, other))
        elif isinstance(s, A.Loop):
            out += _loop(A.Loop(s.form, s.cond, tidy(s.body, style)))
        else:
            out.append(s)
        if ends(tuple(out[-1:])) and not any(isinstance(x, A.Label) for r in body[j + 1:] for x in A.walk(r)):
            break  # nothing after it is reached
    return tuple(out)


def _loop(s: A.Loop) -> list[A.Stmt]:
    """A loop without a condition as `while` or `do`, when leaving it is the first or the last thing its body does."""
    body = _strip(s.body)
    if s.form != "ever" or not body:
        return [A.Loop(s.form, s.cond, body)]
    f, rest = body[0], body[1:]
    if isinstance(f, A.If):
        if f.then == (A.Break(),) and not f.other and rest:
            return [A.Loop("while", _not(f.cond), _strip(rest))]
        if not f.other and rest == (A.Break(),) or f.other == (A.Break(),) and not rest:
            return [A.Loop("while", f.cond, _strip(f.then))]
        if not f.other and rest and isinstance(f.then[-1], A.Return) and not _has(f.then, (A.Break, A.Continue)) and not _has(rest, A.Break):
            return [A.Loop("while", _not(f.cond), _strip(rest)), *f.then]  # it leaves the function: the same after the loop
    last, before = body[-1], body[:-1]
    if isinstance(last, A.If) and not last.other and before and not _has(before, A.Continue):
        if last.then == (A.Break(),):
            return [A.Loop("do", _not(last.cond), before)]
        if isinstance(last.then[-1], A.Return) and not _has(last.then, (A.Break, A.Continue)) and not _has(before, A.Break):
            return [A.Loop("do", _not(last.cond), before), *last.then]
    if len(body) > 2 and isinstance(last, (A.Break, A.Return)) and not _has(body[:-2], A.Continue):
        c = body[-2]
        if isinstance(c, A.If) and c.then == (A.Continue(),) and not c.other:
            if isinstance(last, A.Break):
                return [A.Loop("do", c.cond, body[:-2])]
            if not _has(body[:-2], A.Break):
                return [A.Loop("do", c.cond, body[:-2]), last]
    return [A.Loop("ever", None, body)]


def _strip(body: tuple[A.Stmt, ...]) -> tuple[A.Stmt, ...]:
    while body and isinstance(body[-1], A.Continue):
        body = body[:-1]
    return body


def selects(body: tuple[A.Stmt, ...]) -> tuple[A.Stmt, ...]:
    """Conditional values written as statements."""
    out: list[A.Stmt] = []
    for s in body:
        if isinstance(s, A.Return) and isinstance(s.value, A.Choose):
            out += [A.If(s.value.cond, (A.Return(s.value.yes),)), A.Return(s.value.no)]
        elif isinstance(s, A.Assign) and isinstance(s.value, A.Choose):
            c = s.value
            if c.no == s.to:
                out.append(A.If(c.cond, (A.Assign(s.to, c.yes),)))
            elif c.yes == s.to:
                out.append(A.If(_not(c.cond), (A.Assign(s.to, c.no),)))
            else:
                out.append(A.If(c.cond, (A.Assign(s.to, c.yes),), (A.Assign(s.to, c.no),)))
        elif isinstance(s, A.If):
            out.append(A.If(s.cond, selects(s.then), selects(s.other)))
        elif isinstance(s, A.Loop):
            out.append(A.Loop(s.form, s.cond, selects(s.body)))
        else:
            out.append(s)
    return tuple(out)


# ---------------------------------------------------------------------------------------- declarations

def _mentions(s, v: A.Local) -> bool:
    return any(x == v for x in A.walk(s))


def declare(body: tuple[A.Stmt, ...], variables: list[A.Local]) -> tuple[A.Stmt, ...]:
    """Each variable is declared in the innermost list that holds all its uses, with its first value when that comes first."""
    for v in variables:
        body = _declare(body, v)
    return body


def _declare(body: tuple[A.Stmt, ...], v: A.Local) -> tuple[A.Stmt, ...]:
    at = [j for j, s in enumerate(body) if _mentions(s, v)]
    if not at:
        return body
    j = at[0]
    s = body[j]
    if isinstance(s, A.Assign) and s.to == v and not _mentions(s.value, v):
        return (*body[:j], A.Declare(v, s.value), *body[j + 1:])
    if len(at) == 1:
        if isinstance(s, A.If) and not _mentions(s.cond, v) and _mentions_any(s.then, v) != _mentions_any(s.other, v):
            return (*body[:j], A.If(s.cond, _declare(s.then, v), _declare(s.other, v)), *body[j + 1:])
        if isinstance(s, A.Loop) and (s.cond is None or not _mentions(s.cond, v)) and _first_is_assignment(s.body, v):
            return (*body[:j], A.Loop(s.form, s.cond, _declare(s.body, v)), *body[j + 1:])
    return (*body[:j], A.Declare(v, None), *body[j:])


def _mentions_any(body: tuple[A.Stmt, ...], v: A.Local) -> bool:
    return any(_mentions(s, v) for s in body)


def _first_is_assignment(body: tuple[A.Stmt, ...], v: A.Local) -> bool:
    """Whether the list sets the variable before anything in it reads it, so that nothing is carried around a loop."""
    for s in body:
        if _mentions(s, v):
            if isinstance(s, A.Assign) and s.to == v and not _mentions(s.value, v):
                return True
            if isinstance(s, A.If) and not _mentions(s.cond, v):
                arms = [a for a in (s.then, s.other) if _mentions_any(a, v)]
                return all(_first_is_assignment(a, v) for a in arms) and len(arms) == 1 and not any(_mentions(x, v) for x in body[body.index(s) + 1:])
            return False
    return False


MIRROR = {"<": ">", ">": "<", "<=": ">=", ">=": "<="}


def _orders(x) -> bool:
    return isinstance(x, A.Binary) and x.op in MIRROR and not isinstance(x.left, A.Num) and not isinstance(x.right, A.Num)


def comparisons(body: A.Body) -> int:
    """How many comparisons of order there are whose sides are both computed."""
    return sum(_orders(x) for s in body.stmts for x in A.walk(s))


def mirrored(body: tuple[A.Stmt, ...], which: tuple[int, ...]) -> tuple[A.Stmt, ...]:
    n = -1

    def f(x):
        nonlocal n
        mine = False
        if _orders(x):
            n += 1
            mine = n in which or which == (-1,)
        y = A.rebuild(x, f)
        return A.Binary(MIRROR[y.op], y.right, y.left, y.type) if mine else y
    return tuple(f(s) for s in body)


def structure(flow: Flow, style: Style = Style()) -> A.Body:
    g = _Graph(flow)
    g.simplify()
    join_conditions(g)
    g.simplify()
    if style.split_returns:
        split_returns(g)
        g.simplify()
    body = tidy(_Structurer(g).go(), style)
    body = tidy(body, replace(style, invert=False))
    if style.select == "if":
        body = selects(body)
    if style.mirror:
        body = mirrored(body, style.mirror)
    params = {p.id for p in flow.params}
    variables: dict[int, A.Local] = {}
    for s in body:
        for x in A.walk(s):
            if isinstance(x, A.Local) and x.id not in params:
                variables.setdefault(x.id, x)
    return A.Body(flow.params, flow.result, declare(body, [variables[k] for k in sorted(variables)]), flow.assumptions)


__all__ = ["Style", "comparisons", "structure"]
