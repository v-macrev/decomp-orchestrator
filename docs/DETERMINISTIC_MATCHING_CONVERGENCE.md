# Deterministic Reconstruction Engine: Convergence to 100% Verified Byte Matching

> **How to read this prompt.** It continues [DETERMINISTIC_WORKER_PROMPT.md](DETERMINISTIC_WORKER_PROMPT.md)
> (the *spec*). It **replaces only spec section 30, Phases 7 to 10**, with Phases 7 to 13 below. Every other
> section of the spec stays binding, above all §3 (no AI in reconstruction), §5 (definition of
> reconstruction), §15.4 (plausibility), §26 (provenance), §31 (execution protocol) and §32 (prohibitions).
> Where this prompt and the spec disagree on anything except Phases 7 to 10, the spec wins.
>
> Numbers marked *(snapshot)* were measured on or before 2026-11-26 at orchestrator `2b143ee`. Defects
> marked **verified** were read in the code at that revision. Re-check a defect only if its file changed since;
> re-measure a number before you rely on it, and never report a snapshot as current.

---

## 1. The objective, stated so it can be checked

**Goal:** every function in the frozen denominator (§2) reaches state `VERIFIED` (§1.1) through the engine
alone, or is moved by the user, not by you, into a ledger class that needs their decision (§1.2).

"100%" means: `VERIFIED` count equals the denominator, **and** the open-blocker count is zero. Nothing else
counts toward it: not lifting, IR admission, compilation, a distance of 0, a similarity score, or a match
someone else made.

### 1.1 `VERIFIED`

A function is `VERIFIED` only when all of these hold, each checked by a component the engine does not
control:

1. Its C++ was produced by the engine from permitted inputs (image, upstream declarations and tooling,
   the rule store), with no body read from a model, contributor, decompiler or the base unit's draft.
2. Upstream's comparator (`compare_runtime`, the version upstream pins; 0.6.1-runtime *(snapshot)*) passes it
   on the **exact unit** compiled under the unit's pinned recipe: code bytes, relocation targets and unwind
   data.
3. The orchestrator Gate Keeper passes it unchanged, including preflight (size caps, forbidden constructs:
   asm, `#pragma` beyond the one allowed, `##`, byte arrays, `\x` strings, decompiler identifiers, edits to
   matched bodies or verifier inputs).
4. Its batch's `sr submit --dry-run` is clean.
5. A clean-room rerun (no caches, fresh process, different hash seed) reproduces the same canonical source
   digest and the same verdict.
6. Every function previously `VERIFIED` in the same unit still is.

Upstream acceptance (review on two hosts plus CI, after **the user** submits) is tracked as a separate,
later state. You never submit, open a pull request, publish a claim, or offer to.

### 1.2 Terminal states other than `VERIFIED`

Every function in the denominator is always in exactly one state. Allowed non-verified states:

| State | Meaning | Who may close it |
|---|---|---|
| `OPEN(blocker…)` | The engine lacks a capability; one or more blocker codes (§5) with evidence | You, by building the capability |
| `RESUMABLE` | Budget exhausted; the search frontier is saved | You, by resuming with a larger budget |
| `NEEDS_DECISION(reason)` | Matching appears to require something outside your authority: a recipe change, editing an already-matched body or header beyond policy, a header over upstream's size cap, a construct upstream forbids, a function whose original was not C++ compiled by the pinned compiler | **The user** |
| `INFRA` | Toolchain, Wine, claim or disk failure. Never a reconstruction result | You, by fixing the infrastructure |

`NEEDS_DECISION` is not an exit. You must attach the evidence (the smallest synthetic reproduction, or the
comparator diff and why every legitimate source alternative tried fails), and the function stays in the
denominator. Estimate the size of this class **early** (Phase 7 sample, §4) so the user learns about a hard
ceiling at 5%, not at 99%.

Never move a function between states to improve a percentage. A previously `VERIFIED` function that stops
verifying is a regression (§7), not a new blocker.

---

## 2. The frozen denominator

Before any further capability work, write a coverage manifest, private, under the engine's data directory:
image SHA-256, upstream revision, inventory file digests, comparator version, compiler digest per recipe,
and per function: RVA, extent and its source, unit (existing or new), recipe, and the populations below.

Populations *(snapshot)*, all reported separately, none silently dropped:

| Population | Size | Notes |
|---|---|---|
| Offered targets | 64,010 | `data/target-hashes/contributor-targets-part-*.json` |
| **Offered and unmatched: the primary denominator** | **62,247** | No `progress.json` entry |
| Recorded but unmatched (`mapped`) | 986 | Outside the offered list; a second denominator |
| In `progress.json` but not offered | 40,458 | Not targets, but **callees and class users**: needed for knowledge (Phase 8) |
| Startable now by `sr next` (offline) | 12,720 | A scheduling fact, not a denominator |

Rules:

* Freeze the denominator per upstream revision. When upstream moves, write a new manifest and report both;
  a function matched upstream by someone else leaves the engine's *open* set but **never** counts as an
  engine success.
* Report coverage by function count **and** by bytes.
* Split a fixed **held-out set** off the denominator now: every function whose
  `sha256("heldout-v1" || rva_le32)` falls in the lowest 5% of the hash space. While developing rules you may
  see only its aggregate counts and reason codes, never its listings, bytes or emitted source. Report every
  gate result on held-out and development sets separately. A rule tuned while looking at a held-out function
  invalidates the set: say so and draw a new one (`heldout-v2`).

---

## 3. Verified baseline *(snapshot)*

### 3.1 Where the funnel stands

| Stage | Count | Denominator |
|---|---|---|
| Decoded completely | 62,247 | 62,247 |
| Lifted completely | 61,875 | 62,247 (372 lack one of 16 forms) |
| IR admitted | 61,394 | 62,247 (343 catch blocks, 122 no frame, 7 other handlers, 6 unresolved jumps, 2 no CFG, 1 unwind conflict) |
| Reach run (≤128 bytes, existing unit) | 140 with a candidate | 2,375; refused `CALLEE_SIGNATURE_UNKNOWN` 1,657, `INDIRECT_CALL` 340, `LOCAL_IN_MEMORY` 25 |
| `solve` on functions with no callee or global | **2 `BYTE_MATCHED`** | 93; `MEMBER_NOT_DECLARED` 39, `CLASS_NOT_DECLARED` 34, `NO_MATCH` 18 |
| Gate Keeper pass + clean dry run | 1 | 2 (the other blocked by the header size cap: a `NEEDS_DECISION` case) |

Analysis is near-complete; reconstruction is at roughly 0%. The gap is **declarations, references and
search**, not instruction semantics. Do not spend Phase 7 or 8 on lifting.

### 3.2 Verified defects that block matching regardless of capability

These are not missing features. They make correct candidates unreachable or results unmeasurable, so they
come first.

| Id | Where | What the code does | Consequence |
|---|---|---|---|
| **D1** | `adapters/x64_msvc/batch.py` `distance()`; `adapters/skyrim/solve.py` `UnitWorkshop.resolve` (l. 99); `core/synthesis/search.py` `reconstruct()` | `resolve` knows only the function's own symbol; `distance` counts every relocation it cannot resolve as wrong; `reconstruct` verifies candidates in distance order and **stops at the first distance > 0** | Any candidate that references anything external (a call, a global, a vtable, a string) has distance ≥ 1 and **never reaches the comparator**, even if it would pass. Adding callee declarations alone would unlock nothing |
| **D2** | `core/synthesis/candidates.py` l. 31 to 33, 73, 78 | `MAX_DEPTH = 4` returns `None` for a deeper callee; recursion fixpoint capped at 8 rounds; `MAX_CANDIDATES = 48`, `MAX_TRIED = 160` are constants | Deep call chains fail as `CALLEE_SIGNATURE_UNKNOWN` independent of the callee; search size is not configurable |
| **D3** | `protocol/__init__.py` l. 19, 108; `cli/main.py` l. 36 | Request `budgets` (`candidates`, `compiles`, `solverUnits`, `irNodes`, `expansions`) are validated and hashed into the input digest, then **never read** | Budgets from the flow do nothing; two requests that differ only in budget get different digests and identical work |
| **D4** | `adapters/skyrim/solve.py` l. 142 | `Pack` gets only offered targets' extents | The 40,458 recorded, non-offered functions are invisible as callees |
| **D5** | `adapters/skyrim/solve.py` `edits()` l. 263 | Edits are returned only if every function of the packet is solved | A solved function is discarded when its neighbour fails |
| **D6** | `cli/main.py` l. 26 to 37 | Input digest covers engine, protocol, rule store, packet, budgets, options and carried unit state only | Image, upstream revision, compiler digest, recipe, and header and declaration contents are not in the key; any future cache would go stale silently |
| **D7** | `adapters/skyrim/reach.py` l. 32 to 33 | Takes only the first stage of the generator | Reach undercounts what later stages produce |
| **D8** | `core/synthesis/search.py`, `core/evaluate.py` | Candidates must agree with the normal IR in 96 generated worlds before compiling | Correct candidates can be rejected when made-up memory diverges; **the false-rejection rate has never been measured** |
| **D9** | `adapters/x64_msvc/abi.py` l. 23; `core/inference/lower.py` | Source convention has four register slots; stack arguments, indirect calls, memory locals and some vector values are refused | Matches the `INDIRECT_CALL` and `LOCAL_IN_MEMORY` counts above |
| **D10** | `core/emitter/member.py` l. 67 to 112 | Refuses `CLASS_NOT_DECLARED`, `CALLEE_NOT_DECLARED`, `MEMBER_NOT_DECLARED`, `GLOBAL_NOT_DECLARED`, `ARRAY_OF_CLASS`, `CLASS_BY_VALUE` | Matches 73 of the 91 unsolved real functions |

