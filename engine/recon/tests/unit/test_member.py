# SPDX-License-Identifier: AGPL-3.0-or-later
"""A body as a member function of a declared class, and where its declaration goes in a header's text."""
import pytest

from recon.adapters.x64_msvc import declarations as D
from recon.core.inference import types as ty
from recon.core.inference.signature import NotReconstructed

U32 = ty.Int(32, False)

HEADER = """#pragma once
#include <cstdint>

// class Box { int Get(); } in a comment is not the class
class Box : public Base
{
public:
    std::int32_t Get(std::int32_t a_add);   // "Get(" in a comment
    void Reset() { value = 0; }
    char tag = ';';

    std::int32_t value;
    std::uint8_t unknown0C[0x4];  // 0C
};
static_assert(sizeof(Box) == 0x10);
"""


# ---------------------------------------------------------------- the header's text (pure)

def test_blank_keeps_offsets_and_removes_comments_and_literals():
    b = D.blank(HEADER)
    assert len(b) == len(HEADER)
    assert b.count("\n") == HEADER.count("\n")
    assert "comment" not in b and "';'" not in b
    assert "std::int32_t Get(std::int32_t a_add);" in b


def test_the_class_body_is_the_definition_not_a_mention():
    code = D.blank(HEADER)
    a, b = D.class_body(code, "Box")
    assert code[a] == "{" and code[b] == "}" and "unknown0C" in code[a:b]
    assert D.class_body(code, "Missing") is None


def test_a_method_declaration_is_found_and_an_inline_definition_refused():
    [d] = D.method_declarations(HEADER, "Box", "Get")
    assert d.text == "std::int32_t Get(std::int32_t a_add);"
    with pytest.raises(NotReconstructed, match="INLINE_DEFINITION"):
        D.method_declarations(HEADER, "Box", "Reset")
    assert D.method_declarations(HEADER, "Box", "Other") == []
    assert D.method_declarations(HEADER, "Missing", "Get") is None


def test_the_declaration_is_replaced_in_place_or_added_at_the_end():
    text, old = D.with_declaration(HEADER, "Box", "Get", "std::int32_t Get(std::int32_t a_add)")
    assert old is not None and text == HEADER
    text, old = D.with_declaration(HEADER, "Box", "Get", "static std::int32_t Get(std::int32_t a1)")
    assert old.text.startswith("std::int32_t Get(") and "static std::int32_t Get(std::int32_t a1);" in text
    text, old = D.with_declaration(HEADER, "Box", "Size", "std::uint32_t Size()")
    assert old is None
    assert text.index("public:\n    std::uint32_t Size();\n") < text.index("};\nstatic_assert")


@pytest.mark.parametrize("decl, code", [
    ("    virtual int Get();", "VIRTUAL_DECLARATION"),
    ("    int Get() override;", "VIRTUAL_DECLARATION"),
    ("    int Get() = delete;", "VIRTUAL_DECLARATION"),
    ("    int Get();\n    int Get(int a);", "OVERLOADED_METHOD"),
])
def test_declarations_the_engine_may_not_rewrite_are_refused(decl, code):
    text = "class Box\n{\npublic:\n" + decl + "\n};\n"
    with pytest.raises(NotReconstructed, match=code):
        D.with_declaration(text, "Box", "Get", "int Get()")


def test_a_class_the_header_does_not_define_is_refused():
    with pytest.raises(NotReconstructed, match="CLASS_NOT_IN_UNIT_HEADER"):
        D.with_declaration("class Box;\n", "Box", "Get", "int Get()")


def test_the_layout_report_gives_offsets_names_and_virtual_bases():
    report = "\n".join([
        "class Base\tsize(8):", "\t+---", " 0\t| refs", " 4\t| pad", "\t+---", "",
        "class Box\tsize(16):", "\t+---", " 0\t| +--- (base class Base)", " 0\t| | refs", " 4\t| | pad", "\t| +---",
        " 8\t| value", "  \t| <alignment member> (size=3)", "12\t| unknown0C", "\t+---", ""])
    assert D.layout_report(report, "Box") == (16, [(0, "refs"), (4, "pad"), (8, "value"), (12, "unknown0C")], False)
    assert D.layout_report(report, "Missing") is None


# ---------------------------------------------------------------- the member form (needs the venv)

