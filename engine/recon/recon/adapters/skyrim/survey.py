# SPDX-License-Identifier: AGPL-3.0-or-later
"""Per-function facts of the pinned image and the aggregates built from them.

`analyse_function` decodes one inventory range, relates it to `.pdata` and its unwind data, and counts what
it references. A report is aggregate counts; the per-function rows are written only under a private `.local`
directory by the caller. Nothing here keeps bytes, operands or listing lines.

Blocking policy (specification section 8): when `.pdata` or decoding disagrees with the inventory the
function is `blocked` with upstream's reason where one exists; the engine does not choose between them.
"""
from __future__ import annotations

import bisect
from collections import Counter
from dataclasses import dataclass, field

from recon.adapters.x64_msvc import decode as x64decode
from recon.adapters.x64_msvc import unwind as x64unwind
from recon.adapters.skyrim.image import PinnedImage
from recon.adapters.skyrim.inventory import Target, size_bucket
from recon.core.model import Flow

# status of a function after analysis
DECODED = "decoded"            # every byte of the range is an instruction or identified table data
INVALID = "invalid-instruction"
UNREADABLE = "unreadable"      # the range is not all file content (upstream's target-range-* reasons)
BLOCKED = "blocked"            # an upstream refusal applies: no search can end in a match


@dataclass
class FunctionFacts:
    rva: int
    size: int
    status: str
    reason: str | None = None
    insns: int = 0
    stop_offset: int | None = None
    mnemonics: dict[str, int] = field(default_factory=dict)
    flows: dict[str, int] = field(default_factory=dict)
    calls_direct: int = 0
    calls_indirect: int = 0
    jumps_out: int = 0        # direct jumps leaving the range (tail calls), conditional ones included
    jumps_indirect: int = 0   # switch dispatch and tail calls through a pointer
    data_refs: dict[str, int] = field(default_factory=dict)  # by section of the target
    pdata_entries: int = 0
    unwind: str = "none"      # none | plain | handler | chained | refused
    handler_data: str = "none"  # none | funcinfo | other | mixed
    data_bytes: int = 0       # table data after the code, inside the range
    data_kind: str = "none"   # none | rva-table | other-data
    extent: str = "none"      # .pdata against the inventory range: exact | prefix | leaf | misaligned (see pdata_extent)


def _pdata_overlapping(pdata: list[tuple[int, int, int]], starts: list[int], rva: int, end: int):
    i = bisect.bisect_right(starts, rva) - 1
    i = max(i, 0)
    while i < len(pdata) and pdata[i][0] < end:
        b, e, u = pdata[i]
        if e > rva:
            yield pdata[i]
        i += 1


def pdata_extent(entries, rva: int, end: int) -> str:
    """How the `.pdata` entries starting at `rva` relate to the inventory range: `exact` (contiguous entries cover it all),
    `prefix` (they cover only the start: funclets or data follow), `leaf` (no entry at all: a function without unwind data),
    `misaligned` (entries exist but none starts at `rva`)."""
    if not entries:
        return "leaf"
    cur = rva
    for b, e, _u in sorted(entries):
        if b == cur:
            cur = e
    if cur == end:
        return "exact"
    return "prefix" if cur > rva else "misaligned"


