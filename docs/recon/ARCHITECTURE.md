# Architecture

Specification: [DETERMINISTIC_WORKER_PROMPT.md](../DETERMINISTIC_WORKER_PROMPT.md), sections 6, 7, 21.
Evidence for every statement about existing code is in [REPOSITORY_AUDIT.md](REPOSITORY_AUDIT.md).

## What exists and what is new

The orchestrator already discovers work, queues packets, leases worktrees, gates every answer on upstream's
comparator, stages accepted work and prepares pull requests that the user submits. **Nothing of that is
rebuilt.** The deterministic worker replaces only the span between "prepare" and "materialise edits":

```text
lease -> prepare -> [ engine process: analyze .. synthesize <-> compile .. diagnose ] -> shared tail
shared tail = materialise, restoreAccepted, declareMembers, repairAnswer, findRepeat, gate, learn, route,
              splitMatched, recordAttribution, slot reset           (engine.ts:3031-3150, still to be factored)
```

## Processes

```text
apps/server (Node)                                   engine/recon (Python, in WSL beside the checkout)
  processTask: node.kind === 'deterministic'           one process per request, bounded, no network
    -> DeterministicWorker.solve()   --JSON Lines-->   python3 -s -B -m recon serve
    <- progress*, one result, exit 0 <--stdout-----    stdin: one request line
  -> shared tail -> Gate Keeper (unchanged)
```

The process runs through `repo/host.ts` and `util/proc.ts`: scrubbed environment, wall-clock bound,
cancellable. There is no daemon and no socket. Everything game-derived stays under the checkout's
`.local/orchestrator/recon/` (cache, checkpoints, results, diagnosis, venv).

## Layers of the engine (`engine/recon/recon/`)

| Layer | Directory | Contains | Must not contain |
|---|---|---|---|
| Generic core | `core/` | IR, analyses, inference, structuring, synthesis, emitter, diagnostics, canonical serialisation | register names, MSVC flags, addresses, class names |
| Architecture and compiler | `adapters/x64_msvc/` | decoding, lifting, ABI, unwind, compiler invocation, COFF | anything Skyrim-specific |
| Target | `adapters/skyrim/` | image and hash check, inventory, packs, declarations, recipes, labels, binding, doctor | |
| Protocol and CLI | `protocol/`, `cli/` | the wire contract, the commands | |

Allowed imports: `adapters/skyrim -> adapters/x64_msvc -> core`; `core` imports neither. Enforced by
`tests/unit/test_layers.py`, which also fails on any import of a network or AI client. Layers are created
when the code that needs them exists: today `core/` (canonical serialisation, instruction and segment
records), `adapters/x64_msvc/` (decoding, unwind data, RTTI) and `adapters/skyrim/` (image, inventory,
survey, cross-checks, environment check) exist. `core` names no register and no compiler flag (tested).

## From bytes to analysis (Phase 3)

```text
decode (iced) -> lift (x64_msvc/lift.py) -> statements (core/sem.py) -> cfg -> dataflow, frame, values (core/analysis/)
                  ^ only forms in lift_coverage.json                           ^ calling convention from x64_msvc/abi.py
```

`x64_msvc/program.py` runs the whole chain for one function and returns an `Analysis` with a digest or a `Refusal`
(stage, fixed code). `core/evaluate.py` runs semantics on concrete values: the differential tests compare it with the
processor (`hwexec.py`, `validate.py`, only ever synthetic instructions), and the analysis tests use it as the oracle.

## From analysis to admitted IR (Phase 4)

```text
Analysis --build--> Fn (raw) --validate--> passes (simplify, merge, forward, promote, dead-stores, dead; polarity, straighten)
                                              each result validated --> admit --> Admitted --require--> reconstruction (Phase 5)
                                                                                    |
                                                                                    +--> idioms: proved hypotheses, beside the function
```

| Module of `core/ir/` | What it holds |
|---|---|
| `model.py` | `Fn`: values, memory tokens and regions, exception states, observations; canonical bytes, digest, semantic digest |
| `memory.py`, `build.py` | following addresses, regions, aliasing; registers to SSA, the calling convention, memory threading |
| `validate.py` | every rule as a fixed code; `admit` and `require`, the only way on |
| `interp.py` | runs a function and checks its memory claims while it runs |
| `rules.py`, `passes.py`, `smt.py` | rewrite rules as data, the transformations, the proofs |
| `idioms.py`, `effects.py` | compiler-undo hypotheses; aliasing and side effects |

