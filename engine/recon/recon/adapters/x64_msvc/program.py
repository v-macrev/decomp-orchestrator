# SPDX-License-Identifier: AGPL-3.0-or-later
"""One function from bytes to analysis results: decode, lift, control flow, data flow, frame, agreement with unwind data.

The result is an `Analysis` or a `Refusal` naming the stage, a fixed code and a detail that holds nothing of the
function beyond the class of the instruction form that is missing.
"""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field
from typing import Callable

from recon.adapters.x64_msvc import eh
from recon.adapters.x64_msvc import switch as sw
from recon.adapters.x64_msvc import unwind as uw
from recon.adapters.x64_msvc.abi import CALLING, CLOBBERED, WIDTHS
from recon.adapters.x64_msvc.decode import _iced, decode_function
from recon.adapters.x64_msvc.lift import lift
from recon.core.analysis import cfg as cf
from recon.core.analysis import dataflow as df
from recon.core.analysis import frame as fr
from recon.core.analysis.values import Values
from recon.core.canonical import digest
from recon.core.ir import build as ib
from recon.core.ir.model import Fn
from recon.core.sem import Branch, CallTo, Const, Goto, Lifted, Unsupported

UNSUPPORTED = "UNSUPPORTED_INSTRUCTION"
INVALID = "INVALID_INSTRUCTION"
CONFLICT = "CONFLICTING_EVIDENCE"
NOT_REPRESENTED = "NOT_REPRESENTED"


@dataclass(frozen=True)
class Refusal:
    stage: str                       # decode, lift, cfg
    code: str
    detail: str = ""
    #: for the lift stage: every missing (form, reason), so demand can be counted
    missing: tuple[tuple[str, str], ...] = ()


@dataclass
class Analysis:
    rva: int
    size: int
    insns: list[Lifted]
    cfg: cf.Cfg
    flow: df.Flow
    frame: fr.Frame | None
    frame_refusal: str | None
    switches: dict[int, sw.Dispatch] = field(default_factory=dict)
    data_start: int | None = None
    unwind_checked: int = 0
    unwind_conflicts: tuple[str, ...] = ()

    def summary(self) -> dict:
        return {"rva": self.rva, "size": self.size, "cfg": self.cfg.summary(), "flow": self.flow.summary(), "frame": self.frame.summary(CALLING) if self.frame else None,
                "frame_refusal": self.frame_refusal, "switches": [[d.rva, d.bound, [list(t) for t in d.tables], list(d.targets)] for _r, d in sorted(self.switches.items())],
                "data_start": self.data_start, "unwind": [self.unwind_checked, list(self.unwind_conflicts)]}

    def digest(self) -> str:
        return digest(self.summary())


UnwindEntry = tuple[int, int, uw.UnwindInfo]  # (begin RVA, end RVA, info)


def lift_range(code: bytes, rva: int, image_base: int, validated: frozenset[str] | None) -> tuple[list[Lifted], list[Unsupported]]:
    ok: list[Lifted] = []
    bad: list[Unsupported] = []
    for i in _iced().Decoder(64, code, ip=image_base + rva):
        r = lift(i, image_base, validated)
        if isinstance(r, Lifted):
            ok.append(r)
        else:
            bad.append(r)
    return ok, bad


def _leaders(insns: list[Lifted], image_base: int) -> set[int]:
    out = {insns[0].rva}
    for i in insns:
        if isinstance(i.terminator, (Branch, Goto)):
            out.add(i.end)
    return out | {t - image_base for t in sw.direct_targets(insns)}


def _pointer_jump(insns: list[Lifted], k: int, leaders: set[int]) -> bool:
    """Whether the jump goes to a whole pointer, read from memory or held in a location, never to a computed address."""
    v = Values().run(insns[sw.block_start(insns, k, leaders) : k + 1], CLOBBERED)
    n = v.nodes[v.control[insns[k].rva]]
    return n.kind in ("load", "entry") and n.width == 64