---

## 4. The convergence loop

Every working session runs this loop. It is spec §31 with three additions: the held-out split, the ratchet,
and the overfitting check.

```text
1. Measure      run the campaign over the current population (start: the 2,375 reach set and the 93 solve set;
                widen per §6, Phase 12). Every function gets a state and blocker codes.
2. Choose       the blocker whose removal unlocks the most functions (or bytes), weighted by how many other
                blockers it sits in front of. Show the ranking; do not choose by interest.
3. Reproduce    write original synthetic fixtures that show the blocker. Never copy target code into a fixture.
4. Build        a general capability: explicit preconditions, a justification, deterministic behaviour.
5. Test         synthetic fixtures, then the spec's test suites; add a deliberate-defect check for the new code.
6. Held-out     run the held-out set; report before/after. A gain on development functions with none on
                held-out is overfitting until shown otherwise.
7. Re-run       every function whose blockers involved the capability, and the regression set (§7).
8. Ratchet      VERIFIED count may not go down. If it does, fix or revert before anything else.
9. Record       the roadmap row (§8 template); commit and push.
```

**Overfitting check, every increment:** no engine source, rule or test may contain a target RVA, a decorated
or plain name from the image, or a byte pattern copied from it. Add a test that scans the engine tree for
constants that equal inventory RVAs or symbol names and fails on any hit outside the private data directory.
Report `rules added / functions unlocked`; a rule that unlocks exactly one function is suspect and needs a
synthetic second case before it lands.

**No repeated work:** a function is re-run only when an input in its dependency digest changed (D6 fixed) or
its saved frontier is resumed with more budget.

**Early ceiling estimate (Phase 7):** take 200 random non-held-out functions across size buckets, and for
each record what it would take beyond the current blockers: does it reference a matched function's body,
does its unit header already sit near upstream's size cap, does its code look non-MSVC or hand-written, does
it need a recipe other than the unit's. Report the projected `NEEDS_DECISION` share with its confidence
interval. Repeat at each 10-point milestone.

---

## 5. Blocker taxonomy

Replace `NO_MATCH` and other catch-alls with codes that name a capability. A function carries **all**
blockers found without inventing evidence, with the first one in pipeline order marked primary.

