# SPDX-License-Identifier: AGPL-3.0-or-later
"""Imported functions: the slots of the import address table, read from the import directory, and the signatures the
platform's headers declare of them, read back from what the compiler made of those declarations (D-052)."""
from __future__ import annotations

import struct

import pytest

from recon.adapters.x64_msvc.headers import decode, import_signatures, probe_text
from recon.adapters.x64_msvc.imports import Import, iat_range, import_slots
from recon.core.inference.signature import FLOAT, INT, Slot


def image() -> bytes:
    """A PE32+ header and, at RVA = offset, one library's import descriptor, lookup table, names and table of slots."""
    b = bytearray(0x2000)
    b[0:2] = b"MZ"
    struct.pack_into("<I", b, 0x3C, 0x80)
    b[0x80:0x84] = b"PE\0\0"
    opt = 0x80 + 24
    struct.pack_into("<H", b, opt, 0x20B)
    struct.pack_into("<I", b, opt + 108, 16)
    struct.pack_into("<II", b, opt + 112 + 8 * 1, 0x1000, 40)       # the import directory
    struct.pack_into("<II", b, opt + 112 + 8 * 12, 0x1100, 32)      # the import address table
    struct.pack_into("<IIIII", b, 0x1000, 0x1200, 0, 0, 0x1300, 0x1100)
    struct.pack_into("<QQQQ", b, 0x1200, 0x1400, (1 << 63) | 5, 0x1420, 0)
    b[0x1300:0x130D] = b"LIBRARY1.dll\0"
    b[0x1402:0x140C] = b"Allocate1\0"
    b[0x1422:0x1428] = b"Wait2\0"
    return bytes(b)


def test_every_slot_of_the_table_has_its_library_and_name_or_none_for_an_ordinal():
    blob = image()
    got = import_slots(blob, lambda rva, n: blob[rva:rva + n])
    assert got == {0x1100: Import("library1.dll", "Allocate1"), 0x1108: Import("library1.dll", None), 0x1110: Import("library1.dll", "Wait2")}
    assert iat_range(blob) == (0x1100, 0x1120)


def test_an_image_without_imports_has_no_slots():
    b = bytearray(image())
    struct.pack_into("<II", b, 0x80 + 24 + 112 + 8, 0, 0)
    assert import_slots(bytes(b), lambda rva, n: bytes(b[rva:rva + n])) == {}


def enc(*v: int) -> bytes:
    return bytes(v) + bytes(128 - len(v))


def test_an_encoding_says_the_signature_the_declaration_gives():
    s = decode(enc(1, 0, 2, 1, 64, 1, 32, 2, 64))          # long long f(int, double)
    assert s is not None and s.params == (Slot(INT, 32), Slot(FLOAT, 64)) and s.result == Slot(INT, 64)
    assert ("declared", "import") in s.evidence
    assert decode(enc(1, 0, 0, 0, 0)).result is None and decode(enc(1, 0, 0, 0, 0)).params == ()   # void f(void)


@pytest.mark.parametrize("v", [
    enc(0),                                  # no function: a variable or a type
    enc(1, 1, 1, 0, 0, 1, 64),               # variadic
    enc(1, 0, 1, 0, 0, 3, 96),               # an aggregate by value
    enc(1, 0, 0, 3, 128),                    # an aggregate result
    enc(1, 0, 1, 1, 64, 0, 0),               # a void parameter cannot be
])
def test_what_the_convention_does_not_pass_in_registers_has_no_signature(v):
    assert decode(v) is None


def test_each_name_has_its_own_line_after_the_headers():
    text, first = probe_text(("windows.h",), ["One", "Two"])
    lines = text.splitlines()
    assert "::One)" in lines[first - 1] and "recon_import_0" in lines[first - 1]
    assert "::Two)" in lines[first] and "recon_import_1" in lines[first]


def test_the_platform_headers_declare_what_the_compiler_says(toolchain, tmp_path):
    (tmp_path / "std.cpp").write_text("#include <windows.h>\n#include <type_traits>\n", encoding="utf-8")
    code, _out = toolchain.tool.run("cl", ["/nologo", "/c", "std.cpp"], tmp_path)
    if code != 0:
        pytest.skip("this host's compiler cannot read the platform headers (a Windows compiler over a WSL path)")
    got = import_signatures(toolchain.tool, tmp_path, ["HeapAlloc", "sqrtf", "printf", "NoSuchFunctionAnywhere", "??0decorated"])
    assert got["HeapAlloc"].params == (Slot(INT, 64), Slot(INT, 32), Slot(INT, 64)) and got["HeapAlloc"].result == Slot(INT, 64)
    assert got["sqrtf"].params == (Slot(FLOAT, 32),) and got["sqrtf"].result == Slot(FLOAT, 32)
    assert "printf" not in got and "NoSuchFunctionAnywhere" not in got and "??0decorated" not in got   # variadic, undeclared, no identifier


def test_a_name_at_the_very_end_of_what_can_be_read_is_read():
    blob = image()
    end = 0x1428                                         # one past the last name's terminator

    def read(rva, n):
        if rva + n > end:
            raise ValueError("outside the section")
        return blob[rva:rva + n]
    assert import_slots(blob, read)[0x1110] == Import("library1.dll", "Wait2")
