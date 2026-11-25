# SPDX-License-Identifier: AGPL-3.0-or-later
"""A tiny two-pass assembler over iced for synthetic fixtures: labels are strings, branches are always 32-bit."""
from __future__ import annotations

import iced_x86 as ix

C, R = ix.Code, ix.Register
I = ix.Instruction
BASE, RVA = 0x1_4000_0000, 0x1000


def mem(base=None, disp=0, index=None, scale=1):
    return ix.MemoryOperand(base if base is not None else R.NONE, index if index is not None else R.NONE, scale, disp, 8 if disp or base is None else 0)


class Asm:
    """Build a function: `a(instruction)`, `a.label(name)`, `a.branch(code, label)`, `a.data(bytes or callable(labels))`."""

    def __init__(self, rva: int = RVA, base: int = BASE) -> None:
        self.items: list = []
        self.rva, self.base = rva, base

    def __call__(self, ins) -> "Asm":
        self.items.append(("ins", ins))
        return self

    def label(self, name: str) -> "Asm":
        self.items.append(("label", name))
        return self

    def branch(self, code: int, name: str | int) -> "Asm":
        self.items.append(("branch", code, name))
        return self

    def lazy(self, make) -> "Asm":
        """`make(labels)` gives an instruction whose operands depend on labels (RVAs); its length must not."""
        self.items.append(("lazy", make))
        return self

    def data(self, make) -> "Asm":
        self.items.append(("data", make))
        return self

    def assemble(self) -> tuple[bytes, dict[str, int]]:
        labels: dict[str, int] = {}
        out = b""
        for _ in range(3):
            known = dict(labels)
            out = b""
            for item in self.items:
                at = self.rva + len(out)
                if item[0] == "label":
                    labels[item[1]] = at
                    continue
                if item[0] == "data":
                    out += item[1](known) if callable(item[1]) else item[1]
                    continue
                if item[0] == "branch":
                    to = item[2] if isinstance(item[2], int) else known.get(item[2], self.rva)
                    ins = I.create_branch(item[1], self.base + to)
                elif item[0] == "lazy":
                    ins = item[1]({k: known.get(k, self.rva) for k in labels} | known if known else _Any(self.rva))
                else:
                    ins = item[1]
                e = ix.Encoder(64)
                e.encode(ins, self.base + at)
                out += e.take_buffer()
            if known == labels and known:
                break
        return out, labels


class _Any(dict):
    def __init__(self, v: int) -> None:
        super().__init__()
        self.v = v

    def __missing__(self, _k):
        return self.v


# ---------------------------------------------------------------- shorthands

def push(r):
    return I.create_reg(C.PUSH_R64, r)


def pop(r):
    return I.create_reg(C.POP_R64, r)


def ret():
    return I.create(C.RETNQ)


def sub_rsp(n):
    return I.create_reg_i32(C.SUB_RM64_IMM32, R.RSP, n)


def add_rsp(n):
    return I.create_reg_i32(C.ADD_RM64_IMM32, R.RSP, n)


def mov_rr(d, s):
    return I.create_reg_reg(C.MOV_R64_RM64, d, s)


def mov_ri(d, v):
    return I.create_reg_i32(C.MOV_RM64_IMM32, d, v)


def load(d, m):
    return I.create_reg_mem(C.MOV_R64_RM64, d, m)


def store(m, s):
    return I.create_mem_reg(C.MOV_RM64_R64, m, s)


def lea(d, m):
    return I.create_reg_mem(C.LEA_R64_M, d, m)


def cmp32(r, v):
    return I.create_reg_i32(C.CMP_RM32_IMM32, r, v)


def add_rr(d, s):
    return I.create_reg_reg(C.ADD_R64_RM64, d, s)


def add_ri(d, v):
    return I.create_reg_i32(C.ADD_RM64_IMM32, d, v)
