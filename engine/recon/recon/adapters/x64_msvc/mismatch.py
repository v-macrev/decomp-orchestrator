# SPDX-License-Identifier: AGPL-3.0-or-later
"""How a compiled candidate differs from the target: one `MISMATCH` kind (core/synthesis/kinds.py) and its evidence.

The comparison reads two instruction streams, the candidate's (with what its relocations mean by the evidence) and the
target's, and never anything else of the target. It first tries the explanations that account for every difference at
once, in this order: the same instructions with other encodings or trailing padding (size only), the same instructions
under a renaming of registers, the same blocks in another order with conditions taken either way (block order, branch
polarity), the same instructions with other frame offsets (stack layout). When none explains everything, the streams
are aligned and each differing stretch is given the kind of what differs in it; the kind that accounts for the most
differing instructions is primary, a tie going to the earlier kind of `KINDS`.

Deterministic: no set or dict order reaches the result; the alignment is difflib's, which is deterministic. The kind is
evidence for choosing which rules to try next. It never decides anything about a match: only the comparator does.
"""
from __future__ import annotations

import difflib
from dataclasses import dataclass
from functools import lru_cache
from typing import Callable

from recon.adapters.x64_msvc import coff
from recon.adapters.x64_msvc.decode import _iced, mnemonic_name
from recon.core.synthesis import kinds as K

#: x64 registers a callee preserves (Windows): their saves and restores are unwind data
NONVOLATILE = ("RBX", "RBP", "RDI", "RSI", "R12", "R13", "R14", "R15")
#: extensions and the signed and unsigned forms of one operation
EXTENDING = frozenset({"movzx", "movsx", "movsxd", "cdqe", "cdq", "cqo", "cwde", "cbw", "cwd"})
SIGN_PAIRS = frozenset({frozenset(p) for p in (("shr", "sar"), ("div", "idiv"), ("mul", "imul"), ("movzx", "movsx"), ("movzx", "movsxd"),
                                               ("mov", "movzx"), ("mov", "movsx"), ("mov", "movsxd"), ("cvtsi2ss", "cvtsi2sd"))})
#: condition codes (iced's) that differ only in signedness: below/less, above/greater, and the or-equal forms
_SIGNED_CC = (("B", "L"), ("AE", "GE"), ("BE", "LE"), ("A", "G"))
PADDING = frozenset({"int3", "nop"})
#: a frame allocation of another size: stack layout or unwind, settled once all stretches are counted (`_primary`)
FRAME = "frame"


@dataclass(frozen=True)
class Ins:
    """One instruction, as the comparison sees it."""

    offset: int
    length: int
    mnemonic: str
    ops: tuple                      # operand tokens: ("r", register) ("m", size, base, index, scale, disp) ("i", value) ("b",) ("x",)
    cc: str                         # condition code name, "" without one
    flow: str                       # "jcc", "jmp", "call", "ret", "" (other)
    branch: int | None              # the offset an internal branch leads to
    ref: object                     # what an external field leads to: an RVA, "?" (no evidence names it), or None

    @property
    def token(self) -> tuple:
        """What has to be equal for two instructions to be the same instruction (references and branch targets apart)."""
        return (self.mnemonic, self.ops)

    @property
    def external(self) -> bool:
        return self.ref is not None


@dataclass(frozen=True)
class Mismatch:
    """The kind, and how many differing instructions each kind accounts for (sorted by kind order)."""

    kind: str
    counts: tuple[tuple[str, int], ...]
    #: one explanation accounts for every difference (as opposed to the largest share of stretches)
    whole: bool

    @property
    def code(self) -> str:
        return K.code(self.kind)


@lru_cache(maxsize=None)
def _regs():
    ix = _iced()
    names = {v: k for k, v in vars(ix.Register).items() if isinstance(v, int) and not k.startswith("_")}
    return ix, names


