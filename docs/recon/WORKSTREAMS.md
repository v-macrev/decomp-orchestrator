<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Parallel workstreams of the deterministic engine

From 2026-11-27, engine development runs as four workstreams, each in its own Git worktree, on its own branch, with its
own private data directory. This document is the charter: who owns which modules, the interfaces between streams, how
compute is shared, and when work is measured. `docs/DETERMINISTIC_MATCHING_CONVERGENCE.md` still holds in full (the
objective, the frozen denominator, the held-out set, the loop of §4, the regression set of §7, the rules of §9). Nothing
here relaxes it.

The goal is more engineering iterations per day and more independently verified byte matches. Volume of implementation
is not the goal.

## 1. The streams

| Stream | Scope | Branch (app worktree) | Private data directory (WSL) |
|---|---|---|---|
| **P7**: measurement | Measurement, blocker classification, the regression corpus, authoritative campaigns, integration | `main` (the main checkout) | `.local/orchestrator/recon/phase7/` |
| **P8**: knowledge | Whole-program knowledge, signatures, declarations, canonical class and member reconstruction | `…ws-p8-knowledge…` | `.local/orchestrator/recon/ws/p8/` |
| **P9**: synthesis | Mismatch-directed deterministic synthesis, the compiler knowledge base, compiler-feedback search | `…ws-p9-synthesis…` | `.local/orchestrator/recon/ws/p9/` |
| **P12**: throughput | Performance, incremental computation, caching, compilation throughput, resource scheduling | `…ws-p12-throughput…` | `.local/orchestrator/recon/ws/p12/` |

Data directories are under the upstream checkout (`/home/victo/skyrim_decomp`) and stay private. Each stream records
its actual branch name in its own file under `docs/recon/workstreams/`.

Phases 10 (ABI breadth) and 11 (remaining source constructs) have no stream yet. Their blockers (ABI 154, Source 94,
Machine 38 primary in the D-060 development set) stay ranked in P7's reports. One of them opens as a fifth stream when
its count overtakes the smallest active stream's or when a stream closes.

## 2. Priorities, by measured blocker counts

Source: the D-060 campaign (`phase7-summary-d060.json`), development set 2,141 functions, BYTE_MATCHED 89 (4,285 bytes),
held-out 108, BYTE_MATCHED 9 (425 bytes). Primary blocker counts are the expected impact: each removal moves at most
that many functions to the next gate, and experience so far (e1e2ad1, c86f548) is that a large share of those then stop at
`MISMATCH`, which is P9's work.

| Rank | Blocker (primary, development) | Count | Stream |
|---|---|---|---|
| 1 | `CALLEE_SIGNATURE_UNKNOWN` | 706 | P8 |
| 2 | `INDIRECT_CALL` | 352 | P8 (vtable slot to declared method); calls through function pointers stay Phase 10 |
| 3 | `MEMBER_NOT_DECLARED` | 245 | P8 |
| 4 | `CLASS_NOT_DECLARED` | 212 | P8 |
| 5 | `CALLEE_NOT_DECLARED` | 134 | P8 |
| 6 | `READS_A_LOCATION_NOBODY_SET` | 100 | P8 (call-site evidence) |
| 7 | `MISMATCH` + kinds | 51 | P9; grows with every P8 gain |
| 8 | `CONSTRUCT_UNSUPPORTED` | 62 | Phase 11 (queued) |
| 9 | `LAYOUT_CONTRADICTION` | 30 | P7, in flight (D-062, D-063) |
| 10 | `UNIT_HEADER_DOES_NOT_COMPILE` | 22 | P7 classifies, then routes |
| - | `STACK_ARGUMENT` 23, `PARAMETER_IN_TWO_LOCATIONS` 13, `VECTOR_ARGUMENT` 11 | 47 | Phase 10 (queued) |
| - | `TAIL_RESULT_DIFFERS` 7, `DOES_NOT_COMPILE` 5, `SEMANTIC_DISAGREEMENT` 2 | 14 | P9 |

