# Implementation roadmap and status

Specification: [DETERMINISTIC_WORKER_PROMPT.md](../DETERMINISTIC_WORKER_PROMPT.md), section 30. Status is
recorded as measured; nothing below is claimed done that a test does not show.

## Phase 1: repository integration — status 2026-11-25

| Deliverable | State |
|---|---|
| Audit of both repositories with file and line | **Done for the items listed as audited**; the rest is named in [REPOSITORY_AUDIT.md](REPOSITORY_AUDIT.md), "Not yet audited" |
| Architecture, integration contract, decision log | Done (these documents) |
| Environment validation (`recon doctor`) | Done: reports Python, machine, optional packages, upstream target, revision and modules, comparator import, image hash against the pin, MSVC directory, Wine, data directory. Run on this machine: image hash equals the pin; comparator imports; `iced_x86`, `z3`, `capstone` absent |
| Minimal executable project skeleton | Done: `engine/recon` (no dependencies), `apps/server/src/recon` |
| Initial automated tests | Done: 36 engine tests (`pytest`, WSL) and 23 server tests (`vitest`), including the real engine through WSL |
| Protocol round trip from the server on this host | **Done**: `real engine in WSL` tests in `apps/server/test/recon.test.ts` (solve, determinism, doctor) |
| Contract-equal local compare measured against `sr compare` | **NOT DONE.** Needs a scratch build whose build record the comparator accepts; first measurement belongs to the start of Phase 5, on synthetic code only |
| Locked environment with pinned hashes | **NOT DONE**, nothing to lock yet (D-002) |

**The Phase 1 gate is therefore not fully met.** What is missing is the local-compare measurement. It needs
the compile loop, which the vertical slice (Phase 5) builds; doing it earlier on real packs would mean
reading game-derived output, which the owner's rules rule out for the implementing agent (D-011).

## Phase 2: binary analysis — status 2026-11-25

Measured on the pinned image (sha256 equals `builds/target.json`) over the **62,247 unmatched** offered
targets (17.3 MB); every figure is reproduced by the commands in `engine/recon/README.md`.

| Deliverable | State |
|---|---|
| Executable loading with hash check, read-only | Done (`adapters/skyrim/image.py`, through upstream's `PeImage`); refuses a differing hash (tested) |
| Address mapping | Done: RVA to section, file offset, file-backed read; unreadable ranges give upstream's `target-range-*` reasons |
| Inventory, including targets without a progress entry | Done. 64,010 offered, 62,247 unmatched; **all 62,247 have no `progress.json` entry** (the 986 `mapped` entries are not among the offered targets) |
| Function boundaries | Inventory range is the boundary; `.pdata` agrees everywhere: **55,265 exact, 6,982 leaf (no unwind data), 0 conflicting** |
| Instruction decoding | iced-x86 1.21.0 (upstream's pin). **62,247 of 62,247 ranges decode completely** (4,433,298 instructions, 208 distinct mnemonics, 18 s) |
| Agreement with upstream's decoder | **62,247 of 62,247 agree** on instruction boundaries, branch and RIP-relative targets (`tools/analysis/x64.py`); capstone agrees on boundaries for a sample of 12,450 |
| References | Direct calls, indirect calls and jumps, tail jumps, data references by section: counted per function |
| Unwind and exception metadata | Version, chain and handler decoded as contract v2 reads them; upstream's `unsupported-unwind` raised early. In the unmatched set: 23,231 plain, 8,244 chained, 23,790 with a handler (23,782 with a `FuncInfo` of magic `0x19930522`, 8 other), 6,982 none; **0 blocked** |
| Jump tables inside the range | Set apart from the code: 26 functions, 4,306 bytes, all starting with an in-range address table |
| Vtables and RTTI | From the image alone: 8,637 vtables (8,623 with a decorated class name, 1,247 secondary-base), 89,898 slots in 29,887 distinct targets; 21,191 of those are inventory or `.pdata` function starts, 8,696 are not (7,808 of them are stubs of at most 16 bytes, consistent with the offered list leaving out thunks; **not verified further**) |
| Instruction and construct coverage report | `survey --out` writes demand per mnemonic and the per-function rows, privately; `coverage_if(supported)` computes, for a supported set, the functions fully covered and the single forms that block most (it orders Phase 3 lifting) |
| Unsupported inputs rejected with upstream's reason | Done and tested on synthetic images (`unsupported-unwind`, `unwind-entry-crosses-boundary`, `target-range-outside-image`) |

**Gate: met for what it states** (ranges loaded and decoded accurately and in agreement with upstream's decoder,
unsupported inputs refused with reasons, coverage report exists).

**Limits to keep in mind**

* Agreement of boundaries and targets between three decoders is not a proof of correct *semantics*; that is
  Phase 3, with execution-based differential tests.
* A table is recognised by the code's own forward reference into the range. A forward reference to ordinary
  code would be mistaken for one (documented by a test). In the unmatched set all 26 trailing regions start
  with an in-range address table, so none is `other-data`. Byte index tables that no instruction references
  directly would be decoded as code; none is known.
* The RTTI scan is checked for internal consistency (slots are code, locators validate themselves), not against
  an independent export; upstream's own RTTI helper needs a Ghidra export that is not present.
* Exception data is classified, not yet compared with a candidate's: handler identity is not named (no symbols).

## Items found by the audit that block or shape later phases

| Id | Item | Needed by |
|---|---|---|
| R-1 | Request via a file in the task directory (not stdin) so the WSL cancel handshake runs; optional streaming runner for live progress | Phase 6 |
| R-2 | Factor the shared tail of `processTask` (`engine.ts:3031-3150`) into one function | Phase 6 |
| R-3 | Comparator-accepted build record from a scratch build, and the cost of the local compare versus `sr compare` | Start of Phase 5 |
| R-4 | Provenance wording for engine output (D-006), a decision for the user | Phase 6 |
| R-5 | ~~Hashed, locked venv~~ done for `iced_x86` and `capstone`; `z3` when Phase 4 needs it (D-002) | Phase 4 |
| R-7 | The server runs the engine with the **venv's** Python for any command that decodes (`process.ts` defaults to `python3`); a config value for it | Phase 6 |
| R-6 | Comparator reason-code list read from source into a mapping test | Phase 5 |

## Next increments, in order

1. ~~Phase 2, binary analysis~~ (done above).
2. **Phase 3 and 4**, lifting (general-purpose integer subset first, ordered by the demand the survey
   records), IR, validator, first transformations, each with differential tests against execution.
3. **Phase 5**, the vertical slice on a synthetic function (branches, member access, a call), which also
   delivers R-3.
4. **Phase 6**, the deterministic tier in the orchestrator, ending at one unreconstructed target function
   that reaches packet `passed` through the unchanged Gate Keeper. Then stop: the user submits.

The next capability is always chosen by the coverage and failure reports, not by interest.