def analyse(code: bytes, rva: int, image_base: int, validated: frozenset[str] | None, unwind_entries: list[UnwindEntry] | None = None) -> Analysis | Refusal:
    """`unwind_entries`: the `.pdata` entries inside the range, when there are any."""
    dec = decode_function(code, rva, image_base)
    if dec.error is not None:
        return Refusal("decode", CONFLICT if dec.error == "ambiguous-data-reference" else INVALID, dec.error)
    stop = dec.data_start if dec.data_start is not None else rva + len(code)
    insns, bad = lift_range(code[: stop - rva], rva, image_base, validated)
    if bad:
        forms = sorted({(u.form, u.reason) for u in bad})
        return Refusal("lift", UNSUPPORTED, forms[0][0], tuple(forms))
    data = (dec.data_start, code[dec.data_start - rva :]) if dec.data_start is not None else None
    leaders = _leaders(insns, image_base)
    switches = sw.resolve(insns, image_base, data, leaders)
    # with a table in the range an indirect jump is a switch or unresolved; without one a jump to a whole pointer leaves
    tails = frozenset() if data is not None else frozenset(
        i.rva for k, i in enumerate(insns) if isinstance(i.terminator, Goto) and not isinstance(i.terminator.target, Const) and _pointer_jump(insns, k, leaders))
    try:
        graph = cf.build(insns, image_base, switches={r: d.targets for r, d in switches.items()}, tails=tails)
    except cf.CfgError as e:
        return Refusal("cfg", CONFLICT, e.reason)
    frame: fr.Frame | None = None
    why: str | None = None
    try:
        frame = fr.analyse(graph, CALLING, WIDTHS)
    except fr.FrameError as e:
        why = e.reason
    a = Analysis(rva, len(code), insns, graph, df.solve(graph, CALLING), frame, why, switches, dec.data_start)
    if frame is not None and unwind_entries is not None:
        a.unwind_checked, a.unwind_conflicts = agreement(frame, unwind_entries, rva)
    return a


def to_ir(a: Analysis, image_base: int, unwind_entries: list[UnwindEntry] | None = None, read: uw.Reader | None = None,
          handler_name: Callable[[int], str | None] | None = None) -> Fn | Refusal:
    """The IR of an analysed function, straight from its instructions (no transformation applied). `read`: the image, for
    exception data; `handler_name`: the name of the function an RVA imports through its thunk, when it is one."""
    try:
        exceptions = None
        if any(info.handler is not None for _b, _e, info in unwind_entries or []):
            if read is None:
                raise ib.BuildRefusal("exception-edges-not-represented")
            ends = [i.end for i in a.insns if isinstance(i.terminator, CallTo)]
            own = [(b, i) for b, _e, i in unwind_entries or [] if i.handler is not None]
            if (len(own) == 1 and own[0][0] == a.rva and handler_name is not None and own[0][1].handler is not None
                    and handler_name(own[0][1].handler) == eh.C_SPECIFIC_HANDLER):
                spans = sorted((i.rva, i.end) for i in a.insns)

                def inside(r: int) -> bool:
                    k = bisect_right(spans, (r, 1 << 64)) - 1
                    return k >= 0 and spans[k][0] <= r < spans[k][1]
                exceptions = eh.seh_unwinding(read, own[0][1], inside, ends)
            else:
                exceptions = eh.unwinding(read, unwind_entries or [], a.rva, ends)
        if a.frame is None:
            raise ib.BuildRefusal(a.frame_refusal or "no-frame")
        if a.unwind_conflicts:
            raise ib.BuildRefusal("frame-contradicts-unwind-data")
        return ib.build(a.cfg, a.flow, a.frame, CALLING, WIDTHS, image_base, a.rva, exceptions)
    except (ib.BuildRefusal, eh.EhError) as e:
        return Refusal("ir", NOT_REPRESENTED, e.reason)


def agreement(frame: fr.Frame, entries: list[UnwindEntry], rva: int) -> tuple[int, tuple[str, ...]]:
    """Compare the recovered frame with the unwind codes: the height after each prologue step and every saved register's slot.

    Returns (facts checked, conflicts). A chained entry is checked for its saves, relative to the parent's whole frame. Without
    an entry the function must be a leaf: it moves the stack pointer by nothing and saves nothing.
    """
    if not entries:
        return 1, () if frame.depth == 0 and not frame.saved else ("leaf-with-a-frame",)
    checked = 0
    bad: set[str] = set()
    total = 0
    named: set[str] = set()
    for begin, _end, info in sorted(entries, key=lambda e: e[0]):
        if info.chained is None and begin != rva:
            bad.add("second-primary-entry")
            continue
        if info.codes is None:
            bad.add("unwind-code-not-understood")
            continue
        base = total if info.chained else 0
        steps = sorted(info.codes, key=lambda c: c.offset)
        done = 0
        pushes: list[tuple[str, int]] = []
        for c in steps:
            done += c.alloc
            if c.push and c.register:
                pushes.append((c.register, -(base + done)))
            if c.alloc:
                checked += 1
                if frame.heights.get(begin + c.offset) != -(base + done):
                    bad.add("height-after-prologue-step")
        slots = pushes + [(c.register, c.slot - (base + done)) for c in steps if c.register and not c.push]
        for name, slot in slots:
            named.add(name)
            checked += 1
            if frame.saved.get(name) != slot:
                bad.add("saved-register-slot")
        if info.chained is None:
            total = done
    if set(frame.saved) - named:
        bad.add("saved-register-not-in-unwind-data")
    return checked, tuple(sorted(bad))