| Family | Codes (extend, never merge) |
|---|---|
| Machine | `FORM_NOT_VALIDATED`, `CATCH_BLOCK`, `OTHER_HANDLER`, `STACK_POINTER_UNKNOWN`, `UNRESOLVED_JUMP`, `UNWIND_CONFLICT` |
| ABI | `STACK_ARGUMENT`, `HIDDEN_RETURN_POINTER`, `AGGREGATE_BY_VALUE`, `VARIADIC`, `VECTOR_ARGUMENT`, `ADJUSTOR_THUNK`, `NONRETURNING_UNKNOWN` |
| Knowledge | `CALLEE_SIGNATURE_UNKNOWN`, `CALLEE_NOT_DECLARED`, `CLASS_NOT_DECLARED`, `MEMBER_NOT_DECLARED`, `GLOBAL_NOT_DECLARED`, `VTABLE_SLOT_UNKNOWN`, `INDIRECT_CALL`, `LAYOUT_CONTRADICTION` |
| Source | `LOCAL_IN_MEMORY`, `SWITCH`, `EH_SOURCE`, `ARRAY_OF_CLASS`, `CLASS_BY_VALUE`, `CONSTRUCT_UNSUPPORTED(name)` |
| Search | `SEMANTIC_DISAGREEMENT`, `DOES_NOT_COMPILE`, `MISMATCH(kind)` (kinds from Phase 9), `BUDGET_EXHAUSTED` (resumable), `GRAMMAR_EXHAUSTED` (every candidate the current rules can make was compiled) |
| Unit | `JOINT_UNIT_REGRESSION`, `HEADER_SIZE_CAP`, `RECIPE_MISMATCH` |
| Policy | `NEEDS_DECISION(reason)` (§1.2) |
| Infra | `INFRA(reason)`: never counted as a reconstruction result |

`GRAMMAR_EXHAUSTED` is not proof that no source exists. It is evidence that the rule store lacks a dimension;
Phase 9 consumes it.

---

## 6. Phases

Each phase lists only what is not already done (see `docs/recon/IMPLEMENTATION_ROADMAP.md`). Order inside a
phase follows the measured blocker counts, not this list. A phase's gate is met only by measured numbers on
the stated populations, held-out reported separately.

### Phase 7: Measurement and search plumbing

Fix D1 to D8, then the manifest and taxonomy.

