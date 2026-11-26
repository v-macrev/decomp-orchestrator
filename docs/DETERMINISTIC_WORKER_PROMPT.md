# Deterministic Binary-to-C++ Reconstruction Worker for decomp-orchestrator

> **How to read this prompt.** It is complete: all 34 sections are requirements. Numbers marked
> *(snapshot)* were read on 2026-11-25 from skyrim_decomp `39e7cb38b1`, from this tool's own database
> and from the machine it runs on. They explain the design. Re-measure them before relying on them and
> never report them as current. Where this prompt and the code disagree, the code is right: record the
> difference (section 4) and continue.

**Vocabulary used throughout**

| Term | Meaning |
|---|---|
| *orchestrator* | This repository, `decomp-orchestrator` |
| *upstream* | https://github.com/Mudcrab-Team/skyrim_decomp |
| *checkout* | The local clone of upstream that the orchestrator drives (`config/orchestrator.json`, `repo`) |
| *base* | The upstream revision the worktrees stand on (`repo.baseRef`) |
| *engine* | The new reconstruction engine, `engine/recon/` |
| *deterministic worker* | The server-side component that runs the engine for a packet |
| *deterministic tier* | A flow node whose `kind` is `deterministic` |
| *packet* | One task: one to four functions of one unit, with an allowlist of paths |
| *unit* | A reconstruction source file (and its header) under upstream's `reconstruction/` |
| *pack* | The private per-function folder `sr start` writes: `pack.json`, `bytes.txt`, `listing.txt` |
| *Gate Keeper* | `apps/server/src/gatekeeper/*`, whose `compare` stage runs upstream's comparator |
| *comparator* | Upstream `tools/compare.py` and the modules it uses |
| *matched* | Upstream's own final status. Only upstream grants it |

---

## 1. Role and mission

Act as a Principal Software Engineer, Compiler Engineer, Reverse Engineering Specialist, and Software
Architect with extensive experience in:

- Compiler construction and optimization, in particular MSVC 19.x x64 code generation.
- Binary analysis and executable formats: PE32+, COFF objects, COMDAT sections, `.pdata`/`.xdata`.
- x86-64 instruction semantics, including SSE.
- Intermediate representations and SSA.
- Control-flow and data-flow reconstruction.
- Program synthesis and constraint solving.
- Application Binary Interfaces: Win64 calling convention, MSVC C++ object model, RTTI, exception handling.
- Deterministic algorithms.
- High-performance systems engineering.
- Software verification and reproducible builds.
- TypeScript services (Node, Fastify, SQLite, Zod, React) and Python tooling.

Your mission is to design, implement, test, and integrate a production-grade, fully automated,
deterministic binary-to-C++ reconstruction engine, and to run it as a **deterministic worker inside
decomp-orchestrator**.

- **Initial target:** Skyrim Special Edition, Steam 1.7.104 (upstream `builds/target.json`, build id
  `sse-steam-1-7-104`).
- **Reference repository:** https://github.com/Mudcrab-Team/skyrim_decomp
- **Host system:** this repository. It already discovers work, queues packets, leases worktrees, runs
  LLM worker tiers, gates every answer on upstream's comparator, stages accepted work and prepares pull
  requests that the user submits.

Today a worker tier processes a packet like this:

```text
lease -> prepare (claim, start, worktree) -> context bundle -> account -> LLM call -> parse answer
      -> materialise edits -> repair helpers -> Gate Keeper -> route
```

The deterministic worker replaces *context bundle, account, LLM call, parse answer* with software:

```text
lease -> prepare -> [ analyze -> lift -> infer -> structure -> synthesize <-> compile -> diagnose ]
      -> materialise edits -> repair helpers -> Gate Keeper -> route
```

Everything before and after the brackets is existing code and stays in charge. The answer of a
deterministic tier is judged by the same Gate Keeper, with the same rules, as any other answer.

The objective is to replace AI-assisted function drafting with a conventional software engineering
system that reconstructs compilable, readable, semantically correct C++ and has its compiled machine code
independently verified against the original executable.

Do not build another orchestration layer around AI agents, and do not build another orchestration layer
at all: orchestration exists. **Build the actual reconstruction engine and plug it in.**

---

## 2. Fundamental engineering principles

The system must follow these principles:

1. Correctness before performance.
2. Correctness before readability.
3. Determinism before heuristic convenience.
4. Verification before acceptance.
5. Evidence before inference.
6. Automation before manual intervention.
7. Reusability before target-specific implementation.
8. Incremental delivery before architectural overengineering.
9. Existing infrastructure before unnecessary replacement: first the orchestrator's, then upstream's.
10. Measurable results before subjective assessments.

Every architectural decision must be justified by a technical requirement, measurable benefit, or
verified limitation.

Avoid unnecessary abstractions, dependencies, frameworks, and distributed infrastructure. There is one
server process, one database, one checkout and a few worktree slots. Keep it that way.

The final system must be maintainable, extensible, testable, observable, and capable of operating over
the whole target inventory. Upstream's scope counts 106,486 functions without funclets and thunks, and
offers 64,010 as contributor targets *(snapshot)*; the design must hold for hundreds of thousands.

### 2.1 Operating rules of this project

These come from the owner. They override convenience and any other section.

- **Only the user submits.** Never call a submit endpoint with `dryRun: false`, never open a pull
  request, never create a claim issue, never offer to do any of these, and never put a "submit" choice in
  front of the user. Prepare work until it is *ready* and stop.
- **Claims stay local until a real pull request.** Use `sr claim --offline-ok` as the existing adapter
  does; never publish one, never pass `--ack-collision`. Release claims on functions that will not be
  submitted.
- **Commit and push every milestone** of this repository, typechecked and tested, after scanning the diff
  for secrets, private paths and game-derived content. The repository is public.
- **The live server runs on port 8789** and is started with `tools/server.ps1 start`. Never stop it
  unasked. Restart it only when no run and no operation is active, and say so.
- **The live database `data/real.db` is read-only for development.** Tests, evaluations and experiments
  use their own database and their own slots.
- **Migrations are additive** (`MIGRATIONS` in `apps/server/src/db/database.ts` is append-only) and every
  saved flow, run, task and attempt must still load after them.
- **Licence:** AGPL-3.0-or-later with an SPDX line in every new file. Before adding a dependency, check
  its licence for compatibility, pin its version and record its hash.

---

## 3. Absolute prohibition of AI-assisted reconstruction

The reconstruction engine must operate entirely through conventional computational methods.

The following are strictly prohibited within the reconstruction pipeline, meaning inside the engine and
anywhere a deterministic tier's answer is produced, completed or repaired:

- Large Language Models.
- AI agents.
- Machine learning models.
- Neural networks.
- AI inference services.
- AI APIs, including the orchestrator's own `ProviderAdapter` implementations.
- Prompt-based decompilation.
- AI-generated implementations of individual target functions.
- Human-written implementations of individual target functions.
- Target-specific lookup tables containing prewritten function implementations, keyed by address, name,
  hash or code shape.

In this orchestrator that also forbids the engine to read, directly or through a cache:

- Any body an LLM tier wrote: `attempts.files_json`, stored candidates, `task.fix` candidates, batch
  branches, drafts already present in a unit for the packet's own functions, give-up sources.
- Skills, lessons and run knowledge written by a model (`data/real-skills`, `lessons`, `skills*` tables,
  `run_knowledge_cache`).
- The upstream unit source of the function being reconstructed, when one exists.
- The output of any decompiler, Ghidra's included.

Two upstream tools are deterministic but **copy existing bodies**: `tools/twins/` stamps a matched
exemplar on identical targets, and `tools/sibling_transplant.py` transplants bodies from another
project. They are not reconstruction. Never call them from the engine and never count their results as
reconstructed. Declarations, names, types and layouts that they and other tools publish may be used as
evidence (section 12).

AI-assisted development of the generic reconstruction engine is permitted. AI-assisted reconstruction of
the target functions is not.

The distinction is fundamental:

**The software must reconstruct the functions. The implementing agent must build the software that makes
reconstruction possible.**

When you debug the engine on a real function, the fix must be a general rule with explicit
preconditions and a synthetic test. Never tune the engine to one address. A rule whose only evidence is
one target function is not a rule (section 20).

Permitted techniques include:

- Deterministic algorithms.
- Static and dynamic binary analysis.
- Symbolic execution.
- Abstract interpretation.
- Constraint solving.
- SAT/SMT solvers.
- Enumerative program synthesis.
- Graph algorithms.
- Rule-based transformations.
- Compiler optimization analysis.
- Bounded combinatorial search.
- Compiler-guided candidate generation.
- Deterministic pattern extraction.
- Formal and differential verification.

Automatically derived reconstruction patterns are permitted, provided they are generalized, validated,
reproducible, and not disguised implementations of individual target functions.

The completed engine must remain fully functional in an offline environment without access to any AI
service. A run with only deterministic tiers must start and finish with **no accounts configured**, make
**zero provider calls**, and need no `exposureConsent`, because it sends nothing anywhere. The meaning of
that flag for LLM tiers does not change. A test asserts all three.

**Mixed flows are allowed.** A flow may place a deterministic tier first and LLM tiers after it. The
engine never sees the LLM's work. A later LLM tier may see the engine's failed attempt in the packet
history, as it sees any other; the function is then credited to the LLM and never to the engine.

---

## 4. Mandatory repository audit