Knowledge is 1,686 of the 2,052 open development functions (82%), so P8 carries the main lever and gets the first
claim on authoritative campaign slots. P9's direct count is small today, but it decides how many of P8's unlocks become
matches. P12 is a multiplier on everyone: one authoritative cycle costs about 2.5 hours today (prewarm 57 to 119 min,
campaign 94 min with 4 workers), which caps the program at a few measured cycles a day.

Inside a stream, work in order of the measured counts, refreshed at every authoritative checkpoint. P7 republishes the
ranking table above (development and held-out separately) with each checkpoint.

### First targets per stream

* **P8:** signatures from call-site evidence plus callee evidence over the SCC worklist (`CALLEE_SIGNATURE_UNKNOWN`,
  `READS_A_LOCATION_NOBODY_SET`); callees the project names but the unit does not declare (`CALLEE_NOT_DECLARED`);
  secondary classes from upstream declarations (`CLASS_NOT_DECLARED`); typed members carved from `unknownXX` arrays
  under the all-users-agree and compiler-confirmed `sizeof`/`offsetof` rule, with the header size-cap check
  (`MEMBER_NOT_DECLARED`); virtual calls resolved through the vtable store (`INDIRECT_CALL`). Gate: Phase 8 of the plan.
* **P9:** a classifier from compiled-but-different objects to `MISMATCH(kind)` (register assignment, instruction
  selection, block order, branch polarity, stack layout, extension width or signedness, constant materialisation, call
  or relocation, unwind, size only); the versioned compiler knowledge base learned from synthetic experiments only; the
  kind-to-rule-family map; the deterministic priority queue with frontier continuation. Gate: Phase 9 of the plan.