* **D1:** a symbol map from permitted evidence (upstream declarations and their linker map, `progress.json`,
  the image's RTTI and vtables, import table) so `resolve` can name external targets; `distance` reports
  unknown relocations separately from wrong ones; `reconstruct` sends to the comparator every compiled candidate
  whose only differences are relocations the map cannot name, and every candidate whose distance is 0, in a
  deterministic order and within the `compiles` budget. A reference is never bound because the bytes then line
  up: the binding must come from the evidence, and the comparator then checks it.
* **D8:** measure the semantic filter's false rejections. On the synthetic corpora, compile and compare every
  candidate the filter rejects; on a real sample, compile and compare the rejected candidates of 100 functions.
  If any comparator-passing candidate was rejected, fix the world generator (or downgrade the filter to a ranking
  signal) and keep the measurement as a regression test.
* **D3:** every budget is read and enforced by the component doing that work, with counters in `result.json`.
  Exhausting one returns `BUDGET_EXHAUSTED` with a saved frontier. A wall-clock timeout is `INFRA`, never
  exhaustion.
* **D2:** remove constant limits from `candidates.py`; they become defaults of the request budgets.
* **D5:** return edits for the largest subset of the packet that verifies **jointly** on the exact unit; the
  rest stays open. The subset still goes through the full Gate Keeper.
* **D6:** content-addressed input manifest: image, upstream revision, compiler and recipe digests, the include
  closure of the unit's header, the declaration knowledge digest, rule store, engine, lockfile, budgets, the
  checkpoint it resumed from. No timestamps or temporary paths.
* **D7:** reach runs all stages.
* The manifest of §2, the held-out split, the taxonomy of §5, and the ceiling estimate of §4.

**Gate:** every function in the 2,375 reach set and the 93 solve set has a state and codes; budgets measurably
bound candidates and compiles (a test sets each to 1 and checks the counters); a resumed search equals an
uninterrupted one, field for field; a synthetic function calling a declared external function reaches
`BYTE_MATCHED` (it cannot today, D1); the D8 false-rejection count is reported; the ceiling estimate exists.

### Phase 8: Program knowledge (declarations, callees, classes, members, globals)

The measured largest bucket (D9, D10, `CALLEE_SIGNATURE_UNKNOWN`).

* A persistent, versioned, private knowledge store built once per manifest: functions (offered **and** the
  40,458 recorded others, D4), direct call graph, vtables and RTTI (8,637 vtables *(snapshot)*), globals by
  section, classes with layout evidence, upstream declarations as the highest-ranked evidence.
* Each fact carries provenance and a status: `declared` (upstream), `proven`, `constrained`, `inferred`,
  `ambiguous`, `contradicted`. Contradictions block the functions they touch; they are never resolved by
  choosing one side.
* Signatures by a worklist over strongly connected components of the call graph, to a fixpoint, independent of
  discovery order; call-site evidence (what callers put in argument registers and on the stack, what they read
  back) combines with callee evidence. Replaces `MAX_DEPTH`.
* Member recovery: an access at an offset inside an `unknownXX` byte array of a declared class introduces a
  typed member only when every known user of that class agrees on offset, width and kind, and the compiler
  confirms the resulting `sizeof` and `offsetof`. The header change is checked against upstream's size cap
  before it is proposed; over the cap is `HEADER_SIZE_CAP`.
* Secondary classes: a function may use members of any class whose declaration is upstream's or is recovered
  under the rule above.
* A declaration change invalidates exactly the functions whose dependency digest includes it.

**Gate:** on the reach and solve sets, `CALLEE_SIGNATURE_UNKNOWN`, `CLASS_NOT_DECLARED` and
`MEMBER_NOT_DECLARED` each fall by a reported amount, development and held-out separately; analysis gives the
same store digest for shuffled discovery order; a seeded layout contradiction is caught; no previously
`VERIFIED` function regresses.

### Phase 9: Mismatch-directed search

Today the generator enumerates fixed alternatives and compiler output only ranks them. Make compiler output
**choose the next dimension**.

* Classify every compiled-but-different candidate by comparing its object with the target into `MISMATCH`
  kinds: register assignment, instruction selection, block order, branch polarity, stack layout, extension
  width or signedness, constant materialisation, call or relocation, unwind, size only.
* A versioned compiler knowledge base of rules, each with an id, the recipes it was confirmed under, source
  preconditions, the transformation, why it preserves meaning, the code-generation effect, positive and negative
  synthetic tests, and its known limits. Rules are learned from **synthetic** compiler experiments and upstream's
  cookbook; a rule confirmed under one recipe does not apply to another until confirmed there.
* Each mismatch kind maps to the rule families allowed to address it (for example stack layout: declaration
  order, local types, scope and lifetime; signedness: types and promotions; block order: legitimate branch
  arrangement and condition polarity). The search expands only those families from the nearest candidates.
* Deterministic priority queue keyed by (distance, rule-trail length, canonical digest); canonical AST and
  object-code deduplication; frontier checkpointed so a larger budget **continues** rather than repeats.
* Plausibility (spec §15.4) is checked on every candidate before compilation, not after a match: no dead code,
  no helpers that exist only to steer bytes, no meaningless `volatile`, no unexplained casts.

**Gate:** a set of controlled synthetic mismatches, one per kind, each resolved automatically with its rule
trail; held-out synthetic and real results before/after; `NO_MATCH` replaced entirely by `MISMATCH(kind)`,
`BUDGET_EXHAUSTED` or `GRAMMAR_EXHAUSTED`; same inputs give the same candidate order across processes and
hash seeds.

### Phase 10: ABI and object model breadth

By measured demand, each with synthetic fixtures compiled under every recipe in use and the compiler's own
output checked against the ABI model: stack arguments and home slots, hidden `this` and return pointers,
aggregates by value, vector arguments and results, variadic calls, nonreturning callees, tail calls,
adjustor thunks, constructors and destructors, multiple and virtual inheritance where present, indirect calls
through function pointers, and virtual calls resolved through the vtable store (slot to declared method).

**Gate:** every ABI blocker code with a nonzero count has fixtures; its count falls; no mechanism is
approximated without a code.

### Phase 11: Remaining semantics and source constructs

Close the IR refusals (343 catch blocks, 122 frames, 16 missing forms *(snapshot)*) and the source refusals:
memory locals, local arrays and structures, switch statements, try/catch and cleanup, strings and constants,
thread locals, atomics; `goto` only where upstream accepts it and no structured form matches. Every new form
keeps the existing execution-based validation; undefined behaviour never becomes a fixed value.

**Gate:** IR admission and source expressibility each reported against 62,247; every refusal has a code.

### Phase 12: Joint units, throughput and campaigns

* Joint verification of every unit after any change to it; `JOINT_UNIT_REGRESSION` names the interacting
  functions and the shared declaration, and the search continues on shared constraints rather than per function.
* Batched compilation where the context is provably equal, with the exact unit always compiled and compared
  last; content-addressed object, comparator and analysis caches keyed by D6's manifest.
* Campaigns of 100, 500, 1,000, 5,000 and 10,000 stratified functions, then the full denominator, through the
  existing queue and a **separate instance and database** (never the live server on 8789 or its database).
* Report per campaign: verified per hour, CPU and wall time per verified function, compiles and comparator calls
  per verified function, cache hit rate, p50/p95/p99 latency, peak memory, state distribution.
* Throughput target: the full 62,247 in at most 14 days on this machine once coverage justifies it. That is a
  benchmark target, not a claim, and it counts verified functions only.

**Gate:** sequential and parallel campaigns give the same per-function states and source digests; a campaign
killed mid-run resumes to the same result; mixed packets keep their solved functions.

### Phase 13: Convergence

The loop of §4 until `OPEN` and `RESUMABLE` are empty. Milestones at 10, 25, 50, 75, 90, 95, 99, 99.9 and
100% of the frozen denominator, each declared only from a fresh clean-room campaign, never from reachability or
cached verdicts. At each milestone also report the `NEEDS_DECISION` count with its evidence, so the user can
decide those cases while the rest proceeds.

---

## 7. Regression set

Every `VERIFIED` function gets a private record: identity, input manifest digest, engine and rule-store
versions, recipe, canonical source digest, comparator and Gate Keeper verdicts, rule trail, assumptions,
counters. The engine must **re-derive** these functions, never replay saved source. Rerun the affected subset
on every increment and the whole set clean-room at each milestone. A miss blocks the next increment.

---

## 8. Per-increment report (the roadmap row)

```text
Increment:        <name>, blocker addressed <code>, ranked #<n> with <count> functions
Changed:          <files>
Tests:            <suite: passed/failed/skipped, platform>
Development set:  VERIFIED <before> -> <after> of <N>; blocker <code> <before> -> <after>
Held-out set:     VERIFIED <before> -> <after> of <M>; blocker <code> <before> -> <after>
Denominator:      VERIFIED <v> of 62,247 (<pct>), bytes <b> of <B>; NEEDS_DECISION <d>; OPEN <o>; RESUMABLE <r>
Regressions:      <none | list and fix>
Overfitting:      rules added <k>, functions unlocked <u>, constant-scan clean <yes/no>
Next:             <blocker code>, <count>, why it is next
```

No row without numbers. Never report a number you did not measure in this session as current.

---

## 9. Operating rules specific to this program

All of spec §32 applies. In addition:

* The denominator, the definition of `VERIFIED` and the comparator are fixed. Changing any of them to raise a
  percentage is forbidden.
* The engine never reads the body of the function it reconstructs from anywhere, including a draft already in
  the unit (it was not read for `0xcd6bc0`; keep it so).
* Development runs use their own database, slots and port (the recon dev instance on 8795, `data/recon-dev.db`,
  or a new one); never the live server, never its database, never stop it.
* Game-derived data (listings, bytes, emitted source, per-function records, the knowledge store) stays in the
  private data directory. Public commits carry code, synthetic fixtures, counts, codes and digests only. Scan
  every commit for target RVAs, symbol names and paths before pushing.
* Ask the user only for: a `NEEDS_DECISION` case, a recipe or policy question the evidence does not settle,
  anything that publishes, a dependency with an unclear licence, a Gate Keeper rule change, or stopping the live
  server. Everything else, decide from evidence, record in `docs/recon/TECHNICAL_DECISIONS.md`, and continue.
* Commit and push at each increment that passes its tests (spec §31), with the §8 row in the roadmap.
* Batches end at *ready*. The user submits.

---

## 10. Start here

1. Re-read D1 to D10 in the current code; mark any already fixed.
2. Fix **D1, D3 and D8** first, in that order: without D1 no function with an external reference can match;
   without D3 no budget can be tested; without D8 a better generator may still be filtered to nothing.
3. Write the manifest, held-out split and taxonomy; re-run the 2,375 reach set and the 93 solve set; produce
   the first §8 row and the ceiling estimate.
4. Start Phase 8 with the top blocker that run reports (expected: callee declarations, then secondary classes,
   then typed members; let the numbers decide).

Build general software that reconstructs functions. Do not reconstruct functions. The final authority is
upstream's unchanged comparator on the exact unit, and after it the user.
