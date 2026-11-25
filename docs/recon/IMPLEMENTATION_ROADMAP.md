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

## Items found by the audit that block or shape later phases

| Id | Item | Needed by |
|---|---|---|
| R-1 | Request via a file in the task directory (not stdin) so the WSL cancel handshake runs; optional streaming runner for live progress | Phase 6 |
| R-2 | Factor the shared tail of `processTask` (`engine.ts:3031-3150`) into one function | Phase 6 |
| R-3 | Comparator-accepted build record from a scratch build, and the cost of the local compare versus `sr compare` | Start of Phase 5 |
| R-4 | Provenance wording for engine output (D-006), a decision for the user | Phase 6 |
| R-5 | Hashed, locked venv for `iced_x86` and `z3` (D-002) | Phase 2 and 4 |
| R-6 | Comparator reason-code list read from source into a mapping test | Phase 5 |

## Next increments, in order

1. **Phase 2, binary analysis.** Image loading through upstream's `pecoff.PeImage` with the hash check on
   every load; address mapping; inventory integration including targets without a `progress.json` entry;
   decoding through upstream's `x64` module compared with an independent decoder; the instruction and
   construct coverage report over the unmatched inventory (counts only, in the private directory).
2. **Phase 3 and 4**, lifting, IR, validator, first transformations, each with differential tests.
3. **Phase 5**, the vertical slice on a synthetic function (branches, member access, a call), which also
   delivers R-3.
4. **Phase 6**, the deterministic tier in the orchestrator, ending at one unreconstructed target function
   that reaches packet `passed` through the unchanged Gate Keeper. Then stop: the user submits.

The next capability is always chosen by the coverage and failure reports, not by interest.
