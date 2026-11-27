# SPDX-License-Identifier: AGPL-3.0-or-later
"""The compiler knowledge base: rules that change how a candidate is written without changing what it does.

Each rule names a transformation the generator can make (a change of `candidates.Choice`), the recipes it was confirmed
under, its preconditions, why it keeps the meaning, what it does to the code, and its positive and negative synthetic
experiments (pairs of functions in `tests/fixtures/cpp/p9_rules.cpp`: `<Case>Before` and `<Case>After`). A rule is
confirmed under a recipe only when every positive pair compiles differently there, with its primary `MISMATCH` kind
among the rule's `effect`, and every negative pair compiles identically (`tests/unit/test_p9_rules.py` compiles them).
Rules are learned from those original experiments and from upstream's matching cookbook (`cookbook` gives the rule
numbers there), never from a target.

`FAMILIES` maps each mismatch kind to the rule families allowed to address it: first the families confirmed to cause
that kind, then those the cookbook relates to it. The search expands only those families from the nearest candidates,
and every other family only after them (core/synthesis/search.py).

The base is versioned: any change of a rule's id, transformation, preconditions or recipes moves `RULES_VERSION`, and its
digest is part of what a result rests on.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from typing import Iterator, Protocol

from recon.core.synthesis import kinds as K

RULES_VERSION = 1
#: the recipe every rule below was confirmed under (`reconstruction/recipes/<name>.json` upstream)
O2 = "msvc-19.16.27054-o2"
#: rules applied on one path from the canonical form, at most
MAX_TRAIL = 6
#: open signs and mirrored comparisons a rule takes one at a time, at most (as the first-stage generator did)
MAX_ONE_BY_ONE = 4


class Context(Protocol):
    """What the generator knows of the function that rules need: counts of its open points."""

    open: int                   # integer variables whose sign nothing decides
    compared: int               # comparisons of order
    results: int                # possible readings of the result
    readings: tuple[int, ...]   # for each callee, by place, how many other readings of its signature there are


@dataclass(frozen=True)
class Rule:
    id: str
    name: str                    # the change's name in `Choice.changes()`, up to its first ':'
    family: str
    recipes: tuple[str, ...]
    preconditions: str
    transformation: str
    meaning: str                 # why the meaning is kept
    codegen: str                 # what it does to the code, as the experiments show
    effect: tuple[str, ...]      # kinds confirmed as the primary kind of a positive experiment
    positive: tuple[str, ...]    # experiment cases (function pairs) where it changes the code
    negative: tuple[str, ...]    # experiment cases where its precondition fails and it changes nothing
    limits: str
    cookbook: tuple[int, ...] = ()
    #: kinds the cookbook's symptom relates to the rule, beyond those confirmed here
    related: tuple[str, ...] = ()

    def data(self) -> dict:
        return {k: getattr(self, k) for k in ("id", "name", "family", "recipes", "preconditions", "transformation", "meaning", "codegen",
                                              "effect", "positive", "negative", "limits", "cookbook", "related")}


RULES: tuple[Rule, ...] = (
    Rule("P9-R001", "shared-return", "exit-arrangement", (O2,),
         "The function returns from more than one place, and a return only hands on a value known on that path.",
         "Write one result local, assigned on every path, and one return at the end (Style.split_returns = False).",
         "Every path assigns the local exactly the value it returned before, and nothing runs between the assignment and the return.",
         "The compiler merges exits: blocks move and the last test is taken the other way; the epilogue is shared.",
         (K.POLARITY,), ("Exit", "Exit2"), ("ExitNeg",),
         "A path that leaves through a different epilogue (a tail call) keeps its own return in the cookbook's experience.",
         (34,), (K.BLOCKS, K.REGISTERS, K.SELECTION, K.SIZE_ONLY, K.UNWIND)),
    Rule("P9-R002", "select-as-if", "select-form", (O2,),
         "A value is chosen by a condition (a ?: of the canonical form).",
         "Write the choice as an if statement assigning a local in each arm (Style.select = 'if').",
         "Both forms evaluate the condition once and exactly one arm; the local takes the arm's value.",
         "A conditional move keeps its condition but takes it the other way, with the operands and the result register exchanged.",
         (K.REGISTERS,), ("Select", "Select2"), ("SelectNeg",),
         "Arms with calls or loads that may fault compile to branches either way.",
         (34, 43), (K.SELECTION, K.BLOCKS, K.POLARITY)),
    Rule("P9-R003", "guarded-do-while", "loop-form", (O2,),
         "A loop whose canonical form is a while loop the compiler rotated (a guard and a do-while).",
         "Keep the guard and the do-while as the code has them (unrotate = False).",
         "The guard is the loop's own condition before the first iteration; the body runs in the same order the same number of times.",
         "Blocks of the loop are laid out differently: a test moves, an alignment pad appears, an exit block moves.",
         (K.BLOCKS,), ("Loop", "Loop2"), ("LoopNeg",),
         "A simple loop with one condition compiles identically in both forms (the compiler rotates it either way).",
         (3, 20), (K.SIZE_ONLY, K.SELECTION)),
    Rule("P9-R004", "arms-exchanged", "branch-arrangement", (O2,),
         "A two-way branch with both arms present.",
         "Negate the condition and exchange the arms (Style.invert = True).",
         "The negated condition selects the other arm on exactly the inputs that selected it before.",
         "The compiler lays the then-arm out first: blocks exchange places and the test is taken the other way; a conditional tail "
         "call can become a jump to a tail call.",
         (K.POLARITY, K.BLOCKS, K.CALL), ("Arms3", "Arms2", "Arms"), ("ArmsNeg",),
         "A branch the compiler turns into a conditional move compiles identically.",
         (2, 34), (K.SIZE_ONLY,)),
    Rule("P9-R005", "mirror", "comparison-form", (O2,),
         "The function compares values for order.",
         "Write every comparison from the other side, a < b as b > a (Style.mirror = (-1,)).",
         "Exchanging the operands and the relation gives the same truth value for every input.",
         "The comparison's operands are exchanged and the condition code swaps (less for greater).",
         (K.POLARITY,), ("Mirror", "Mirror2"), ("MirrorNeg",),
         "Comparisons the compiler folds into arithmetic are not changed.",
         (42,), (K.REGISTERS, K.SELECTION)),
    Rule("P9-R006", "mirror-one", "comparison-form", (O2,),
         "The function has more than one comparison of order.",
         "Write one comparison, by position, from the other side (Style.mirror = (k,)).",
         "As P9-R005, for one comparison.",
         "As P9-R005, at one comparison.",
         (K.POLARITY,), ("Mirror", "Mirror2"), ("MirrorNeg",),
         f"The first {MAX_ONE_BY_ONE} comparisons only.",
         (42,), (K.REGISTERS, K.SELECTION)),
    Rule("P9-R007", "read-again", "value-reuse", (O2,),
         "A value read from memory is used again after a call or a store that may change that memory.",
         "Read it again where it is used instead of keeping it (read_again = True).",
         "The execution check runs both forms on the same inputs; the form is kept only where both agree.",
         "The compiler reloads the value: a preserved register and its save disappear, an extension moves.",
         (K.UNWIND, K.EXTENSION), ("Read", "Read2"), ("ReadNeg", "ReadNeg2"),
         "Without a call or an aliasing store between the reads the compiler reads once either way.",
         (1, 61), (K.REGISTERS, K.SELECTION, K.STACK, K.BLOCKS)),
    Rule("P9-R008", "sign", "types-and-promotions", (O2,),
         "An integer variable whose sign no operation decides.",
         "Declare it with the other signedness (flips = (k,)).",
         "No operation the function does on the variable depends on its sign, so both declarations compute the same.",
         "Comparisons, shifts and extensions take their signed or unsigned forms.",
         (K.EXTENSION,), ("Sign", "Sign2"), ("SignNeg",),
         f"The first {MAX_ONE_BY_ONE} open signs one at a time.",
         (6, 38, 68), (K.CONSTANT, K.SELECTION)),
    Rule("P9-R009", "sign-all", "types-and-promotions", (O2,),
         "More than one integer variable whose sign no operation decides.",
         "Declare all of them with the other signedness (flips = all).",
         "As P9-R008, for each.",
         "As P9-R008.",
         (K.EXTENSION,), ("Sign", "Sign2"), ("SignNeg",),
         "All at once or one at a time; other subsets come only by combining one-at-a-time rules.",
         (6, 38, 68), (K.CONSTANT, K.SELECTION)),
    Rule("P9-R010", "no-arithmetic-undo", "arithmetic-form", (O2,),
         "The normal form has arithmetic the canonical form reads as a division, remainder or multiplication.",
         "Keep the arithmetic as the code computes it (undo = False).",
         "The reading was proved equal; the arithmetic is the computation the code does.",
         "Registers, constants and instructions of the arithmetic differ.",
         (K.SELECTION, K.CONSTANT, K.REGISTERS), ("Undo", "Undo2", "Undo3"), ("UndoNeg",),
         "Only readings the idiom prover accepted.",
         (), (K.EXTENSION,)),
    Rule("P9-R011", "result", "result-reading", (O2,),
         "The result has more than one reading (a truth value or an integer, a width).",
         "Read the result another way (result = k).",
         "Callers see the same bits in the result register for the part the reading covers; the execution check compares them.",
         "A truth value made a full integer: the result register is zeroed before the set-on-condition.",
         (K.EXTENSION,), ("Result", "Result2"), ("ResultNeg",),
         "Readings the evidence offers only.",
         (66, 46), (K.CONSTANT, K.CALL)),
    Rule("P9-R012", "callee", "callee-reading", (O2,),
         "A callee whose signature its callers or its own code leave open.",
         "Read the callee's signature another way (callees = ((place, reading),)).",
         "The arguments the callee reads are passed the same; the execution check compares the calls.",
         "Arguments are extended at another width or sign before the call.",
         (K.EXTENSION,), ("Callee", "Callee2"), ("CalleeNeg",),
         "Readings the program store offers only.",
         (5, 68), (K.CALL, K.REGISTERS)),
)

BY_ID = {r.id: r for r in RULES}
FAMILY_ORDER: tuple[str, ...] = tuple(dict.fromkeys(r.family for r in RULES))


def _families() -> dict[str, tuple[str, ...]]:
    out: dict[str, tuple[str, ...]] = {}
    for k in K.KINDS:
        confirmed = [r.family for r in RULES if k in r.effect]
        related = [r.family for r in RULES if k in r.related]
        out[k] = tuple(dict.fromkeys(confirmed + related))
    return out


#: kind -> the families allowed to address it, confirmed ones first
FAMILIES: dict[str, tuple[str, ...]] = _families()


def directed(kind: str | None) -> tuple[str, ...]:
    """The families a candidate of this kind is expanded with first; every family when the kind is not known."""
    if not kind or kind not in FAMILIES:
        return FAMILY_ORDER
    return FAMILIES[kind]


def rest(kind: str | None) -> tuple[str, ...]:
    """The families left after `directed`, in the base's order."""
    first = set(directed(kind))
    return tuple(f for f in FAMILY_ORDER if f not in first)


