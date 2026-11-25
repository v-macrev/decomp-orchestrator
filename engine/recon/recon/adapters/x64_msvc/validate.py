# SPDX-License-Identifier: AGPL-3.0-or-later
"""Execution-based differential tests of the lifter, form by form.

For every instruction form the lifter accepts in 64-bit mode, instances are generated from the form's own
operand description (registers, high bytes, every addressing shape, edge immediates), run on the processor and
compared with the evaluated semantics: sixteen registers, seven flags, the memory and stack windows and where
control goes. What the semantics call undefined is not compared, and how often that happened is counted.

Generation uses a fixed seed and the form's name only, so a failure reproduces. `write_table` records the
result; the lifter refuses a form that is not in it, and a test refuses a table made by another lifter.
"""
from __future__ import annotations

import hashlib
import json
import random
import subprocess
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from recon.adapters.x64_msvc import hwexec
from recon.adapters.x64_msvc.decode import _iced, mnemonic_name
from recon.adapters.x64_msvc.lift import FLAGS, GPR, HANDLERS, SHARED, _tables, form_of, lift
from recon.core import evaluate as ev
from recon.core.sem import Lifted, Unsupported

SEED = 20261125
TABLE = Path(__file__).with_name("lift_coverage.json")
HERE = Path(__file__).resolve().parent
#: every file whose meaning the recorded result depends on
DIGESTED = (HERE / "lift.py", HERE / "hwexec.py", HERE / "validate.py", HERE.parents[1] / "core/sem.py", HERE.parents[1] / "core/evaluate.py")

MEM_WINDOW = 0x200
STACK_WINDOW = 0x100


