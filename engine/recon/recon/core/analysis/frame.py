# SPDX-License-Identifier: AGPL-3.0-or-later
"""The stack frame and what registers hold, by abstract execution over the control-flow graph.

A value is a constant, "the low bits equal what location X held on entry plus a constant", or unknown. The stack
pointer is one such value, so its height is known at every instruction or the frame is refused. Stack slots are
tracked the same way, which shows whether a register a function must preserve really gets its entry value back.

A value computed from a frame address in a way that is not followed (an index into a local array) is marked as
derived from the frame. A store through it, or through an unknown pointer once a frame address has left the
function's sight, makes every slot unknown except saved registers. That exception is an assumption (the program
stays inside its own objects), and the result states it whenever it was used.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from recon.core.analysis.cfg import RETURN, TAIL, TAIL_INDIRECT, Cfg
from recon.core.analysis.dataflow import Abi
from recon.core.evaluate import UNDEF, apply
from recon.core.sem import Atom, BlockCopy, BlockFill, CallTo, Const, Get, Let, Lifted, Load, Put, Store


@dataclass(frozen=True, slots=True)
class Sym:
    """The low `low` bits are `off` (base None) or the entry value of location `base` plus `off`. With `low` 0 only the origin is known."""

    base: str | None
    off: int
    low: int


TOP = None  # unknown
Value = Sym | None


class FrameError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class State:
    locs: dict[str, Value]
    slots: dict[int, Value]          # entry-relative byte offset of a word-sized slot
    escaped: bool = False            # a frame address went where this analysis cannot follow (memory outside, a callee)
    spilled: bool = False            # a frame address was stored in the frame
    crossed: frozenset[int] = frozenset()   # slots kept across a call that could be its stack arguments

    def copy(self) -> "State":
        return State(dict(self.locs), dict(self.slots), self.escaped, self.spilled, self.crossed)


@dataclass(frozen=True)
class Access:
    rva: int
    off: int        # relative to the stack pointer on entry (0 is the return address)
    size: int
    write: bool


@dataclass
class Frame:
    heights: dict[int, int] = field(default_factory=dict)       # instruction RVA -> stack pointer minus its entry value, before it
    accesses: list[Access] = field(default_factory=list)
    indexed: list[int] = field(default_factory=list)            # instructions that access the frame at an offset that is not constant
    saved: dict[str, int] = field(default_factory=dict)         # preserved location -> slot it was saved in
    saved_at: dict[str, int] = field(default_factory=dict)      # ... and the instruction that did it
    address_taken: list[int] = field(default_factory=list)      # frame offsets whose address reaches a call or memory
    depth: int = 0                                              # lowest height, as a positive number
    assumptions: tuple[str, ...] = ()
    calls: dict[int, tuple[str, int | None]] = field(default_factory=dict)   # call RVA -> (direct or indirect, target address)
    constants: dict[tuple[int, str], int] = field(default_factory=dict)      # (instruction, location it reads) -> its constant value

    def regions(self, abi: Abi) -> dict[str, list[int]]:
        """Offsets of accessed slots by what they are: the caller's home space and stack arguments, saved registers, the rest."""
        save = set(self.saved.values())
        out: dict[str, set[int]] = {"return-address": set(), "home": set(), "stack-arguments": set(), "saved": set(), "locals": set()}
        for a in self.accesses:
            if a.off in save:
                out["saved"].add(a.off)
            elif a.off >= abi.word + abi.home:
                out["stack-arguments"].add(a.off)
            elif a.off >= abi.word:
                out["home"].add(a.off)
            elif a.off >= 0:
                out["return-address"].add(a.off)
            else:
                out["locals"].add(a.off)
        return {k: sorted(v) for k, v in out.items()}

    def summary(self, abi: Abi) -> dict:
        return {"heights": [[r, h] for r, h in sorted(self.heights.items())], "depth": self.depth, "regions": self.regions(abi), "indexed": self.indexed,
                "saved": [[k, v, self.saved_at[k]] for k, v in sorted(self.saved.items())], "address_taken": self.address_taken, "assumptions": list(self.assumptions),
                "calls": [[r, k, t] for r, (k, t) in sorted(self.calls.items())], "constants": [[r, n, v] for (r, n), v in sorted(self.constants.items())]}


