# SPDX-License-Identifier: AGPL-3.0-or-later
"""Blocker codes by capability, and the state a function is in (convergence plan, sections 1.2 and 5).

Every reason code the engine gives belongs to one family, and families come in pipeline order: what the machine code
is, how it is called, what the project declares, what the source can say, what the search finds, what the unit allows,
what needs the user's decision. A function carries every blocker found, the first in pipeline order primary. A code no
family claims is `UNCLASSIFIED`, which a test keeps at zero for every code written in the engine's source.

States: `BYTE_MATCHED` (the engine's comparator passed it: `VERIFIED` needs the Gate Keeper, the dry run and a clean-room
rerun, which are not the engine's), `RESUMABLE` (a budget ran out; a frontier is saved), `NEEDS_DECISION` (evidence says
matching needs something outside the engine's authority: the user decides), `INFRA` (never a reconstruction result),
`OPEN` (a capability is missing).
"""
from __future__ import annotations

from recon.core.synthesis import kinds as _kinds

ORDER = ("Machine", "ABI", "Knowledge", "Source", "Search", "Unit", "Policy", "Infra")
BYTE_MATCHED, RESUMABLE, NEEDS_DECISION, INFRA, OPEN = "BYTE_MATCHED", "RESUMABLE", "NEEDS_DECISION", "INFRA", "OPEN"

#: code -> (family, the plan's name for it when it differs)
CODES: dict[str, tuple[str, str]] = {}


def _add(family: str, *codes: str, name: str = "") -> None:
    for c in codes:
        CODES[c] = (family, name or c)


_add("Machine", "UNSUPPORTED_INSTRUCTION", "INVALID_INSTRUCTION", "CONFLICTING_EVIDENCE", "NOT_REPRESENTED", "STACK_POINTER_UNKNOWN",
     "IRREDUCIBLE_CONTROL_FLOW", "LIFT_COVERAGE_MISSING", "FORM_NOT_VALIDATED", "UNWIND_CONFLICT")
_add("Machine", "CATCH_BLOCKS_NOT_REPRESENTED", "CATCH_BLOCK", name="CATCH_BLOCK")
_add("Machine", "HANDLER_NOT_UNDERSTOOD", "OTHER_HANDLER", "EXCEPTION_DATA_MALFORMED", "EXCEPTION_EDGES_NOT_REPRESENTED",
     "EXCEPTION_RUNTIME_SLOT_IS_ALSO_USED", name="OTHER_HANDLER")
_add("Machine", "UNRESOLVED_JUMP", name="UNRESOLVED_JUMP")
_add("Machine", "NO_FRAME", "FRAME_CONTRADICTS_UNWIND_DATA", "READS_A_LOCATION_THAT_WAS_NOT_LIVE", name="STACK_POINTER_UNKNOWN")
_add("ABI", "STACK_ARGUMENTS", "STACK_ARGUMENT", name="STACK_ARGUMENT")
_add("ABI", "VECTOR_PARAMETER", "VECTOR_VALUE", "VECTOR_ARGUMENT", name="VECTOR_ARGUMENT")
_add("ABI", "NO_RETURN", "NONRETURNING_UNKNOWN", name="NONRETURNING_UNKNOWN")
_add("ABI", "HIDDEN_RETURN_POINTER", "AGGREGATE_BY_VALUE", "VARIADIC", "ADJUSTOR_THUNK", "PARAMETER_IN_TWO_LOCATIONS",
     "PRESERVED_LOCATION_CHANGED", "TAIL_RESULT_DIFFERS", "READS_A_LOCATION_NOBODY_SET", "LOWERING_UNSETTLED",
     "RESULT_READING_ABSENT")
_add("Knowledge", "CALLEE_SIGNATURE_UNKNOWN", "CALLEE_CHAIN_TOO_DEEP", name="CALLEE_SIGNATURE_UNKNOWN")
_add("Knowledge", "CALLEE_NOT_DECLARED", "CLASS_NOT_DECLARED", "MEMBER_NOT_DECLARED", "GLOBAL_NOT_DECLARED", "VTABLE_SLOT_UNKNOWN",
     "INDIRECT_CALL", "CLASS_NOT_IN_UNIT_HEADER", "DECLARATION_NOT_UNIQUE", "OVERLOADED_METHOD", "VIRTUAL_DECLARATION", "INLINE_DEFINITION",
     "VIRTUAL_BASES", "NAME_NOT_PLAIN", "SEVERAL_CLASSES")
_add("Knowledge", "LAYOUT_CONFLICT", "LAYOUT_CONTRADICTION", "CONFLICTING_TYPES", "TYPES_OF_DIFFERENT_WIDTH", "MISALIGNED_MEMBER", "LAYOUT_SIZE",
     name="LAYOUT_CONTRADICTION")