def analyse_function(img: PinnedImage, rva: int, size: int, *, _pdata=None, _starts=None) -> FunctionFacts:
    pdata = _pdata if _pdata is not None else img.runtime_functions()
    starts = _starts if _starts is not None else [p[0] for p in pdata]
    try:
        code = img.read(rva, size)
    except ValueError as e:
        return FunctionFacts(rva, size, UNREADABLE, str(e))
    end = rva + size
    f = FunctionFacts(rva, size, DECODED)

    # unwind data first: an upstream refusal blocks the function whatever the code looks like
    entries = list(_pdata_overlapping(pdata, starts, rva, end))
    f.pdata_entries = len(entries)
    f.extent = pdata_extent(entries, rva, end)
    for b, e, u in entries:
        if b < rva or e > end:
            f.status, f.reason = BLOCKED, "unwind-entry-crosses-boundary"
            break
    if f.status != BLOCKED:
        spans = [(b, e) for b, e, _ in entries]
        if any(a[1] > c[0] for a, c in zip(spans, spans[1:])):
            f.status, f.reason = BLOCKED, "unwind-entry-overlap"
    if f.status != BLOCKED:
        kinds: set[str] = set()
        handlers: set[str] = set()
        for _b, _e, u in entries:
            try:
                info = x64unwind.read_unwind(img.read, u)
            except ValueError:
                f.status, f.reason = BLOCKED, "malformed-image"
                break
            if info.refusal:
                f.status, f.reason = BLOCKED, info.refusal
                f.unwind = "refused"
                break
            if info.chained:
                kinds.add("chained")
            elif info.handler is not None:
                kinds.add("handler")
                magic = x64unwind.funcinfo_magic(img.read, info)
                handlers.add("funcinfo" if magic == x64unwind.FUNCINFO_MAGIC else "other")
            else:
                kinds.add("plain")
        else:
            # the answer must not depend on the order of the entries: a range with both kinds says so
            f.handler_data = "none" if not handlers else handlers.pop() if len(handlers) == 1 else "mixed"
            f.unwind = "handler" if "handler" in kinds else "chained" if "chained" in kinds else "plain" if kinds else "none"

    res = x64decode.decode_function(code, rva, img.image_base)
    f.data_bytes = 0 if res.data_start is None else res.end - res.data_start
    f.data_kind = res.data_kind or "none"
    f.insns = len(res.insns)
    mn: Counter[str] = Counter()
    fl: Counter[str] = Counter()
    refs: Counter[str] = Counter()
    for i in res.insns:
        mn[i.mnemonic] += 1
        fl[i.flow.value] += 1
        if i.flow is Flow.CALL:
            f.calls_direct += 1
        elif i.flow is Flow.CALL_INDIRECT:
            f.calls_indirect += 1
        elif i.flow in (Flow.JUMP, Flow.BRANCH) and i.target is not None and not (rva <= i.target < end):
            f.jumps_out += 1
        elif i.flow is Flow.JUMP_INDIRECT:
            f.jumps_indirect += 1
        if i.data_ref is not None:
            refs[img.section_name_at(i.data_ref) or "outside-image"] += 1
    f.mnemonics, f.flows, f.data_refs = dict(mn), dict(fl), dict(refs)
    if res.error is not None:
        f.stop_offset = res.stop - rva
        if f.status != BLOCKED:
            # an undecodable tail is never assumed to be data: only a table the code itself references is
            f.status, f.reason = (BLOCKED if res.error == "ambiguous-data-reference" else INVALID), res.error
    elif f.status != BLOCKED and x64decode.misdirected_branches(res.insns):
        f.status, f.reason = BLOCKED, "branch-into-instruction"
    elif f.status != BLOCKED and f.data_kind == "other-data":
        f.status, f.reason = BLOCKED, "unidentified-data-in-range"
    return f


def survey(img: PinnedImage, targets: list[Target], progress=None) -> tuple[dict, list[FunctionFacts]]:
    pdata = img.runtime_functions()
    starts = [p[0] for p in pdata]
    rows: list[FunctionFacts] = []
    for n, t in enumerate(targets):
        rows.append(analyse_function(img, t.rva, t.size, _pdata=pdata, _starts=starts))
        if progress and n % 2000 == 0:
            progress(n)
    return aggregate(rows), rows


def aggregate(rows: list[FunctionFacts]) -> dict:
    status = Counter(r.status for r in rows)
    reasons = Counter(r.reason for r in rows if r.reason and r.status in (BLOCKED, UNREADABLE, INVALID))
    by_bucket: dict[str, Counter] = {}
    mnemonic_functions: Counter[str] = Counter()
    for r in rows:
        by_bucket.setdefault(size_bucket(r.size), Counter())[r.status] += 1
        for m in r.mnemonics:
            mnemonic_functions[m] += 1
    return {
        "functions": len(rows),
        "bytes": sum(r.size for r in rows),
        "status": dict(sorted(status.items())),
        "refusal_reasons": dict(sorted(reasons.items())),
        "by_size_bucket": {k: dict(sorted(v.items())) for k, v in sorted(by_bucket.items())},
        "instructions": sum(r.insns for r in rows),
        "distinct_mnemonics": len(mnemonic_functions),
        "unwind": dict(sorted(Counter(r.unwind for r in rows).items())),
        "handler_data": dict(sorted(Counter(r.handler_data for r in rows).items())),
        "pdata_extent": dict(sorted(Counter(r.extent for r in rows).items())),
        "trailing_data": dict(sorted(Counter(r.data_kind for r in rows).items())),
        "trailing_data_bytes": sum(r.data_bytes for r in rows),
        "with_direct_calls": sum(1 for r in rows if r.calls_direct),
        "with_indirect_calls": sum(1 for r in rows if r.calls_indirect),
        "with_indirect_jumps": sum(1 for r in rows if r.jumps_indirect),
        "with_tail_jumps": sum(1 for r in rows if r.jumps_out),
        "mnemonic_functions": dict(mnemonic_functions.most_common()),
    }


def coverage_if(rows: list[FunctionFacts], supported: set[str]) -> dict:
    """Instruction coverage over `rows` for a supported mnemonic set: how many functions are fully covered, and for each
    unsupported mnemonic how many functions it alone blocks. This orders lifting work by demand (section 9)."""
    full = 0
    sole: Counter[str] = Counter()
    for r in rows:
        if r.status != DECODED:
            continue
        missing = [m for m in r.mnemonics if m not in supported]
        if not missing:
            full += 1
        elif len(missing) == 1:
            sole[missing[0]] += 1
    return {"fully_covered": full, "blocked_by_one_form": dict(sole.most_common())}
