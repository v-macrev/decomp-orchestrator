# SPDX-License-Identifier: AGPL-3.0-or-later
"""Deliberately wrong semantics, to measure whether the differential vectors would notice a mistake."""
from __future__ import annotations

import dataclasses

from recon.core.sem import BlockCopy, BlockFill, Branch, Const, Let, Lifted, Load, Put, Store

SWAP = {"add": "sub", "sub": "add", "and": "or", "or": "xor", "xor": "or", "shl": "lshr", "lshr": "ashr", "ashr": "lshr", "ult": "ule", "ule": "ult",
        "slt": "ult", "sle": "ule", "eq": "ne", "ne": "eq", "zext": "sext", "sext": "zext", "mul": "add", "udiv": "sdiv", "sdiv": "udiv",
        "urem": "srem", "srem": "urem", "clz": "ctz", "ctz": "clz"}


def mutants(lifted: Lifted):
    """(description, mutant): one statement changed in each."""
    undef = {s.dst.id for s in lifted.stmts if isinstance(s, Let) and s.op == "undef"}

    def rebuilt(k, new):
        st = list(lifted.stmts)
        if new is None:
            del st[k]
        else:
            st[k] = new
        return dataclasses.replace(lifted, stmts=tuple(st))

    for k, s in enumerate(lifted.stmts):
        if isinstance(s, Put):
            if isinstance(s.val, Const) or s.val.id not in undef:
                yield f"drop put {s.loc.name}", rebuilt(k, None)
        elif isinstance(s, Store):
            yield "drop store", rebuilt(k, None)
        elif isinstance(s, (BlockCopy, BlockFill)):
            yield "drop block", rebuilt(k, None)
        elif isinstance(s, Branch):
            yield "invert branch", rebuilt(k, Branch(s.cond, s.fall, s.taken))
        elif isinstance(s, Load) or not isinstance(s, Let):
            continue
        elif s.op in SWAP:
            yield f"{s.op} -> {SWAP[s.op]}", rebuilt(k, dataclasses.replace(s, op=SWAP[s.op]))
        elif s.op == "ite":
            yield "swap arms", rebuilt(k, dataclasses.replace(s, args=(s.args[0], s.args[2], s.args[1])))
        elif s.op in ("not", "neg"):
            yield f"{s.op} dropped", rebuilt(k, dataclasses.replace(s, op="or", args=(s.args[0], s.args[0])))
        if isinstance(s, Let):
            for j, a in enumerate(s.args):
                if isinstance(a, Const) and a.width > 1 and s.op != "undef":
                    off = Const((a.value + 1) & ((1 << a.width) - 1), a.width)
                    yield "constant + 1", rebuilt(k, dataclasses.replace(s, args=s.args[:j] + (off,) + s.args[j + 1:]))