def _member_tests():
    pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
    pytest.importorskip("z3", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
    import asm as T
    from asm import BASE, RVA, Asm, C, I, R, mem
    from test_source import adder, canonical, program

    from recon.core.emitter.member import Declared, Member, member_form
    return T, BASE, RVA, Asm, C, I, R, mem, adder, canonical, program, Declared, Member, member_form


def test_a_read_through_the_first_parameter_is_a_member_of_this():
    T, BASE, RVA, Asm, C, I, R, mem, adder, canonical, program, Declared, Member, member_form = _member_tests()
    c = canonical(program(adder()))
    d = Declared("Box", "Get", (Member(8, "value", U32),))
    u = member_form(c.body, c.types, BASE, RVA, d)
    assert u.form == "this"
    assert u.definition == "unsigned int Box::Get(unsigned int arg2)\n{\n    return this->value + arg2;\n}\n"
    assert u.declaration == "unsigned int Get(unsigned int arg2)"


def test_an_element_of_a_declared_array_of_the_same_type_is_used():
    T, BASE, RVA, Asm, C, I, R, mem, adder, canonical, program, Declared, Member, member_form = _member_tests()
    c = canonical(program(adder()))
    d = Declared("Box", "Get", (Member(0, "values", U32, 4),))
    assert "this->values[2]" in member_form(c.body, c.types, BASE, RVA, d).definition


@pytest.mark.parametrize("members", [
    (),                                                     # nothing declared there
    ((8, "value", ty.Int(32, True), 0),),                   # another type at that offset: the tree's types are its own
    ((4, "value", U32, 0),),                                # the right type elsewhere
    ((0, "bytes", ty.Int(8, False), 16),),                  # an array of another type over it
    ((0, "values", U32, 2),),                               # an array of that type that ends before it
])
def test_a_member_the_header_does_not_declare_is_refused(members):
    T, BASE, RVA, Asm, C, I, R, mem, adder, canonical, program, Declared, Member, member_form = _member_tests()
    c = canonical(program(adder()))
    ms = tuple(Member(*m) for m in members)
    with pytest.raises(NotReconstructed, match="MEMBER_NOT_DECLARED"):
        member_form(c.body, c.types, BASE, RVA, Declared("Box", "Get", ms))


def test_a_first_parameter_used_as_a_value_makes_a_static_member():
    T, BASE, RVA, Asm, C, I, R, mem, adder, canonical, program, Declared, Member, member_form = _member_tests()
    f = Asm(RVA)(I.create_reg_reg(C.MOV_R32_RM32, R.EAX, R.ECX))(I.create_reg_reg(C.ADD_R32_RM32, R.EAX, R.EDX))(T.ret())
    c = canonical(program(f))
    u = member_form(c.body, c.types, BASE, RVA, Declared("Box", "Sum", ()))
    assert u.form == "static" and u.declaration == "static unsigned int Sum(unsigned int arg1, unsigned int arg2)"
    assert u.definition.startswith("unsigned int Box::Sum(unsigned int arg1, ") and "this" not in u.definition


def test_a_body_that_ignores_the_first_parameter_keeps_an_unused_this():
    T, BASE, RVA, Asm, C, I, R, mem, adder, canonical, program, Declared, Member, member_form = _member_tests()
    f = Asm(RVA)(I.create_reg_i32(C.MOV_R32_IMM32, R.EAX, 7))(T.ret())
    c = canonical(program(f))
    u = member_form(c.body, c.types, BASE, RVA, Declared("Box", "Seven", ()))
    assert u.form == "this_unused" and u.declaration == "int Seven()"
    assert u.definition == "int Box::Seven()\n{\n    return 7;\n}\n"


def _calls_stores():
    """f(p): stores(p, 5), where stores(p, v) sets p->member4 = v"""
    T, BASE, RVA, Asm, C, I, R, mem, adder, canonical, program, Declared, Member, member_form = _member_tests()
    from test_source import OTHER, stores
    f = Asm(RVA)(T.sub_rsp(40))(I.create_reg_i32(C.MOV_R32_IMM32, R.EDX, 5))
    f.branch(C.CALL_REL32_64, OTHER)
    f(T.add_rsp(40))(T.ret())
    c = canonical(program(f, stores()))
    return c, BASE, RVA, OTHER, Declared, Member, member_form


def test_a_callee_the_project_has_not_named_is_called_by_its_placeholder_and_declared():
    c, BASE, RVA, OTHER, Declared, Member, member_form = _calls_stores()
    u = member_form(c.body, c.types, BASE, RVA, Declared("Box", "Put", (Member(4, "value", ty.Int(32, True)),)),
                    unnamed=lambda at: at == BASE + OTHER)
    name = f"Function{OTHER:x}"
    assert u.callees == ((name, OTHER),)
    assert u.definition == f"void Box::Put(long long arg1)\n{{\n    {name}(arg1, 5);\n}}\n"   # p passed on as a value: static
    assert u.prototypes == f"void {name}(long long arg1, int arg2);\n"


def _reads_global(t=ty.Int(32, True), address=0x5000):
    """int Box::Value() { return <the object at `address`>; }, over the adder's types (it calls nothing)"""
    from recon.core.structuring import ast as A
    T, BASE, RVA, Asm, C, I, R, mem, adder, canonical, program, Declared, Member, member_form = _member_tests()
    c = canonical(program(adder()))
    body = A.Body((), t, (A.Return(A.Global(BASE + address, t)),))
    return body, c.types, BASE, RVA, Declared("Box", "Value", ()), member_form


def test_an_object_the_project_has_not_named_is_read_by_its_placeholder_and_declared_extern():
    body, types, BASE, RVA, d, member_form = _reads_global()
    u = member_form(body, types, BASE, RVA, d, unnamed_data=lambda at: at == BASE + 0x5000)
    assert u.definition == "int Box::Value()\n{\n    return Data5000;\n}\n"
    assert u.data == (("Data5000", 0x5000),) and u.callees == ()
    assert u.prototypes == "extern int Data5000;\n"
    f = member_form(*_reads_global(ty.Float(32))[:5], unnamed_data=lambda at: True)
    assert f.prototypes == "extern float Data5000;\n"


def test_the_address_of_an_object_the_project_has_not_named_is_its_byte_placeholder():
    from recon.core.structuring import ast as A
    _body, types, BASE, RVA, d, member_form = _reads_global()
    I64 = ty.Int(64, True)
    body = A.Body((), I64, (A.Return(A.Num(BASE + 0x5000, I64)),))
    u = member_form(body, types, BASE, RVA, d, unnamed_data=lambda at: at == BASE + 0x5000)
    assert u.definition == "long long Box::Value()\n{\n    return reinterpret_cast<long long>(Data_5000);\n}\n"
    assert u.prototypes == 'extern "C" unsigned char Data_5000[];\n' and u.data == (("Data_5000", 0x5000),)
    assert "5000" not in member_form(body, types, BASE, RVA, d).prototypes      # not an object of the image: a number
    both = A.Body((), I64, (A.Return(A.Binary("+", A.Num(BASE + 0x5000, I64), A.Cast(A.Global(BASE + 0x5000, ty.Int(32, True)), I64), I64)),))
    with pytest.raises(NotReconstructed, match="LAYOUT_CONFLICT"):          # one object, two declarations
        member_form(both, types, BASE, RVA, d, unnamed_data=lambda at: True)


def test_a_function_no_exception_may_leave_is_declared_noexcept():
    from dataclasses import replace
    body, types, BASE, RVA, d, member_form = _reads_global()
    types.fn = replace(types.fn, noexcept=True)
    u = member_form(body, types, BASE, RVA, d, unnamed_data=lambda at: True)
    assert u.declaration == "int Value() noexcept"
    assert u.definition.startswith("int Box::Value() noexcept\n{")


def test_an_object_the_project_names_is_not_given_a_placeholder():
    body, types, BASE, RVA, d, member_form = _reads_global()
    with pytest.raises(NotReconstructed, match="GLOBAL_NOT_DECLARED"):
        member_form(body, types, BASE, RVA, d)


def test_a_unit_whose_functions_declare_one_placeholder_differently_gets_no_edits():
    pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
    from recon.adapters.skyrim.solve import Outcome, edits
    a = Outcome(0x10, "solved", "BYTE_MATCHED", definition="int Box::Get()\n{\n    return Data50;\n}\n",
                declaration="int Get()", name="Box::Get", prototypes="extern int Data50;\n")
    b = Outcome(0x30, "solved", "BYTE_MATCHED", definition="float Box::Set()\n{\n    return Data50;\n}\n",
                declaration="float Set()", name="Box::Set", prototypes="extern float Data50;\n")
    text = "class Box\n{\npublic:\n};\n"
    assert edits([a, b], "unit/Box.h", "unit/Box.cpp", text) == []
    assert edits([a, a], "unit/Box.h", "unit/Box.cpp", text)[0]["declarations"] == "extern int Data50;"


def test_a_callee_the_project_names_is_not_given_a_placeholder():
    c, BASE, RVA, OTHER, Declared, Member, member_form = _calls_stores()
    with pytest.raises(NotReconstructed, match="CALLEE_NOT_DECLARED"):
        member_form(c.body, c.types, BASE, RVA, Declared("Box", "Put", (Member(4, "value", ty.Int(32, True)),)))


# ---------------------------------------------------------------- what the compiler reads from a header

def test_the_compiler_gives_members_offsets_and_types(toolchain, tmp_path):
    root = tmp_path / "root"
    (root / "unit").mkdir(parents=True)
    std = root / "unit" / "std.cpp"
    std.write_text("#include <cstdint>\n#include <type_traits>\n", encoding="utf-8")
    code, _out = toolchain.tool.run("cl", [*toolchain.flags, "/c", f"/Fo{tmp_path / 'std.obj'}", "unit/std.cpp"], root)
    if code != 0:
        pytest.skip("this host's compiler cannot read the standard headers (a Windows compiler over a WSL path)")
    (root / "unit" / "Box.h").write_text("\n".join([
        "#pragma once", "#include <cstdint>",
        "class Base { public: std::uint32_t refs; std::uint32_t pad; };",
        "class Other;",
        "class Box : public Base", "{", "public:",
        "    std::int16_t s16;", "    bool flag;", "    float scale;", "    Other* other;", "    float* scales;",
        "    std::uint8_t unknown20[0x10];  // 20", "private:", "    std::int32_t hidden;", "};",
        "static_assert(sizeof(Box) == 0x38, \"size\");", ""]), encoding="utf-8")
    facts = D.class_facts(toolchain.tool, toolchain.flags, root, "unit/Box.h", "Box", tmp_path / "work")
    got = {m.name: (m.offset, m.type, m.count) for m in facts.members}
    assert facts.size == 0x38 and not facts.virtual_bases
    assert got["refs"] == (0, ty.Int(32, False), 0)
    assert got["s16"] == (8, ty.Int(16, True), 0)
    assert got["flag"] == (10, ty.BOOL, 0)
    assert got["scale"] == (12, ty.Float(32), 0)
    assert got["scales"] == (24, ty.Ptr(ty.Float(32)), 0)
    assert got["unknown20"] == (32, ty.Int(8, False), 16)
    assert "other" not in got and "hidden" not in got        # a pointer to a class; a member this unit cannot name
    assert {"other", "hidden"} <= set(facts.names)
    assert not any(p.name.startswith(".recon-probe") for p in (root / "unit").iterdir())


def test_the_compiler_guards_a_noexcept_member_s_calls_and_loads_a_placeholder_s_address(toolchain, tmp_path):
    """What D-058 and D-059 rest on, with the pinned compiler: the address of a byte placeholder is loaded through a
    relocation (not as a number), and `noexcept` gives a function that calls what may throw a frame handler and the
    runtime's slot set to -2."""
    from recon.adapters.x64_msvc import coff
    root = tmp_path / "root"
    (root / "unit").mkdir(parents=True)
    got = {}
    for nx in ("", " noexcept"):
        (root / "unit" / "Box.cpp").write_text("\n".join([
            'extern "C" unsigned char Data_5000[];', "void Function6000(long long arg1);",
            f"struct Box {{ void Put(){nx}; }};", f"void Box::Put(){nx}", "{",
            "    Function6000(reinterpret_cast<long long>(Data_5000));", "}", ""]), encoding="utf-8")
        obj = tmp_path / f"box{len(nx)}.obj"
        code, out = toolchain.tool.run("cl", [*(f for f in toolchain.flags if f != "/c"), "/c", f"/Fo{obj}", "unit/Box.cpp"], root)
        assert code == 0, out
        o = coff.Object(obj.read_bytes())
        (fn,) = [f for f in o.functions().values() if coff.plain(f.symbol) == "Put"]
        got[nx] = (fn, o)
    plain, guarded = got[""][0], got[" noexcept"][0]
    for fn in (plain, guarded):
        assert any(r.symbol == "Data_5000" and r.kind in coff.REL32 for r in fn.relocs)
    help_slot = b"\x48\xc7\x44\x24"                     # mov qword [rsp+disp8], imm32
    assert any(guarded.code[k:k + 4] == help_slot and guarded.code[k + 5:k + 9] == b"\xfe\xff\xff\xff" for k in range(len(guarded.code)))
    assert b"\xfe\xff\xff\xff" not in plain.code and len(guarded.code) > len(plain.code)


def test_the_packet_carries_each_placeholder_prototype_once_after_the_unit_s_includes():
    pytest.importorskip("iced_x86", reason="needs the private venv (engine/recon/scripts/setup-venv.sh)")
    from recon.adapters.skyrim.solve import Outcome, edits
    a = Outcome(0x10, "solved", "BYTE_MATCHED", definition="int Box::Get()\n{\n    return Function20();\n}\n",
                declaration="int Get()", name="Box::Get", prototypes="int Function20();\n")
    b = Outcome(0x30, "solved", "BYTE_MATCHED", definition="void Box::Set()\n{\n    Function20();\n    Function40(1);\n}\n",
                declaration="void Set()", name="Box::Set", prototypes="int Function20();\nvoid Function40(int arg1);\n")
    text = "class Box\n{\npublic:\n    int Get();\n};\n"
    cpp = edits([a, b], "unit/Box.h", "unit/Box.cpp", text)[0]
    assert cpp["path"] == "unit/Box.cpp" and cpp["declarations"] == "int Function20();\nvoid Function40(int arg1);"
    plain = Outcome(0x10, "solved", "BYTE_MATCHED", definition=a.definition, declaration="int Get()", name="Box::Get")
    assert "declarations" not in edits([plain], "unit/Box.h", "unit/Box.cpp", text)[0]
