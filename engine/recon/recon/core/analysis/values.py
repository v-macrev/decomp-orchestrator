# SPDX-License-Identifier: AGPL-3.0-or-later
"""Value numbering over a path of blocks: equal expressions get one node, constants are folded.

A node names a value in terms of what the path's start held: entry values of locations, loads and constants. Loads
carry the version of memory they saw; any store, block operation, fence or call starts a new version, so two loads
are one value only when nothing in between could have changed it (no alias reasoning).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from recon.core.evaluate import UNDEF, apply
from recon.core.sem import Atom, BlockCopy, BlockFill, Branch, CallTo, Const, Fence, Get, Goto, Let, Lifted, Load, Put, Store

COMMUTATIVE = frozenset({"add", "mul", "and", "or", "xor", "eq", "ne"})


@dataclass(frozen=True, slots=True)
class Node:
    """`kind`: const, entry, load, op, opaque. `args` are node ids."""

    kind: str
    width: int
    op: str = ""
    args: tuple[int, ...] = ()
    value: int = 0      # const: the value; load: the memory version; opaque: a serial number


@dataclass
class Values:
    nodes: list[Node] = field(default_factory=list)
    ids: dict[Node, int] = field(default_factory=dict)
    env: dict[str, int] = field(default_factory=dict)
    memory: int = 0
    serial: int = 0
    #: (instruction, location) -> the node the instruction reads there
    reads: dict[tuple[int, str], int] = field(default_factory=dict)
    #: instruction -> the condition of its branch, or the target of its jump or call
    control: dict[int, int] = field(default_factory=dict)
    #: instruction -> (operation, argument nodes) in order
    ops_at: dict[int, list[tuple[str, tuple[int, ...]]]] = field(default_factory=dict)

    def node(self, n: Node) -> int:
        k = self.ids.get(n)
        if k is None:
            k = self.ids[n] = len(self.nodes)
            self.nodes.append(n)
        return k

    def const(self, v: int, w: int) -> int:
        return self.node(Node("const", w, value=v))

    def opaque(self, w: int) -> int:
        self.serial += 1
        return self.node(Node("opaque", w, value=self.serial))

    def entry(self, name: str, width: int) -> int:
        k = self.env.get(name)
        if k is None:
            k = self.env[name] = self.node(Node("entry", width, name))
        return k

    def op(self, name: str, args: tuple[int, ...], w: int) -> int:
        """The node of an operation, simplified only by identities that hold for every input."""
        ns = [self.nodes[a] for a in args]
        mask = (1 << w) - 1
        if name == "undef":
            return self.opaque(w)
        if all(n.kind == "const" for n in ns):
            r = apply(name, [n.value for n in ns], [n.width for n in ns], w)
            return self.opaque(w) if r is UNDEF else self.const(r, w)
        if name in COMMUTATIVE and (ns[0].kind == "const", args[0]) > (ns[1].kind == "const", args[1]):
            args, ns = (args[1], args[0]), [ns[1], ns[0]]  # constants last, then by number, so equal expressions meet
        if name in ("add", "sub", "or", "xor", "shl", "lshr", "ashr") and ns[1].kind == "const" and ns[1].value == 0:
            return args[0]
        if name in ("xor", "sub") and args[0] == args[1]:
            return self.const(0, w)
        if name in ("and", "or") and args[0] == args[1]:
            return args[0]
        if name == "ite":
            if ns[0].kind == "const":
                return args[1] if ns[0].value else args[2]
            if args[1] == args[2]:
                return args[1]
        if name in ("zext", "sext", "trunc") and ns[0].width == w:
            return args[0]
        if name == "trunc" and ns[0].kind == "op":
            inner = ns[0]
            if inner.op == "trunc":
                return self.op("trunc", inner.args, w)
            if inner.op in ("zext", "sext"):
                narrow = self.nodes[inner.args[0]].width >= w
                return self.op("trunc" if narrow else inner.op, inner.args, w)
            if inner.op in ("add", "sub", "mul", "and", "or", "xor"):  # the low bits depend on the low bits only
                return self.op(inner.op, tuple(self.op("trunc", (x,), w) for x in inner.args), w)
        if name == "zext" and ns[0].kind == "op" and ns[0].op == "zext":
            return self.op("zext", ns[0].args, w)
        if name in ("add", "sub") and ns[1].kind == "const":
            c = ns[1].value if name == "add" else -ns[1].value
            if ns[0].kind == "op" and ns[0].op == "add" and self.nodes[ns[0].args[1]].kind == "const":
                return self.op("add", (ns[0].args[0], self.const((self.nodes[ns[0].args[1]].value + c) & mask, w)), w)
            if name == "sub":
                return self.op("add", (args[0], self.const(c & mask, w)), w)
        return self.node(Node("op", w, name, args))

    def run(self, insns: Iterable[Lifted], clobbered: dict[str, int] | None = None) -> "Values":
        """Follow the instructions in order. `clobbered` names the locations a call may change, with their widths."""
        for i in insns:
            env: dict[int, int] = {}

            def at(a: Atom) -> int:
                return self.const(a.value, a.width) if isinstance(a, Const) else env[a.id]

            for s in i.stmts:
                if isinstance(s, Let):
                    args = tuple(at(a) for a in s.args)
                    env[s.dst.id] = self.op(s.op, args, s.dst.width)
                    self.ops_at.setdefault(i.rva, []).append((s.op, args))
                elif isinstance(s, Get):
                    env[s.dst.id] = self.entry(s.loc.name, s.loc.width)
                    self.reads.setdefault((i.rva, s.loc.name), env[s.dst.id])
                elif isinstance(s, Put):
                    self.env[s.loc.name] = at(s.val)
                elif isinstance(s, Load):
                    env[s.dst.id] = self.opaque(s.dst.width) if s.atomic else self.node(Node("load", s.dst.width, args=(at(s.addr),), value=self.memory))
                elif isinstance(s, (Store, BlockCopy, BlockFill, Fence)):
                    self.memory += 1
                elif isinstance(s, Branch):
                    self.control[i.rva] = at(s.cond)
                elif isinstance(s, (Goto, CallTo)):
                    self.control[i.rva] = at(s.target)
            if isinstance(i.terminator, CallTo):
                self.memory += 1
                # without a convention nothing is known to survive
                for n, w in sorted((clobbered if clobbered is not None else {n: self.nodes[k].width for n, k in self.env.items()}).items()):
                    self.env[n] = self.opaque(w)
        return self