def decode(code: bytes, refs: dict[int, object], rva: int | None) -> list[Ins]:
    """The instructions of `code`. `refs`: offsets of relocated fields and what they mean (an RVA, or None: no evidence).
    `rva`: the code's own address when it is the target (its external fields are read from its bytes), else None."""
    ix, names = _regs()
    out: list[Ins] = []
    for i in ix.Decoder(64, code, ip=0):
        if i.is_invalid:
            out.append(Ins(i.ip, i.len, "(bad)", (bytes(code[i.ip:i.ip + i.len]),), "", "", None, None))
            continue
        mn = mnemonic_name(ix, i.mnemonic).lower()
        field = next((o for o in sorted(refs) if i.ip <= o < i.ip + i.len), None)
        ref: object = None
        if field is not None:
            ref = "?" if refs[field] is None else refs[field]
        flow = ("jcc" if i.is_jcc_short_or_near else "jmp" if i.is_jmp_short_or_near or i.is_jmp_near_indirect else
                "call" if i.is_call_near or i.is_call_near_indirect else "ret" if mn == "ret" else "")
        branch = None
        ops: list[tuple] = []
        for k in range(i.op_count):
            kind = i.op_kind(k)
            if kind == ix.OpKind.REGISTER:
                ops.append(("r", names.get(i.op_register(k), str(i.op_register(k)))))
            elif kind == ix.OpKind.MEMORY:
                if i.is_ip_rel_memory_operand:
                    if ref is None and rva is not None:
                        ref = rva + i.ip_rel_memory_address
                    ops.append(("m", int(i.memory_size), "RIP"))
                else:
                    ops.append(("m", int(i.memory_size), names.get(i.memory_base, ""), names.get(i.memory_index, ""), i.memory_index_scale,
                                _signed(i.memory_displacement)))
            elif kind in (ix.OpKind.NEAR_BRANCH16, ix.OpKind.NEAR_BRANCH32, ix.OpKind.NEAR_BRANCH64):
                t = i.near_branch_target
                if field is None and 0 <= t < len(code):
                    branch = t
                    ops.append(("b",))
                else:
                    if ref is None:
                        ref = (rva + t) if rva is not None else "?"
                    ops.append(("x",))
            elif kind in (ix.OpKind.IMMEDIATE8, ix.OpKind.IMMEDIATE16, ix.OpKind.IMMEDIATE32, ix.OpKind.IMMEDIATE64, ix.OpKind.IMMEDIATE8TO16,
                          ix.OpKind.IMMEDIATE8TO32, ix.OpKind.IMMEDIATE8TO64, ix.OpKind.IMMEDIATE32TO64, ix.OpKind.IMMEDIATE8_2ND):
                ops.append(("i", i.immediate(k)))
            else:
                ops.append(("o", int(kind)))
        cc = "" if i.condition_code == ix.ConditionCode.NONE else _cc_name(ix, i.condition_code)
        out.append(Ins(i.ip, i.len, mn, tuple(ops), cc, flow, branch, ref))
    return out


def _signed(d: int) -> int:
    return d - (1 << 64) if d >= 1 << 63 else d


_CC: dict[int, str] | None = None


def _cc_name(ix, v: int) -> str:
    global _CC
    if _CC is None:
        _CC = {val: k for k, val in vars(ix.ConditionCode).items() if isinstance(val, int) and not k.startswith("_")}
    return _CC.get(v, str(v))


_NEG = {"O": "NO", "B": "AE", "E": "NE", "BE": "A", "S": "NS", "P": "NP", "L": "GE", "LE": "G"}
NEGATE = {**_NEG, **{v: k for k, v in _NEG.items()}}
#: the condition that holds when the operands of the comparison are exchanged
_SWAP = {"L": "G", "LE": "GE", "B": "A", "BE": "AE"}
SWAP = {**_SWAP, **{v: k for k, v in _SWAP.items()}}
SIGN_CC = {frozenset(p) for p in _SIGNED_CC}


def _full(ix, names: dict[int, str], reg: str) -> tuple[str, int] | None:
    """A general-purpose register as (its 64-bit name, its width in bytes), None for any other register."""
    v = getattr(ix.Register, reg, None)
    if v is None or not ix.RegisterExt.is_gpr(v):
        return None
    return names[ix.RegisterExt.full_register(v)], ix.RegisterExt.size(v)


# ------------------------------------------------------------------------------------------- explanations of everything

def _renaming(a: list[Ins], b: list[Ins]) -> bool | None:
    """True when b is a under a consistent, non-identical renaming of general-purpose registers; False when no renaming
    makes them equal; None when they are not even the same shape."""
    if len(a) != len(b) or any(x.mnemonic != y.mnemonic or len(x.ops) != len(y.ops) or x.flow != y.flow for x, y in zip(a, b)):
        return None
    ix, names = _regs()
    fwd: dict[str, str] = {}
    back: dict[str, str] = {}
    renamed = False

    def same(p: str, q: str) -> bool:
        nonlocal renamed
        fp, fq = _full(ix, names, p), _full(ix, names, q)
        if fp is None or fq is None:
            return p == q
        if fp[1] != fq[1]:
            return False
        if fwd.setdefault(fp[0], fq[0]) != fq[0] or back.setdefault(fq[0], fp[0]) != fp[0]:
            return False
        renamed |= fp[0] != fq[0]
        return True

    for x, y in zip(a, b):
        for p, q in zip(x.ops, y.ops):
            if p[0] != q[0]:
                return False
            if p[0] == "r":
                if not same(p[1], q[1]):
                    return False
            elif p[0] == "m" and p[2] != "RIP":
                if p[1] != q[1] or p[4] != q[4] or p[5] != q[5]:
                    return False
                for r, s in ((p[2], q[2]), (p[3], q[3])):
                    if (r == "") != (s == "") or (r and not same(r, s)):
                        return False
            elif p != q:
                return False
    return renamed