def source_digest() -> str:
    h = hashlib.sha256()
    for p in DIGESTED:
        h.update(p.name.encode() + b"\0" + p.read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()


def load_validated(check: bool = True) -> frozenset[str]:
    """The forms that passed; empty when the table is absent or was made by other sources."""
    try:
        t = json.loads(TABLE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return frozenset()
    if check and t.get("source_digest") != source_digest():
        return frozenset()
    return frozenset(t["forms"])


#: where the executable region goes when it can, so that generated addresses, and with them every vector, repeat exactly
REGION_AT = 0x200_0000_0000


def processor() -> hwexec.Processor:
    try:
        return hwexec.Processor(REGION_AT)
    except RuntimeError:
        return hwexec.Processor()


class CannotBuild(Exception):
    pass


# ---------------------------------------------------------------------------- building instances

class Gen:
    def __init__(self, ix, proc: hwexec.Processor, rng: random.Random) -> None:
        self.ix, self.p, self.r = ix, proc, rng
        self.imms = 0
        R = ix.Register
        self.names = {v: k for k, v in vars(R).items() if isinstance(v, int) and not k.startswith("_")}
        g = [v for v in self.names if ix.RegisterExt.is_gpr(v)]
        self.by_width = {w: [v for v in g if ix.RegisterExt.size(v) * 8 == w] for w in (8, 16, 32, 64)}
        self.by_width[8] = sorted(self.by_width[8])
        self.full = lambda v: GPR[ix.RegisterExt.number(ix.RegisterExt.full_register(v))]
        self.safe = {w: [v for v in vs if self._full(v) != "rsp"] for w, vs in self.by_width.items()}

    def _full(self, v: int) -> str:
        n = self.names[v]
        return {"AH": "rax", "CH": "rcx", "DH": "rdx", "BH": "rbx"}.get(n) or GPR[self.ix.RegisterExt.number(self.ix.RegisterExt.full_register(v))]

    def pick(self, w: int) -> int:
        # the stack pointer is an operand now and then; it must never be the common case
        return self.r.choice(self.by_width[w] if self.r.random() < 0.15 else self.safe[w])

    def imm(self, w: int) -> int:
        edge = [0, 1, 2, (1 << w) - 1, 1 << (w - 1), (1 << (w - 1)) - 1, 0x7F & ((1 << w) - 1), 0x80 & ((1 << w) - 1)]
        # every other instance takes the next edge value, so that each of them (a shift by exactly one, say) is sure to occur
        self.imms += 1
        return edge[self.imms // 2 % len(edge)] if self.imms % 2 else self.r.getrandbits(w)

    def build(self, code: int, mem: bool, lock: bool, rep: bool):
        """One instance of the form, with how to aim its memory operand, or CannotBuild."""
        ix, r = self.ix, self.r
        K, O = ix.OpKind, ix.OpCodeOperandKind
        info = ix.OpCodeInfo(code)
        i = ix.Instruction()
        i.code = code
        used_mem = False
        widths = {O.R8_OR_MEM: 8, O.R16_OR_MEM: 16, O.R32_OR_MEM: 32, O.R64_OR_MEM: 64}
        plain = {O.R8_REG: 8, O.R8_OPCODE: 8, O.R16_REG: 16, O.R16_RM: 16, O.R16_OPCODE: 16, O.R32_REG: 32, O.R32_RM: 32, O.R32_OPCODE: 32,
                 O.R64_REG: 64, O.R64_RM: 64, O.R64_OPCODE: 64}
        fixed = {O.AL: "AL", O.CL: "CL", O.AX: "AX", O.DX: "DX", O.EAX: "EAX", O.RAX: "RAX"}
        imms = {O.IMM8: ("IMMEDIATE8", "immediate8", 8), O.IMM8SEX16: ("IMMEDIATE8TO16", "immediate8to16", 8),
                O.IMM8SEX32: ("IMMEDIATE8TO32", "immediate8to32", 8), O.IMM8SEX64: ("IMMEDIATE8TO64", "immediate8to64", 8),
                O.IMM16: ("IMMEDIATE16", "immediate16", 16), O.IMM32: ("IMMEDIATE32", "immediate32", 32),
                O.IMM32SEX64: ("IMMEDIATE32TO64", "immediate32to64", 32), O.IMM64: ("IMMEDIATE64", "immediate64", 64)}
        strings = {O.SEG_RSI: K.MEMORY_SEG_RSI, O.ES_RDI: K.MEMORY_ESRDI, O.SEG_RDI: K.MEMORY_SEG_RDI}
        for k in range(info.op_count):
            o = info.op_kind(k)
            if o in widths and not mem:
                i.set_op_kind(k, K.REGISTER)
                i.set_op_register(k, self.pick(widths[o]))
            elif o in widths or o in (O.MEM, O.MEM_OFFS):
                if o == O.MEM and not mem:
                    raise CannotBuild("memory only")
                used_mem = True
                i.set_op_kind(k, K.MEMORY)
                self._memory(i, o == O.MEM_OFFS)
            elif o in plain:
                i.set_op_kind(k, K.REGISTER)
                i.set_op_register(k, self.pick(plain[o]))
            elif o in fixed:
                i.set_op_kind(k, K.REGISTER)
                i.set_op_register(k, getattr(ix.Register, fixed[o]))
            elif o == O.IMM8_CONST_1:
                i.set_op_kind(k, K.IMMEDIATE8)
                i.immediate8 = 1
            elif o in imms:
                kind, attr, w = imms[o]
                i.set_op_kind(k, getattr(K, kind))
                v = self.imm(w)
                if "TO" in kind:  # the property takes a signed value
                    v = ev.signed(v, w)
                setattr(i, attr, v)
            elif o in (O.BR64_1, O.BR64_4):
                i.set_op_kind(k, K.NEAR_BRANCH64)
                i.near_branch64 = self.p.taken_ip
            elif o in strings:
                i.set_op_kind(k, strings[o])
            else:
                raise CannotBuild("operand kind")
        if mem and not used_mem:
            raise CannotBuild("no memory operand")
        if lock:
            i.has_lock_prefix = True
        if rep:
            i.has_rep_prefix = True
        enc = ix.Encoder(64)
        try:
            enc.encode(i, self.p.test_ip)
        except ValueError as e:
            raise CannotBuild("encoder") from e
        data = enc.take_buffer()
        d = ix.Decoder(64, data, ip=self.p.test_ip).decode()
        if d.code != code or d.len != len(data) or d.has_lock_prefix != lock:
            raise CannotBuild("another encoding")
        return d, data

    def _memory(self, i, offs: bool) -> None:
        ix, r = self.ix, self.r
        R = ix.Register
        i.memory_base = R.NONE
        i.memory_index = R.NONE
        i.memory_index_scale = 1
        if offs:
            i.memory_displacement = self.p.mem + MEM_WINDOW // 2 + r.randrange(-32, 32)
            i.memory_displ_size = 8
            return
        shape = r.choice(("base", "base", "disp8", "disp32", "index", "index", "index-disp", "rip"))
        if shape == "rip":
            i.memory_base = R.RIP
            i.memory_displacement = self.p.mem + MEM_WINDOW // 2 + r.randrange(-32, 32)
            i.memory_displ_size = 8
            return
        base = r.choice(self.by_width[64])
        i.memory_base = base
        if shape in ("index", "index-disp"):
            i.memory_index = r.choice([v for v in self.safe[64] if v != base])
            i.memory_index_scale = r.choice((1, 2, 4, 8))
        if shape == "disp8":
            i.memory_displacement = r.randrange(-128, 128) & (2**64 - 1)
            i.memory_displ_size = 1
        elif shape in ("disp32", "index-disp"):
            i.memory_displacement = r.randrange(-(2**31), 2**31) & (2**64 - 1)
            i.memory_displ_size = 4


# ---------------------------------------------------------------------------- states

def edge_value(r: random.Random) -> int:
    if r.random() < 0.45:
        w = r.choice((8, 16, 32, 64))
        v = r.choice((0, 1, 2, (1 << w) - 1, (1 << w) - 2, 1 << (w - 1), (1 << (w - 1)) - 1, (1 << (w - 1)) + 1, 0x55, 0xAA))
        return v if r.random() < 0.6 else (v | r.getrandbits(64) << w) & (2**64 - 1)
    return r.getrandbits(64)


@dataclass
class FormResult:
    vectors: int = 0
    undefined: int = 0       # compared places the semantics leave undefined
    traps: int = 0           # vectors the semantics say trap (samples are executed in processes of their own)
    unaimed: int = 0         # states whose accesses leave the windows; the form fails when there are any
    refused: int = 0
    failures: list[str] = field(default_factory=list)
    trap_samples: list[tuple] = field(default_factory=list)


class HarnessError(RuntimeError):
    pass


class _Memory:
    """The model's memory: the windows' bytes, plus which bytes are undefined."""

    def __init__(self, windows: list[tuple[int, bytes]]) -> None:
        self.w = [(a, bytearray(d)) for a, d in windows]
        self.undef: set[int] = set()

    def _at(self, addr: int, size: int):
        for a, d in self.w:
            if a <= addr and addr + size <= a + len(d):
                return d, addr - a
        raise HarnessError("an access outside the test windows")

    def read(self, addr: int, size: int) -> int:
        d, o = self._at(addr, size)
        return int.from_bytes(d[o:o + size], "little")

    def write(self, addr: int, size: int, v) -> None:
        d, o = self._at(addr, size)
        span = range(addr, addr + size)
        if v is ev.UNDEF:
            self.undef.update(span)
        else:
            self.undef.difference_update(span)
            d[o:o + size] = v.to_bytes(size, "little")


def make_state(g: Gen, ins, m: str) -> tuple[dict, dict, list[tuple[int, bytes]]] | None:
    """Registers, flags and memory windows that aim the instruction's accesses at the windows; None when this instance cannot be aimed."""
    ix, r, p = g.ix, g.r, g.p
    R, K = ix.Register, ix.OpKind
    # in some states the operands are related (equal, opposite, complementary, zero), which unrelated values almost never are
    x = edge_value(r)
    pool = (0, x, x, -x & (2**64 - 1), ~x & (2**64 - 1), (x + 1) & (2**64 - 1), 1) if r.random() < 0.3 else None
    value = (lambda: r.choice(pool)) if pool else (lambda: edge_value(r))
    regs = {n: value() for n in GPR}
    flags = {n: r.getrandbits(1) for n in FLAGS}
    if m[:4] not in ("MOVS", "STOS", "LODS") or m in ("MOVSX", "MOVSXD"):
        if r.random() < 0.7:
            flags["df"] = 0
    mem = bytearray(r.randbytes(MEM_WINDOW))
    stack = bytearray(r.randbytes(STACK_WINDOW))
    mem_at, stack_at = p.mem, p.stack + hwexec.STACK_SIZE // 2
    sp = stack_at + STACK_WINDOW // 2
    explicit_sp = any(ins.op_kind(i) == K.REGISTER and g._full(ins.op_register(i)) == "rsp" for i in range(ins.op_count))
    stackish = m in ("PUSH", "POP", "CALL", "RET", "LEAVE")
    if not explicit_sp or stackish:
        regs["rsp"] = sp
    if m == "LEAVE":
        regs["rbp"] = sp
    has_mem = any(ins.op_kind(i) == K.MEMORY for i in range(ins.op_count))
    ea = None

    if m in ("SHL", "SAL", "SHR", "SAR", "ROL", "ROR", "RCL", "RCR", "SHLD", "SHRD"):
        regs["rcx"] = regs["rcx"] & ~0xFF | r.choice((0, 1, 2, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, r.getrandbits(8)))
    divisor = None
    if m in ("DIV", "IDIV"):
        # most of the time the dividend is built from a divisor and a quotient that fits, anywhere in the quotient's range
        w = (ix.MemorySizeExt.size(ins.memory_size) * 8) if has_mem else ix.RegisterExt.size(ins.op_register(0)) * 8
        mask = (1 << w) - 1
        if r.random() < 0.85:
            d, q = edge_value(r) & mask, edge_value(r) & mask
            if m == "IDIV":
                d, q = ev.signed(d, w), ev.signed(q, w)
            rem = r.randrange(abs(d)) if d else 0
            n = q * d + (-rem if m == "IDIV" and (q < 0) != (d < 0) and q else rem)
            divisor = d & mask
            if w == 8:
                regs["rax"] = regs["rax"] & ~0xFFFF & (2**64 - 1) | n & 0xFFFF
            else:
                regs["rax"] = regs["rax"] & ~mask & (2**64 - 1) | n & mask
                regs["rdx"] = regs["rdx"] & ~mask & (2**64 - 1) | n >> w & mask
        if not has_mem and divisor is not None:
            full, off = g._full(ins.op_register(0)), 8 if g.names[ins.op_register(0)] in ("AH", "BH", "CH", "DH") else 0
            if full not in ("rax", "rdx", "rsp"):
                regs[full] = regs[full] & ~(mask << off) & (2**64 - 1) | divisor << off
    if m == "CMPXCHG" and r.random() < 0.5 and not has_mem:
        regs[g._full(ins.op_register(0))] = regs["rax"]
    if m == "JRCXZ" and r.random() < 0.5:
        regs["rcx"] = 0
    if m[:4] in ("MOVS", "STOS", "LODS") and m not in ("MOVSX", "MOVSXD") and not has_mem:
        mid = mem_at + MEM_WINDOW // 2
        regs["rcx"] = r.randrange(0, 9)
        regs["rsi"] = mid + r.randrange(-40, 40)
        regs["rdi"] = mid + r.randrange(-40, 40)
    if m in ("JMP", "CALL") and ins.op_kind(0) == K.REGISTER:
        if g._full(ins.op_register(0)) == "rsp":
            return None
        regs[g._full(ins.op_register(0))] = p.taken_ip
    if m == "RET":
        o = STACK_WINDOW // 2
        stack[o:o + 8] = p.taken_ip.to_bytes(8, "little")

    if has_mem:
        at = mem_at + MEM_WINDOW // 2 + r.randrange(-40, 40)
        if ins.is_ip_rel_memory_operand or ins.memory_base == R.NONE:
            at = ins.ip_rel_memory_address if ins.is_ip_rel_memory_operand else ins.memory_displacement
        elif m == "LEA" or m == "NOP":
            pass  # the address is computed, never used
        else:
            b = g._full(ins.memory_base)
            disp = ins.memory_displacement
            if b == "rsp":  # the stack pointer is the base: aim inside the stack window, so the displacement must be small
                if disp > 64 and disp < 2**64 - 64:
                    return None
                at = None
                if ins.memory_index != R.NONE:
                    regs[g._full(ins.memory_index)] = r.randrange(-2, 3) & (2**64 - 1)
                if explicit_sp:
                    regs["rsp"] = sp
            else:
                if ins.memory_index != R.NONE:
                    idx = g._full(ins.memory_index)
                    x = r.randrange(-4, 5) & (2**64 - 1)
                    regs[idx] = x
                    disp += x * ins.memory_index_scale
                regs[b] = (at - disp) & (2**64 - 1)
                if b == "rcx" and m in ("JRCXZ",):
                    return None
            # a pop raises the stack pointer before the address is formed; a base of rsp is covered by the window
        if m in ("BT", "BTS", "BTR", "BTC") and ins.op_kind(1) == K.REGISTER:
            rr = g._full(ins.op_register(1))
            if ins.memory_base != R.NONE and not ins.is_ip_rel_memory_operand and rr == g._full(ins.memory_base):
                return None
            if ins.memory_index != R.NONE and rr == g._full(ins.memory_index):
                return None
            if rr == "rsp":
                return None
            w = ix.RegisterExt.size(ins.op_register(1)) * 8
            regs[rr] = regs[rr] & ~((1 << w) - 1) & (2**64 - 1) | r.randrange(-500, 500) & ((1 << w) - 1)
        if at is not None and m not in ("LEA", "NOP"):
            o = at - mem_at
            if m in ("JMP", "CALL"):
                mem[o:o + 8] = p.taken_ip.to_bytes(8, "little")
            elif m in ("CMPXCHG",) and r.random() < 0.5:
                mem[o:o + 8] = regs["rax"].to_bytes(8, "little")
            elif divisor is not None:
                mem[o:o + w // 8] = divisor.to_bytes(w // 8, "little")
            elif r.random() < 0.6:
                mem[o:o + 8] = value().to_bytes(8, "little")
        elif m in ("JMP", "CALL"):
            return None
    return regs, flags, [(mem_at, bytes(mem)), (stack_at, bytes(stack))]


# ---------------------------------------------------------------------------- comparing

def check_vector(proc: hwexec.Processor, lifted: Lifted, data: bytes, next_ip: int, state, res: FormResult, text: str) -> None:
    regs, flags, windows = state
    mem = _Memory(windows)
    mach = ev.Machine(mem.read, mem.write, {**regs, **flags})
    try:
        out = ev.run(lifted, mach)
    except ev.Trapped as t:
        res.traps += 1
        res.trap_samples.append((data, regs, flags, windows, t.kind))
        return
    except HarnessError:
        res.unaimed += 1
        return
    hr, hf, mark, hw = proc.run(regs, flags, windows)
    res.vectors += 1
    bad = []
    for n in GPR:
        v = mach.locs[n]
        if v is ev.UNDEF:
            res.undefined += 1
        elif v != hr[n]:
            bad.append(n)
    for n in FLAGS:
        v = mach.locs[n]
        if v is ev.UNDEF:
            res.undefined += 1
        elif v != hf[n]:
            bad.append(n)
    for (a, d), real in zip(mem.w, hw):
        for k in range(len(d)):
            if d[k] != real[k] and a + k not in mem.undef:
                bad.append("memory")
                break
    res.undefined += len(mem.undef)
    goes = {"fall": 0, "branch-fall": 0}.get(out.kind, 1)
    if goes != mark or (goes and out.target != proc.taken_ip) or (out.kind == "branch-fall" and out.target != next_ip):
        bad.append("control")
    if bad:
        res.failures.append(f"{text}: {','.join(bad)}")


def forms(ix) -> list[tuple[str, int, bool, bool, bool]]:
    """(form name, code, memory, lock, rep) for every 64-bit form of a mnemonic the lifter knows."""
    _r, codes = _tables(ix)
    out = []
    for code, name in sorted(codes.items()):
        info = ix.OpCodeInfo(code)
        if not info.is_instruction or not info.mode64:
            continue
        m = mnemonic_name(ix, info.mnemonic)
        if m not in HANDLERS or (m in SHARED and name != SHARED[m]):
            continue
        O = ix.OpCodeOperandKind
        kinds = [info.op_kind(i) for i in range(info.op_count)]
        can_mem = any(o in (O.R8_OR_MEM, O.R16_OR_MEM, O.R32_OR_MEM, O.R64_OR_MEM, O.MEM, O.MEM_OFFS) for o in kinds)
        only_mem = any(o in (O.MEM, O.MEM_OFFS) for o in kinds)
        shapes = ([] if only_mem else [False]) + ([True] if can_mem else [])
        for mem in shapes:
            out.append((name + (":mem" if mem else ""), code, mem, False, False))
            if mem and info.can_use_lock_prefix:
                out.append((name + ":mem:lock", code, mem, True, False))
        if any(o in (O.SEG_RSI, O.ES_RDI, O.SEG_RDI) for o in kinds) or name in ("RETNQ",):
            out.append((name + ":rep", code, False, False, True))
    return out


def run_form(proc: hwexec.Processor, entry, instances: int, states: int, seed: int = SEED) -> FormResult | str:
    """The result of one form, or the reason it is refused or cannot be built."""
    ix = _iced()
    name, code, mem, lock, rep = entry
    g = Gen(ix, proc, random.Random(seed ^ zlib.crc32(name.encode())))
    res = FormResult()
    why = "cannot-build"
    for _ in range(instances):
        try:
            ins, data = g.build(code, mem, lock, rep)
        except CannotBuild as e:
            why = f"cannot-build: {e}"
            continue
        lifted = lift(ins)
        if isinstance(lifted, Unsupported):
            res.refused += 1
            why = lifted.reason
            continue
        if form_of(ix, ins) != name:
            why = "another form"
            continue
        proc.load(data)
        m = mnemonic_name(ix, ins.mnemonic)
        for _ in range(states):
            st = make_state(g, ins, m)
            if st is not None:
                check_vector(proc, lifted, data, ins.next_ip, st, res, str(ins))
    if res.vectors == 0 and res.traps == 0:
        return why
    return res


TRAP_CHILD = """
import sys, json
from recon.adapters.x64_msvc.hwexec import Processor
d = json.loads(sys.stdin.read())
try:
    p = Processor(d["base"])
except RuntimeError:
    print("cannot-place")
    raise SystemExit(0)
p.load(bytes.fromhex(d["code"]))
print("running", flush=True)
p.run(d["regs"], d["flags"], [(a, bytes.fromhex(w)) for a, w in d["windows"]])
print("no-trap")
"""


#: how each trap ends a process: Windows exception status, POSIX signal
TRAP_STATUS = {"divide-error": ({0xC0000094, 0xC0000095}, {8}), "breakpoint": ({0x80000003}, {5}), "invalid-opcode": ({0xC000001D}, {4})}


def confirm_trap(base: int, sample) -> str:
    """Run one vector predicted to trap in a process of its own, at the same addresses: "confirmed", "cannot-place" or what went wrong."""
    data, regs, flags, windows, kind = sample
    req = {"base": base, "code": data.hex(), "regs": regs, "flags": flags, "windows": [(a, w.hex()) for a, w in windows]}
    p = subprocess.run([sys.executable, "-s", "-B", "-c", TRAP_CHILD], input=json.dumps(req), text=True, capture_output=True, cwd=str(HERE.parents[2]), timeout=60)
    out = p.stdout.split()
    if out[:1] == ["cannot-place"]:
        return "cannot-place"
    if out != ["running"]:
        return "no trap happened" if "no-trap" in out else "the child failed before running"
    win, posix = TRAP_STATUS[kind]
    ok = (p.returncode & 0xFFFFFFFF) in win if sys.platform == "win32" else -p.returncode in posix
    return "confirmed" if ok else "ended differently than predicted"


MIN_VECTORS = 64       # executed and compared, per form
TRAPS_PER_FORM = 4     # predicted traps repeated in processes of their own, per form


def run_all(instances: int = 24, states: int = 16, only: str | None = None) -> dict:
    ix = _iced()
    proc = processor()
    passed: dict[str, dict] = {}
    refused: dict[str, str] = {}
    failed: dict[str, list[str]] = {}
    traps_confirmed = traps_unplaced = 0
    for e in forms(ix):
        if only and not e[0].startswith(only):
            continue
        r = run_form(proc, e, instances, states)
        if isinstance(r, str):
            refused[e[0]] = r
            continue
        if r.failures or r.unaimed:
            failed[e[0]] = r.failures[:3] + [f"{len(r.failures)} of {r.vectors} differ, {r.unaimed} unaimed"]
            continue
        confirmed = 0
        step = max(1, len(r.trap_samples) // TRAPS_PER_FORM)
        for s in r.trap_samples[::step][:TRAPS_PER_FORM]:
            how = confirm_trap(proc.base, s)
            if how == "confirmed":
                confirmed += 1
            elif how == "cannot-place":
                traps_unplaced += 1
            else:
                failed[e[0]] = [f"predicted {s[4]}: {how}"]
                break
        if e[0] in failed:
            continue
        traps_confirmed += confirmed
        if r.traps and not confirmed:
            refused[e[0]] = "a predicted trap could not be repeated"
        elif r.vectors < MIN_VECTORS and not (confirmed and not r.vectors):  # a form that only ever traps has no vectors to compare
            refused[e[0]] = "too few vectors"
        else:
            passed[e[0]] = {"vectors": r.vectors, "traps": confirmed, "undefined": r.undefined}
    return {"passed": passed, "refused": refused, "failed": failed, "traps_confirmed": traps_confirmed, "traps_unplaced": traps_unplaced}


def write_table(result: dict, date: str) -> None:
    if result["failed"]:
        raise SystemExit("not written: forms failed")
    TABLE.write_text(json.dumps({"schema": 1, "seed": SEED, "date": date, "source_digest": source_digest(),
                                 "vectors": sum(v["vectors"] for v in result["passed"].values()), "forms": result["passed"]},
                                indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