Before implementing architectural changes, inspect both repositories: upstream through the pinned base in
a worktree (not through the clone's main working tree, which can be weeks behind), and this one.

Pin the audited revisions and record both commit hashes.

### 4.1 Inspect upstream

- Repository-level and directory-level agent instructions (`AGENTS.md` and any nested ones).
- README and contribution documentation (`docs/contributor-card.md`, `docs/drafter-card.md`,
  `docs/contributor-parallel.md`).
- Legal and provenance documentation (`LEGAL.md`, `PROVENANCE.md`, `docs/authorizations.md`).
- Licensing and clean-room requirements (`docs/clean-room.md`).
- Reconstruction directories and indexes (`reconstruction/**`, `tools/header_index.py`).
- Function inventory and metadata (`data/progress.json`, `data/target-hashes/contributor-targets*.json`,
  `data/target-hashes/contributor-target-facts*`, `data/ready-queue.json`, scope data).
- Existing function declarations and headers (`reconstruction/declarations/`,
  `reconstruction/generated/crashlogger_pdb/`, `docs/declaration-kit.md`).
- Existing reconstruction examples, as *style* evidence only. Reading them to learn conventions is
  allowed; feeding them to the engine is not.
- Compiler recipes and toolchain configuration (`reconstruction/recipes/*.json`,
  `data/recipe-alternatives.json`, `builds/`).
- Compilation and comparison infrastructure (`tools/contrib.py`, `tools/verifier/*`, `tools/compare.py`,
  `tools/pecoff.py`, `docs/comparator-contract.md`).
- Function verification and acceptance workflows (`docs/verification.md`).
- Dependency resolution mechanisms (`tools/verifier/bind.py`, `auto_hints.py`, symbol maps).
- Submission and sanitization tooling (`sr submit`, `sr preflight`, `sr intake`,
  `tools/lint_reconstruction.py`, `tools/check_code_rules.py`, `docs/code-rules.md`).
- CI/CD workflows (`.github/workflows`).
- Existing tests and automation.
- Progress reporting infrastructure.
- Known compiler behaviour (`docs/matching-cookbook.md`, `docs/cookbook-notes/`,
  `docs/near-tier-lessons.md`, `data/giveups/`, `docs/ideas-next.md`).
- Deterministic tools that overlap with the engine: `tools/verifier/permute.py`, `align.py`,
  `disasm.py`, `compiler_sweep.py`, `tools/analysis/x64.py`, `imagemodel.py`, family generators,
  `tools/msvclib/`, `tools/f3x64/`.

### 4.2 Inspect this repository

| Area | Where |
|---|---|
| Run loop, task processing, routing, staging | `apps/server/src/orchestrator/engine.ts` (`slotLoop`, `processTask`, `route`, `settle`, `finishStaging`, `outagePause`, `recordAttribution`) |
| Queue, leases, crash recovery, packet states | `apps/server/src/queue/taskQueue.ts` |
| Account pool and providers (what the engine must *not* use) | `apps/server/src/pool/scheduler.ts`, `providers/*` |
| Repository adapter and its real and simulated implementations | `repo/types.ts`, `repo/srRepo.ts`, `repo/simRepo.ts` |
| Process execution: local or WSL, bounded, scrubbed, cancellable | `repo/host.ts`, `util/proc.ts` |
| Discovery, readiness and difficulty | `intel/gatherer.ts`, `intel/complexity.ts`, `intel/x64features.ts`, `packages/core/src/complexity.ts` |
| Gate Keeper stages and rules | `gatekeeper/{gatekeeper,rules,scope,cpp,provenance,review}.ts` |
| Answer repair and splicing | `orchestrator/{headerRepair,labelRepair,classDecls,splice,edits}.ts` |
| Attribution and staging | `orchestrator/{attribution,staging,history,capacity}.ts` |
| Schemas and flow validation | `packages/core/src/{schemas,flow}.ts` |
| Database and migrations | `apps/server/src/db/*` |
| HTTP API and events | `apps/server/src/api/server.ts` |
| UI: flow builder, runs, packets, desk | `apps/web`, `tools/desk/collect.py` |
| Existing design documents | `docs/PHASE2.md` to `docs/PHASE4.md` |

### 4.3 Determine precisely

1. How functions are discovered and identified, including the majority of targets that have no
   `data/progress.json` entry: what unit, class and area name they get from `sr next`, `sr start` and the
   gatherer, and whether the gatherer's counts include them.
2. How original function boundaries are established, and what happens when `.pdata` disagrees.
3. How reconstruction candidates are represented: the unit, its header, the six counted header lines,
   function header lines, the packet's `allowedPaths`.
4. How compiler recipes are selected for a unit, which alternatives `data/recipe-alternatives.json`
   permits and under which condition, and how to detect that a function needs `o2-fpfast`, `o2-os` or a
   `noeh` variant.
5. How compilation dependencies are resolved: include roots, own header, shared headers, the declaration
   kit, recipes that add the reconstruction root.
6. How reconstructed functions are compiled: Wine or native `cl`, flags, SDK, one process or many, caches.
7. How machine-code comparisons are performed, and **which module calls give a contract-equal local
   comparison without the cost of a full `sr compare`**; measure both.
8. Which relocation adjustments and exclusions are permitted, each with the line of code that applies it.
9. How function acceptance is recorded: two hosts, the review, the verdicts table, strikes.
10. How provenance is established: origin labels, `Code origin`, adapted bodies, source exposure,
    attribution, and what upstream wants to see for tool-made source. The card says a claim names the
    "actual model id or agent/tool name" and leaves `Drafted by` out of headers; rule R40 refuses comments
    that name a model, tool or pipeline, and the phrase "generated by"; this tool's `attribution.ts` writes
    an attribution line. Decide the header text, the `Code origin` text and the `--model` value for engine
    output from that evidence.
11. How reconstruction results become eligible for submission, and whether a set of engine-made units
    falls under upstream's *Families* rule (generator named by version and digest) and what the pull
    request text must then say.
12. Which components can be reused without modification, which need a thin wrapper, and which must not be
    used (section 3).
13. How symbols bind: which names bind automatically, when `bind-hints.json` is needed, whether a hint
    survives to CI, how destructors, string literals, vtables, thread-locals and folded functions are named.
14. Whether `permute.py` can run here with a `local` runner, and which of its functions can be imported
    (mutations, scoring) instead of shelled out to.
15. Exactly what a pack holds and what must be read from the image instead.
16. Which limits differ between here and upstream. This tool caps a pull request at 60 functions;
    upstream's cap is 2000 and its recommendation 50 to 200 *(snapshot)*. Report it; do not change it.
17. Which comparator categories are out of scope upstream (other exception handlers, unwind v2, statics
    under later contracts, funclets as targets), so the engine refuses them early.
18. Which orchestrator behaviours assume a model call behind every attempt: pool waits, outage pauses,
    budgets, pre-warm, skills, curator, review, strikes, per-worker caps, attribution, desk statistics.

Treat repository documentation, executable configuration, tests, and actual implementation as primary
evidence. Do not invent repository capabilities, interfaces, compiler versions, or acceptance criteria.

### 4.4 Facts already collected *(snapshot; verify each)*

**Inventory**

- 64,010 offered targets; 62,247 unmatched, 17.3 MB of code.
- Unmatched by size in bytes: up to 16: 2,371. Up to 32: 3,135. Up to 64: 6,894. Up to 128: 13,764. Up to
  256: 16,708. Up to 512: 11,404. Up to 1024: 5,687. Larger: 2,284.
- `data/progress.json`: 42,221 functions, 41,235 matched (2.23 MB), 986 mapped. 11,838 of the matched
  functions are 16 bytes or less and only 69 exceed 256. Simple families are already done by generators,
  so the unmatched set is where the engine's value lies, and a raw recovery rate over the matched set
  says little.
- Facts (label, size, prototype) exist for 61,867 targets; the ready queue holds 5,000 entries; about 30
  give-up records exist.

**Compiler**

- 42 recipes. Compilers from `19.00.24247` to `19.16.27054`, with plain, reconstruction-root and
  root-include forms, `noeh`, `o2-fpfast`, `o2-os` and "represented" variants.
- Default `msvc-19.16.27054-o2`: `/nologo /c /O2 /MD /GS- /EHsc /GR /fp:precise /Gy`, SDK 10.0.19041.0.
  The unit's `Recipe:` line chooses.

**Comparator**

- Contract v2: the whole COMDAT section, every byte exact or explained by a reference; REL32 and
  REL32_1 to REL32_5, ADDR32NB, SECREL; jump tables; TLS; unwind version 1; exception data for
  `__CxxFrameHandler3`, `__GSHandlerCheck_EH`, `__C_specific_handler`, `__GSHandlerCheck_SEH`,
  `__GSHandlerCheck`. Padding between functions is not compared.

**Binding**

- Compared functions bind by `bind-hints.json`, then the header line `// 0x<rva> Class::Method[(sig) const]`
  by qualified name, then by member name; several candidates are narrowed by declared signature, target
  size and published target hash. Still several is *unbound*.
- References bind by hint, then `symbols.json`, then position (when the target's own field at that offset
  decodes to one of the pack's listed references), then the one pack reference whose community name fits.
- Virtual destructors: slot 0 is the deleting destructor `??_G` or `??_E`, not `??1`.

**This tool's history**

- 188 functions were left dead after LLM tiers in the two real runs.
- Reasons of failing compares in those runs: `function-size-mismatch` 677, `code-byte-mismatch` 419,
  `function-symbol-missing` 389, `unresolved-symbol` 28, `undeclared-alias` 17,
  `relocation-target-mismatch` 11, `unwind-info-mismatch` 3, `unwind-coverage-missing` 1.
- A Gate Keeper compare takes 7.6 s at the median and 19.5 s at the 90th percentile. It cannot be the
  inner loop of a search.

**Compile cost under this machine's Wine, trivial synthetic code**

- One `cl` process per file: about 0.47 s. Eight files in one `cl`: about 0.65 s. One file with 200
  functions: about 0.47 s. Process start dominates, so **candidates must be batched**.

**Environment**

- The checkout, toolchain and packs are in WSL: 4 cores, 7 GB of memory, Python 3.14; `iced_x86`, `z3`
  and `capstone` are not installed. The Node server runs on the Windows host, which has Python 3.13 and
  can also run a native `cl`. Measure both before fixing where compile batches run.

**Traps**

- The private `contrib/config.json` names a default LLM model. `sr compare` falls back to it when a task
  names none, so **every engine call must pass its own `--model` value**, or engine work is credited to
  that model.
- The Gate Keeper treats a trivial body for a target of 24 bytes or more as `CHEAT_STUB`; a second strike
  quarantines the packet. An engine that emits partial bodies would destroy its own packets.
- `sr compare` may retry failed functions under alternative flag sets (advisory). Pass `--no-retry` where
  the result must be about one recipe.

### 4.5 Phase 1 deliverables

Create, in this repository:

- `docs/recon/REPOSITORY_AUDIT.md`
- `docs/recon/ARCHITECTURE.md`
- `docs/recon/INTEGRATION_CONTRACT.md`
- `docs/recon/TECHNICAL_DECISIONS.md` (dated decision log)
- `docs/recon/IMPLEMENTATION_ROADMAP.md`
- `docs/PHASE5.md`, a short overview in the style of PHASE2 to PHASE4 that links the five.

Document existing infrastructure, integration points, legal constraints, architectural risks, unresolved
dependencies, and the initial implementation scope. Give file and line for every claim about behaviour.

If repository documentation and actual behavior disagree, record the discrepancy explicitly.

Reuse the reference project's and the orchestrator's infrastructure wherever technically and legally
appropriate. Import upstream Python modules from the pinned worktree at run time; do not vendor them. Put
the digest of every imported upstream file in the engine's cache keys, because the base moves.

The audit is part of the first milestone, together with running code. It is not a phase of its own that
may grow without limit.

---

## 5. Technical definition of reconstruction

This project is not a conventional decompiler.

Traditional decompilation generally attempts to recover a semantically equivalent high-level
representation from machine code. This engine must additionally solve a compiler-constrained
reconstruction problem.

Given:

- Original machine code B, with its relocation targets, unwind information and exception data.
- Target compiler C.
- Approved compilation recipe R of the unit.
- Compilation environment E.
- Known declarations and dependencies D.

The engine must search for a valid C++ implementation S such that:

```text
Verify(Compile(S, C, R, E, D), B) = PASS
```

The verification predicate is defined by upstream's actual acceptance requirements. In this system it is
applied in three widening rings, none of which the engine may alter:

```text
1. Engine, advisory:   upstream comparator modules on the engine's scratch build of the exact unit
2. Orchestrator:       GateKeeper(S) = pass, whose compare stage runs  ./sr --json compare
3. Upstream:           byte match on two hosts + one admitted review + CI, after the user submits
```

A reconstruction candidate must satisfy both semantic constraints and the applicable binary verification
contract. **A byte match is required and not sufficient.** Upstream's review rejects source that is
decompiler output, byte steering (dead code, nonsensical control flow, helpers that exist only to force
bytes), impossible source, unproven provenance, over-claims or poor hygiene. The engine must therefore
also satisfy a plausibility predicate (section 15.4).

Do not assume that:

- A successful compilation constitutes a successful reconstruction.
- Semantic equivalence guarantees byte equivalence.
- Byte equivalence of a scratch build guarantees equivalence in the unit.
- Identical instruction counts guarantee correctness.
- Similar assembly guarantees correctness.
- Original variable names and source-level abstractions can always be recovered.
- Every executable function necessarily has a recoverable representation under the approved compiler
  recipe.
- A function's source was one function. Inlining, folding and merging hide helpers.

The objective is to maximize independently verified reconstruction coverage, not to claim recovery of the
exact historical source code.

Unsupported, ambiguous, or currently unsolvable functions must be classified honestly.

---

## 6. System architecture

Implement the following end-to-end architecture. The outer boxes are existing orchestrator code.

```text
  Gatherer / sr next  ->  task queue  ->  slot lease  ->  RepoAdapter.prepare      (existing)
                                                              |
        Target Executable + Pack + Inventory + Declarations + Unit skeleton
                                                              |
                                                              v
                                                       Binary Analysis
                                                              |
                                                              v
                                              Function Identification / Boundaries
                                                              |
                                                              v
                                                     Instruction Decoding
                                                              |
                                                              v
                                                 Semantic Instruction Lifting
                                                              |
                                                              v
                                                    Control-Flow Analysis
                                                              |
                                                              v
                                                      Data-Flow Analysis
                                                              |
                                                              v
                                             Semantic IR / SSA / Memory Model
                                                              |
                                                              v
                                                Type and Signature Inference
                                                              |
                                                              v
                                                    Control-Flow Structuring
                                                              |
                                                              v
                                             Compiler-Aware Candidate Synthesis
                                                              |
                                                              v
                                                         C++ Generation
                                                              |
                                                              v
                                                Batched Compilation (scratch)
                                                              |
                                                              v
                                         Contract comparison (upstream modules)
                                                              |
                                               +--------------+--------------+
                                               |                             |
                                             MATCH                        MISMATCH
                                               |                             |
                                               v                             v
                                   Exact-unit rebuild + recheck    Failure Classification
                                               |                             |
                                               v                             v
                                      Plausibility checks          Constraint Refinement
                                               |                             |
                                               |                             v
                                               |            Deterministic Candidate Search --> Retry
                                               v
        Edits -> repair helpers -> Gate Keeper -> route -> staging -> dry run        (existing)
                                               |
                                               v
                                  READY. The user decides to submit.
```

Cross-cutting infrastructure:

- Persistent reconstruction state.
- Function dependency graph (seeded from upstream's ready queue and the pack's references).
- Compiler behavior database.
- Reconstruction pattern registry.
- Content-addressed artifact cache.
- Deterministic scheduler inside the engine; the orchestrator's queue outside it.
- Provenance tracking.
- Structured diagnostics.
- Metrics and progress reporting.
- Test and regression infrastructure.

Each component must expose a clearly defined, versioned interface. Avoid circular dependencies and
uncontrolled sharing of mutable state.

### 6.1 Process view

```text
apps/server (TypeScript, the Node process)               engine/recon (Python, beside the checkout)
+--------------------------------------------+           +-----------------------------------------------+
| RunEngine.processTask                      |           | one process per packet, bounded               |
|   node.kind === 'deterministic'            |  JSONL    |  adapters/skyrim   image, pack, decls, recipes |
|     -> DeterministicWorker.solve() --------+--stdio--> |  adapters/x64_msvc decode, lift, ABI, cl, COFF |
|     <- progress, result, reason codes -----+---------- |  core              IR, analysis, synthesis     |
|   -> shared tail: repair, gate, route      |           |                                               |
+--------------------------------------------+           +-----------------------------------------------+
             |                                                               |
       SQLite (counts, codes,                                    .local/orchestrator/recon/
       digests of our own source)                                (everything game-derived)
```

The process runs through the existing `Host.run` and `util/proc.ts`: local or WSL, time-bounded, scrubbed
environment, cancellable, whole process tree killed on abort. There is no daemon, no socket, no network.

---

## 7. Architectural boundaries

Separate the implementation into three principal engine layers, plus the worker in the server. A test
fails on any import against the allowed direction: `adapters/skyrim -> adapters/x64_msvc -> core`, and
`core` imports neither.

### 7.1. Generic reconstruction core (`engine/recon/core`)

Responsible for:

- Intermediate representation.
- Data-flow and control-flow analysis.
- Type inference.
- Semantic transformations.
- Candidate synthesis.
- Constraint solving.
- Search algorithms.
- Code generation.
- Verification orchestration.

The generic core must not contain Skyrim-specific function addresses, class names, implementations, or
executable assumptions. It contains no x86 register names and no MSVC flags either.

### 7.2. Architecture and compiler adapter (`engine/recon/adapters/x64_msvc`)

Responsible for:

- Instruction-set architecture.
- Instruction semantics.
- Register model.
- Memory model.
- Calling conventions.
- ABI rules, including the MSVC object model, RTTI and exception handling.
- Compiler behavior.
- Compiler invocation.
- Object-file inspection.
- Relocation semantics.

Implement only the adapters required for the initial target. Do not introduce speculative multi-platform
complexity.

### 7.3. Target project adapter (`engine/recon/adapters/skyrim`)

Responsible for:

- Skyrim executable configuration and hash check.
- Function inventory integration.
- Existing project declarations.
- Compiler recipe resolution.
- Project-specific verification, through upstream's own modules.
- Reconstruction acceptance vocabulary (upstream's reason codes and states).
- Provenance and submission requirements: origin labels, header lines, naming.
- Progress reporting integration.

The initial implementation must support Skyrim SE without preventing future integration with other
decompilation projects.

### 7.4. Deterministic worker (`apps/server/src/recon`)

Responsible for:

- The flow-node schema: `FlowNodeData` gains `kind: 'llm' | 'deterministic'` (default `'llm'`, so every
  saved flow loads) and an optional `recon` block (search budgets, compile jobs, size limit, options).
  Account-pool fields are irrelevant for such a node and must not be required.
- The branch in `processTask`, after `prepare` and late classification and before anything that assumes a
  model: no `contextV2.build`, no `pool.acquire`, no `providers.complete`, no skill selection, no prefix
  pre-warm, no response parsing.
- The engine process, its protocol, heartbeats, cancellation and crash handling.
- Turning the engine's result into the same `edits` structure an LLM answer produces.
- Mapping engine outcomes to the existing routes.

The existing free-attempt path (`freeAttempt`, used for splices and stored candidates) is the precedent
for an attempt without a model call. **Factor the shared tail** (materialise, `restoreAccepted`,
`declareMembers`, `repairAnswer`, `findRepeat`, gate, `learn`, `route`, `splitMatched`,
`recordAttribution`, slot reset) into one function that both paths call. Do not copy it.

### 7.5. Protocol between server and engine

Versioned JSON Lines over stdio.

Request, one line:

```text
{ protocol, requestId, command: "solve",
  packet: { functions: [{ rva, size, name }], unit, allowedPaths },
  worktree, taskDir, packDirs, carriedUnitState, modelName,
  budgets: { candidates, compiles, solverUnits, irNodes, expansions },
  options, dataDir }
```

Responses:

```text
{ type: "progress", stage, counters }                      any number of lines; no text from the target
{ type: "result",
  inputDigest, engineVersion, ruleStoreVersion,
  functions: [{ rva, status, reasonCode, counters, ruleTrail, originLabels, evidenceSummary }],
  edits, codeOrigin, adaptedBodies }                       exactly one, then exit 0
```

- `status` is one of `solved | unsolved | unsupported | blocked`.
- `edits` is the orchestrator's `UnitEdit[]`: `path`, `header`, `declarations`, `members`, `replace`,
  `functions[{name, code}]`. It contains only functions the engine solved and nothing else.
- The response schema has **no field that can carry bytes, listings, operands or addresses inside code**.
  Validate it with Zod on arrival, reject unknown fields, bound every string.
- Progress messages carry stage names and integers. They are safe to put in events and logs.
- A missing result, a non-zero exit, a malformed line or a timeout is an *infrastructure* failure: never
  charged to the packet, never a strike, never the end of the run.
- The engine answers `doctor`, `analyze` and `explain` through the same protocol.

---

## 8. Binary analysis engine

Use established binary analysis technology. Do not implement an instruction decoder from scratch unless a
verified limitation makes it necessary.

Evaluate suitable infrastructure such as:

- Upstream's own `tools/pecoff.py` (`PeImage`), `tools/analysis/x64.py` and `imagemodel.py`. These are
  the reference: whatever else is chosen must agree with them.
- iced-x86, which upstream already pins (`1.21.0`) for its generators. This is the default candidate.
- Capstone and Zydis.
- Ghidra and *raw* P-code, for instruction semantics only. Upstream pins a Ghidra and a JDK. Ghidra's
  **decompiler output must never be an engine input**. A JVM per worker does not fit this machine's
  memory; if P-code is chosen, it must be precomputed or shared.
- LLVM (`llvm-objdump` is present) and LLVM-based lifters.
- LIEF.

Select dependencies based on technical suitability, licensing, deterministic behavior, integration cost,
and completeness. Avoid introducing multiple libraries that solve the same problem without a documented
justification.

The binary analysis engine must support:

- Executable format identification.
- Architecture identification.
- Executable section discovery.
- Address and file-offset translation.
- Instruction decoding.
- Instruction operand analysis.
- Relative address resolution.
- RIP-relative memory references.
- Direct and indirect calls.
- Conditional and unconditional branches.
- Tail jumps (upstream writes these as `return Callee(...)` as the last statement).
- Function boundary discovery.
- Global data references.
- Cross-references.
- Compiler-generated functions: deleting destructors, adjustor thunks, vector constructor iterators,
  dynamic initializers, catch and unwind funclets.
- Thunks and aliases, including identical-code folding.
- Jump tables and switch range tables.
- Virtual tables and RTTI.
- Imports.
- Thread-local accesses through `gs:[0x58]` and `_tls_index`.
- String and floating-point constants.
- Available symbol information.
- Relocation information.
- Unwind and exception-handling metadata: `UNWIND_INFO`, chained entries, `FuncInfo`, state maps, try
  and catch tables.

Function discovery must combine available evidence from multiple sources. Do not infer function
boundaries from simplistic prologue signatures alone.

**Prefer validated inventory entries.** RVA and size come from upstream's target list or the prepared
task. When `.pdata` or decoding disagrees, record the conflict and block the function; do not choose.

Represent unresolved addresses, uncertain boundaries, and conflicting evidence explicitly.

The original executable must remain immutable: opened read-only, its SHA-256 checked against
`builds/target.json` on every load, and the digest included in every cache key.

Refuse early, with a reason, what the comparator itself cannot accept (for example
`unsupported-unwind`, `unsupported-eh-handler`, `eh-funcinfo-unsupported`,
`candidate-boundary-unsupported`, `unsupported-relocation`): no search can end in a match there.

---

## 9. Semantic instruction lifting

Implement a semantic lifting layer that converts decoded instructions into architecture-independent
operations while preserving architecture-specific behavior.

The lifting layer must account for:

- Register aliases and partial-register writes (32-bit writes zero the upper half; 8- and 16-bit writes
  do not).
- Register width.
- Implicit operands.
- Arithmetic and logical flags, each flag separately, including those an instruction leaves undefined.
- Carry and overflow behavior.
- Signed and unsigned arithmetic.
- Integer extension and truncation.
- Effective address computation.
- Floating-point behavior: scalar and packed SSE, rounding, NaN and parity flag behaviour of
  `ucomiss`/`comiss`, conversions with truncation.
- SIMD operations.
- Stack operations, home space and frame-pointer forms.
- Memory reads and writes.
- Atomic instructions and `lock` prefixes.
- String instructions (`rep movs`, `rep stos`) that MSVC emits for copies and fills.
- Calling conventions.
- Architecture-defined and undefined behavior.

Every supported instruction must have an explicit semantic representation.

Unsupported instructions must produce a structured failure: `UNSUPPORTED_INSTRUCTION` with the mnemonic
class, counted so that coverage work can be ordered by demand. The function stops there.

Never approximate unsupported instructions or silently discard side effects.

Where an existing lifting framework provides reliable semantics, reuse it rather than duplicating its
functionality.

Whatever the source of the semantics, **validate them against execution**: for each supported
instruction form, differential tests with edge values and generated inputs against real hardware or an
independent emulator. Keep the result as a coverage table: form, number of vectors, date, digest.

Emit a machine-readable *instruction coverage report* over the unmatched inventory: how many functions
would lift completely if form X were added. That report, not interest, orders the lifting work.

---

## 10. Intermediate representation

Implement a versioned semantic IR suitable for analysis, transformation, validation, and C++ generation.
Use Static Single Assignment form where appropriate.

The IR must represent:

- Integer and floating-point operations.
- Bitwise and logical operations.
- Comparisons and condition codes.
- Register and temporary values.
- Memory operations.
- Pointer arithmetic.
- Type conversions.
- Sign and zero extension.
- Function calls, with ABI effects and clobbers.
- Control-flow transfers, tail calls and switch dispatch.
- Return values, including returns through a hidden pointer.
- Phi nodes.
- SIMD operations.
- Atomic operations.
- Exception-related control flow: state numbers, unwind edges, catch entries.

Preserve:

- Operation width and signedness constraints.
- Precision and rounding semantics.
- Evaluation dependencies.
- Memory access width and alignment.
- Observable side effects.
- Aliasing constraints.
- Calling conventions.
- Original instruction address mappings.
- Undefined or unknown values.
- Evidence supporting inferred properties.

Use an explicit memory model suitable for alias analysis and memory-sensitive transformations: memory SSA
over disjoint regions (stack slots, `this` fields by offset, globals, escaped memory, unknown), with
explicit volatile and atomic accesses.

Do not discard machine-level details merely because they are inconvenient to express in C++. Details that
do not affect semantics but do affect matching (instruction order, register choice, branch polarity, stack
slot order, duplicated tails) are kept beside the IR as *codegen observations*; they guide synthesis and
never enter semantic equality.

Serialization is canonical: equal IR gives equal bytes and an equal digest.

### IR validation

Implement a validator that checks:

- SSA consistency.
- Definition-use relationships.
- Control-flow integrity.
- Type consistency.
- Memory operation validity.
- Instruction coverage: every instruction of the function is represented by IR operations, by a recorded
  codegen observation (prologue, epilogue, unwind-described saves), or the function is rejected.
- Preservation of mandatory semantic properties.

Invalid IR must never enter candidate generation.

Every IR transformation declares its precondition and its guarantee. Tests check each one by SMT over
small generated IR and by concrete evaluation over larger generated IR.

---

## 11. Program analysis infrastructure

Implement reusable analysis passes for:

- Basic-block construction.
- Control-flow graphs.
- Dominator and post-dominator trees.
- Strongly connected components.
- Natural loop detection.
- Loop nesting.
- Definition-use chains.
- Reaching definitions.
- Liveness analysis.
- Constant propagation.
- Value numbering.
- Stack-frame recovery: locals, home slots, outgoing arguments, saved registers, agreement with unwind
  codes.
- Memory alias analysis.
- Side-effect analysis.
- Function call graphs.
- Interprocedural signature propagation.

Interprocedural facts computed once per image digest and cached under the private data directory:

- Callee arity, argument widths and return use, agreed across call sites.
- Call-site census: how each callee is called, so that an unknown parameter type becomes constrained.
- Inline census: recurring instruction shapes across the image that are inlined helpers (reference
  counts, string-cache lookups, spin locks, smart-pointer releases, container walks).
- Vtable layouts, override relations and slot indices from RTTI.
- Folded functions and their alias sets.

Analyze functions in isolation when possible, and introduce interprocedural analysis when required to
resolve ambiguities or dependencies.

### 11.1 Compiler undo

A separate, explicit group of passes recognizes what MSVC did and lifts it back **as a hypothesis with
alternatives**, never as a fact:

- Multiplication by a magic number for division and remainder; shifts for powers of two.
- Strength reduction, `lea` arithmetic, induction variable rewriting.
- `setcc`, `cmov`, `sbb`, `neg` idioms for booleans and selections.
- Tail merging, cross-jumping and tail duplication.
- Loop inversion, unrolling, pointer-to-counter conversion.
- Switch lowering: jump tables, compressed tables, decision trees, range tests, bit tests.
- Inlined `memcpy`, `memset`, `strlen`, `strcmp`, structure copies by vector moves.
- Inlined member helpers, reference-count increments and decrements, spin-wait loops.
- Store merging and constant pooling, `-1` versus zeroed-register stores.
- Vptr stores and their elimination in constructors and destructors.
- Exception-state stores and the `-2` unwind-help slot.
- Callee-saved register selection, home-slot use and shrink-wrapped saves.
- Security cookie absence (`/GS-`) and frame layout rules.

All analysis results must be reproducible and traceable to their inputs. Analysis passes must be
independently testable, and each is keyed by the digest of what it read.

---

## 12. Type, signature, and structure inference

Implement deterministic, evidence-based inference.

Use evidence from, in this order of authority:

1. The pinned image: RTTI, vtables, unwind and exception data, instruction semantics, call sites.
2. ABI rules.
3. Known function declarations in upstream headers and the declaration kit.
4. `contributor-target-facts` and the CrashLogger-derived layouts upstream already publishes.
5. Register and stack usage.
6. Memory access widths.
7. Arithmetic operations.
8. Pointer dereferences.
9. Structure offsets.
10. Virtual calls.
11. Return-value conventions.
12. Cross-function relationships.
13. Existing reverse-engineered headers (community sources upstream permits, with their labels).
14. Validated project metadata.

Support inference of:

- Integer types, widths and signedness.
- Floating-point types.
- Boolean values.
- Pointer and reference types.
- Arrays.
- Structures, including returned-by-value ones.
- Enumerations when supported by evidence.
- Function pointers.
- Class layouts where sufficient evidence exists.
- Function signatures, including `const`, `static` versus member, and hidden return pointers.
- Virtual dispatch relationships and slot order.
- Template instantiations that upstream names.

Every inferred property must have an evidence classification:

```text
PROVEN        follows from the image, the ABI, or an authoritative declaration
CONSTRAINED   the image limits it to a known finite set
INFERRED      best supported reading; another is possible
AMBIGUOUS     several readings with equal support
UNKNOWN       no evidence
```

Where multiple valid interpretations exist, represent them as candidate constraints instead of
prematurely selecting one. Signed against unsigned, `int` against `bool`, member against free function and
pointer against reference are search dimensions (section 14), not early decisions.

Do not invent semantic names, class relationships, or structure members. Reuse authoritative declarations
whenever available.

Reject transformations that introduce unjustified assumptions about signed overflow, pointer aliasing,
alignment, object lifetime, or other C++ undefined behavior.

### 12.1 Upstream rules that shape the result

- **Typed members, not offset casts (R4).** `*(T*)((char*)this + 0x58)` is not acceptable output, and
  neither is byte-pointer arithmetic on objects.
- When the layout is unknown, the function is `LAYOUT_UNKNOWN`, unless the engine can declare a *minimal
  stand-in class* in the unit's own header whose members are proven by accesses, with the label upstream
  prescribes (`STANDIN` plus the origin of the name). Audit what upstream accepts before emitting one, and
  never define a second layout of a class that another header in the include closure defines.
- A missing virtual slot shifts every virtual call. Slot order must come from RTTI or an authoritative
  declaration.
- Called functions are **declared, never defined**. A live argument register at a call means the callee
  takes that argument.
- Every name carries exactly one origin label, taken from the source that has the name:
  `COMMUNITY(owner/repo@rev, licence)`, `CRASHLOGGER_PDB(...)`, `SYMBOLS(...)`, `SIBLING(...)`,
  `EXE_RTTI`, `OBSERVED`, `GUESS(low)`, and `STANDIN` together with one of them.
- A name with no source gets a stable neutral name and `GUESS(low)` where the card asks for it.
- Sources that upstream restricts (private or anonymous symbol files) are used only as
  `docs/authorizations.md` allows; when in doubt, not at all.
- A header gap (a class that only another unit declares) is reported as `header-gap`, never solved by
  editing another unit.

---

## 13. Control-flow reconstruction

Transform the analyzed control-flow graph into structured C++ wherever possible.

Support:

- Conditional expressions.
- If/else statements.
- Nested conditions.
- Switch statements.
- While loops.
- Do/while loops.
- For loops.
- Break and continue.
- Early returns.
- Multiple return paths, and one result local with a shared exit.
- Short-circuit evaluation.
- Irreducible control flow.
- Exception-related regions where supported: scoped objects whose destructors create the unwind states,
  `try`/`catch` where the function's exception data shows one.

Use deterministic graph algorithms, region analysis, and compiler-aware structural transformations.

Where safe structured reconstruction is impossible, use an explicitly supported C++ fallback, such as
controlled goto-based representations, provided the reference project permits it. Upstream rule R14 limits
`goto`: audit its exact text, rank every `goto` form last, and report how many solved functions needed one.

Maintain multiple structurally valid candidates when different source representations may produce
different compiler output. The structurer returns an ordered set, not one tree. Documented sources of
different output under this compiler include:

- Exits that differ only in register choice, select form or epilogue sharing (one result local against
  several returns).
- A two-way check written in either polarity, or nested against joined with `&&`.
- A loop that stops on a found result, with the result in the condition or a `break`.
- A list walk that takes the element, advances, then uses it.
- A pointer loop against a counted loop.
- A null path threaded to the exit against a value kept and tested again.
- A pick between a pointer and a fallback, as a conditional expression or an `if`.
- A `continue` misread as a `break`.

Never alter observable behavior merely to produce more idiomatic source code, and never alter it to
produce the target's bytes.

---

## 14. Compiler-aware program synthesis

This is the central reconstruction component. Do not implement the engine as a simple
assembly-to-pseudocode translator.

The synthesis engine must reconstruct candidate C++ representations based on:

1. Machine-level semantic constraints.
2. Recovered program structure.
3. Type and signature constraints.
4. Existing declarations.
5. Approved compiler behavior.
6. Previously validated transformation patterns.
7. Feedback from actual compiler output.

### 14.1 Search space

Define a constrained search space over legitimate C++ representations. Candidate dimensions may include:

- Expression representation: operand order, association, common subexpressions written once or twice.
- Evaluation order where semantically permitted.
- Conditional structure.
- Loop representation.
- Local variable scope and declaration order.
- Temporary variable placement: introduced, inlined, re-read from memory.
- Integer type selection, signedness, and width of locals, parameters, members and returns.
- Casting strategies.
- Boolean normalization and zero forms (`!p`, `p == nullptr`, `p ? a : b`).
- Return-path organization.
- Memory access representation: member, reference to member, accessor, bit-field, array element.
- Function call representation: member or free, by value or by reference, out-parameter, return by value.
- Inlined helper against call; small inline accessor against direct read.
- Object construction and destruction forms: default construction, member initializers, assignment.
- Copies: assignment, member by member, `memcpy`, `__m128` rows.
- Approved compiler-specific constructs (`__forceinline`, `__declspec(noinline)`, `__restrict`,
  `__declspec(thread)`, intrinsics) only where upstream's rules permit that construct for that reason.
  Cookbook rule 27: `noinline` stands in for a translation-unit boundary and nothing else.
- The recipe, only among those the unit may use (section 16).

### 14.2 Techniques

Use deterministic techniques such as:

- Constraint propagation.
- Enumerative synthesis.
- Rule-based term rewriting.
- Equality saturation where technically appropriate.
- SAT/SMT solving.
- Bounded tree search.
- Deterministic branch-and-bound.
- Canonicalization and candidate deduplication.

### 14.3 Rules, not mutations

Every choice point is a **rule**:

```text
id, version
kind                       structural | expression | type | declaration | memory | call | recipe
preconditions              on the validated IR, types and structure
transformation             from one candidate tree to another
semantic guarantee         preserved by construction, or checked by SMT against the target IR
symptoms                   mismatch classes it addresses (section 18)
evidence                   synthetic experiments, cookbook rule, counts of verified functions
plausibility cost          how far it moves from code a programmer would write
```

Upstream's `permute.py` already lists useful mutations: declaration swap, move and split, temporary
introduce and inline, `if` inversion, early return, `&&` split, loop form, integer type, comparison form,
commuted operands, test form, increment form, out-parameter initialization, zero form, return through a
variable. Reuse its scoring and tree handling where they can be imported. **Its permissiveness must not be
copied:** it allows rewrites that change semantics (width, re-reads). Here each such rewrite must prove its
precondition or be rejected.

The matching cookbook (77 rules *(snapshot)*) is the first input to the rule store. Its ranking says which
symptoms matter most. Start with the rules that closed most functions and those that stay open most often:

| Cookbook rule | Subject | Use in the engine |
|---|---|---|
| 34 | Exits that differ in register choice or epilogue sharing: one result local | Structural rule |
| 38 | Compare width or sign decides the branch form | Type rule |
| 31 | Immediate against xor-zero stores; constructor store order | Construction rule |
| 16 | Flag bit tested as load, shift, test: a by-value bit-index helper | Helper rule |
| 48 | Parity branch or double round trip: unit recipe `o2-fpfast` | Recipe rule, if permitted |
| 35, 36, 44, 20 | Loops that stop on a result; list walks; find loops; pointer loops | Structural rules |
| 41, 40, 43, 47 | Folded repeated tests; threaded null paths; set against move; pointer picks | Expression rules |
| 42, 45, 19 | Operand load and store order | Order rules |
| 37, 52, 59 | Flag words, bit-fields, snapshots | Memory rules |
| 10, 14, 18, 25, 28 | Deleting destructors, adjustor thunks, vptr stores | Declaration rules |
| 13, 67, 72 | Exception-state slots without a visible handler | Exception rules |
| 21 | `gs:[0x58]` with `_tls_index`: thread-local variable | Declaration rule |
| 22, 23, 33, 60 | Out-parameters, member read after test, by-value returns and arguments | Call rules |
| 24, 50, 51, 57, 63 | Copies, vector rows, zero fills | Memory rules |
| 12, 71 | Callee-saved register swap; closed in some units by a class-type local | Early-stop class, one rule |
| 55, 61 | Scratch register in a chain of reads; small inline accessors | Memory rules |
| 69, 70 | A single differing number is a layout fact or a call argument | Constraint refinement |
| 77 | Compile many variants per attempt | The compile loop itself (section 16) |

For every encoded rule, run a synthetic experiment under the pinned compiler and record
`confirmed | refuted | untested`. Refuted rules are kept, marked, and not used.

### 14.4 Candidate discipline

- Every candidate must satisfy the established semantic constraints before entering compilation.
- Candidates are canonicalized and deduplicated twice: by canonical tree before compiling, and by the
  digest of the produced **code section, relocations and unwind data** after compiling. The whole object
  file is not a key; it contains timestamps and paths.
- Search must prioritize candidates using reproducible, documented criteria. The default key, in order:
  rules tagged with the observed symptom, number of changes from the canonical form, plausibility cost,
  rule id, position in the tree.
- Similarity metrics (for example upstream's `align.py` distance) may guide search ordering, but they must
  never replace the independent acceptance verifier.
- A packet may hold up to four functions of one unit. Solve each with its own search and budget, then
  confirm all solved ones together in one exact-unit build. If together they no longer match (shared
  declarations, inlining between them), keep the largest set that does, in RVA order, and report the rest.

---

## 15. C++ generation

Implement a deterministic C++ emitter that consumes validated semantic and structural representations.

The generated source must:

- Compile under the approved project toolchain, in the language mode its recipe uses.
- Preserve known function signatures.
- Preserve observable behavior.
- Respect the target ABI.
- Use existing project declarations.
- Preserve memory access semantics.
- Use deterministic naming conventions.
- Include required provenance metadata.
- Follow reference repository coding standards.

Generate readable C++ whenever this does not compromise correctness or binary verification.

For unknown identifiers, use stable, neutral naming conventions rather than fabricated semantic names.
Derive a local's name from its type or role (`result`, `index`, `entry`, `count`, `item`), numbered when
needed. Do not use decompiler shapes: rule R39 refuses `undefined*` and `CONCAT...`, and advises against
`param_1`, `iVar1`, `local_28`.

Do not emit raw decompiler pseudocode as accepted source.

### 15.1 Prohibited as methods of achieving a match

- Inline assembly containing reconstructed target instructions.
- Raw machine-code arrays.
- Byte-emission directives.
- Binary embedding.
- Compiler-output patching.
- Original executable patching.
- Hardcoded function-specific implementations.
- Undefined behavior deliberately exploited without explicit validation and project approval.
- Arbitrary casts introduced solely to suppress compiler errors.
- `#pragma` steering, token pasting, macro redefinition, `#line`, absolute addresses, hex escapes in
  strings, references to the verifier, conditional compilation around bodies.
- `volatile` carriers, dead code, dummy locals, self-assignment, redundant tests, helpers that exist only
  to change code generation (upstream R17, R38).

The generated source must represent the reconstructed program semantics.

The orchestrator's `gatekeeper/rules.ts` already detects many of these: `CHEAT_INLINE_ASM`,
`CHEAT_BYTE_ARRAY`, `CHEAT_HEX_ESCAPE`, `CHEAT_ABS_ADDRESS`, `CHEAT_PRAGMA`, `CHEAT_TOKEN_PASTE`,
`CHEAT_MACRO_REDEFINE`, `CHEAT_LINE_DIRECTIVE`, `CHEAT_STUB`, `CHEAT_MATCHED_BODY_REMOVED`,
`CHEAT_MATCHED_BODY_MODIFIED`, `CHEAT_VERIFIER_REFERENCE` and the `LEAK_*` family. The engine runs the same
checks on itself before answering. A cheat strike against engine output is a **defect of the engine** with
a regression test, not an event to tolerate.

### 15.2 Output form

- Output is `UnitEdit[]` for the packet's `allowedPaths` only, materialised by the existing edit and splice
  helpers. Accepted bodies, carried bodies and other units are never altered; existing header statements are
  extended, not rewritten.
- Only solved functions are emitted. Never a stub, a partial body or a placeholder for an unsolved one.
- New units follow upstream's `<Class>_<rva>.h` and `.cpp` naming. Shared headers are included by their
  reconstruction-root path, with the recipe form that permits it.
- Callees are declared, not defined. `static_assert` carries a message. A tail jump is `return Callee(...)`
  as the last statement.
- One member per line, one meaning per local, stable order everywhere.

### 15.3 Provenance metadata

- The unit header stays within upstream's counted lines (Source exposure, SPDX, Code origin, `// 0x<rva>
  Name`, Adapted bodies, include) and leaves out the ones the card says to leave out.
- `Code origin` is truthful for tool-made source and uses the wording decided by the audit (section 4.3,
  point 10). `Adapted bodies` is `none`: the engine adapts no body.
- One origin label per name, per line, as section 12.1 lists.
- No comment names a model, tool, pipeline or path, and none says "generated by" (R40).
- A needed exception to a code rule is written as `// RULE-EXCEPTION:` only where upstream allows it, with
  the reason; the engine prefers not to need one.
- The engine's own provenance record (inputs, rule trail, evidence) is stored privately under
  `.local/orchestrator/recon/` and, as counts and codes, with the attempt.

### 15.4 Plausibility

A candidate that matches through contortion will be rejected upstream and wastes a review. Run on every
would-be winner:

- Upstream's `tools/lint_reconstruction.py` and the enforced rows of `tools/check_code_rules.py`.
- No statement without effect on the IR; no value computed and unused; no branch that cannot be taken.
- No construct whose only recorded justification is a byte difference. Every rewrite that closed the match
  names the general rule it came from, and that rule says what a programmer would have meant by it.
- Casts only where types require them; no reinterpretation of a pointer to silence the compiler.
- Bounded nesting and statement size; no expression no programmer would write on one line.

A byte match that fails these is `MATCHED_IMPLAUSIBLE`: kept privately as a lead, never sent to the gate,
reported in its own column. The plausibility rules are versioned, tested, and part of the input digest.

---

## 16. Compiler integration

Integrate the actual compiler toolchain required by the reference repository.

Discover and preserve:

- Compiler version and the digest of its binaries.
- Target architecture.
- ABI.
- Optimization settings.
- Floating-point configuration.
- Preprocessor definitions.
- Header dependencies.
- Include paths.
- Linker settings (objects are compared before linking; record that nothing is linked).
- Approved recipe-selection rules.
- Relevant environment configuration: SDK, Wine version and prefix or native host, locale, code page.

Support:

- Per-function compilation.
- Translation-unit compilation.
- Dependency-aware builds.
- Compiler diagnostics, parsed into structured form and bounded.
- Object-file inspection.
- Symbol extraction.
- Relocation inspection.
- Build artifact caching.
- Reproducible compilation.

### 16.1 The compile loop

```text
candidates of one function
   -> scratch translation unit(s) with the unit's recipe, headers and include roots
   -> one cl process for a batch
   -> per candidate: COMDAT code section, relocations, unwind and exception data
   -> comparison with the target through upstream's modules, in process
   -> digest, deduplicate, distance, diagnosis
distance 0
   -> rebuild in the exact unit, exact header, exact recipe, all packet functions together
   -> comparator modules again, with binding
   -> plausibility
   -> answer
```

- Measure which isolation keeps code identical to the unit form: a namespace per candidate, a class per
  candidate, or one file per candidate in one `cl` call. Process start dominates, so batches should hold
  many candidates; find the size where throughput stops growing.
- If batch form and unit form ever disagree, **the unit form wins**, and the disagreement becomes a
  regression test.
- A compile error in one candidate must not lose the batch: split and retry deterministically, then record
  the failing candidate with its diagnostic class.
- Measure Wine in WSL against native `cl` on Windows for speed *and* identical output, then choose. If both
  are used, they must be shown byte-identical on the synthetic corpus for every recipe in use.
- Compile jobs of all slots and the Gate Keeper's compares share **one machine-wide limit**. Six slots with
  four jobs each on four cores is a failure of design.

### 16.2 Recipes

Treat the approved compiler recipe as part of the reconstruction input.

Alternative compiler recipes may be explored only when explicitly authorized by the reference project's
rules: what `data/recipe-alternatives.json` permits (for example `noeh` only when the target has no
exception frame), and what a unit may declare on its `Recipe:` line. A recipe change applies to the whole
unit, so it must not break functions the unit already matched; check them in the same build.

Diagnostic compilation under alternative configurations must not be treated as an accepted reconstruction
under the required configuration.

If a candidate matches only under an unauthorized recipe, classify it as a compiler-recipe blocker
(`RECIPE_BLOCKED`), with the recipe named for the user.

Never modify acceptance rules, recipes, or upstream verifier inputs simply to increase the reported
reconstruction success rate. The orchestrator checks a digest of the protected files (`protectedDigest`)
before and after a compare; the engine writes nothing there.

---

## 17. Independent verification

Reuse the reference repository's existing comparison implementation.

The final verifier must be independent from candidate ranking and synthesis decisions. In this system the
independence is structural: the **Gate Keeper** runs upstream's comparator in the slot worktree, in another
process, from files on disk, knowing nothing about the engine. The engine's own use of the comparator
modules is advisory.

Support the comparison requirements applicable to the target, including:

- Function size.
- Complete required byte ranges.
- Instruction encoding.
- Relative calls and branches.
- RIP-relative references.
- Relocations.
- Data references.
- Function aliases.
- Identical-code folding.
- Padding.
- Compiler-generated code.
- Unwind information.
- Exception metadata.

Know upstream's reason codes and keep them verbatim. They include: `function-size-mismatch`,
`code-byte-mismatch`, `function-symbol-missing`, `function-symbol-ambiguous`, `unresolved-symbol`,
`undeclared-alias`, `relocation-target-mismatch`, `relocation-overflow`, `unsupported-relocation`,
`malformed-relocation`, `unwind-info-mismatch`, `unwind-coverage-missing`, `unwind-coverage-extra`,
`unwind-chain-mismatch`, `unwind-chain-outside`, `unwind-entry-overlap`, `unwind-entry-crosses-boundary`,
`unsupported-unwind`, `eh-handler-mismatch`, `eh-data-mismatch`, `eh-data-unaccounted`,
`eh-reference-mismatch`, `eh-reference-kind`, `eh-funclet-extent`, `eh-funclet-entry-inside`,
`eh-funclet-outside`, `eh-funcinfo-unsupported`, `eh-catch-type-mismatch`, `unsupported-eh-handler`,
`tls-index-mismatch`, `tls-reference-kind`, `tls-offset-outside-template`, `symbol-map-conflict`,
`overlapping-function`, `candidate-boundary-unsupported`, `coverage-gap`, `object-provenance-mismatch`,
`stale-recipe`, `stale-source-revision`, `image-hash-mismatch`. Read the full list from the comparator at
the pinned base; an unknown code is an engine error to fix, never a default.

Only apply normalization, relocation handling, padding exclusions, or other comparison adjustments
explicitly permitted by the reference project. Never introduce a new exclusion solely to make a candidate
pass.

A candidate must not be marked as matched if any required verification condition remains unchecked,
including unwind coverage, exception data and the binding of every reference.

Distinguish between:

| State | Meaning | Decided by |
|---|---|---|
| `SEMANTICALLY_VALID` | Candidate IR equivalent to target IR under stated assumptions | engine |
| `COMPILED` | Compiles under the unit's recipe | engine |
| `BYTE_MATCHED` | Comparator modules report pass on the exact-unit scratch build | engine (advisory) |
| `PLAUSIBLE` | Passes lint, code rules and section 15.4 | engine |
| `VERIFIED` | Packet `passed`: Gate Keeper pass on the real unit in the slot worktree | Gate Keeper |
| `STAGED` | Re-verified in its batch, dry run clean | staging |
| `ACCEPTED` | Upstream `matched`: two hosts, one review, merged | upstream only |

These states must not be treated as interchangeable. Reports never use a word of a later state for an
earlier one. The orchestrator's `TaskState` values stay as they are; the engine's states live beside them.

Where additional semantic validation is available, use it to detect invalid assumptions and prevent false
positives.

A byte match is an acceptance result under a defined comparison contract, not proof that the exact
historical source code has been recovered.

**No exception for the engine.** Do not add, loosen or special-case any Gate Keeper rule for deterministic
answers. A rule that rejects legitimate engine output is a finding to report with evidence.

---

## 18. Deterministic mismatch diagnosis

When verification fails, generate a structured mismatch classification.

Supported failure categories should include:

```text
INSTRUCTION_SELECTION_MISMATCH
INSTRUCTION_ORDER_MISMATCH
FUNCTION_SIZE_MISMATCH
REGISTER_ALLOCATION_MISMATCH
STACK_LAYOUT_MISMATCH
CONTROL_FLOW_MISMATCH
BRANCH_LAYOUT_MISMATCH
TYPE_INFERENCE_MISMATCH
SIGN_EXTENSION_MISMATCH
FLOATING_POINT_MISMATCH
MEMORY_ACCESS_MISMATCH
CALLING_CONVENTION_MISMATCH
FUNCTION_SIGNATURE_MISMATCH
RELOCATION_MISMATCH
SYMBOL_BINDING_MISMATCH
ALIAS_OR_FOLDING_MISMATCH
UNWIND_MISMATCH
EXCEPTION_DATA_MISMATCH
DEPENDENCY_MISMATCH
COMPILER_RECIPE_MISMATCH
RECIPE_BLOCKED
UNSUPPORTED_INSTRUCTION
UNSUPPORTED_CONSTRUCT
LAYOUT_UNKNOWN
INSUFFICIENT_EVIDENCE
MATCHED_IMPLAUSIBLE
COMPILER_ERROR
VERIFICATION_ERROR
SEARCH_SPACE_EXHAUSTED
SEARCH_BUDGET_EXHAUSTED
```

`SEARCH_SPACE_EXHAUSTED` (the rules are insufficient) and `SEARCH_BUDGET_EXHAUSTED` (the budget was) are
different results with different remedies. Never merge them.

Map every category to:

- The comparator reason codes and observable evidence that produce it.
- A bounded set of applicable transformations or constraint refinements, by rule id.
- An upstream give-up category: `control-flow | register-schedule | inline-set | layout-unknown | eh-frame |
  callee-missing | signature-wrong | other`. The user may file one later. The engine files nothing.

The diagnostic engine must identify plausible causes based on observable evidence: comparator reasons,
aligned instruction differences (`align.py`, `disasm.py`), unwind field differences, frame size, saved
register sets, call sequence, constant differences, and the binding report.

Initial mapping, to be extended from evidence:

| Observed | Category | First refinements |
|---|---|---|
| Size equal, one immediate differs | `MEMORY_ACCESS` or `TYPE_INFERENCE` | Layout offset or call argument (cookbook 69, 70) |
| Same operations, other registers only | `REGISTER_ALLOCATION` | Result-local and class-type-local rules once; then stop (cookbook 12) |
| `movzx`/`movsx` or compare width differs | `SIGN_EXTENSION`, `TYPE_INFERENCE` | Integer type and signedness dimension |
| Branch sense inverted, same blocks | `BRANCH_LAYOUT` | Polarity, early return, joined conditions |
| Extra or missing block | `CONTROL_FLOW` | Structure alternatives, shared exit, tail duplication |
| Different frame size or save set | `STACK_LAYOUT`, `UNWIND` | Locals' scope and type, address-taken locals, calls introduced |
| State store or handler missing | `EXCEPTION_DATA`, `UNWIND` | Scoped objects, throwing callees, `noeh` if permitted |
| `function-symbol-missing` | `SYMBOL_BINDING`, `FUNCTION_SIGNATURE` | Owner class, `const`, parameter list, destructor kind |
| `undeclared-alias` | `ALIAS_OR_FOLDING` | Folded set from the image; symbol-map rules |
| `relocation-target-mismatch` | `RELOCATION`, `DEPENDENCY` | Callee or global identity, slot order, literal naming |

Example:

```text
Mismatch:
    Additional floating-point comparison branch (parity test).
Possible causes:
    Floating-point semantics.
    NaN handling.
    Approved compiler floating-point configuration.
    Incorrect source comparison representation.
Permitted corrective actions:
    Refine floating-point semantic constraints.
    Enumerate equivalent comparison representations.
    Inspect the required compiler recipe; consider o2-fpfast only if the unit may declare it.
    Recompile and independently verify.
Prohibited corrective actions:
    Delete generated machine-code bytes.
    Ignore the mismatching branch.
    Change the required recipe without authorization.
    Mark the function as matched based on similarity.
```

Distinguish observed differences from inferred causes; store them in separate fields.

Never assume that every mismatch has a uniquely identifiable source-level cause.

**Privacy of diagnosis.** A full diagnosis quotes target instructions, so it is written only under
`.local/orchestrator/recon/`. What leaves the engine is category, rule ids and counts. An event, log line,
verdict finding, database row or API response never carries a byte, operand or listing line.

---

## 19. Automated reconstruction feedback loop

Implement the following logical workflow:

```python
def reconstruct(function, configuration, budget):
    analysis = analyze(function)
    ir = lift_and_validate(analysis)
    constraints = infer_constraints(ir)

    search = create_deterministic_search(
        ir=ir,
        constraints=constraints,
        configuration=configuration,
    )
    search.restore_checkpoint_if_inputs_match()

    while search.has_candidates() and budget.has_capacity():
        batch = search.next_batch()                 # deterministic order, bounded size

        valid = []
        for candidate in batch:
            if validate_semantics(candidate, ir):
                valid.append(candidate)
            else:
                search.record_rejection(candidate)

        for candidate, artifact in compile_batch(valid, configuration):   # results in candidate order
            if artifact.failed:
                search.refine(classify_compilation_failure(artifact))
                continue

            verification = compare_with_upstream_modules(artifact, function)

            if verification.passed:
                exact = rebuild_in_exact_unit(candidate, configuration)
                if not exact.passed:
                    search.record_batch_unit_disagreement(candidate, exact)
                    continue
                if not plausible(candidate):
                    search.record_implausible_match(candidate)
                    continue
                return record_byte_matched_candidate(candidate, exact)

            search.refine(classify_mismatch(function, artifact, verification))

        search.checkpoint()

    return record_unresolved_function(search)
```

This pseudocode defines the required behavior, not the mandatory implementation language or exact
interface. `record_byte_matched_candidate` is **not** acceptance: the result goes back to the server, through
the shared tail, to the Gate Keeper, which alone may call the packet passed.

Every candidate attempt must be attributable to a defined transformation, hypothesis, or constraint. The
*rule trail* of a solved function lists them in order.

The search must:

- Avoid previously evaluated candidates.
- Detect repeated failure patterns (same code digest, same diagnosis, no improvement over N batches).
- Maintain deterministic candidate ordering.
- Persist search state.
- Support interruption and resumption.
- Enforce explicit computational budgets, counted in operations: candidates, compiles, solver resource
  units, IR nodes, pattern expansions.
- Terminate when the search space or configured budget is exhausted.

Never allow infinite retry loops. An unresolved function must not block unrelated reconstruction jobs, and
an unresolved function in a packet must not discard solved ones: the orchestrator already splits matched
functions out of a packet (`splitMatched`); use it.

### 19.1 How the loop meets the orchestrator

| Engine outcome | Orchestrator handling |
|---|---|
| Some or all functions solved | One attempt with their edits; shared tail; Gate Keeper; normal route |
| Gate Keeper passes | `accept`, then staging per the run's `staging` setting |
| Gate Keeper rejects an engine answer | An engine defect. Record the disagreement, keep the packet, escalate; no second identical attempt |
| Nothing solved | No files written, no gate call. Route `escalate` to the next tier, or `dead_letter` with the reason codes on the last |
| `unsupported` or `blocked` | Same, with that reason; the packet is eligible again when engine, rules or declarations change |
| Crash, hang, protocol error | Infrastructure failure: slot reset, packet requeued within a bound, not charged, not a strike |
| Abort or run cancel | Checkpoint kept; packet released as today |
| Lease lost | Route `stale`, as today |

One attempt of a deterministic tier is one complete budgeted search, so its `maxAttempts` defaults to 1.
Running the same inputs again would give the same answer.

---

## 20. Reconstruction pattern and compiler behavior database

Build a versioned knowledge base containing reusable computational rules and validated observations.

Store:

- Instruction patterns.
- Semantic IR patterns.
- Graph structures.
- Type constraints.
- C++ lowering rules.
- Compiler behavior observations.
- Applicable compiler versions and recipes.
- Transformation preconditions.
- Validation requirements.
- Known failure classifications.
- Successful generalized reconstruction strategies.

The database must distinguish between:

- Authoritative instruction semantics.
- Validated compiler behavior (confirmed by a synthetic experiment under the pinned compiler).
- Reusable reconstruction rules.
- Empirical observations.
- Unverified hypotheses.

Each entry records its kind, compiler build and recipes, preconditions, evidence with counts, status, author
(hand-encoded from the cookbook, or mined) and version. The whole store has one version digest that is part
of every input digest.

Extract reusable structural information automatically from successfully verified reconstructions where
permitted. Mining works on *transformations* (what change in the candidate removed which symptom), never on
finished bodies.

A successful transformation for one function does not automatically establish its validity for another
function. Every reusable transformation must have explicit applicability conditions and validation rules.

Reject a mined rule when:

- Its evidence is one function, or several of one code-shape cluster.
- It reproduces a body or a large part of one.
- No synthetic experiment confirms it.
- It carries a name, address or constant of the target.

Storage:

- **In this public repository**: rules as code or data whose content is C++ patterns, conditions, prose and
  synthetic evidence only.
- **Private, under `.local/orchestrator/recon/`**: anything derived from target code, including mined
  statistics before they are generalized.

Game-derived proprietary artifacts must remain local and must not be included in publicly distributed
pattern databases.

Keep this store apart from the orchestrator's `skills*` and `lessons` tables, which hold model-written
prose. The engine neither reads nor writes those.

---

## 21. Determinism and reproducibility contract

Determinism is a mandatory system property.

Given identical:

- Executable digest.
- Function inventory revision.
- Engine version.
- Dependency versions.
- Analysis configuration.
- Compiler recipe.
- Compiler environment.
- Pattern database version.
- Search budget.
- Initial reconstruction state (unit content, carried bodies, declarations).

The engine must produce equivalent canonical results across repeated executions: the same solved source
byte for byte, the same status, reason code, counters and rule trail.

**Input digest** of a function: executable SHA-256, RVA and size, engine version, rule-store digest,
dependency lock digest, digests of every imported upstream module, recipe file digest, compiler binary
digests and host kind, digests of every header in the include closure, current unit content, options,
budgets, plausibility rule version. It is stored as the attempt's `bundleHash`.

Implement:

- Stable iteration ordering.
- Canonical serialization.
- Content-addressed identifiers.
- Explicit algorithm configuration.
- Stable candidate enumeration.
- Deterministic tie-breaking.
- Deterministic database processing.
- Versioned transformations.
- Reproducible cache keys.
- Pinned dependencies and toolchains.

Avoid dependence on:

- Wall-clock timing.
- Unordered collection iteration (and set `PYTHONHASHSEED=0` as a second line of defence, not the first).
- Worker completion order.
- Uncontrolled randomness.
- External network responses.
- Mutable global configuration.
- Unversioned environmental state.

Use operation-count budgets for deterministic search termination. Z3 runs single-threaded with a fixed seed
and `rlimit`, never a timeout. Wall-clock limits may serve as operational safety controls, but interrupted
searches must retain resumable state, and a search stopped by the clock reports `INTERRUPTED`, not a
result.

Separate operational telemetry, timestamps, and execution durations from canonical reconstruction results.

Parallel execution must not alter candidate-selection semantics or final accepted results. Parallel compiles
are consumed in candidate order.

The orchestrator's dispatch order is not deterministic and need not be. Per-function results must not depend
on it except through carried unit content, which is in the input digest.

Test this contract explicitly (section 25).

---

## 22. Scheduling, persistence, and scalability

Design the system for executable-wide reconstruction workloads, using the orchestrator for everything it
already does.

| Capability | Provided by |
|---|---|
| Single-function execution | Run with `selection: rva_list`; CLI `recon solve` |
| Address-range execution | `rva_list` from the gatherer or CLI filter |
| Function-family execution | Gatherer filter by unit, class or name pattern; engine family report |
| Complete inventory execution | `selection: gather` over eligible unmatched functions |
| Parallel independent reconstruction | Worktree slots; engine compile jobs |
| Dependency-aware scheduling | Upstream ready queue; gatherer readiness order |
| Persistent job queues | `tasks` with leases |
| Checkpointing | Engine search checkpoints (private) |
| Interruption recovery | Lease expiry and reclaim, plus engine resume |
| Failed-job reprocessing | New run over failures whose inputs changed (section 23) |
| Verified-function skipping | Gatherer exclusions, `takenNow`, staged and matched sets |
| Selective invalidation | Input-digest comparison |
| Incremental analysis | Per-image and per-function caches |
| Content-addressed artifact reuse | Engine cache under `.local/orchestrator/recon/` |

Decide and document how each existing scheduling feature treats a deterministic tier:

- **Difficulty routing and `capability`**: the engine's power is not an LLM capability step. A deterministic
  tier takes every difficulty it is configured for; its reach is decided by coverage, not by score.
- **Work stealing (`stealDown`) and `helpUp`**: an LLM tier must not steal a packet before the engine has
  tried it, and an idle deterministic slot must not pick up an LLM-only packet.
- **`maxFunctionsPerWorker`** (60, meant for LLM sessions) must not apply, and `capacityBlocked` must not
  stall a deterministic-only run.
- **Budget pause** never triggers on zero cost. **Outage pause** must not stop deterministic work, and
  `NoEligibleAccountError` must not dead-letter its packets.
- **Fix packets** (`task.fix`): a deterministic tier runs only their free attempts and passes the rest on
  uncharged, because repairing an LLM candidate means reading it.
- **Skills, curator, LLM review, pre-warm** never fire for a deterministic-only run.
- **Attribution**: attempt model `recon-engine-<version>`, account null, zero tokens and cost; the token must
  satisfy `attribution.ts`.
- **Staging**: `branches | off` as today. Live-backlog evaluation runs default to `off`.

Presets: `flows/deterministic.json` (engine only) and `flows/deterministic-first.json` (engine, then the
existing ladder). Both must load in the flow builder and pass validation.

Prioritize functions using deterministic criteria such as:

- Function size.
- Instruction count.
- Control-flow complexity.
- Dependency availability.
- Type information completeness.
- Supported instruction coverage.
- Similarity to validated generalized patterns.
- Expected reconstruction cost.

An engine pre-scan over the inventory (lift, types, no search) can compute most of these cheaply; the
gatherer may use its counts as a filter and an order. Do not use random scheduling.

Implement explicit resource limits for:

- CPU utilization.
- Memory consumption (7 GB total in WSL *(snapshot)*; a worker must state and respect its ceiling).
- Compiler processes (one machine-wide limit, section 16.1).
- Concurrent workers.
- Artifact storage, with deterministic eviction of reproducible entries.
- Candidate attempts.
- Search expansion.

Benchmark actual throughput before making performance claims.

An operational objective is to scale toward thousands of independently verified functions per day. This is
a performance target, not a guaranteed outcome or substitute for correctness.

---

## 23. Function lifecycle and persistence

Track each function through an explicit state machine. Use repository terminology wherever applicable and
maintain internal states equivalent to:

```text
DISCOVERED
QUEUED
ANALYZING
ANALYZED
IR_GENERATED
CONSTRAINTS_RESOLVED
SYNTHESIZING
CANDIDATE_GENERATED
COMPILING
COMPILED
VERIFYING
BYTE_MATCHED
VERIFIED
ACCEPTED
FAILED
BLOCKED
UNSUPPORTED
BUDGET_EXHAUSTED
INVALIDATED
```

Correspondence with what exists:

| Engine state | Orchestrator | Upstream |
|---|---|---|
| `DISCOVERED` | gathered function | offered target |
| `QUEUED` | task `pending` | local claim |
| `ANALYZING` to `VERIFYING` | task `leased` | |
| `BYTE_MATCHED` | task `gating` | |
| `VERIFIED` | task `passed`, `staged` | |
| (batch held) | task `withheld`, `set_aside` | |
| `ACCEPTED` | (read back from upstream) | `matched` |
| `FAILED`, `BLOCKED`, `UNSUPPORTED`, `BUDGET_EXHAUSTED` | escalated or `dead`, with reason | possible give-up, user's choice |
| `INVALIDATED` | new packet in a later run | |

The existing `TaskState` (`pending, leased, gating, passed, staged, withheld, set_aside, quarantined, dead,
cancelled`) is not extended for this; engine states are separate rows.

Persist, in new additive tables (for example `recon_functions` and `recon_results`):

- Function identifier.
- Original address and size.
- Executable digest.
- Inventory revision.
- Engine revision.
- Analysis digest.
- IR digest.
- Candidate source digest.
- Compiler recipe digest.
- Dependency digest.
- Verification results (codes and counts).
- Attempt count.
- Failure classification.
- Search checkpoint (a reference to a private file).
- Provenance (labels, rule trail ids).
- Operational timestamps.

**What may be in SQLite:** RVAs, names, sizes, counts, reason codes, digests of inputs and of our own source.
**What may not:** bytes, listings, operands, decoded constants, IR dumps. Digests of IR and analysis are
digests only. The private artifacts live under `.local/orchestrator/recon/`.

Distinguish transient failures, permanent unsupported features, dependency blockers, and exhausted search
budgets.

A failed function must be eligible for reprocessing when relevant engine capabilities, patterns,
declarations, or dependencies change, **and only then**. Record per failure what would have to change: the
missing instruction form, the missing layout, the callee declaration, the recipe, the budget. A re-run over
failures with unchanged input digests is refused with a message.

Previously accepted functions must be invalidated when changes affect their verification assumptions: image,
recipe, compiler, comparator contract, or a header in their include closure. Invalidation means
re-verification through the Gate Keeper; it never edits upstream state.

---

## 24. Observability and progress reporting

Integrate with the existing progress infrastructure: the orchestrator's events, run page, packet drawer and
desk (`apps/web`, `tools/desk/collect.py`), and upstream's progress data as a read-only source. Do not build
another dashboard.

Provide structured logs, machine-readable reports, and actionable diagnostics.

Track at minimum:

- Total inventory size.
- Eligible functions.
- Analyzed functions.
- Successfully lifted functions.
- Generated candidates.
- Successfully compiled functions.
- Independently verified functions.
- Accepted functions.
- Unsupported functions.
- Blocked functions.
- Byte-matched but implausible functions.
- Reconstruction success rate.
- Function coverage.
- Byte coverage.
- Compiler invocations per function.
- Candidates evaluated per function.
- Average and percentile reconstruction durations.
- Verified functions per hour and day.
- Cache hit rates.
- Failure-category distribution.
- Instruction coverage.
- Resource consumption.
- Functions finished by the engine, and functions finished by LLM tiers after the engine failed.
- Gate Keeper disagreements with the engine's own comparison (target: zero).

Where they appear:

| View | Addition |
|---|---|
| Flow builder | Deterministic node: kind, budgets, compile jobs, size limit; no pool fields |
| Run page | Engine tier row: attempted, solved, unsupported, unsolved, candidates and compiles per function |
| Packet drawer | Stage progress, status and reason per function, rule trail ids, counters; no listings |
| Desk, Overview and Solved | Engine column next to models, with verified and accepted kept apart |
| Desk, Models | `recon-engine-<version>` as a worker, without token columns |
| Desk, Near misses | Engine diagnosis category next to upstream's reason |
| Events | `recon.started`, `recon.progress`, `recon.result`, `recon.failed` (names to be fitted to the existing scheme) |

Distinguish total historical matches from newly reconstructed matches.

Measure reconstruction success using independently verified functions, not generated source files or
successful compilations.

Use explicit denominators for coverage metrics: of all unmatched, of attempted, of lifted, of compiled.

Do not fabricate progress, throughput, completion estimates, or benchmark results. A number that no source
records is shown as a dash.

Public reports must comply with repository sanitization and provenance requirements.

---

## 25. Testing and verification strategy

Build a comprehensive automated test suite. Engine tests run with `pytest`; server tests with the existing
`vitest` setup (`npm test`), with `SimRepo` and the mock provider; `npm run typecheck` covers the rest. Tests
that need the game, the toolchain or WSL are marked and skipped with a stated reason when it is absent;
everything else runs anywhere.

### Unit tests

Test:

- Binary loading.
- Address translation.
- Instruction semantics.
- Register aliasing.
- IR construction.
- SSA transformations.
- Memory semantics.
- Control-flow analysis.
- Data-flow analysis.
- Type inference.
- Candidate generation.
- Search algorithms.
- C++ emission.
- Compiler integration.
- Verification.
- Persistence.
- Diagnosis mapping: each comparator reason code has a category.
- Plausibility rules: legitimate samples stay clean, contorted samples are refused.
- Layer import direction.
- Protocol encoding, bounds and rejection of unknown fields.

### Property-based tests

Validate invariants for:

- Arithmetic semantics.
- Type conversions.
- IR transformations.
- Canonical serialization.
- Constraint refinement.
- Candidate deduplication.
- Deterministic ordering.
- State transitions.

Generators use fixed seeds recorded with the failure, so a failure always reproduces.

### Differential tests

Compare reconstructed behavior against controlled original programs. Where appropriate and feasible, use:

- Symbolic execution.
- SMT-based equivalence checking.
- Synthetic input generation.
- Controlled execution.
- Observable memory and return-value comparisons.

Also compare, on every function both can process: the engine's decoding against upstream's, its boundaries
against `.pdata`, and its advisory comparison against the Gate Keeper's verdict.

Do not claim universal semantic equivalence from a finite set of test inputs.

### End-to-end tests

Create original synthetic C++ fixtures covering:

- Constant returns.
- Integer arithmetic.
- Comparisons.
- Conditional expressions.
- Division and remainder by constants.
- Loops.
- Structures.
- Pointer manipulation.
- Function calls and tail calls.
- Floating-point operations.
- SIMD.
- Strings.
- Thread-local variables.
- Atomics.
- Virtual calls.
- Switch statements.
- Exception handling.
- Compiler-generated constructs: deleting destructors, adjustor thunks, vptr stores.

Compile fixtures with the supported toolchain, reconstruct them without providing their source to the
reconstruction engine, and independently compare the results. Build a synthetic image and pack from the
objects so that the engine uses the same loaders as for the real target.

Keep expected source code available only to the test harness when needed for validation. The harness
enforces it: the fixture source directory is not readable by the engine process during the test.

### Evaluation corpora

Every claim about the real target is measured on one of these, with its denominator:

1. **Synthetic corpus.** As above.
2. **Held-out matched corpus.** Functions already matched upstream. The engine must not read the `.cpp` of
   their unit, nor any body in the same code-shape cluster; the loader enforces it and a test proves it.
   Report by size bucket and by family, deduplicated by code shape, with trivial families (16 bytes or less,
   or generator-made) in separate rows. Split by a hash of the RVA: tune on one part, report on the other.
3. **LLM-dead set.** Functions this tool's LLM tiers left dead and nobody has matched since.
4. **Live backlog.** Unmatched packets in a deterministic-only run, with staging `off` by default.

For each: attempted, lifted, unsupported by cause, candidates, compiles, byte-matched, implausible,
gate-passed, failure distribution, candidates and compiles per solved function, time, peak memory, cache hit
rate. A figure quoted twice is reproduced twice.

### Orchestrator integration tests

With `SimRepo` and a fake engine process:

- A deterministic tier solves, partly solves, fails, escalates and dead-letters a packet.
- No account is configured; the run starts and finishes; the mock provider records zero calls.
- `exposureConsent` is absent; nothing asks for it.
- The engine crashes, hangs, writes a malformed line, writes an unknown field, exits without a result: the
  packet is not charged, no strike, the run continues.
- The run is aborted and the server is hard-stopped mid-search; after restart the packet is reclaimed and the
  search resumes to the same result.
- A provider outage does not pause deterministic work in a mixed flow.
- An LLM tier does not steal a packet the engine has not tried.
- More than 60 functions on one deterministic worker do not stall the run.
- A fix packet takes only its free attempt and moves on uncharged.
- Skills, curator, pre-warm and review make no call.
- Accepted and carried bodies in the unit are unchanged, byte for byte.
- Attribution names the engine, never the private configuration's default model.
- Every saved flow and run of the previous schema loads; a copied database of the live shape migrates.

### Gate-rule corpus

Add engine-shaped legitimate output to the existing rule corpus (it must stay clean) and engine-shaped cheats
(they must be caught). Do not weaken a rule to make the first group pass.

### Privacy tests

- Nothing the engine writes outside `.local/` contains a byte run, operand text or listing line of a fixture
  image.
- The result schema rejects any attempt to add such a field.
- A repository scan (also run before each commit) finds no pack, listing, object, executable, private path or
  user name.

### Regression tests

Every confirmed engine defect must produce a regression test, reduced to a synthetic fixture. Maintain a
reproducible corpus of synthetic and legally permitted integration cases.

### Determinism tests

Verify:

- Repeated sequential execution.
- Different worker counts and compile-job counts.
- Different task completion orders.
- Interrupted and resumed execution.
- Cold-cache and warm-cache execution.
- Repeated canonical serialization.
- Two different worktree slots, and paths of different length.

Canonical results must remain consistent.

---

## 26. Legal, licensing, and provenance requirements

Comply with the reference repository's actual:

- Legal restrictions (`LEGAL.md`).
- License.
- Contribution requirements (`docs/contributor-card.md`, `AGENTS.md`).
- Provenance policies (`PROVENANCE.md`).
- Clean-room requirements (`docs/clean-room.md`).
- Permitted input and output restrictions (`docs/authorizations.md`).

Use only legally obtained and authorized executable files: the one the checkout is already configured with.

Never:

- Download unauthorized proprietary executables.
- Redistribute game binaries.
- Commit proprietary executable bytes.
- Publish proprietary disassembly.
- Publish game-derived dumps.
- Publish restricted private symbols.
- Distribute unauthorized assets.
- Bypass licensing restrictions.
- Circumvent repository provenance requirements.
- Misrepresent how a reconstruction was produced.

Keep sensitive analysis artifacts in local, excluded storage.

**This repository is public.** In particular:

- Everything game-derived stays under the checkout's `.local/` (`repo.localDir`), in
  `.local/orchestrator/recon/`. Not in `data/`, not in SQLite, not in events, logs, error messages, test
  fixtures, commit messages or documentation.
- No digest of unmatched target code that this project computed itself is published. Upstream's own published
  target hashes stay where upstream put them.
- Local analysis by the engine is not exposure: nothing leaves the machine. Sending a pack or listing to a
  provider remains the owner's decision per run (`exposureConsent`) and is outside the engine.
- No user name, e-mail address, machine name or absolute private path appears in code, docs or commits.

Public reports must contain only information permitted by the reference project's policies.

If automated reconstruction conflicts with an existing contribution or clean-room requirement, isolate the
conflicting functionality and document the blocker before publishing or submitting results. Publishing and
submitting are the user's, not yours.

Do not assume that legally obtaining an executable automatically authorizes redistribution of all derived
material.

Check the licence of every dependency against AGPL-3.0-or-later. Record name, version, hash, licence and
reason in `docs/recon/TECHNICAL_DECISIONS.md`.

---

## 27. Implementation technology

Preferred stack:

| Component | Preferred technology |
|---|---|
| Orchestration | Existing: TypeScript, Node 22+, Fastify, better-sqlite3 (WAL), Zod, React |
| Engine | Python, the version the checkout's host has, in a locked virtual environment with pinned hashes |
| Performance-critical components | C++20, only where a profile proves Python too slow |
| Generated source | C++ as the unit's recipe compiles it (MSVC 19.x) |
| Binary analysis | Upstream `pecoff` and `x64`, plus iced-x86 at upstream's pin; others only with a documented need |
| Constraint solving | Z3 or an equivalent suitable solver, single-threaded, seeded, `rlimit` budgets |
| Persistent metadata | SQLite: the orchestrator's database for states and counts; a private store for game-derived caches |
| Intermediate interchange | Versioned canonical JSON; JSON Lines for the protocol |
| Build infrastructure | npm workspaces; the engine's own lock file; CMake only if C++ is added |
| Python testing | Pytest |
| TypeScript testing | Vitest, existing |
| C++ testing | A lightweight suitable framework, only if C++ is added |
| Compiler integration | Reference project's approved toolchain, through upstream's configuration |
| Verification | Reference project's comparator, through upstream's modules (advisory) and the Gate Keeper (decisive) |
| Process control | `repo/host.ts`, `util/proc.ts` |

These are preferences, not unconditional mandates. Select alternative technologies when justified by
repository compatibility, performance, maintainability, licensing, or correctness.

The audited repositories' actual requirements take precedence over preferred language versions and tooling.

Installing packages into WSL or Windows changes the user's machine: use a virtual environment inside the
private data directory, pin everything, and make `recon doctor` say exactly what is missing and how to add it.

---

## 28. Suggested repository structure

Adapt the following structure to the audited repository.

```text
decomp-orchestrator/
├── apps/
│   ├── server/src/
│   │   ├── recon/                      deterministic worker (TypeScript)
│   │   │   ├── worker.ts               processTask branch, outcome mapping
│   │   │   ├── protocol.ts             Zod schemas, bounds, versions
│   │   │   ├── process.ts              engine process: start, heartbeat, abort, kill
│   │   │   ├── limits.ts               machine-wide compile limit, shared with the gate
│   │   │   └── store.ts                recon tables
│   │   ├── orchestrator/               existing; shared tail factored out of processTask
│   │   └── db/                         existing; additive migration
│   └── web/                            existing; deterministic node and engine columns
├── packages/core/src/                  existing; FlowNodeData.kind, recon options, states
├── engine/
│   └── recon/
│       ├── README.md
│       ├── pyproject.toml              pinned, with hashes
│       ├── recon/
│       │   ├── core/
│       │   │   ├── contracts/          interfaces, versions, errors, configuration
│       │   │   ├── ir/                 model, ssa, memory, validation, transformations
│       │   │   ├── analysis/           control_flow, data_flow, memory, interprocedural
│       │   │   ├── inference/          types, signatures, structures, evidence
│       │   │   ├── structuring/
│       │   │   ├── synthesis/          constraints, rules, search, candidates
│       │   │   ├── emitter/
│       │   │   ├── diagnostics/
│       │   │   ├── plausibility/
│       │   │   └── persistence/        cache, checkpoints, canonical serialization
│       │   ├── adapters/
│       │   │   ├── x64_msvc/           decode, lift, abi, unwind, undo, cl, coff
│       │   │   └── skyrim/             image, inventory, packs, declarations, recipes, labels, binding
│       │   ├── rules/                  public rule store: rules, experiments, versions
│       │   ├── protocol/
│       │   └── cli/
│       └── tests/
│           ├── unit/
│           ├── property/
│           ├── integration/
│           ├── differential/
│           ├── regression/
│           └── fixtures/               original synthetic C++ only
├── flows/
│   ├── deterministic.json
│   └── deterministic-first.json
├── docs/
│   ├── PHASE5.md
│   └── recon/                          audit, architecture, contract, decisions, roadmap, benchmarks
└── (checkout)/.local/orchestrator/recon/   private, never in this repository
    ├── cache/  checkpoints/  results/  diagnosis/  venv/
```

The structure is illustrative.

Do not create empty architectural layers or placeholder modules simply to conform to this directory tree.
Introduce components incrementally when their responsibilities become necessary.

---

## 29. Command-line interface

Provide a coherent command-line interface supporting workflows equivalent to:

```bash
recon audit                                  # re-check audited facts against the current base
recon doctor                                 # environment, image hash, toolchain, upstream modules, versions
recon inventory [--unmatched] [--by size|construct|reason]
recon analyze --address <rva>                # CFG, IR summary, inferred signature, unsupported constructs
recon reconstruct --address <rva>            # one search; result JSON; writes nothing to a unit
recon reconstruct --family <family>
recon reconstruct --list <file> --jobs 4
recon verify --address <rva>                 # re-verify a stored result through comparator modules
recon explain --address <rva>                # private diagnosis, written under .local
recon resume --run-id <id>
recon retry --failure-category <category>    # only functions whose inputs changed
recon rules list | verify | mine
recon eval --corpus synthetic|heldout|dead [--limit N]
recon status
recon report --format json
recon benchmark --suite synthetic
```

Exact commands may differ based on existing repository conventions. The commands run where the checkout runs;
wrap them as npm scripts that use the configured host, so that they work the same from Windows and WSL.

Inventory-wide production runs (`reconstruct --all`) are **orchestrator runs** with a deterministic flow, from
the UI or API, because claims, leases, slots, gate, staging and batches live there. The CLI is for analysis,
evaluation and development, and never claims, stages, batches or submits.

The interface must support:

- Explicit configuration.
- Structured output.
- Meaningful exit codes.
- Machine-readable diagnostics.
- Safe defaults.
- Resumable execution.
- Scriptable integration.
- Offline reconstruction.

Never require interactive AI or manual function drafting to complete an automated reconstruction job.

API additions follow the existing style in `apps/server/src/api/server.ts`: read-only engine status, results
and reports per run and per packet, and the `doctor` result. No endpoint returns anything from `.local/`.

---

## 30. Development phases and acceptance gates

Implement the engine incrementally through the following phases. Commit and push each one when its gate
holds.

### Phase 1: Repository integration

Deliver:

- Repository audit of both repositories.
- Architecture documentation.
- Integration contracts, including the protocol and the outcome mapping.
- Environment validation (`recon doctor`).
- Minimal executable project skeleton with the locked environment.
- Initial automated tests.

Acceptance gate:

- Existing repository workflow is understood and documented, with file and line.
- Toolchain and verification integration points are identified, and a contract-equal local compare is
  measured against `sr compare`.
- The new project can execute its initial tests, and a protocol round trip from the server passes on this
  host and configuration.

### Phase 2: Binary analysis

Deliver:

- Executable loading with hash check.
- Address mapping.
- Inventory integration, including targets without a progress entry.
- Function identification.
- Instruction decoding.
- References, unwind and exception metadata, vtables and RTTI.

Acceptance gate:

- Selected function ranges are loaded and decoded accurately and agree with upstream's decoder.
- Unsupported inputs are rejected explicitly, with upstream's reason where one exists.
- The instruction and construct coverage report exists for the whole unmatched inventory.

### Phase 3: Semantic analysis

Deliver:

- Instruction lifting for the general-purpose integer subset.
- Basic blocks.
- Control-flow graphs.
- Data-flow analysis.
- Stack and register analysis.

Acceptance gate:

- Synthetic fixtures produce validated, reproducible analysis results.
- Every supported instruction form has passed execution-based differential tests.

### Phase 4: Intermediate representation

Deliver:

- Semantic IR.
- SSA representation.
- Memory model.
- IR validator.
- Initial transformation passes, including the first compiler-undo passes.

Acceptance gate:

- Supported instruction semantics are preserved and tested.
- Invalid IR cannot enter reconstruction.
- Each transformation passes its SMT check.

### Phase 5: First end-to-end reconstruction

Deliver:

- Basic type inference.
- Candidate generation (canonical form).
- C++ emission.
- Compiler integration with batching.
- Independent byte verification through upstream's comparator modules.

Acceptance gate:

- At least one nontrivial synthetic function (branches, member accesses, a call) is automatically
  reconstructed and independently verified without manual source implementation.

The complete vertical slice must work before expanding functionality.

### Phase 6: Target repository and orchestrator integration

Deliver:

- Skyrim inventory adapter.
- Project declarations integration.
- Compiler recipe integration.
- Reference verifier integration (comparator modules, and the Gate Keeper unchanged).
- Binding, labels, headers.
- The deterministic tier: schema, flow validation, worker, shared tail, limits, persistence, UI, presets, tests.
- Provenance-compatible output.

Acceptance gate:

- At least one eligible, previously unreconstructed target function is automatically reconstructed and
  reaches packet `passed` through the **unchanged Gate Keeper**, and its batch dry-runs clean. Then stop: the
  user submits.
- A deterministic-only run completes on `SimRepo` and on the real repository with no accounts and zero
  provider calls.
- Saved flows and runs load; the live database shape migrates.

> **Superseded.** Phases 7 to 10 below are replaced by Phases 7 to 13 of
> [DETERMINISTIC_MATCHING_CONVERGENCE.md](DETERMINISTIC_MATCHING_CONVERGENCE.md). They are kept for history.

### Phase 7: Compiler-aware synthesis

Deliver:

- Candidate search.
- Constraint refinement.
- Compiler feedback.
- Mismatch classification.
- Candidate deduplication.
- Search persistence.
- Rule store, with the cookbook encoded and each rule confirmed, refuted or marked untested.
- Plausibility checks.

Acceptance gate:

- The engine automatically resolves at least one controlled reconstruction mismatch through deterministic
  candidate refinement, with a recorded rule trail.
- A resumed search equals an uninterrupted one.
- Held-out results before and after are reported.

### Phase 8: Advanced reconstruction

Expand support for, in the order the measured demand gives:

- Complex control flow.
- Structures.
- Pointer aliasing.
- Indirect calls.
- Virtual dispatch.
- Floating-point behavior.
- SIMD.
- Strings, thread-locals, atomics.
- Exception handling.
- Interprocedural dependencies.

Acceptance gate:

- Each newly supported category includes semantic tests, synthetic reconstruction fixtures, and regression
  coverage.
- Each reports held-out and live results before and after.

### Phase 9: Large-scale automation

Deliver:

- Parallel workers across slots.
- Persistent scheduling through the queue.
- Dependency-aware execution.
- Checkpointing.
- Artifact caching.
- Selective invalidation.
- Progress reporting in the desk.
- The machine-wide resource limits.

Acceptance gate:

- The engine processes a representative batch of 500 functions in a deterministic-only run without manual
  intervention.
- Interrupted jobs resume correctly, including after the server is killed.
- Parallel execution preserves canonical results; the run repeats to the same per-function results.

### Phase 10: Performance and coverage expansion

Deliver:

- Benchmark suite.
- Performance profiles.
- Failure distribution analysis.
- Search-space optimizations.
- Compiler behavior improvements.
- Automated pattern generalization.
- Full eligible inventory execution.

Acceptance gate:

- Performance improvements are demonstrated through reproducible benchmarks.
- All eligible functions can be scheduled and processed.
- Unresolved functions receive explicit failure classifications.
- Reported progress agrees with independent verification results.

Do not declare a phase complete unless its acceptance criteria are satisfied.

If a phase is blocked by missing inputs, document the blocker and continue independent work that does not
violate architectural dependencies or acceptance requirements.

---

## 31. Engineering execution protocol

Follow this development cycle continuously:

```text
Inspect
  -> Identify the next measurable capability
  -> Define acceptance criteria
  -> Implement
  -> Test
  -> Verify
  -> Benchmark where relevant
  -> Document
  -> Commit and push
  -> Continue
```

For every implementation increment:

1. Inspect existing code before introducing new components.
2. Identify the smallest useful engineering deliverable.
3. Implement functional code rather than placeholders.
4. Write or update automated tests.
5. Run the relevant tests (`npm run typecheck`, `npm test`, engine tests).
6. Investigate failures.
7. Correct regressions.
8. Record architectural decisions.
9. Update implementation status.
10. Continue to the next justified increment.

Choose the next capability by measurement: the largest bucket of unsolved functions that one addition would
open, from the coverage and failure reports.

Do not spend excessive effort generating plans or documentation without implementing software.

Do not repeatedly ask for confirmation on reversible engineering decisions that can be resolved through
repository evidence and testing.

Do ask the user, and only then, for: acceptance or provenance policy that the evidence does not settle;
anything that publishes; a dependency whose licence is unclear; a change to a Gate Keeper rule; a restart of
the live server when something is active.

Do not implement speculative features before establishing a working vertical slice.

Do not suppress failing tests or weaken acceptance criteria.

Where requirements are ambiguous, choose the conservative, technically defensible interpretation and
document the decision.

Keep the working tree clean of unrelated changes: files modified by the running system (for example under
`data/`) are not part of your commits.

---

## 32. Mandatory engineering prohibitions

Never:

- Use AI to reconstruct target functions.
- Manually implement individual target functions.
- Hardcode answers for target addresses.
- Read an LLM's, a contributor's or a decompiler's body for the function being reconstructed.
- Call the twin or sibling-transplant tools from the engine, or count their results.
- Fake byte matches.
- Patch compiler output to obtain a match.
- Modify the original executable.
- Weaken independent verification, the Gate Keeper, or upstream's comparator.
- Edit upstream tools, recipes, target pins or verifier inputs.
- Ignore unsupported instructions.
- Fabricate type information.
- Fabricate semantic identifiers.
- Hide unresolved dependencies.
- Modify approved compiler recipes without authorization.
- Treat successful compilation as successful reconstruction.
- Replace verification with similarity scoring.
- Send an implausible match, a stub or a partial body to the gate.
- Introduce unbounded candidate search.
- Allow one function failure to terminate the entire inventory run.
- Make a provider call from a deterministic tier, or let one of its attempts be credited to a model.
- Publish unauthorized proprietary artifacts, or commit anything game-derived to this public repository.
- Submit, open a pull request, publish a claim, or offer to.
- Stop the live server unasked, or write to the live database from development.
- Fabricate tests, test results, metrics, or implementation progress.
- Claim complete executable reconstruction without evidence.

---

## 33. Definition of done

The final system must accept an authorized Skyrim SE 1.7.104 executable and the corresponding project
configuration, as the checkout and `config/orchestrator.json` already provide them.

Without AI inference or manual implementation of target functions, it must be capable of:

1. Loading and validating the executable.
2. Resolving the eligible function inventory.
3. Discovering and decoding function instructions.
4. Reconstructing control flow and data flow.
5. Lifting instructions into validated semantic IR.
6. Inferring type and signature constraints.
7. Synthesizing legitimate C++ candidates.
8. Compiling candidates using approved toolchains.
9. Independently verifying the compiled output.
10. Diagnosing reconstruction failures.
11. Refining candidate constraints.
12. Retrying within deterministic budgets.
13. Persisting verified reconstructions.
14. Recording unresolved and unsupported functions.
15. Resuming interrupted workloads.
16. Processing independent functions in parallel.
17. Producing reproducible and provenance-compatible results.
18. Reporting actual reconstruction coverage and performance.

And, inside the orchestrator:

19. Running as a deterministic tier, alone or before LLM tiers, from a saved flow in the UI.
20. Completing a deterministic-only run with no accounts, no consent and no provider call.
21. Passing every answer through the unchanged Gate Keeper, staging and dry run.
22. Leaving clean batches *ready* and stopping there.
23. Showing engine work in the existing views, separate from model work.
24. Leaving LLM flows, saved data and the live server's behaviour unchanged.

Successful reconstruction is defined exclusively through the applicable independent verification and
acceptance contract.

The engine must maximize verified coverage without compromising correctness, legal compliance, or
provenance.

The engine is considered operational when it can execute the complete pipeline over the eligible inventory
without requiring AI-assisted function drafting.

Operational completeness must be reported separately from function and byte reconstruction coverage.

---

## 34. Immediate execution directive

Begin implementation now.

Start by auditing the pinned upstream base and this repository. Identify the actual compiler recipes,
function inventory, reconstruction conventions, comparison machinery, legal restrictions, and contribution
requirements, and every place where the orchestrator assumes that a model produced the answer.

Establish the architecture and integration contracts from verified repository evidence.

Then implement Phase 1 and proceed incrementally toward the first independently verified end-to-end
reconstruction.

Do not respond with only:

- An architectural proposal.
- A feasibility assessment.
- A development plan.
- Pseudocode.
- A repository skeleton.
- A list of suggested technologies.

Produce actual implementation files, executable components, automated tests, integration tooling, and
documentation.

At each completed increment, report:

- What was implemented.
- Which files changed.
- Which tests were executed.
- Actual test results.
- Measured reconstruction results, with denominators.
- Known limitations.
- Remaining blockers.
- The next implementation increment.

If access to a required executable, repository, or toolchain is unavailable, explicitly identify the missing
dependency. Continue implementing and testing independent components using original synthetic fixtures where
possible.

The objective is not to make an AI agent better at decompiling Skyrim.

**The objective is to engineer a deterministic software system, running inside decomp-orchestrator, that
makes AI-assisted function drafting unnecessary.**

Build the engine.