* **P12:** (1) the compute lanes of §5, enforced by code; (2) incremental campaigns: a function re-runs only when its
  dependency digest changed, proven equal to a full campaign; (3) content-addressed compile and comparator caches and
  batched compilation; (4) less memory per worker so more workers fit; (5) the store decode and reload cost (D-061 is
  P7's first step). Gate: Phase 12 of the plan, plus the equivalence rule of §6.

## 3. Module ownership

The owner is the only stream that changes a module's behaviour. Another stream that needs a change there writes it as a
small separate commit on its own branch, says so in its stream file, and the owner reviews it before merge. Tests follow
the module they test. New modules belong to the stream that creates them.

| Area | Owner | Modules (under `engine/recon/recon/`) |
|---|---|---|
| Campaigns, measurement, taxonomy | P7 | `adapters/skyrim/{campaign,ceiling,coverage,measure,manifest,survey,reach,verify,comparator,filter_audit,crosscheck,inventory,upstream,environment}.py`, `core/taxonomy.py`, `cli/*` |
| Knowledge and inference | P8 | `core/knowledge.py` (facts and semantics), `core/inference/*`, `adapters/x64_msvc/{declarations,headers,imports,rtti,symbols,program,leaf,abi}.py`, `adapters/skyrim/{prewarm,pack,packfacts,normal}.py` |
| Synthesis and emission | P9 | `core/synthesis/*`, `core/emitter/*`, `core/structuring/*`, `core/canonical.py`, `core/evaluate.py`, `adapters/skyrim/solve.py` (search and form side), the compiler knowledge base (new) |
| Throughput | P12 | `core/workers.py`, `core/workload.py`, `adapters/skyrim/profile.py`, `adapters/x64_msvc/{cl,batch,coff}.py` (compile execution), caches (new), store back ends behind `knowledge.Store` |
| Frozen | P7 approves | `adapters/x64_msvc/{lift,lift_sse,decode,hwexec,validate,unwind,eh,switch}.py`, `core/{sem,softfloat,model}.py`, `core/ir/*`, `core/analysis/*`, `protocol/*`, `core/budget.py`. A change here needs `validate-lift --write` where the README says so, and a decision record |

Shared, additive only: `tests/synth.py`, `tests/conftest.py`, `tests/fixtures/` (original synthetic fixtures, prefixed
with the stream: `p8_*.cpp`), the parser table in `cli/main.py` (a new subcommand is one added block; its code lives
in the owner's module, not in `cli/commands.py`).

### Decisions and roadmap rows

* P7 continues `D-0NN` in `docs/recon/TECHNICAL_DECISIONS.md`.
* P8, P9 and P12 number their decisions `D8-NNN`, `D9-NNN`, `D12-NNN` in `docs/recon/workstreams/P8.md` (and so on).
  That file also holds the stream's branch, status, and §8 rows from targeted runs, labelled as targeted.
* Only P7 writes denominator numbers into `docs/recon/IMPLEMENTATION_ROADMAP.md`, from authoritative campaigns.

### Handover at C0

P7's increment D-061 to D-066 is uncommitted in the main checkout while its prewarm and equality checks run. It touches
`core/inference/{types,whole}.py`, `core/emitter/{cpp,member}.py`, `adapters/skyrim/campaign.py`, `cli/*`, and adds
`core/workload.py` and `adapters/skyrim/profile.py`. **C0** is the commit that lands it on `main`. Until C0, P8, P9 and
P12 do not edit those files and work on new modules, synthetic fixtures and design. At C0 they rebase, and ownership of
those files passes as listed above. Nobody touches the main checkout's working tree or the `phase7/` store, and nobody
stops a P7 run.

## 4. Interface contracts

These change only additively. A breaking change needs a new schema version, a decision record in the owner's file, and
updated consumers in the same merge.

| # | Contract | Owner | Consumers | Where | Invariant |
|---|---|---|---|---|---|
| C1 | Campaign record and summary | P7 | all | `campaign.Record`, `final.jsonl`, `summary.json` | One record per function per run: state, primary and all blockers, levels, source digest, counters. Fields are added, never renamed |
| C2 | Blocker taxonomy | P7 | all | `core/taxonomy.py` | Codes are appended, never merged or removed. P8 proposes Knowledge codes, P9 owns the list of `MISMATCH(kind)` kinds, P7 lands them |
| C3 | Program knowledge | P8 (semantics), P12 (storage) | P7, P9 | `whole.Program` (`signature`, `alternatives`, `callee`, `name`, `sites`, `edges`, `normal`), `knowledge.Store`, the namespace digests | Every fact carries provenance and a status. A store back end or cache from P12 returns identical values and the identical store digest. A change of meaning moves the namespace |
| C4 | Search | P9 | P7 | `search.Workshop` (`judge`, `verify`), `Candidate`, `Judged`, `Frontier` (`FRONTIER_SCHEMA`), `Result` | Same inputs give the same candidate order across processes, worker counts and `PYTHONHASHSEED`. A larger budget continues a frontier, it does not repeat it |
| C5 | Compilation | P12 | P9, P7 | `batch.Compiler.batch` / `exact`, `solve.Context.compile`, `cl.Toolchain` | Byte-identical objects and diagnostics to an uncached, sequential, exact-unit compile. The exact unit is compiled and compared last. Cache keys contain the toolchain digest, recipe, and full header and source text |
| C6 | Dependency digest | P7 | P12 (cache keys), P8 (declaration part) | `manifest.inputs`, `knowledge.namespaces` | Covers every input that can change a result: image, upstream revision, compiler and recipe, the unit header's include closure, the declarations a function uses, rule store, engine, lockfile, budgets, resumed checkpoint. An omitted input is a correctness bug, not a cache miss |
| C7 | Budgets and protocol | frozen | all | `core/budget.py`, protocol v1 (`INTEGRATION_CONTRACT.md`) | Unchanged. Upstream verification (comparator, Gate Keeper) is unchanged |
| C8 | Compute lanes | P12 | all | `core/workload.py` (lease), §5 | Lanes decide when and where work runs, never what it computes |
| C9 | Regression corpus and ratchet | P7 | all | private `phase7/regression.jsonl`, `campaign --from … --regression` (D-064) | Every function ever BYTE_MATCHED is re-derived from the image and knowledge, never by replaying stored source. Losing one blocks the merge |

## 5. Compute lanes

The machine has 4 cores, 16 GB, and WSL sees about 7.7 GB. A campaign worker has peaked at 2.3 GB. Four streams that each
run full campaigns would thrash this machine and slow every stream down. So compute runs in lanes:

| Lane | Who | Limit while an authoritative lease is held | Limit otherwise |
|---|---|---|---|
| Authoritative | P7 only: prewarm and campaigns at a checkpoint | up to 3 workers (4 for a run already started) | n/a |
| Development, heavy (a targeted campaign, a profile, more than 50 compiles) | any stream, **one at a time** across all streams | 1 process, `nice -n 19`, at most 1.5 GB | up to 2 workers |
| Development, light (unit tests, synthetic fixtures, single functions) | any stream | 1 process, `nice -n 19` | unrestricted within one core per stream |

Until P12 enforces this in code, wrap every heavy development run with the shared lock:

```sh
flock /home/victo/skyrim_decomp/.local/orchestrator/recon/ws/locks/dev-heavy.lock nice -n 19 <command>
```

Check for an authoritative lease (`analysis.lease` in `phase7/`, D-065) before choosing a worker count. Never run
anything against `phase7/knowledge.db` except P7's own runs. Each stream works on its own snapshot of the store:
`sqlite3 phase7/knowledge.db ".backup ws/pN/knowledge.db"`, taken after P7 has confirmed the C0 store (and again after
any later checkpoint whose analysis namespace moved). Raising WSL's memory limit would allow one more worker. That
changes a system setting, so only the user decides it.

## 6. Validation cadence

No stream runs a full-population campaign. Validation has three levels:

1. **Development (minutes, many times a day):** synthetic fixtures and the stream's unit tests, then a targeted run
   on the stream's own store: `campaign --from <latest authoritative final.jsonl> --blockers <the stream's codes>
   --regression`, in the development lane. Results go in the stream file, labelled *targeted*.
2. **Merge gate (per merge into `main`):** the full engine suite on Linux (and Windows when platform code changed); the
   regression corpus re-derived (C9) with zero losses; the constant scan clean (no image RVA, name or byte in the
   engine tree); held-out reported as aggregate counts only; for P12, the equivalence check below. Then rebase onto
   `main` and fast-forward. `main` only moves by fast-forward of a rebased, gated branch, one stream at a time.
3. **Authoritative checkpoint (P7):** a full campaign over the frozen population at a tagged commit of `main`
   (`auth-NNN`), run from a clean detached worktree rather than from a working tree with uncommitted changes, so every
   number traces to a commit. It is triggered when at least one capability has merged since the last checkpoint and
   no checkpoint is running. While a cycle takes about 2.5 hours, that is at most two or three a day. The prewarm runs
   only when the analysis namespace moved. The checkpoint produces the §8 roadmap row, the refreshed ranking of §2, and
   the new regression corpus. Milestones (10%, 25%, …) are declared only from clean-room campaigns on a fresh store.

**Equivalence rule for P12:** an optimisation lands only if, on a fixed stratified sample plus the whole regression
corpus, it gives identical per-function states, blocker lists, source digests, comparator verdicts and store digest
to the unoptimised path, sequentially and in parallel, and resumed after a kill. Once incremental campaigns land,
every checkpoint where they are used also runs the clean full campaign at least every third checkpoint, and the two
must agree field for field. No optimisation may reduce coverage, change what a run checks, or skip a function whose
dependency digest is not proven unchanged.

## 7. Invariants every stream keeps

* The frozen denominator, the held-out set (`heldout-v1`: aggregate counts and codes only, never listings, bytes or
  source), the definition of `VERIFIED`, the comparator, and the Gate Keeper are unchanged.
* Deterministic behaviour: same inputs give the same outputs across processes, worker counts and hash seeds.
* Evidence provenance on every fact and every binding. A reference is never bound because the bytes then line up.
* No engine source, rule or test contains a target RVA, an image name or bytes. Rules are learned from synthetic
  fixtures and upstream's cookbook. A rule that unlocks exactly one function needs a second synthetic case.
* Game-derived data stays under the private data directories. Public commits carry code, synthetic fixtures, counts,
  codes and digests only.
* Development servers, if any, use their own port and database (P8 8796, P9 8797, P12 8798; `data/recon-<stream>.db`).
  Never the live server on 8789 or its database, and never the recon dev instance on 8795, whose batch waits for the
  user.
* Batches end at *ready*. Only the user submits.