def _blocks(xs: list[Ins]) -> list[tuple[tuple, str]]:
    """Basic blocks as (their instructions without a closing jump, the condition of a closing conditional jump or "").
    Unconditional internal jumps are dropped (they only say where the next block is); a condition is kept as the
    unordered pair it and its negation form, so that a block reads the same whichever way its test is taken."""
    leaders = {0} | {x.branch for x in xs if x.branch is not None}
    for k, x in enumerate(xs):
        if x.flow in ("jcc", "jmp", "ret") and k + 1 < len(xs):
            leaders.add(xs[k + 1].offset)
    out: list[tuple[tuple, str]] = []
    body: list[tuple] = []
    cc = ""
    for k, x in enumerate(xs):
        if x.offset in leaders and k:
            out.append((tuple(body), cc))
            body, cc = [], ""
        if x.flow == "jmp" and x.branch is not None:
            continue
        if x.flow == "jcc" and x.branch is not None:
            cc = x.cc
            pair = tuple(sorted((x.cc, NEGATE.get(x.cc, x.cc))))
            body.append(("jcc", pair))
            continue
        body.append(x.token)
    out.append((tuple(body), cc))
    return [(bdy, c) for bdy, c in out if bdy]


def _arrangement(a: list[Ins], b: list[Ins]) -> str | None:
    """BLOCKS or POLARITY when b has a's blocks in another arrangement, else None."""
    ba, bb = _blocks(a), _blocks(b)
    if sorted(x for x, _c in ba) != sorted(x for x, _c in bb) or [x for x, _c in ba] == [x for x, _c in bb] and \
            [c for _x, c in ba] == [c for _x, c in bb]:
        return None
    # pair equal bodies in order of appearance; a pair whose closing conditions differ was taken the other way
    left: dict[tuple, list[str]] = {}
    for x, c in bb:
        left.setdefault(x, []).append(c)
    flipped = sum(1 for x, c in ba if c and left[x] and left[x].pop(0) != c)
    return K.POLARITY if flipped else K.BLOCKS


def _frame(x: Ins) -> tuple:
    """An instruction with its frame offsets and the frame's size left out."""
    ops = []
    for p in x.ops:
        if p[0] == "m" and p[2] in ("RSP", "RBP"):
            p = (*p[:5], "*")
        ops.append(p)
    if x.mnemonic in ("sub", "add") and x.ops and x.ops[0] == ("r", "RSP"):
        ops = [("r", "RSP"), ("i", "*")]
    return (x.mnemonic, tuple(ops))


# ------------------------------------------------------------------------------------------- stretches

def _sign_cc(p: str, q: str) -> bool:
    return frozenset((p, q)) in SIGN_CC or frozenset((NEGATE.get(p, p), q)) in SIGN_CC


def _is_zeroing(x: Ins) -> bool:
    return x.mnemonic in ("xor", "sub") and len(x.ops) == 2 and x.ops[0] == x.ops[1] and x.ops[0][0] == "r"


def _is_constant(x: Ins) -> bool:
    return _is_zeroing(x) or (x.mnemonic in ("mov", "or") and len(x.ops) == 2 and x.ops[0][0] == "r" and x.ops[1][0] == "i")


def _is_save(x: Ins) -> bool:
    """A save or restore of a preserved register: a push or pop, or a store to or load from a stack slot."""
    regs = [p[1] for p in x.ops if p[0] == "r"]
    full = [_full(*_regs(), r) for r in regs]
    nonvol = any(f is not None and f[0] in NONVOLATILE for f in full)
    if x.mnemonic in ("push", "pop"):
        return nonvol
    if x.mnemonic == "mov" and len(x.ops) == 2 and nonvol:
        return any(p[0] == "m" and p[2] == "RSP" for p in x.ops)
    return False


def _widens(xs: list[Ins], k: int) -> bool:
    """Whether xs[k] zeroes a register whose low byte a set-on-condition then writes: a truth value made a full integer."""
    x = xs[k]
    if not _is_zeroing(x):
        return False
    ix, names = _regs()
    mine = _full(ix, names, x.ops[0][1])
    for y in xs[k + 1:k + 4]:
        if y.mnemonic.startswith("set") and y.ops and y.ops[0][0] == "r":
            f = _full(ix, names, y.ops[0][1])
            if f is not None and mine is not None and f[0] == mine[0]:
                return True
    return False