_add("Source", "LOCAL_IN_MEMORY", "SWITCH", "EH_SOURCE", "ARRAY_OF_CLASS", "CLASS_BY_VALUE", "STORE_TO_READ_ONLY_MEMORY")
_add("Source", "ARRAY_FORM", "ADDRESS_FORM", "ADDRESS_VALUE", "ADDRESS_CONSTANT", "INTEGER_VIEW_OF_ANOTHER_TYPE", "FLOAT_VIEW_OF_ANOTHER_TYPE",
     "FLOAT_LITERAL", "CONVERSION", "CONSTANT_TYPE", "COMPARISON_WIDTH", "COMPARISON_OF_TRUTH_VALUES", "SIGN_EXTENDED_TRUTH_VALUE",
     "UNORDERED_COMPARISON", "VALUE_WIDTH", name="CONSTRUCT_UNSUPPORTED")
_add("Search", "NOT_EQUIVALENT", "SEMANTIC_DISAGREEMENT", name="SEMANTIC_DISAGREEMENT")
_add("Search", "DOES_NOT_COMPILE", "EXACT_UNIT_DOES_NOT_COMPILE", name="DOES_NOT_COMPILE")
_add("Search", "NO_MATCH", "MISMATCH", name="MISMATCH")
for _code, _name in _kinds.CODES.items():           # MISMATCH(kind): the kinds are P9's list (contract C2)
    _add("Search", _code, name=_name)
_add("Search", "NO_CANDIDATE", "GRAMMAR_EXHAUSTED", name="GRAMMAR_EXHAUSTED")
_add("Search", "BUDGET_EXHAUSTED")
_add("Unit", "UNIT_HEADER_DOES_NOT_COMPILE", "UNIT_HEADER_NOT_READABLE", "JOINT_UNIT_REGRESSION", "RECIPE_MISMATCH")
_add("Unit", "HEADER_SIZE_CAP", "NEW_UNIT")
_add("Policy", "NEEDS_DECISION")
_add("Infra", "WORKER_DIED", "NO_WORKTREE", "TOOLCHAIN_UNAVAILABLE", "INPUT_MISSING", "COMPILER_FAILED", "ENGINE_ERROR", "NOT_IN_INVENTORY", "SIZE_LIMIT",
     "NOT_A_FUNCTION_OF_THE_PACK", "NO_SUCH_FUNCTION", "INFRA", "NOT_STARTABLE", "NOT_ATTEMPTED")

#: prefixes of codes made from a name (an operation, an effect, an exit the IR does not represent)
PREFIXES = (("OPERATION_", "Machine", "NOT_REPRESENTED"), ("EFFECT_", "Machine", "NOT_REPRESENTED"), ("EXIT_", "Machine", "NOT_REPRESENTED"))
#: blockers that are a policy question, not a missing capability (section 1.2)
DECISIONS = frozenset({"HEADER_SIZE_CAP", "RECIPE_MISMATCH", "NEEDS_DECISION"})


def family(code: str) -> str:
    """The family of a code; comparator reasons (lower case, upstream's) are mismatches of a kind; else UNCLASSIFIED."""
    if code in CODES:
        return CODES[code][0]
    for p, fam, _n in PREFIXES:
        if code.startswith(p):
            return fam
    if code and code == code.lower() and code.replace("-", "").isalnum():
        return "Search"
    return "UNCLASSIFIED"


def name(code: str) -> str:
    """The plan's code for an engine code: `MISMATCH(kind)` for a comparator reason."""
    if code in CODES:
        return CODES[code][1]
    for p, _fam, n in PREFIXES:
        if code.startswith(p):
            return n
    if family(code) == "Search":
        return f"MISMATCH({code})"
    return code


def blockers(codes) -> list[str]:
    """Every code once, in pipeline order (the primary first), each family's codes in a fixed order."""
    rank = {f: k for k, f in enumerate(ORDER)}
    return sorted(set(codes), key=lambda c: (rank.get(family(c), len(ORDER)), c))


def state(matched: bool, codes) -> str:
    """The state of a function from whether the engine's comparator passed it and the codes it carries."""
    if matched:
        return BYTE_MATCHED
    bs = blockers(codes)
    if any(family(c) == "Infra" for c in bs):
        return INFRA
    if "BUDGET_EXHAUSTED" in bs:
        return RESUMABLE
    if any(c in DECISIONS for c in bs):
        return NEEDS_DECISION
    return OPEN


__all__ = ["BYTE_MATCHED", "CODES", "DECISIONS", "INFRA", "NEEDS_DECISION", "OPEN", "ORDER", "RESUMABLE", "blockers", "family", "name", "state"]
