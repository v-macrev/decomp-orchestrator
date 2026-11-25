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
| Alias analysis, side-effect summaries, SSA, the versioned IR | **Not done**: Phase 4 |

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
* Vector registers are not modelled; a function that uses one is refused, so no vector register's preservation is claimed.
* Functions with exception handlers are analysed along ordinary edges only; the edges into handlers are not in the graph.

## Items found by the audit that block or shape later phases

| Id | Item | Needed by |
|---|---|---|
| R-1 | Request via a file in the task directory (not stdin) so the WSL cancel handshake runs; optional streaming runner for live progress | Phase 6 |
| R-2 | Factor the shared tail of `processTask` (`engine.ts:3031-3150`) into one function | Phase 6 |
| R-3 | ~~Comparator-accepted build record from a scratch build, and the cost of the local compare~~ done, measured above | - |
| R-4 | Provenance wording for engine output (D-006), a decision for the user | Phase 6 |
| R-5 | ~~Hashed, locked venv~~ done for `iced_x86` and `capstone`; `z3` when Phase 4 needs it (D-002) | Phase 4 |
| R-7 | The server runs the engine with the **venv's** Python for any command that decodes (`process.ts` defaults to `python3`); a config value for it | Phase 6 |
| R-6 | Comparator reason-code list read from source into a mapping test | Phase 5 |

## Next increments, in order

1. ~~Phase 2, binary analysis~~ (done above).
2. ~~Phase 3, integer lifting and analysis~~ (done above). Then **Phase 4**: the versioned IR and its validator, first
   transformations, and scalar floating point and vector moves in the order of the demand report, each with differential tests.
3. **Phase 5**, the vertical slice on a synthetic function (branches, member access, a call), which
   builds on the measured local compare.
4. **Phase 6**, the deterministic tier in the orchestrator, ending at one unreconstructed target function
   that reaches packet `passed` through the unchanged Gate Keeper. Then stop: the user submits.

The next capability is always chosen by the coverage and failure reports, not by interest.