def _one(x: Ins, xs: list[Ins] | None = None, k: int = -1) -> str:
    """The kind an instruction one stream has and the other lacks speaks of (`xs`, `k`: its stream and place there)."""
    if xs is not None and _widens(xs, k):
        return K.EXTENSION
    if x.mnemonic in PADDING:
        return K.SIZE_ONLY
    if x.flow in ("jmp", "jcc", "ret") and not x.external:
        return K.BLOCKS
    if x.flow in ("call", "jmp") or x.external:
        return K.CALL
    if _is_save(x) or (x.mnemonic in ("sub", "add") and x.ops[:1] == (("r", "RSP"),)):
        return K.UNWIND
    if x.mnemonic in EXTENDING:
        return K.EXTENSION
    if _is_constant(x):
        return K.CONSTANT
    if x.mnemonic == "mov" and len(x.ops) == 2 and x.ops[0][0] == "r" and x.ops[1][0] == "r":
        return K.REGISTERS
    return K.SELECTION


def _pair(x: Ins, y: Ins) -> str:
    """The kind of the difference between two instructions in the same place."""
    if x.flow == "jcc" and y.flow == "jcc" or x.cc and y.cc and x.mnemonic[:3] == y.mnemonic[:3]:
        if NEGATE.get(x.cc) == y.cc or SWAP.get(x.cc) == y.cc or NEGATE.get(SWAP.get(x.cc, "")) == y.cc:
            return K.POLARITY
        if _sign_cc(x.cc, y.cc):
            return K.EXTENSION
    if x.mnemonic == y.mnemonic in ("cmp", "test") and len(x.ops) == 2 and x.ops == y.ops[::-1]:
        return K.POLARITY                                   # a comparison written from the other side
    if x.external or y.external or x.flow in ("call", "jmp") or y.flow in ("call", "jmp"):
        if x.token == y.token or x.flow != y.flow or x.external != y.external or x.ref != y.ref:
            return K.CALL
    if frozenset((x.mnemonic, y.mnemonic)) in SIGN_PAIRS or x.mnemonic in EXTENDING or y.mnemonic in EXTENDING:
        return K.EXTENSION
    if _is_constant(x) and _is_constant(y):
        return K.CONSTANT
    if _is_save(x) or _is_save(y):
        return K.UNWIND
    if x.mnemonic == y.mnemonic and len(x.ops) == len(y.ops):
        kinds = []
        ix, names = _regs()
        for p, q in zip(x.ops, y.ops):
            if p == q:
                continue
            if p[0] != q[0]:
                kinds.append(K.CONSTANT if "i" in (p[0], q[0]) else K.SELECTION)
            elif p[0] == "r":
                fp, fq = _full(ix, names, p[1]), _full(ix, names, q[1])
                kinds.append(K.EXTENSION if fp and fq and fp[0] == fq[0] else K.EXTENSION if fp and fq and fp[1] != fq[1] else K.REGISTERS)
            elif p[0] == "i":
                kinds.append(FRAME if x.mnemonic in ("sub", "add") and x.ops[0] == ("r", "RSP") else K.CONSTANT)
            elif p[0] == "m":
                if p[1] != q[1]:
                    kinds.append(K.EXTENSION)
                elif p[2] == "RIP" or q[2] == "RIP":
                    kinds.append(K.CALL)
                elif p[2:5] != q[2:5]:
                    kinds.append(K.REGISTERS)
                else:
                    kinds.append(K.STACK if p[2] in ("RSP", "RBP") else K.CONSTANT)
            else:
                kinds.append(K.SELECTION)
        if kinds:
            return min(kinds, key=lambda k: K.KINDS.index(K.STACK if k == FRAME else k))
    return K.SELECTION


def _stretch(sa: list[Ins], i0: int, i9: int, sb: list[Ins], j0: int, j9: int, counts: dict[str, int]) -> None:
    """Give each instruction of a differing stretch (sa[i0:i9] against sb[j0:j9]) a kind: pairs in the same place by
    `_pair`, the rest by `_one`."""
    a, b = sa[i0:i9], sb[j0:j9]
    if len(a) == len(b):
        for x, y in zip(a, b):
            k = _pair(x, y)
            counts[k] = counts.get(k, 0) + 1
        return
    inner = difflib.SequenceMatcher(None, [x.mnemonic for x in a], [y.mnemonic for y in b], autojunk=False)
    for tag, i1, i2, j1, j2 in inner.get_opcodes():
        if tag in ("equal", "replace") and i2 - i1 == j2 - j1:
            for x, y in zip(a[i1:i2], b[j1:j2]):
                if x.token != y.token:
                    k = _pair(x, y)
                    counts[k] = counts.get(k, 0) + 1
            continue
        for xs, at, n in ((sa, i0 + i1, i2 - i1), (sb, j0 + j1, j2 - j1)):
            for p in range(at, at + n):
                k = _one(xs[p], xs, p)
                counts[k] = counts.get(k, 0) + 1


