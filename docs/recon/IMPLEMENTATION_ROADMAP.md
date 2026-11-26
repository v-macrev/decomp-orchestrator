# Implementation roadmap and status

Specification: [DETERMINISTIC_WORKER_PROMPT.md](../DETERMINISTIC_WORKER_PROMPT.md), section 30. Status is
recorded as measured; nothing below is claimed done that a test does not show.

## Phase 1: repository integration — status 2026-11-25

| Deliverable | State |
|---|---|
| Audit of both repositories with file and line | **Done for the items listed as audited**; the rest is named in [REPOSITORY_AUDIT.md](REPOSITORY_AUDIT.md), "Not yet audited" |
| Architecture, integration contract, decision log | Done (these documents) |
| Environment validation (`recon doctor`) | Done: reports Python, machine, optional packages, upstream target, revision and modules, comparator import, image hash against the pin, MSVC directory, Wine, data directory. Run on this machine: image hash equals the pin; comparator imports; `iced_x86`, `z3`, `capstone` absent |
| Minimal executable project skeleton | Done: `engine/recon`, `apps/server/src/recon` |
| Initial automated tests | Done: 36 engine tests (`pytest`, WSL) and 23 server tests (`vitest`), including the real engine through WSL |
| Protocol round trip from the server on this host | **Done**: `real engine in WSL` tests in `apps/server/test/recon.test.ts` (solve, determinism, doctor) |
| Contract-equal local compare measured against `sr compare` | **Done.** `adapters/skyrim/comparator.py` compiles, binds and compares in process through upstream's own functions; `recon measure-compare` checks it against `sr compare` (measured below) |
| Locked environment with pinned hashes | Done in Phase 2: `requirements.lock` (runtime and checks), `requirements-dev.lock` (test runner), both hashed (D-002) |

**Local compare, measured 2026-11-25** in WSL on 5 accepted units (17 functions), opened as practice tasks in a private directory:

| What | Result |
|---|---|
| Reports of the engine's own build against `sr compare`'s | 17 of 17 equal but for `candidate.object_sha256`, which differs for every separate compile; code section digests are equal |
| Reports on the very object `sr compare` judged | **17 of 17 equal in every field** |
| Verdicts | 11 pass/pass, 6 fail/fail, none different |
| Negatives (a function against its neighbour's range) | 10 of 10 equal to the comparator's command line, all rejected |
| Cost, median | `sr compare` 7.1 s per unit (up to 38.6 s); in process 1.6 s compile + 0.24 s bind per unit + 0.63 s per function; start 0.6 s |

The 6 failures are equal in both and were not investigated (one compile with `--no-retry` and the unit's first recipe); they do not bear
on equality. Five units are a small sample. **The Phase 1 gate is met.** The first version of this page said the measurement had to
wait for Phase 5 and would mean reading game-derived output; both were wrong.

## Phase 2: binary analysis — status 2026-11-25

Measured on the pinned image (sha256 equals `builds/target.json`) over the **62,247 unmatched** offered
targets (17.3 MB); every figure is reproduced by the commands in `engine/recon/README.md`.

| Deliverable | State |
|---|---|
| Executable loading with hash check, read-only | Done (`adapters/skyrim/image.py`, through upstream's `PeImage`); refuses a differing hash (tested) |
| Address mapping | Done: RVA to section, file offset, file-backed read; unreadable ranges give upstream's `target-range-*` reasons |
| Inventory, including targets without a progress entry | Done. 64,010 offered, 62,247 unmatched; **all 62,247 have no `progress.json` entry** (by construction of the list). The 986 recorded-but-unmatched (`mapped`) functions are outside the list and are a second population |
| Function boundaries | Inventory range is the boundary; `.pdata` agrees everywhere: **55,265 exact, 6,982 leaf (no unwind data), 0 conflicting** |
| Instruction decoding | iced-x86 1.21.0 (upstream's pin). **62,247 of 62,247 ranges decode completely** (4,433,298 instructions, 208 distinct mnemonics, 18 s) |
| Agreement with upstream's decoder | **62,247 of 62,247 agree** on instruction boundaries, branch and RIP-relative targets (`tools/analysis/x64.py`); so are flow kinds since the correction below; capstone agrees on boundaries for **62,247 of 62,247** (first a sample of 12,450) |
| References | Direct calls, indirect calls and jumps, tail jumps, data references by section: counted per function |
| Unwind and exception metadata | Version, chain and handler decoded as contract v2 reads them; upstream's `unsupported-unwind` raised early. In the unmatched set: 23,231 plain, 8,244 chained, 23,790 with a handler (23,782 with a `FuncInfo` of magic `0x19930522`, 8 other), 6,982 none; **0 blocked** |
| Jump tables inside the range | Set apart from the code: 26 functions, 4,306 bytes, all starting with an in-range address table |
| Vtables and RTTI | From the image alone: 8,637 vtables (8,623 with a decorated class name, 1,247 secondary-base), 89,898 slots in 29,887 distinct targets, **29,805 of them known function starts, 82 not, and none of the 82 lies inside a known function** (corrected below) |
| Instruction and construct coverage report | `survey --out` writes demand per mnemonic and the per-function rows, privately; `coverage_if(supported)` computes, for a supported set, the functions fully covered and the single forms that block most (it orders Phase 3 lifting) |
| Unsupported inputs rejected with upstream's reason | Done and tested on synthetic images (`unsupported-unwind`, `unwind-entry-crosses-boundary`, `target-range-outside-image`) |

**Gate: met for what it states** (ranges loaded and decoded accurately and in agreement with upstream's decoder,
unsupported inputs refused with reasons, coverage report exists).

**Limits to keep in mind**

* Agreement of boundaries and targets between three decoders is not a proof of correct *semantics*; that is
  Phase 3, with execution-based differential tests.
* A table is recognised by the code's own forward reference into the range, with the checks of D-016; anything
  ambiguous blocks. Byte index tables that no instruction references directly would be decoded as code; none is known.
* The RTTI scan is checked for internal consistency (slots are code, locators validate themselves), not against
  an independent export; upstream's own RTTI helper needs a Ghidra export that is not present.
* Exception data is classified, not yet compared with a candidate's: handler identity is not named (no symbols).

## Corrections to Phases 1 and 2 — 2026-11-25

Found by re-reading the code and the audit against the specification before Phase 3. Each code change has a test.

| What was wrong | Where | Corrected to |
|---|---|---|
| "The Windows host has no Python" | audit, D-003 | It has 3.13; D-015 |
| The comparator was named as `compare.py` 0.6.0 | audit | `sr compare` decides with `compare_runtime.py` 0.6.1-runtime; the engine's adapter calls that one |
| 8,696 vtable slot targets "not known starts, consistent with thunks" | roadmap, `rtti` command | The check left out the 40,458 functions of `progress.json` that are not offered. 82 remain |
| 187 unexplained targets | audit | Explained from the generator's code |
| `recon audit` described as existing | audit | It does not exist |
| A decode error after a return was taken for data and counted as covered | `survey.py` | An error, never covered |
| A forward reference to code became a "table", or the range was silently read as code | `decode.py` | `ambiguous-data-reference`, blocked (D-016) |
| A branch into the middle of an instruction was not noticed | `survey.py` | blocked |
| `handler_data` depended on the order of `.pdata` entries | `survey.py` | order-free, `mixed` when both |
| The upstream cross-check ignored references only one decoder saw, flow kinds, and an early stop in functions with tables | `crosscheck.py` | all compared; still 62,247 of 62,247 |
| `read_cstr` raised upstream's exception type; `file_offset` returned an offset for bytes not in the file | `image.py` | `ValueError` |
| A function listed with two sizes, or two overlapping functions, was accepted | `inventory.py` | refused |
| Conditional branches that leave the range were not counted as tail jumps | `survey.py` | counted |
| Coverage was counted per mnemonic, which overstates it | `survey.py` | per instruction form since Phase 3 |
| "46 passed, 24 skipped" without the machine | Phase 2 report | one test short; superseded: 189 passed with the image and the worktree, 171 passed and 18 skipped without (Windows) |

## Phase 3: instruction lifting and program analysis — status 2026-11-25

| Deliverable | State |
|---|---|
| Lifting of the general-purpose integer subset | Done: `adapters/x64_msvc/lift.py` to the typed semantics of `core/sem.py`; every register alias, implicit operand and flag explicit, undefined flags as `undef`, traps and atomics as statements |
| Execution-based differential tests per form | Done: **1,146 forms pass, 380,335 vectors, 0 differences, 72 predicted traps repeated and confirmed in processes of their own**. 92 other forms of the same mnemonics are refused or cannot be encoded in 64-bit mode. The table (form, vectors, date, digest of the sources) is `lift_coverage.json`; running it twice gives the same file, and Windows and Linux give the same counts. A form not in it, or a table made by other sources, is refused (`form-not-validated`) |
| Are the vectors able to notice a mistake? | Mutation: of 8,665 deliberately wrong semantics (every third form), 7,625 (88.0%) are noticed, among them every dropped effect and inverted branch. Survivors were reviewed by kind and sampled by form: equivalent changes (an arithmetic for a logical shift whose top bits are cut off, `or` for `xor` of disjoint parts), or claims of *undefined*, which no execution refutes. They were **not** all reviewed one by one |
| Structured refusal | Done: `UNSUPPORTED_INSTRUCTION` with every missing form and its reason |
| Basic blocks, control-flow graph | Done (`core/analysis/cfg.py`): contradictions are errors, conditional and indirect tail calls, calls that cannot return, switch tables resolved from evidence only (`switch.py`), otherwise `unresolved` |
| Dominators, post-dominators, components, loops, reducibility | Done (`graph.py`), tested against the definitions on 300 random graphs |
| Data flow | Done: uses and definitions, reaching definitions, liveness under the calling convention, constants, value numbering along a path (`dataflow.py`, `frame.py`, `values.py`) |
| Stack and registers | Done (`frame.py`): height at every instruction, saved registers and their slots, home space, stack arguments, locals, frame addresses that leave, proof that preserved registers are restored; assumptions stated per function |
| Agreement with unwind codes | Done: unwind codes decoded, compared with the recovered frame |
| Coverage and demand report | Done: `recon coverage`; the demand by form ("how many functions would lift completely if X were added") is written privately |
| Alias analysis, side-effect summaries, SSA, the versioned IR | Phase 4, below |

Measured on the pinned image over the **62,247** unmatched offered targets (469 s, one process):

| What | Count |
|---|---|
| Lift completely | **43,247 of 62,247 (69.5%)** |
| Refused, an instruction form is missing | 19,000; 186 distinct forms, 5,066 of them lack exactly one. Vector and floating-point code is outside this phase's subset |
| Control-flow graph built | 43,246; the one other falls off its end and is refused |
| With loops / irreducible / unreachable blocks | 11,540 / 35 / 391 |
| Switches resolved / functions left with an unresolved jump | 19 / 6 |
| Frame recovered | **43,186 of 43,246**; 60 refused (`stack-pointer-unknown`: a stack probe or an aligned stack pointer) |
| Frame with a stated assumption | 10,831 |
| Facts compared with unwind data | **212,834 in 43,185 functions, 0 conflicts** |
| If the 20 / 40 / 100 forms the demand report puts first were added | 10,520 / 15,605 / 17,590 more functions would lift |

Analyses on synthetic code: hand-written fixtures, and 250 generated functions whose semantics are run from 4 random states
each while every claim (edge taken, stack height, constant, reaching definition, restored register) is checked.
34 deliberate defects in the analyses are each caught by a test. Results have a digest that does not change between runs or with
the hash seed.

**Gate: met** for the integer subset: synthetic fixtures give validated, reproducible results, and every supported form has passed
execution-based tests on this machine's processor.

**Limits**

* One processor was tested (natively and under WSL). What an architecture calls undefined is never compared, so its breadth rests on the manual.
* "Lifts completely" says nothing about matching; no source is produced yet.
* The frame assumes indexed and escaped stores stay inside their own object, and says so per function.
* ~~Vector registers are not modelled~~ (modelled since Phase 4).
* Functions with exception handlers are analysed along ordinary edges only; Phase 4 adds the cleanup states and refuses catch blocks.

## Phase 4: semantic IR — status 2026-11-25

| Deliverable | State |
|---|---|
| Floating-point and vector lifting | Done for the forms the demand report asked for (`lift_sse.py`, own arithmetic on integers in `core/softfloat.py`). Together with the integer subset: **1,607 forms pass, 528,590 vectors, 0 differences, 580 predicted traps confirmed** (`lift_coverage.json`, 373 s, Windows). On Linux the same 1,607 forms pass, 580 traps confirmed; 528,574 vectors, the difference being the four thread-block loads, whose address differs per process). Refused: 143 operand kinds, 14 operand sizes, 12 other encodings, 4 prefixes, 2 the encoder cannot make, 2 outside the subset |
| Are the vector vectors able to notice a mistake? | 4,304 of 5,531 deliberately wrong semantics of XMM forms noticed (77.8%). Survivors were sampled, mostly equivalent; **not** all reviewed |
| Semantic IR, SSA, memory model | Done: `core/ir/{model,memory,build}.py`; versioned, canonical bytes, digest. Unknown aliasing is kept unknown |
| Cleanup-only C++ exceptions | Done (`x64_msvc/eh.py`): states at calls, what a cleanup may read. Catch blocks and other handlers are refused by name |
| IR validator and the one gate | Done: `validate.py`; only `admit` then `require` lead on, and a changed function no longer passes |
| Transformations | simplify (2,970 rule instances under 163 names, **each proved by SMT**), merge, forward, promote, dead-stores, dead, polarity, straighten. The passes that are not rules are checked by whole-function SMT on loop-free code and by running generated programs; each result is validated |
| Compiler-undo | Division and remainder by constants (theorems, checked for every input at 4 and 6 bits in the tests, once at 8), multiplication, masks, ranges, minimum, maximum, absolute value, conditional values, copies, fills, rotated loops. Kept **beside** the function as proved hypotheses, never put in its place unasked |
| Aliasing and side effects | Done: `effects.py` |

**Measured** on the pinned image, over the **62,247** unmatched targets (3,296 s, 3 processes):

| What | Count |
|---|---|
| Lift completely | **61,875 of 62,247 (99.4%)**; 43,247 after Phase 3. 372 lack a form (16 distinct forms) |
| Frame recovered | 61,751; 122 refused (`stack-pointer-unknown`); 20,069 with a stated assumption |
| Unwind facts compared | 367,244 in 61,750 functions; **1 function conflicts** (no unwind data, but a frame) and is refused |
| **IR admitted in normal form** | **61,394 of 62,247 (98.6%)** |
| Refused | 343 catch blocks, 122 no frame, 7 other handlers, 6 unresolved jumps, 1 unwind conflict; 2 have no control-flow graph |
| Rejected by the validator, or not settling | **0** |
| With exception states / an open frame / a stated assumption | 21,558 / 21,720 / 23,605 |
| Operations | 8,792,972 before, 4,493,128 in normal form |
| Functions with at least one proved hypothesis | 38,648 |

"Admitted" means valid and covered by the checks above. It says nothing about matching: no source is produced yet. An earlier full run rejected 15
functions, all for one fault (memory was re-cut once, not until no address became clearer); it was corrected and the run repeated.

**Real functions**: every 30th target run from 4 random states as instructions, raw IR and normal IR: **normal IR agrees in 8,396 of 8,396 runs, raw IR in
8,394**, in 2,099 functions (6,070 runs returned, 834 left by a tail call, 211 trapped, 1,281 ran out of steps and are compared up to there; 35 more of the
sample are not represented). The other 2 runs are one function from two states: a store through a pointer that walks the open frame reached its
saved-register slot and return address. The function states the assumption that this does not happen (`indexed-and-escaped-stores-miss-saved-registers`);
the raw run stops there because the claim is checked while it runs. A first run showed 9 broken claims and 1 difference: in the others the
harness's made-up memory held, by chance, the round address it had given the stack; it now uses one that cannot occur that way.

**Tests**: 390 engine tests pass on Windows with the image and the worktree; 371 pass and 19 are skipped on Linux without them. Server: 360 of 360. Generated programs run as instructions, raw IR and normal IR agree. 58 deliberate defects
were put into the IR code one at a time: 42 were caught at once. Of the 16 others, 13 now have a test and were confirmed caught by it, 2 changed
nothing (one of them led to the removal of a redundant condition), 1 led to a stronger proof (a division's numbers must be those of the value's own
operations).

**Gate: met** for what is represented. Supported instruction semantics are preserved and tested (execution per form on two systems; instructions, raw and
normal IR compared on generated and real functions). Invalid IR cannot enter reconstruction (`admit`/`require`; unsupported input is refused
by name). Each rewrite rule passes its SMT check; the other passes do on small loop-free functions, and are otherwise covered by execution and the validator.

**Limits**

* Not represented: catch blocks, handlers other than frame handler version 3, asynchronous exceptions. Cleanup code itself is not analysed.
* Not undone: switch lowering, tail merging, inlining, vectorised and unrolled loops.
* Floating point assumes the default control word, and says so per function. `rcp` and `rsqrt` approximations are opaque values.
* Whole-function SMT is for loop-free code. Loops rest on the proved rules, the validator and execution.
* Which memory is volatile cannot be known from the code. One processor was tested.

## Phase 5: first end-to-end reconstruction — status 2026-11-25

**The vertical slice works on synthetic functions.** An image goes in, verified C++ comes out, and no source was written by hand.
No function of the real target has been reconstructed or tried in this phase.

| Deliverable | State |
|---|---|
| Type inference | Done, basic (`core/inference/`): parameters and results from the function's own code and its callees' (with a fixpoint for functions that call themselves or each other), classes from accesses, signs, pointers. What nothing decides is an *open* point, and no default rests on signed overflow |
| Candidate generation | Done (`core/structuring/`, `core/synthesis/`): a canonical form, then single changes, then combinations (at most 160 tried, 48 kept). Each is **run against the normal form** in 96 made-up worlds before it counts; equal trees and equal code count once |
| C++ emission | Done (`core/emitter/`): typed members, declared callees, neutral names. No casts of pointers, no comments, no `goto` in anything matched so far |
| Compiler integration | Done (`x64_msvc/{cl,batch,coff}.py`): a namespace per candidate in one process; a candidate that does not compile is found by its error lines (or by halving) and loses nothing else. The compiler must be the one the recipe pins, by digest |
| Independent verification | Done (`skyrim/verify.py`): upstream's `compare_runtime` on the exact unit. Its reason codes are read from its source (**R-6, done**); an unknown one is an engine error |
| `recon reconstruct` | Done: a synthetic pack in, sources and `result.json` out. It refuses the pinned real image |

**Measured** (compiler 19.16.27054, the recipe's own flags):

| What | Result |
|---|---|
| Development functions (`targets.cpp`): the rules were written looking at these | **18 of 18** `BYTE_MATCHED`; 11 in the canonical form. The 4 functions they call: 3 of 4 |
| Held-out functions (`heldout.cpp`): written before the engine saw them, **first run** | **9 of 16** matched; 1 compiled but differs; 1 did not compile; 4 refused; **1 crashed the engine** |
| The same after correcting the two defects that run showed (endless type of a pointer to itself; a function's own parameters were not those it calls itself with) | 11 of 16. This second number is no longer a held-out one |
| The gate's functions: `Total` (loop, branch, members, a call), `Withdraw` (short circuit, members, a call) | both verified, by the engine and again by the harness |
| Cost | 1.5 to 6 s per function; 46 s for the 22 |

What the harness does, for each of the 29 matches it checks: it takes only the source text, compiles it from scratch, makes its own symbol map (RVAs from the
names, constants from the linker's map) and asks upstream's comparator. The engine runs as a process whose audit hook forbids the fixtures, the build
directory and sockets; a test shows that the hook works.

**It can fail**: 9 wrong sources, a call to another function, and 3 wrong extents of a function do not pass. 14 deliberate defects in the Phase 5 code: 12
caught at once, the other 2 have a test now and are caught. The same input gives the same bytes under different hash seeds. **Native and Wine**: on the
synthetic corpus (fixtures and every source written) the code, relocations and unwind data of 76 functions are identical, and so are all results.

**Random functions**: 1,100 generated programs (most read registers nobody set, and are refused): 173 gave 371 candidates, 0 crashes, 0
disagreements; 1 rejected because none of its runs ended. Tests found three text defects, now corrected and tested: negative 64-bit literals written
as unsigned, the largest float, and a shift whose left literal had the wrong type.

**Tests**: 449 engine tests pass on Windows and on Linux (through Wine), none skipped. `lift_coverage.json` is untouched. The server was not changed.

**Gate: met.** Two nontrivial synthetic functions are reconstructed automatically and verified independently.

**Limits**

* Held-out failures name what is missing: an address carried through a loop (`ADDRESS_VALUE`, `CONVERSION`), variable division (`OPERATION_CAT`), vectorised loops
  (`VECTOR_VALUE`), and values kept after a store (no match). Also not there: locals in memory, class results, vector parameters, indirect and virtual calls,
  switches, catch blocks, strings.
* The execution check is evidence, not proof: 96 worlds, memory that is mostly made up. `SEMANTICALLY_VALID` means no more than that.
* A signature comes from the code alone: an unused trailing parameter cannot be seen. Headers, RTTI and upstream's declarations are not used yet.
* The corpus is 34 small functions by one author, in the same C++ dialect.
* A constant the object holds itself is bound where the target's own field leads, when the bytes there are equal. The harness checks that with the linker's map.

## Phase 6: the deterministic tier in the orchestrator — status 2026-11-25

**Done**

| Part | State |
|---|---|
| Flows | `FlowNodeData.kind` (`llm` by default, so saved flows load) and a `recon` block; presets `deterministic-only` and `deterministic-first`; worker kind, engine settings and a template in the flow builder |
| Scheduling | `engineAttempt` after prepare and late classification; the shared tail `answerTail` serves the model path, the free attempt and the engine (R-2); D-009 and D-036 |
| Process | the request in a private file, `serve --request FILE` (R-1); the engine's own Python and module path from `config/orchestrator.json` `recon` (R-7) |
| Persistence | migration 8, `recon_results` (codes and counts); a copy of the live database migrates 7 to 8 and its flow, 2 runs, 266 tasks and 1,702 attempts load |
| Engine `solve` | a function `Class::Method` of an existing unit: member form (D-034), declarations read by the compiler (D-035), compiled next to the unit's header, verified by upstream's comparator; edits only for a wholly solved packet |
| Prepare | `sr start` that refuses because several existing units fit is run again with the unit discovery named (`--unit`), only on that refusal |

**Measured on the real target** (counts, codes, and RVAs and names from upstream's public data only):

| What | Result |
|---|---|
| Offered by `sr next` (offline) | 12,720 startable functions; 2,375 of at most 128 bytes in an existing unit |
| Reach over those (nothing compiled) | 140 candidates; refused: `CALLEE_SIGNATURE_UNKNOWN` 1,657, `INDIRECT_CALL` 340, `LOCAL_IN_MEMORY` 25, others under 20 each |
| `solve` on the 93 without a callee or global | **2 `BYTE_MATCHED`**; unsolved: `MEMBER_NOT_DECLARED` 39, `CLASS_NOT_DECLARED` 34, `NO_MATCH` 18 |
| Cost | 4 to 9 s per function |

**Through the server** (a separate instance with its own database, slots and port; the checkout and its `.local` shared; no
accounts, zero provider calls, no exposure consent):

* `0xcd6bc0 BSNullImplGameSound::Functioncd6bc0`: engine `solved`, Gate Keeper **pass** (unchanged), staged on a local
  branch and re-verified there, and the batch's `sr submit --dry-run` **clean**. Its local claim is unpublished. Not submitted:
  the user submits. The base unit held a draft body of it that did not match; the engine did not read it.
* `0x6a2000 Character::Function6a2000`: first refused by `sr start` (several units fit; fixed above). Then engine `solved`
  and the Gate Keeper's compare passed every byte, but preflight blocked the packet because the unit's header was already over
  upstream's file-size cap. Not an engine disagreement; the claim was released.

**Tests**: server 371 pass, typecheck clean, among them a deterministic-only run that asserts no account, no provider call and
no consent, and what the tier sends. Engine: 470 pass on Linux, none skipped; 469 pass on Windows, where the compiler test of
declarations skips (a Windows compiler cannot read the standard headers over a WSL path).

**Gate: met.** One eligible, previously unreconstructed target function was reconstructed automatically, reached `passed`
through the unchanged Gate Keeper, and its batch dry-runs clean. Then stop: the user submits.

**Limits**

* Most offered functions call others (`CALLEE_SIGNATURE_UNKNOWN`) or read members of a second class (`CLASS_NOT_DECLARED`):
  declarations of callees and of other classes are the next capability, by count.
* Members inside the skeleton's `unknownXX` byte arrays are not carved into typed members (`MEMBER_NOT_DECLARED`).
* New units: the engine reads the skeleton the tooling wrote, but the trial covered existing units only.
* D-006, the provenance wording of engine output, is still the user's decision; the default is in `skyrim/solve.py`.

## Items found by the audit that block or shape later phases

| Id | Item | Needed by |
|---|---|---|
| R-1 | ~~Request via a file, not stdin, so the WSL cancel handshake runs~~ done in Phase 6 (a private file under the engine's data directory); a streaming runner for live progress is still open | - |
| R-2 | ~~Factor the shared tail of `processTask` into one function~~ done, `answerTail` | - |
| R-3 | ~~Comparator-accepted build record from a scratch build, and the cost of the local compare~~ done, measured above | - |
| R-4 | Provenance wording for engine output (D-006), a decision for the user; the default is in use | open |
| R-5 | ~~Hashed, locked venv~~ done, `z3` included (D-021) | - |
| R-7 | ~~The server runs the engine with the venv's Python~~ done: `recon.python` and `recon.pythonPath` | - |
| R-6 | ~~Comparator reason-code list read from source into a mapping test~~ done in Phase 5 | - |

## Next increments, in order

1. ~~Phase 2, binary analysis~~ (done above).
2. ~~Phase 3, integer lifting and analysis~~ (done above). ~~Phase 4, the IR~~ (done above).
3. ~~Phase 5, the vertical slice on synthetic functions~~ (done above).
4. ~~Phase 6, the deterministic tier in the orchestrator~~ (done above; the batch waits for the user to submit).
5. By the failure counts: declarations of callees and of other classes, then typed members carved from byte arrays.

The next capability is always chosen by the coverage and failure reports, not by interest.