CALLEE_ARGS = "callees-do-not-change-stack-arguments-this-function-reads-back"
IN_BOUNDS = "indexed-and-escaped-stores-miss-saved-registers"
COMPARE = frozenset({"eq", "ne", "ult", "ule", "slt", "sle"})


class _Run:
    def __init__(self, cfg: Cfg, abi: Abi, widths: dict[str, int]) -> None:
        self.cfg, self.abi = cfg, abi
        self.bits = 8 * abi.word
        self.mask = (1 << self.bits) - 1
        self.entry = State({n: Sym(n, 0, w) for n, w in sorted(widths.items())}, {})
        self.frame = Frame()
        self.derived = Sym(abi.stack, 0, 0)
        self.reset()

    def reset(self) -> None:
        self.taken: set[int] = set()
        self.acc: set[Access] = set()
        self.indexed: set[int] = set()
        self.saved: dict[str, int] = {}
        self.saved_at: dict[str, int] = {}
        self.assumed: set[str] = set()
        self.frame.calls.clear()
        self.frame.constants.clear()

    # -- values ---------------------------------------------------------------------------------
    def from_frame(self, v: Value) -> bool:
        return v is not TOP and v.base == self.abi.stack

    def lost(self, args: list[Value], width: int) -> Value:
        """The result of an operation that is not followed."""
        return self.derived if width >= self.bits and any(self.from_frame(a) for a in args) else TOP

    def fold(self, s: Let, env: dict[int, Value]) -> Value:
        a = [self.value(x, env) for x in s.args]
        w = s.dst.width
        if s.op == "undef":
            return TOP
        if all(v is not TOP and v.base is None and v.low == x.width for v, x in zip(a, s.args)):
            r = apply(s.op, [v.off for v in a], [x.width for x in s.args], w)  # type: ignore[union-attr]
            return TOP if r is UNDEF else Sym(None, r, w)
        if s.op == "ite":
            c = a[0]
            if c is not TOP and c.base is None and c.low:
                return a[1] if c.off else a[2]
            return a[1] if a[1] is not TOP and a[1] == a[2] else self.lost(a[1:], w)
        if s.op in COMPARE:
            return TOP
        full = all(v is not TOP and v.low == x.width for v, x in zip(a, s.args))
        if s.op in ("xor", "sub") and (s.args[0] == s.args[1] or full and a[0] == a[1]):
            return Sym(None, 0, w)
        if s.op in ("or", "and") and full and a[0] == a[1]:
            return a[0]
        if s.op == "zext" and a[0] is not TOP:
            return a[0]  # the low bits are the same; the new ones are not part of `low`
        if s.op == "trunc" and a[0] is not TOP:
            low = min(a[0].low, w)
            return Sym(a[0].base, a[0].off & ((1 << low) - 1), low) if low else TOP
        if s.op in ("add", "sub") and a[0] is not TOP and a[1] is not TOP:
            x, y = a
            low = min(x.low, y.low)
            m = (1 << low) - 1
            if low and y.base is None:
                return Sym(x.base, (x.off + (y.off if s.op == "add" else -y.off)) & m, low)
            if low and s.op == "add" and x.base is None:
                return Sym(y.base, (x.off + y.off) & m, low)
            if low and s.op == "sub" and x.base == y.base:
                return Sym(None, (x.off - y.off) & m, low)
        return self.lost(a, w)

    def value(self, a: Atom, env: dict[int, Value]) -> Value:
        return Sym(None, a.value, a.width) if isinstance(a, Const) else env[a.id]

    def height(self, v: Value) -> int | None:
        if v is not TOP and v.base == self.abi.stack and v.low >= self.bits:
            off = v.off & self.mask
            return off - (1 << self.bits) if off >> (self.bits - 1) else off
        return None

    def escapes(self, v: Value, st: State) -> None:
        if self.from_frame(v):
            st.escaped = True
            h = self.height(v)
            if h is not None:
                self.taken.add(h)

    def join(self, a: Value, b: Value) -> Value:
        if a == b:
            return a
        return self.derived if self.from_frame(a) or self.from_frame(b) else TOP

    def merge(self, into: State, o: State) -> bool:
        locs = {k: self.join(into.locs.get(k), o.locs.get(k)) for k in into.locs.keys() | o.locs.keys()}
        slots = {k: self.join(into.slots.get(k), o.slots.get(k)) for k in into.slots.keys() | o.slots.keys()}
        locs = {k: v for k, v in locs.items() if v is not TOP}
        slots = {k: v for k, v in slots.items() if v is not TOP}
        esc, sp, cr = into.escaped or o.escaped, into.spilled or o.spilled, into.crossed | o.crossed
        changed = locs != {k: v for k, v in into.locs.items() if v is not TOP} or slots != into.slots or (esc, sp, cr) != (into.escaped, into.spilled, into.crossed)
        into.locs, into.slots, into.escaped, into.spilled, into.crossed = locs, slots, esc, sp, cr
        return changed

    # -- one instruction ------------------------------------------------------------------------
    def step(self, i: Lifted, st: State) -> None:
        env: dict[int, Value] = {}
        abi = self.abi
        sp = self.height(st.locs.get(abi.stack))
        if sp is None:
            raise FrameError("stack-pointer-unknown")
        if self.frame.heights.setdefault(i.rva, sp) != sp:
            raise FrameError("stack-height-differs")
        self.frame.depth = max(self.frame.depth, -sp)
        for s in i.stmts:
            if isinstance(s, Let):
                env[s.dst.id] = self.fold(s, env)
            elif isinstance(s, Get):
                v = env[s.dst.id] = st.locs.get(s.loc.name)
                if v is not TOP and v.base is None and v.low == s.loc.width:
                    self.frame.constants[(i.rva, s.loc.name)] = v.off
            elif isinstance(s, Put):
                st.locs[s.loc.name] = self.value(s.val, env)
            elif isinstance(s, Load):
                env[s.dst.id] = self.load(i, self.value(s.addr, env), s.dst.width, st)
            elif isinstance(s, Store):
                self.store(i, self.value(s.addr, env), self.value(s.val, env), s.val.width // 8, st)
            elif isinstance(s, (BlockCopy, BlockFill)):
                self.block(i, s, st, env)
        if isinstance(i.terminator, CallTo):
            self.call(i, st, env)

    def load(self, i: Lifted, addr: Value, width: int, st: State) -> Value:
        h = self.height(addr)
        unknown = self.derived if st.spilled and width >= self.bits else TOP
        if h is None:
            if self.from_frame(addr):
                self.indexed.add(i.rva)
                return unknown
            return self.derived if st.escaped and width >= self.bits else TOP
        self.acc.add(Access(i.rva, h, width // 8, False))
        if width != self.bits:
            return TOP
        if h in st.slots and h in st.crossed and h not in self.saved.values():
            self.assumed.add(CALLEE_ARGS)
        return st.slots.get(h, unknown)

    def store(self, i: Lifted, addr: Value, v: Value, size: int, st: State) -> None:
        abi = self.abi
        h = self.height(addr)
        if h is None:
            if self.from_frame(addr):
                # an index into the frame, or a pointer that may be one
                self.indexed.add(i.rva)
                if self.from_frame(v):
                    st.spilled = True
                    self.escapes(v, st)
                self.forget(st)
            else:
                self.escapes(v, st)
                if st.escaped:
                    self.forget(st)
            return
        self.acc.add(Access(i.rva, h, size, True))
        if self.from_frame(v):
            st.spilled = True
        for k in [k for k in st.slots if k < h + size and h < k + abi.word]:
            del st.slots[k]
        st.crossed -= {k for k in st.crossed if k < h + size and h < k + abi.word}
        if size == abi.word and v is not TOP:
            st.slots[h] = v
            if v.base in abi.preserved and v.off == 0 and v.low == self.bits and v.base not in self.saved and h < abi.word + abi.home:
                self.saved[v.base] = h
                self.saved_at[v.base] = i.rva

    def block(self, i: Lifted, s: BlockCopy | BlockFill, st: State, env: dict[int, Value]) -> None:
        """An unknown extent: it may reach every slot of the frame once it touches the frame at all."""
        dst = self.value(s.dst, env)
        src = self.value(s.src, env) if isinstance(s, BlockCopy) else TOP
        for v, write in ((dst, True), (src, False)):
            if self.from_frame(v):
                self.indexed.add(i.rva)
                h = self.height(v)
                if h is not None:
                    self.acc.add(Access(i.rva, h, 1, write))
        if self.from_frame(src) and st.spilled and not self.from_frame(dst):
            st.escaped = True  # it may copy a stored frame address out
        if self.from_frame(dst):
            st.spilled = st.spilled or st.escaped
            self.forget(st)
        elif st.escaped:
            self.forget(st)

    def forget(self, st: State) -> None:
        """Slots an unfollowed pointer into the frame may reach; saved registers are kept (the stated assumption)."""
        keep = set(self.saved.values())
        kept = {k: v for k, v in st.slots.items() if k in keep}
        if kept:
            self.assumed.add(IN_BOUNDS)
        st.slots = kept

    def call(self, i: Lifted, st: State, env: dict[int, Value]) -> None:
        abi = self.abi
        t = i.terminator
        assert isinstance(t, CallTo)
        tv = self.value(t.target, env)
        self.frame.calls[i.rva] = ("direct", tv.off) if tv is not TOP and tv.base is None and tv.low >= self.bits else ("indirect", None)
        for n in sorted(abi.arguments):
            if n != abi.stack:
                self.escapes(st.locs.get(n), st)
        sp = self.height(st.locs.get(abi.stack))
        if sp is None:
            raise FrameError("stack-pointer-unknown")
        # from the home space down everything is the callee's
        hi = sp + abi.word + abi.home
        st.slots = {k: v for k, v in st.slots.items() if k >= hi}
        for v in st.slots.values():
            self.escapes(v, st)  # it may be a stack argument
        st.crossed = frozenset(k for k in st.slots if k < 0)
        st.locs[abi.stack] = Sym(abi.stack, (sp + abi.word) & self.mask, self.bits)
        for n in abi.clobbered:
            # a callee that was given a frame address may return it
            st.locs[n] = self.derived if st.escaped and n in abi.results else TOP
        if st.escaped:
            self.forget(st)

    # -- the function ---------------------------------------------------------------------------
    def sweep(self, states: dict[int, State]) -> dict[int, State]:
        out: dict[int, State] = {}
        for k in sorted(states):
            st = states[k].copy()
            for i in self.cfg.blocks[k].insns:
                self.step(i, st)
            out[k] = st
        return out

    def go(self) -> Frame:
        states: dict[int, State] = {self.cfg.entry: self.entry.copy()}
        work = {self.cfg.entry}
        rounds = 0
        while work:
            rounds += 1
            if rounds > 256 * (len(self.cfg.blocks) + 1):  # the lattice is finite and low; this is a defect, not an input
                raise FrameError("analysis-did-not-settle")
            k = min(work)
            work.discard(k)
            st = states[k].copy()
            for i in self.cfg.blocks[k].insns:
                self.step(i, st)
            for e in self.cfg.blocks[k].edges:
                if e.to not in states:
                    states[e.to] = st.copy()
                    work.add(e.to)
                elif self.merge(states[e.to], st):
                    work.add(e.to)
        # over the settled states, so that what is recorded does not depend on the order of the first pass
        first = dict(self.saved)
        self.reset()
        self.sweep(states)
        if self.saved != first:
            raise FrameError("saved-registers-unsettled")
        self.check_exits(self.sweep(states))
        f = self.frame
        f.saved, f.saved_at = dict(sorted(self.saved.items())), dict(sorted(self.saved_at.items()))
        f.accesses = sorted(self.acc, key=lambda a: (a.rva, a.off, a.size, a.write))
        f.indexed = sorted(self.indexed)
        f.address_taken = sorted(self.taken)
        f.assumptions = tuple(sorted(self.assumed))
        return f

    def check_exits(self, out: dict[int, State]) -> None:
        for k, st in sorted(out.items()):
            b = self.cfg.blocks[k]
            if b.end_kind not in (RETURN, TAIL, TAIL_INDIRECT) and not b.leaves_to:
                continue
            # a return has already popped the return address
            if self.height(st.locs.get(self.abi.stack)) != (self.abi.word if b.end_kind == RETURN else 0):
                raise FrameError("stack-not-balanced-at-exit")
            for n in sorted(self.abi.preserved):
                if n in self.entry.locs and st.locs.get(n) != self.entry.locs[n]:
                    raise FrameError("preserved-register-not-restored")


def analyse(cfg: Cfg, abi: Abi, widths: dict[str, int]) -> Frame:
    """The frame, or FrameError. `widths` names every location that has an entry value, with its width."""
    return _Run(cfg, abi, widths).go()


__all__ = ["Access", "Frame", "FrameError", "Sym", "TOP", "analyse"]