def digest() -> str:
    """The digest of the base: what a result rests on."""
    return hashlib.sha256(json.dumps([RULES_VERSION, [r.data() for r in RULES]], sort_keys=True).encode()).hexdigest()


# ------------------------------------------------------------------------------------------- applying rules

def apply(rule: Rule, c, ctx: Context) -> Iterator[tuple[object, str]]:
    """The choices one application of `rule` to choice `c` gives, each with its trail step (`<rule id>` or `<rule id>:<k>`),
    in a fixed order. Nothing when the rule does not apply (its precondition fails, or `c` already has it)."""
    s = c.style
    n = rule.name
    if n == "shared-return" and s.split_returns:
        yield replace(c, style=replace(s, split_returns=False)), rule.id
    elif n == "select-as-if" and s.select != "if":
        yield replace(c, style=replace(s, select="if")), rule.id
    elif n == "guarded-do-while" and c.unrotate:
        yield replace(c, unrotate=False), rule.id
    elif n == "arms-exchanged" and not s.invert:
        yield replace(c, style=replace(s, invert=True)), rule.id
    elif n == "mirror" and ctx.compared and not s.mirror:
        yield replace(c, style=replace(s, mirror=(-1,))), rule.id
    elif n == "mirror-one" and ctx.compared > 1 and (-1,) != s.mirror:
        for k in range(min(ctx.compared, MAX_ONE_BY_ONE)):
            if k not in s.mirror:
                yield replace(c, style=replace(s, mirror=tuple(sorted((*s.mirror, k))))), f"{rule.id}:{k}"
    elif n == "read-again" and not c.read_again:
        yield replace(c, read_again=True), rule.id
    elif n == "sign":
        for k in range(min(ctx.open, MAX_ONE_BY_ONE)):
            if k not in c.flips:
                yield replace(c, flips=tuple(sorted((*c.flips, k)))), f"{rule.id}:{k}"
    elif n == "sign-all" and ctx.open > 1 and c.flips != tuple(range(ctx.open)):
        yield replace(c, flips=tuple(range(ctx.open))), rule.id
    elif n == "no-arithmetic-undo" and c.undo:
        yield replace(c, undo=False), rule.id
    elif n == "result" and c.result == 0:
        for k in range(1, ctx.results):
            yield replace(c, result=k), f"{rule.id}:{k}"
    elif n == "callee":
        taken = {i for i, _j in c.callees}
        for i, alts in enumerate(ctx.readings):
            if i not in taken:
                for j in range(alts):
                    yield replace(c, callees=tuple(sorted((*c.callees, (i, j))))), f"{rule.id}:{i}:{j}"


def expand(c, families: tuple[str, ...], ctx: Context) -> Iterator[tuple[object, str]]:
    """Every single application of the rules of `families` to `c`, family by family in the given order, rules in id order."""
    for f in families:
        for r in RULES:
            if r.family == f:
                yield from apply(r, c, ctx)


__all__ = ["BY_ID", "FAMILIES", "FAMILY_ORDER", "MAX_TRAIL", "O2", "RULES", "RULES_VERSION", "Rule", "apply", "digest", "directed", "expand",
           "rest"]
