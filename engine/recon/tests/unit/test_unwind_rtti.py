# SPDX-License-Identifier: AGPL-3.0-or-later
import struct

import pytest

from recon.adapters.x64_msvc import rtti, unwind
from recon.core.model import Segment

BASE = 0x1_4000_0000


def reader(blob: bytes, at: int = 0):
    def read(rva, size):
        if rva < at or rva + size > at + len(blob):
            raise ValueError("outside")
        return blob[rva - at : rva - at + size]

    return read


def info(version=1, flags=0, count=0, tail=b""):
    slots = count + (count & 1)
    return bytes([version | (flags << 3), 0, count, 0]) + b"\0" * 2 * slots + tail


def test_plain_info():
    u = unwind.read_unwind(reader(info(count=3)), 0)
    assert (u.version, u.refusal, u.chained, u.handler) == (1, None, None, None)


def test_version_other_than_one_is_upstreams_unsupported_unwind():
    assert unwind.read_unwind(reader(info(version=2)), 0).refusal == "unsupported-unwind"


def test_a_chain_with_a_handler_is_refused():
    assert unwind.read_unwind(reader(info(flags=unwind.UNW_FLAG_CHAININFO | unwind.UNW_FLAG_EHANDLER)), 0).refusal == "unsupported-unwind"


def test_chained_entry_reads_the_parent_runtime_function():
    blob = info(flags=unwind.UNW_FLAG_CHAININFO, count=1, tail=struct.pack("<III", 0x10, 0x20, 0x30))
    u = unwind.read_unwind(reader(blob), 0)
    assert u.chained == (0x10, 0x20, 0x30) and u.refusal is None


def test_handler_and_its_funcinfo_magic():
    # info at 0, FuncInfo at 0x100
    funcinfo_rva = 0x100
    blob = bytearray(0x200)
    h = info(flags=unwind.UNW_FLAG_EHANDLER, tail=struct.pack("<II", 0x4000, funcinfo_rva))
    blob[: len(h)] = h
    struct.pack_into("<I", blob, funcinfo_rva, unwind.FUNCINFO_MAGIC)
    u = unwind.read_unwind(reader(bytes(blob)), 0)
    assert u.handler == 0x4000 and unwind.funcinfo_magic(reader(bytes(blob)), u) == unwind.FUNCINFO_MAGIC
    struct.pack_into("<I", blob, funcinfo_rva, 0x19930520)
    assert unwind.funcinfo_magic(reader(bytes(blob)), u) == 0x19930520


def test_unreadable_unwind_raises_value_error():
    with pytest.raises(ValueError):
        unwind.read_unwind(reader(b"\0\0\0\0"), 0x1000)


def test_rtti_locator_and_vtable_from_the_image_alone():
    text = Segment(".text", 0x1000, b"\xC3" * 0x100, True)
    rdata = bytearray(0x200)
    col_rva = 0x2000 + 0x100
    # locator: signature 1, offset 0, cdOffset 0, type descriptor, class hierarchy, self
    struct.pack_into("<6I", rdata, 0x100, 1, 0, 0, 0x2180, 0x21C0, col_rva)
    # vtable: locator pointer at 0x2000, slots after it
    struct.pack_into("<Q", rdata, 0x00, BASE + col_rva)
    struct.pack_into("<QQ", rdata, 0x08, BASE + 0x1010, BASE + 0x1020)
    struct.pack_into("<Q", rdata, 0x18, 0)  # ends the vtable
    struct.pack_into("<I", rdata, 0xF0, 1)  # a stray 1 in data: not a locator (self field does not match)
    seg = Segment(".rdata", 0x2000, bytes(rdata), False)
    vts = rtti.find_vtables([text, seg], BASE)
    assert len(vts) == 1
    v = vts[0]
    assert (v.rva, v.locator, v.type_descriptor, v.offset, v.slots) == (0x2008, col_rva, 0x2180, 0, (0x1010, 0x1020))


def test_rtti_type_name_needs_the_decorated_form():
    ok = lambda rva: b".?AVFoo@@"  # noqa: E731
    bad = lambda rva: b"not a name"  # noqa: E731
    assert rtti.type_name(ok, 0x100) == ".?AVFoo@@" and rtti.type_name(bad, 0x100) is None

    def boom(rva):
        raise ValueError("x")

    assert rtti.type_name(boom, 1) is None
