# SPDX-License-Identifier: AGPL-3.0-or-later
"""What a C++ frame handler's data (FuncInfo, version 3) says about one function: the unwind states, and the state at each address.

The state of a call is the one its return address is in, which is how the runtime looks it up. Only functions whose exceptions
do nothing but clean up are represented: a catch block comes back into the function, and those edges are not built.
Anything else is a fixed reason; nothing is guessed.
"""
from __future__ import annotations

import struct
from bisect import bisect_right
from dataclasses import dataclass

from recon.adapters.x64_msvc.unwind import FUNCINFO_MAGIC, Reader, UnwindInfo
from recon.core.ir.build import Unwinding

EHS, NOEXCEPT = 1, 4
MAX_STATES = 4096

NOT_UNDERSTOOD = "handler-not-understood"
MALFORMED = "exception-data-malformed"


@dataclass(frozen=True)
class FuncInfo:
    states: tuple[tuple[int, int], ...]       # (the state after its action, RVA of the action or 0)
    ip: tuple[tuple[int, int], ...]           # (RVA from which, state)
    tries: int
    unwind_help: int                          # offset from the establisher frame
    specification: int
    flags: int

    def state_at(self, rva: int) -> int:
        k = bisect_right([a for a, _s in self.ip], rva)
        return self.ip[k - 1][1] if k else -1


class EhError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def read_funcinfo(read: Reader, info: UnwindInfo) -> FuncInfo:
    if info.handler_data is None:
        raise EhError(NOT_UNDERSTOOD)
    try:
        (at,) = struct.unpack("<I", read(info.handler_data, 4))
        (magic,) = struct.unpack("<I", read(at, 4))
    except (ValueError, struct.error):
        raise EhError(NOT_UNDERSTOOD) from None
    if magic != FUNCINFO_MAGIC:
        raise EhError(NOT_UNDERSTOOD)
    try:
        _m, n, umap, tries, _tmap, nip, imap, help_, spec, flags = struct.unpack("<IiIIIIIiII", read(at, 40))
        if not 0 <= n <= MAX_STATES or nip > 4 * MAX_STATES:
            raise EhError(MALFORMED)
        raw = read(umap, 8 * n) if n else b""
        states = tuple(struct.unpack_from("<iI", raw, 8 * k) for k in range(n))
        raw = read(imap, 8 * nip) if nip else b""
        ip = tuple(struct.unpack_from("<Ii", raw, 8 * k) for k in range(nip))
    except (ValueError, struct.error) as e:
        raise e if isinstance(e, EhError) else EhError(MALFORMED) from None
    if any(not -1 <= to < s for s, (to, _a) in enumerate(states)) or any(not -1 <= s < n for _a, s in ip) or any(a >= b for (a, _s), (b, _t) in zip(ip, ip[1:])):
        raise EhError(MALFORMED)
    return FuncInfo(states, ip, tries, help_, spec, flags)


def unwinding(read: Reader, entries: list[tuple[int, int, UnwindInfo]], rva: int, ends: list[int]) -> Unwinding | None:
    """The unwinding of a function, None when it has no handler. `ends`: where each of its calls returns to."""
    with_handler = [(b, i) for b, _e, i in entries if i.handler is not None]
    if not with_handler:
        return None
    if len(with_handler) != 1 or with_handler[0][0] != rva:
        raise EhError(NOT_UNDERSTOOD)
    info = with_handler[0][1]
    f = read_funcinfo(read, info)
    if f.tries:
        raise EhError("catch-blocks-not-represented")
    if not f.flags & EHS:
        raise EhError("asynchronous-exceptions-not-represented")
    if f.specification or f.flags & ~(EHS | NOEXCEPT):
        raise EhError("exception-specification-not-represented")
    # the establisher frame: the stack pointer once the frame register is set up, or after the prologue
    steps = sorted(info.codes or (), key=lambda c: c.offset)
    if info.codes is None:
        raise EhError(NOT_UNDERSTOOD)
    sets = [c.offset for c in steps if c.sets_frame]
    depth = sum(c.alloc for c in steps if not sets or c.offset <= sets[0])
    return Unwinding(f.states, tuple(sorted((r, f.state_at(r)) for r in ends)), f.unwind_help - depth, bool(f.flags & NOEXCEPT))


#: the runtime's handler for structured exceptions, which walks a scope table (D-072)
C_SPECIFIC_HANDLER = "__C_specific_handler"
MAX_SCOPES = 64


def seh_unwinding(read: Reader, info: UnwindInfo, inside, ends: list[int]) -> Unwinding:
    """The unwinding of a function whose handler is the runtime's structured-exception handler, from its scope table: per
    scope (begin, end, handler, jump target), innermost first. Only termination scopes (`__finally`, no jump target) are
    represented: an `__except` scope comes back into the function. A scope covers code of the function and hands an exception
    to a handler outside it; scopes are nested or apart, an inner one before any that contains it. The state of a call is the
    innermost scope its return address is in; leaving it, the runtime runs that scope's handler and the next containing one's.
    `inside`: whether an RVA is code of the function."""
    if info.handler_data is None:
        raise EhError(NOT_UNDERSTOOD)
    try:
        (n,) = struct.unpack("<I", read(info.handler_data, 4))
        if not 1 <= n <= MAX_SCOPES:
            raise EhError(NOT_UNDERSTOOD)
        raw = read(info.handler_data + 4, 16 * n)
    except (ValueError, struct.error):
        raise EhError(NOT_UNDERSTOOD) from None
    scopes = [struct.unpack_from("<IIII", raw, 16 * k) for k in range(n)]
    for b, e, h, j in scopes:
        if not (b < e and inside(b) and inside(e - 1)) or h <= 1 or inside(h):
            raise EhError(NOT_UNDERSTOOD)
        if j:
            raise EhError("catch-blocks-not-represented")
    parent = []
    for k, (b, e, _h, _j) in enumerate(scopes):
        for i, (b2, e2, _h2, _j2) in enumerate(scopes):
            if i != k and b < e2 and b2 < e and not (b2 <= b and e <= e2 and i > k or b <= b2 and e2 <= e and i < k):
                raise EhError(NOT_UNDERSTOOD)        # overlapping, or an outer scope listed before an inner one
        parent.append(next((i for i in range(k + 1, n) if scopes[i][0] <= b and e <= scopes[i][1]), -1))
    state = lambda k: -1 if k < 0 else n - 1 - k  # noqa: E731  (a containing scope gets a lower state)
    states = tuple((state(parent[k]), scopes[k][2]) for k in reversed(range(n)))

    def at(r: int) -> int:
        return state(next((k for k, (b, e, _h, _j) in enumerate(scopes) if b <= r < e), -1))
    return Unwinding(states, tuple(sorted((r, at(r)) for r in ends)), None, False)