def _refs_and_branches(a: list[Ins], b: list[Ins], pairs, counts: dict[str, int]) -> None:
    """Of instructions aligned as equal: references that lead elsewhere (call or relocation), and internal branches that
    lead to instructions not aligned with each other (block order)."""
    where_a = {x.offset: k for k, x in enumerate(a)}
    where_b = {y.offset: k for k, y in enumerate(b)}
    match = dict(pairs)
    for i, j in pairs:
        x, y = a[i], b[j]
        if x.ref is not None and y.ref is not None and "?" not in (x.ref, y.ref) and x.ref != y.ref:
            counts[K.CALL] = counts.get(K.CALL, 0) + 1
        if x.branch is not None and y.branch is not None and match.get(where_a.get(x.branch, -1)) != where_b.get(y.branch, -2):
            counts[K.BLOCKS] = counts.get(K.BLOCKS, 0) + 1


def _primary(counts: dict[str, int], whole: bool) -> Mismatch:
    # a frame of another size goes with the saves when saves differ (an extra push realigns the frame), else with the locals
    frame = counts.pop(FRAME, 0)
    if frame:
        k = K.UNWIND if counts.get(K.UNWIND) else K.STACK
        counts[k] = counts.get(k, 0) + frame
    out = tuple((k, counts[k]) for k in K.KINDS if counts.get(k))
    kind = max(out, key=lambda kv: (kv[1], -K.KINDS.index(kv[0])))[0] if out else K.SELECTION
    return Mismatch(kind, out, whole)


def compare(a: list[Ins], b: list[Ins]) -> Mismatch:
    """The kind of the difference between candidate instructions `a` and target instructions `b`."""
    n = max(len(a), len(b))
    if [x.token for x in a] == [y.token for y in b]:
        counts: dict[str, int] = {}
        _refs_and_branches(a, b, list(zip(range(len(a)), range(len(b)))), counts)
        if counts:
            return _primary(counts, len(counts) == 1)
        return Mismatch(K.SIZE_ONLY, ((K.SIZE_ONLY, sum(x.length != y.length for x, y in zip(a, b)) or 1),), True)
    strip = lambda xs: xs[:max((k + 1 for k, x in enumerate(xs) if x.mnemonic not in PADDING), default=0)]  # noqa: E731
    sa, sb = strip(a), strip(b)
    if (sa, sb) != (a, b) and [x.token for x in sa] == [y.token for y in sb]:
        return Mismatch(K.SIZE_ONLY, ((K.SIZE_ONLY, abs(len(a) - len(b))),), True)
    if _renaming(a, b):
        return Mismatch(K.REGISTERS, ((K.REGISTERS, sum(x.token != y.token for x, y in zip(a, b))),), True)
    arranged = _arrangement(a, b)
    if arranged is not None:
        return Mismatch(arranged, ((arranged, n),), True)
    if len(a) == len(b) and [_frame(x) for x in a] == [_frame(y) for y in b]:
        return Mismatch(K.STACK, ((K.STACK, sum(x.token != y.token for x, y in zip(a, b))),), True)
    sm = difflib.SequenceMatcher(None, [x.token for x in a], [y.token for y in b], autojunk=False)
    counts = {}
    pairs: list[tuple[int, int]] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            pairs += list(zip(range(i1, i2), range(j1, j2)))
        else:
            _stretch(a, i1, i2, b, j1, j2, counts)
    _refs_and_branches(a, b, pairs, counts)
    return _primary(counts, False)


def classify(f: coff.Function, target: bytes, rva: int, resolve: Callable[[coff.Reloc], int | None]) -> Mismatch:
    """The kind of mismatch between the candidate's function `f` and the target's bytes at `rva`.

    `resolve(reloc)`: the RVA a reference of the candidate means by the evidence, or None (as for `batch.distance`)."""
    refs: dict[int, object] = {r.offset: resolve(r) for r in f.relocs}
    return compare(decode(f.code, refs, None), decode(target, {}, rva))


__all__ = ["Ins", "Mismatch", "classify", "compare", "decode"]