`x64_msvc/eh.py` reads frame handler data. The IR names locations only as the strings an adapter's convention gives it; `core` still names no register.

## From admitted IR to verified source (Phase 5)

```text
Fn (normal form) --inference/: signature, lower, types--> source-level SSA --structuring/: build, regions--> tree (ast.py) --emitter/cpp.py--> text
      |                                                                                                        |
      +---------------- structuring/evaluate.py: both run in the same worlds, must do the same ----------------+
synthesis/candidates.py: choices in order --> x64_msvc/batch.py (namespaces, one process) --> distance --> exact unit --> skyrim/verify.py (upstream) --> BYTE_MATCHED
```

| Module | What it holds |
|---|---|
| `core/inference/` | `signature.py` parameters and results with their evidence; `lower.py` from locations to parameters; `types.py` classes, pointers, signs, open points |
| `core/structuring/` | `rotate.py` loop rotation undone; `build.py` statements and variables; `regions.py` structure; `ast.py`, `evaluate.py` |
| `core/emitter/cpp.py` | text, a pure function of the tree |
| `core/synthesis/` | `candidates.py` the program, the choices, the checks; `search.py` the stages and the states |
| `x64_msvc/{cl,coff,batch}.py` | the compiler as a process, objects, batches and distances (they rank, they decide nothing) |
| `skyrim/{pack,verify}.py` | synthetic packs; upstream's comparator |
| `core/emitter/member.py` | a tree as a member function of a declared class: `this`, members by their declared names and types (D-034) |
| `x64_msvc/declarations.py` | what a header declares, as the pinned compiler reads it: layout report and a probe of constants (D-035) |
| `skyrim/solve.py` | the protocol's `solve` on the real target: one packet in the slot's worktree, compiled next to the unit's header, verified by upstream's comparator |

The calling convention reaches `core` as data (`abi.SOURCE`). `BYTE_MATCHED` is given only when upstream's comparator passed the exact unit.

## Determinism contract (summary of section 21)

* **Input digest** of a function covers: executable sha256, RVA and size, engine version, rule-store digest,
  dependency lock digest, digests of every imported upstream module, recipe file digest, compiler binary
  digests and host kind, digests of every header in the include closure, the current unit content, options,
  budgets and the plausibility-rule version. It becomes the attempt's `bundleHash`.
* Today the digest covers what the engine reads in Phase 1: protocol and engine versions, rule-store version,
  the packet, model name, budgets, options and the digests of the carried unit files. `requestId` is not
  part of it (test `test_request_id_does_not_change_the_input_digest`). The remaining members are added with
  the code that reads them, each with a test that changing it changes the digest.
* Canonical serialisation: sorted keys, compact, UTF-8, integers only (`core/canonical.py`).
* Budgets are operation counts (candidates, compiles, solver units, IR nodes, expansions). A wall-clock stop
  reports `INTERRUPTED`, never a result. `PYTHONHASHSEED=0` is a second line of defence, not the first.
* Per-function results do not depend on dispatch order except through carried unit content, which is in the
  digest.

## Evidence states (section 17), kept apart from `TaskState`

`SEMANTICALLY_VALID`, `COMPILED`, `BYTE_MATCHED`, `PLAUSIBLE` are the engine's; `VERIFIED` is the Gate Keeper's
pass; `STAGED` is staging's; `ACCEPTED` is upstream's alone. The orchestrator's `TaskState` is not extended;
engine states live in their own rows (additive tables, [INTEGRATION_CONTRACT.md](INTEGRATION_CONTRACT.md)).
Reports never use a word of a later state for an earlier one.

## Privacy boundaries

* SQLite holds RVAs, names, sizes, counts, reason codes and digests of inputs and of our own source. Never
  bytes, listings, operands, decoded constants or IR dumps.
* The result schema has no field that can carry them; this is tested on both sides.
* Diagnosis that quotes instructions is written only under `.local/orchestrator/recon/`.
* The public rule store holds C++ patterns, conditions, prose and synthetic evidence only.

## Reuse before writing

Upstream's `pecoff.py`, `analysis/x64.py`, `imagemodel.py`, `compare*.py`, `verifier/{bind,align,disasm,permute,
unit_build}.py` are imported from the pinned worktree at run time and never vendored; their digests go into
cache keys. The orchestrator's `Host`, `runBounded`, attribution, gate and staging are reused unchanged.
`tools/twins/` and `tools/sibling_transplant.py` copy existing bodies and are never called.
