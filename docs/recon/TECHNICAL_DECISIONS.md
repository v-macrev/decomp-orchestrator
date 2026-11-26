# Technical decisions (dated log)

Newest last. A decision names its evidence; a reversal is a new entry, not an edit.

## D-001 · 2026-11-25 · Engine language and shape
**Decision.** Python, standard library only for now, in `engine/recon/`; one process per request over JSON
Lines; TypeScript worker in `apps/server/src/recon/`.
**Why.** Upstream's comparator, PE and COFF readers, binder and permuter are Python
(`tools/compare.py`, `tools/pecoff.py`, `tools/verifier/*.py`); importing them in process avoids a second
implementation of the acceptance contract. The orchestrator is TypeScript and talks to the engine through its
existing `Host` (`repo/host.ts`). No C++ until a profile proves Python too slow.
**Consequence.** Zero third-party runtime dependencies today, so there is no dependency licence to record yet.

## D-002 · 2026-11-25 · Dependencies: none yet; recorded when added
Table kept here when the first is added. Required columns: name, version, sha256 of the artifact, licence,
AGPL-3.0-or-later compatibility, reason. Candidates, none installed: `iced_x86` (upstream's own pin
`1.21.0`; licence to be read from the package before use), `z3-solver` (MIT, for IR transformation checks),
`capstone` (BSD, only as an independent decoder in differential tests), `hypothesis` (MPL-2.0, tests only).
`pip` is absent in WSL and `venv` is present, so installation is a private venv under
`.local/orchestrator/recon/venv/` with a hashed lock file, created by an explicit step that `recon doctor`
names; nothing is installed implicitly.

**Update 2026-11-25 (Phase 2): two dependencies installed in the private venv** by `scripts/setup-venv.sh`
from `requirements.lock`, `--require-hashes --no-deps`:

| Package | Version | sha256 of the wheel | Licence | Compatible with AGPL-3.0-or-later | Reason |
|---|---|---|---|---|---|
| `iced-x86` | 1.21.0 | `489789377bfc1fe432bd2a8a5780c9f3e7c35be2e6133b0de5432cd901cad32c` | MIT (`License: MIT` in the wheel metadata) | yes | Instruction decoding; upstream's own pin, so the engine agrees with upstream's generators |
| `capstone` | 5.0.9 | `273fd8d747d2e35c88f91450be51a603ecfaafb00d96d9f315dcb8689c86193e` | BSD (`License :: OSI Approved :: BSD License`; `LICENSE.TXT` in the wheel) | yes | An independent decoder for differential checks only; never used to produce an answer |

Both wheels are manylinux x86-64 (`cp38-abi3` and `py3-none`), so they run on this machine's Python 3.14. Both
have no dependencies. `capstone.__version__` reports `5.0.7` for the 5.0.9 wheel; the lock names the wheel.
`z3-solver` was added in Phase 4 (D-021).

## D-003 · 2026-11-25 · The engine runs in WSL, beside the checkout
**Evidence.** The checkout, packs and toolchain are in WSL (`config/orchestrator.json`, `repo.host`); the Windows
host has no Python (`REPOSITORY_AUDIT.md`, environment table), and `Host.run` already reaches WSL.
**Decision.** `engineDir` is translated to `/mnt/<drive>/…` for a WSL host (`process.ts` `toHostPath`); a
`local` host runs the same package with that host's `python`. A native `cl` on Windows is not measured and not
used.

## D-004 · 2026-11-25 · Tests that need the machine are skipped with a reason
Server tests that start the engine in WSL are skipped where WSL or the distribution is absent
(`describe.skipIf`, title says what is needed). Engine tests run anywhere with `pytest`.

## D-005 · 2026-11-25 · Two additions to the specified protocol
`checkout` in the request (`doctor` needs the private contrib config and the image path), and `command` plus
`report` in the result (one result type for all four commands). Both are optional or additive; the
specified fields are unchanged.

## D-006 · 2026-11-25 · Provenance wording for engine output — decided 2026-11-26: the default
Upstream's card asks that `Code origin` be truthful and that a claim name "the actual model id or agent/tool
name"; R40 refuses a comment naming a tool or pipeline, and the Families rule asks for a generator named by
version and digest. Engine output is neither written by a model nor by a person.
**Decision (the user's, 2026-11-26): keep the default.** `Code origin:` states, without naming a product, that the
body was "produced by a deterministic reconstruction tool from the compared function's behaviour in the pinned
image and the declarations of its class in this unit's header; no model wrote it" (`CODE_ORIGIN` in
`engine/recon/recon/adapters/skyrim/solve.py`); `Adapted bodies: none`; the claim and attempt model is
`recon-engine-<version>`. Whether upstream's review accepts that, and whether a set of engine units falls under the
Families rule, is upstream's decision at submission, which only the user makes.

## D-007 · 2026-11-25 · The engine never reads what a model wrote
Section 3 of the specification, applied: no `attempts.files_json`, stored candidates, `task.fix` candidates,
batch branches, give-up sources, skills, lessons or run knowledge; not the unit source of the function being
reconstructed; no decompiler output. Phase 6 enforces it in the loader and a test proves it. The Phase 1
engine reads nothing but the request.

## D-008 · 2026-11-25 · Canonical serialisation refuses floats
`core/canonical.py` accepts integers, strings, booleans, null, lists and objects with string keys. A float has
no canonical text across languages and platforms, so it is refused rather than rounded.

## D-009 · 2026-11-25 · How scheduling features treat a deterministic tier — planned, Phase 6
| Feature | Decision |
|---|---|
| Difficulty routing, `capability` | An engine tier takes every difficulty it is configured for; its reach is coverage, not score |
| `stealDown`, `helpUp` (`engine.ts:2745-2770`) | An LLM tier does not steal a packet the engine has not tried; an idle engine slot does not take an LLM-only packet |
| `maxFunctionsPerWorker` (`db/database.ts:295`) and `capacityBlocked` (`engine.ts:2777-2789`) | Not applied to an engine node |
| Budget pause (`engine.ts:2736-2744`) | Never triggers on zero cost |
| Outage pause (`engine.ts:3011-3016`), `NoEligibleAccountError` (`:3136-3141`) | Must not stop engine work or dead-letter its packets |
| Fix packets (`task.fix`) | Only their free attempts; the rest passes on uncharged |
| Skills, curator, LLM review, pre-warm | Never fire for an engine-only run |
| Attribution | Attempt model `recon-engine-<version>` (satisfies `MODEL_TOKEN`, tested), account null, zero tokens and cost |
| Staging | `branches` or `off` as today; live-backlog evaluation runs default to `off` |

## D-010 · 2026-11-25 · Machine-wide compile limit: reuse upstream's lock, do not invent one
**Evidence.** Upstream has a machine-wide heavy-job cap with file locks (`tools/local_load.py:33`,
`local_max_heavy`, `SR_LOCAL_MAX_HEAVY`), but `.local/verifier/runners.json` is absent here, so the cap is
unset. **Decision (to confirm when compile jobs exist in Phase 5).** Engine compile jobs take slots from the
same lock the Gate Keeper's compares use, rather than a second counter in the server. The prompt's
`limits.ts` is therefore not created until measurement shows the lock cannot serve.

## D-011 · 2026-11-25 · No pack, listing or game byte is read by the implementing agent
Applies to this development, not to the engine. The audit and the tests used only upstream's published
documents and code, hashes, counts and booleans. A function the engine cannot solve is debugged from its
reason codes and counters, and from synthetic fixtures built to reproduce the shape (section 3, "A rule whose
only evidence is one target function is not a rule").

## D-012 · 2026-11-25 · Function boundary: the inventory range, checked against `.pdata`, never replaced by it
**Evidence.** On the 62,247 unmatched targets the inventory range and `.pdata` agree in every case that has
unwind data (55,265 exact) and 6,982 have none (leaf functions). **Decision.** RVA and size come from upstream's
offered list. A disagreement (an entry crossing the range, overlapping entries, a range not readable from the
file) blocks the function with upstream's reason; the engine never picks between sources. In this image there
is nothing to block on, so this rule is exercised by synthetic tests only.

## D-013 · 2026-11-25 · Decode with iced-x86 behind an adapter; the table rule is explicit
iced is the decoder (upstream's pin, section 8's default); upstream's length decoder and capstone are checks, not
alternatives. MSVC puts switch tables after a function's code inside its range, so a whole-range sweep
mis-decodes them. The range's data start is the lowest forward address that a RIP-relative operand or an
image-relative displacement (value of at least 0x1000, below 2^31) reaches, and the code before it must decode
cleanly to exactly there. The known weakness (a forward reference to code) is documented by a test and reported
as `other-data` so it is visible rather than silent.

## D-014 · 2026-11-25 · Aggregates only leave the engine
Commands print counts; rows go only under a directory that has a `.local` component; the survey's mnemonic
demand is private. Public documents carry totals and categories, never instruction names or per-function data.

## D-015 · 2026-11-25 · Correction of D-003: the Windows host has Python; WSL stays the engine's host
**Evidence.** `py -0p` lists 3.13 and 3.10; D-003 rested on a probe of `python` alone. **Decision.** The engine still
runs in WSL in production, because the checkout, the toolchain wrapper and upstream's tools are there. It is also
tested on Windows (same lock, second hash per package): the engine is plain Python, the image-only commands need only
the pinned executable, and development does not depend on WSL being up. Whether compile batches run natively or
through Wine is **still open** and is measured in Phase 5, as section 16.1 asks.

## D-016 · 2026-11-25 · Correction of D-013: an ambiguous data reference blocks
The first rule accepted any clean instruction boundary as a table start and, when it was none, silently read the
range as code; a table after a decode error was "assumed data". Both chose between conflicting evidence, which
section 8 forbids. Now the code before a table must end in a terminator and must not branch into it; otherwise
the function is blocked (`ambiguous-data-reference`). An undecodable tail is an error, a branch into an instruction
blocks, unidentified trailing data blocks, and an inventory that contradicts itself is refused. On the real image
none of these occurs (62,247 of 62,247 still decode).

## D-017 · 2026-11-25 · Own semantics for the integer subset, validated on the processor
Section 9 asks to reuse a reliable lifting framework. **No framework was evaluated by trial here**; the reason not to adopt one is that
it would add a large dependency with its own licence and flag conventions and would still have to be validated form by form, which is
most of the work. Revisit for vector code, where the balance may differ. **Decision.** A small lifter over the decoder already pinned; its authority is execution, not its author.
**Validation.** Each form runs on the processor with generated operands, edge values and related operands; the whole integer state, the
memory and stack windows and the way control goes are compared. A trap the semantics predict is repeated in a child process and must
end it as predicted. The generated region sits at a fixed address so that the same vectors repeat. The recorded table carries a digest of
every source it depends on; a lifter that differs from it validates nothing.

## D-018 · 2026-11-25 · Switches and tail calls only from evidence
An indirect jump is a switch when the target is the image base plus an entry loaded from the table data the decoder set apart, a
comparison of that same index bounds it, the bounded block has one way in, and every entry is an instruction of the function. It is a
tail call when there is no table in the range and the target is a whole pointer (read from memory or held in a register). Everything else is
`unresolved` and stays visible.

## D-019 · 2026-11-25 · A call that nothing follows does not return
When only padding or nothing follows a call before the function's end, control cannot come back there; the block ends in
`noreturn-call`. Any other fall off the end is `CONFLICTING_EVIDENCE`. No list of functions is used.

## D-020 · 2026-11-25 · The frame analysis states its one assumption
A store through a pointer that is not followed is taken to miss the saved registers' slots once a frame address has been indexed or has
left the function; otherwise no function with a local array could be analysed. Results list the assumption when it was used, so a later
phase can weigh it, and unwind data (which comes from the compiler) is compared independently.

## D-021 · 2026-11-25 · `z3-solver` 4.13.4.0 joins the lock (update of D-002)

| Package | Version | sha256 of the wheels | Licence | Compatible with AGPL-3.0-or-later | Reason |
|---|---|---|---|---|---|
| `z3-solver` | 4.13.4.0 | in `requirements.lock` (manylinux and Windows x86-64) | MIT (wheel metadata) | yes | Proves rewrite rules, transformations and compiler-undo hypotheses |

One solver per question, one thread, fixed seed, budget in `rlimit` units (no wall clock), so an answer does not depend on the machine.
"unknown" is never counted as proved. The module is imported only where a proof is made.

## D-022 · 2026-11-25 · Floating point and vectors: own semantics again, on integers
Phase 3's reason holds for vector code (D-017 asked to look again): what costs effort is validating forms, not writing them.
`core/softfloat.py` computes binary32 and binary64 on bit patterns with integers only, so that no result depends on the host; it is checked
against the host's arithmetic, z3's and, through every lifted form, the processor's. Operations are on lanes of a 128-bit value.
**Fixed environment**, recorded as an assumption wherever it matters: round to nearest, subnormals kept, exceptions masked (what the Windows
ABI promises at function entry). A function that changes the control register is refused. The reciprocal approximations are *opaque*: a
function of their operand that is not computed, because their value differs between processors.
In SMT comparisons of two functions a floating operation on non-constants is an uninterpreted function: equal operands give equal results,
and nothing else is concluded.

## D-023 · 2026-11-25 · The thread block is reached through a location of its own
`gs:` is an address relative to a base that lives in a location, like any register's entry value. Nothing is known about the block; it is
a memory region with that base. The validation harness never writes through it.

## D-024 · 2026-11-25 · The IR
SSA values and memory tokens in one form; registers and the stack pointer do not exist in it (frame addresses are `frame(offset)`).
Memory is cut into regions: private frame slots, fields by offset from an entry value, globals, the open frame, everything else; an operation
names each region it may touch and the token it reads and makes. Machine detail (instruction addresses, copies, stack adjustments, polarity)
is kept beside the operations as *observations* and is no part of the semantic digest. Every instruction must become an operation
or an observation from a closed list, or the validator refuses the function.
**Assumptions are stated per function**, never global: the two of D-020, the aligned stack on entry, and the floating-point environment.

## D-025 · 2026-11-25 · One gate into reconstruction
`validate.admit` is the only maker of an `Admitted`; `validate.require` is what later phases call, and it checks the digest again.
The normaliser runs the validator before the first transformation and after each one that changed anything.

## D-026 · 2026-11-25 · A transformation is data where it can be, and is proved either way
Rewrites are instances (explicit width, explicit operand order) of rules in `rules.py`; each instance is proved on its own, and what is
applied is what is proved. The other transformations are checked by SMT on generated small functions and by execution on larger ones.
Moving an address closer to its base can change which region it is in: memory is then cut and threaded anew, and validated.

## D-027 · 2026-11-25 · Compiler-undo results are hypotheses
A hypothesis names a value, an equal expression, every reading a source could have had, and how the equality was shown: an integer theorem
whose premises are checked (division by multiplication; brute-forced over every input at 4 and 6 bits), SMT, or nothing more than a shape
(`structure`: rotated loops, fills). It never changes the function. Nothing ranks the readings; Phase 5's compiler oracle decides.
**Not covered**: switches lowered to comparisons, merged tails, inlined calls, vectorised or unrolled loops, division of 16-bit and narrower values.

## D-028 · 2026-11-25 · Exceptions: cleanups are represented, catches are refused
`FuncInfo` version 3 is read for functions with a frame handler. A call carries the state its *return address* is in (how the runtime looks
it up); the function carries the state table. A call in a state that has a cleanup reads the frame, so that nothing a cleanup needs is
taken for dead. The cleanup funclets themselves are named by address and not analysed. Refused with a reason: try blocks (a
catch comes back into the function), asynchronous exceptions, exception specifications, other handlers. The prologue's store of -2 into the
runtime's own slot is an observation; its place is computed from the unwind codes and the table, and any other use of the slot is refused.

## D-029 · 2026-11-25 · What is open stays open, and the compiler decides
A function's code leaves points of its source open: which side of a comparison is written first, whether a value is read again, how a loop is written,
signs. Inference takes the best-supported reading of each (the canonical form) and the rest become candidates, by number of changes, in a fixed order.
No choice looks at the target's bytes; the compiler and the comparator alone tell candidates apart. Alternatives are general (they apply to any function) and few.

## D-030 · 2026-11-25 · A candidate is run before it is compiled
The tree is executed with C++'s meaning (`structuring/evaluate.py`, which shares nothing with how the tree was made) against the normal form, comparing calls, memory
and result. Undefined behaviour rejects it. Signed overflow wraps, is counted, and is a stated assumption of the source. A difference means there is no candidate,
whatever its bytes would be.

## D-031 · 2026-11-25 · Namespaces in one file, then the exact unit
200 candidates compile in 0.9 s as namespaces of one file, and in 9.5 s as 200 files in one process. A namespace changes only decorated names, which a test checks on
every source written. Only the exact unit is verified, so the batch form cannot decide anything.

## D-032 · 2026-11-25 · Native and Wine are one host
Windows' own execution of the pinned compiler and the checkout's Wine wrappers gave identical code, relocations and unwind data on the synthetic corpus. Debug sections
differ (paths). Development may use either; the same tests run on both.

## D-033 · 2026-11-25 · Held-out functions
`heldout.cpp` is written before the engine sees it. Its first score is reported as it is; a correction it leads to makes the next score an ordinary one, and a new
set is written when a held-out number is wanted again.

## D-034 · 2026-11-25 · A body is a member of the class the unit's header declares
On the real target a function is `Class::Method` in an existing unit. The candidate's tree is written as that member (`core/emitter/member.py`): the
first parameter is `this` when it points to the class whose members the body reads, or when the body does not use it; a first parameter used as a
plain value makes a static member. Members are named and typed as the header declares them; a read where no member of that type starts (or no
element of an array of that type) is refused (`MEMBER_NOT_DECLARED`), and so is a second class, a class by value, a callee or a global. Nothing is
declared by the engine except the method itself: its declaration replaces the one in the class, or is added at its end. Virtual, overloaded and
inline-defined methods are refused. Carving typed members out of the skeleton's `unknownXX` byte arrays is not done yet.

## D-035 · 2026-11-25 · The compiler reads the declarations
What a header declares is read by the pinned compiler, not by a C++ parser: its class-layout report gives offsets and names, and a probe unit of
compile-time constants (one declaration per member: a type code, the offset, the size, the element count) gives the types, read back from the object.
A member the unit cannot name (private, ambiguous) is found by the line of its error and left out. The probe files sit next to the header so its
relative includes resolve, and are removed again. Only the text of one method's declaration is located by hand, with comments and literals blanked.
The header read is the worktree's after the repository's tooling prepared the packet, which is exactly the text the edits apply to; when the server
says that files of earlier packets of the unit may be a model's (`options.modelTextInUnit`), only the base revision is read.

## D-036 · 2026-11-25 · Whole packets, and a tier of one attempt
The engine returns edits only when every function of the packet is solved: a unit with a placeholder left does not compile, so a partial answer could
only fail at the Gate Keeper. Engine runs therefore use packets of one function. Its tier makes one attempt per packet (the same input gives the same
answer), does not steal or get stolen from, has no budget pause, outage or prewarm, and late classification never moves a packet away from it (D-009).
What it does not solve goes to the next tier with the engine's reason code and no gate call.

## D-037 · 2026-11-26 · External references are named by evidence, ranked, and the comparator checks the binding
Defect D1 of the convergence plan. `adapters/x64_msvc/symbols.py` keeps a symbol map from evidence only, highest rank first: the function itself
under its unit's name, a declaration placed by a linker map (a decorated name, so its types are part of the name), and a name the project records
for an address (`data/progress.json`: plain or scoped names, so overloads are not told apart). A name the best-ranked evidence gives two addresses
is ambiguous and resolves to nothing; so do two declarations of one address. A relocation is looked up by its decorated name, then by its scoped
form. A declared function is called by its declared name and takes its declared signature, sign included (`Slot.sign`, which outweighs anything
the code suggests); the emitter writes its prototype from that signature, so the decoration agrees with the declaration only when the types do.
`distance` counts references nothing names apart from wrong ones; every compiled candidate with no known difference goes to the comparator, in
the order (known differences, unnamed references, changes from the canonical form), until one passes or the `compiles` budget is spent. Nothing
binds a reference because the bytes then line up. One exception stays: compiler-made constants (`__real@`, `__xmm@`, `__ymm@`), whose name is their
value, are bound to the read-only place the target's field leads to when it holds that value. A synthetic pack's callees without a declaration
keep the address-derived names of Phase 5. On the real target the recorded names now reach the resolver and the comparator's symbol map, but
the member emitter still refuses callees (D10), so no real result changes yet.

## D-038 · 2026-11-26 · Budgets count operations and are spent where the work is done
Defect D3. `core/budget.py`: `candidates` (trees kept), `expansions` (choices tried), `compiles` (each candidate of a ranking batch and each exact
unit), `solverUnits` (solver checks, each bounded by the solver's own resource limit), `irNodes` (operations and terminators of each normal form
analysed). The generator, the program, the solver and the search spend from the active budget; running out ends the search with
`BUDGET_EXHAUSTED`, the kind, and a frontier (D-039), and never hides a match found before. Defaults are the old constants (48 candidates, 160
expansions) and room for the rest (400 compiles, 2,000 solver checks, 200,000 IR nodes); the constants `MAX_CANDIDATES` and `MAX_TRIED` are gone
(part of D2; the callee depth and the fixpoint rounds remain). A request's budgets bound each function's search, and each search gets a program
of its own so that its counters do not depend on what another search analysed. Counters `budget_<kind>` and `limit_<kind>` are in every result.
A wall-clock limit is the server's and an infrastructure failure, never exhaustion.

## D-039 · 2026-11-26 · A frontier is what the compiler and the verifier said
A frontier holds, by candidate digest, the compiler's judgement and the verifier's answer. A search given one makes the same candidates again (the
generator is deterministic and cheap next to the compiler), takes those answers instead of asking again, and spends its budget as if it had
asked, so it ends exactly where an uninterrupted search with that budget ends, field for field (tested in process and through the command). A
frontier is resumed only by the same engine, rules, image, recipe and function (and, for `solve`, the same header), whatever the budget; it lives
in the private data directory (`dataDir/frontiers/`, or `reconstruct --frontiers`).

## D-040 · 2026-11-26 · The execution check stays a filter, measured and watched
Defect D8. `measure-filter` keeps every tree the execution check rejects, compiles it, and sends each one with no known difference to the
comparator (`adapters/skyrim/filter_audit.py`). Measured on 2026-11-26: on the four synthetic corpora (58 functions) the check let 278 trees through
and rejected 1, which does not compile; on the real target, a fixed sample of the unmatched functions up to 1 KiB was scanned until 100 had trees
(1,732 scanned): 628 let through, 4 rejected (one function, all "a truth value that is neither 0 nor 1"), none of which compiles. False rejections:
**0 measured**. The check stays a filter; the synthetic measurement is a regression test that fails on any false rejection. Open: the four real
rejections could not be compared because they do not compile, and their reason points at a world the generator made up (a truth value read from
made-up memory) rather than at the tree; the audit now records the compiler's codes, and the count is measured again when the generator gains
dimensions (Phase 9).

## D-041 · 2026-11-26 · Every recorded function is a callee, and no constant bounds how deep one is analysed
Defects D2, D4 and D7. The program the engine analyses now holds every function upstream records (`data/progress.json`, matched or
not) besides the offered targets, so a callee is no longer invisible because it is not offered (D4); a record that an offered entry
or another record overlaps is left out, never chosen over it (`inventory.extents`). The callee depth limit of 4 is gone: how much is
analysed is the `irNodes` budget's to bound, and nothing else: the analysis walks the call graph with an explicit stack (D-045),
so no depth of the interpreter's stack limits it either (a first version guarded that stack with `CALLEE_CHAIN_TOO_DEEP`; D-045
removed it). Recursive functions are solved as components (D-045), each further round spending `irNodes` (D2). Reach runs every
stage of the generator (D7).

## D-042 · 2026-11-26 · What a result depends on is in its digest
Defect D6. The input digest of a `solve` request covers, besides what it covered before, the image and build, the upstream revision,
the recipe's digest and its compiler's, the include closure of the unit's header (project headers by path and digest; system headers
are the compiler's), the declaration knowledge (`data/progress.json`), the engine's lockfile, and the frontiers it resumes from
(`adapters/skyrim/manifest.py`). No timestamps or temporary paths. Requests without a worktree keep the old fields.

## D-043 · 2026-11-26 · The denominator is frozen per revision, the held-out set is fixed, and every function has a state
`recon manifest` writes the coverage manifest of the worktree's revision under the private data directory (image, revision, inventory
file digests, comparator version, each recipe's compiler, and per function its extent, extent source, unit when `sr next` places it,
held-out flag and populations) and prints counts only. The held-out set is every function whose `sha256("heldout-v1" || rva_le32)`
falls in the lowest 5% of the hash space; every count is reported for development and held-out functions apart. `core/taxonomy.py`
gives every reason code a family in pipeline order (Machine, ABI, Knowledge, Source, Search, Unit, Policy, Infra) and the plan's name,
and derives the state (`BYTE_MATCHED`, `RESUMABLE`, `NEEDS_DECISION`, `INFRA`, `OPEN`); a test keeps every code written in the
engine's source classified. `recon campaign` gives every function of a population a state and all its blockers, the primary first.
`BYTE_MATCHED` is the engine's comparator only: `VERIFIED` also needs the Gate Keeper, the dry run and a clean-room rerun.

## D-044 · 2026-11-26 · The ceiling estimate counts only what can be told before a match
`recon ceiling` samples 200 startable development functions, 25 per size bucket, in a fixed hash order, and flags a unit file
already within 10% of upstream's per-file caps (read from `tools/contrib_screen.py`) and code that is not the pinned compiler's
(outside `.text`, or an invalid instruction). Whether a function needs another recipe, or a body upstream already matched, cannot be
told before a match is attempted: those are reported as not measured, so the estimate is a lower bound. Identical bytes at another
address are counted but not flagged: the linker did not fold them, so each has its own definition. The overfitting scan
(`tests/unit/test_campaign.py`) fails on any target RVA, recorded scoped name or long plain name in the engine tree; it found one, an
upstream example address in a protocol test, now replaced by a synthetic one.

## D-045 · 2026-11-26 · Callee analysis is done once per program, by components, and kept
The first campaign of Phase 7 analysed the same callees again for every function that reached them, and without an active budget
reach could not stop. Signatures are now found bottom-up over the strongly connected components of the call graph (Tarjan, with an
explicit stack, so a chain of callees is as long as the program makes it): callees first; the members of a cycle together, from one
assumption, each inferred from what is assumed of all of them until nothing changes, a state that comes round again telling
nothing. The result does not depend on which member is asked first or on what was analysed before. Every fact is kept in a private
content-addressed store (`core/knowledge.py`, sqlite under the data directory, never committed): normal forms and refusals, direct
callees and call sites keyed by the function's extent under a namespace that digests the engine's analysis code, the image and the
validated instruction forms; signatures keyed by a Merkle digest of the component's members, their callees' keys and the
declarations they read, so that invalidation follows dependencies and nothing else. A unit of work is written in one transaction
with a full sync; a lease names the process computing it, another waits for it (a lease of a process that has ended is taken over);
a cycle keeps its last finished round, so one interrupted halfway resumes from it and ends where an uninterrupted one would. Memory
holds at most 4,096 normal forms when a store holds them all. A budget that runs out suspends the walk: every component already
solved stays solved. `recon prewarm` does the whole program once, resumably; tests show reuse across programs and processes, resume
after a budget runs out and after the process is killed, order-independent convergence, a chain of 1,500 callees, two workers that
never analyse one function twice, and the memory bound (`tests/unit/test_knowledge.py`).

## D-046 · 2026-11-26 · What a callee's code leaves open is kept as alternatives, and callers' evidence orders them
A callee's signature from its own code is one reading; the others its code leaves open (the other results `signature.results`
lists) and those its callers' code supports (every caller sets more argument locations than it reads; a caller reads a result it
does not leave, or none reads the one it leaves) are kept as alternatives (`Program.alternatives`), those the callers support first.
They come from the callers' normal forms alone (`call_sites`: what a call sets with values of the caller's own, and what it reads
afterwards), so the bottom-up analysis stays a function of the callees and no cycle runs through the whole program; the index of
callers is built once per program by `prewarm`. The search tries them as choices after the forms of the first stage
(`Choice.callees`, written `callee:<place>:<alternative>`), alone, together and with the first-stage forms, within the budget;
every candidate is still compiled and compared byte for byte, so an alternative can only add matches.

## D-047 · 2026-11-26 · A campaign runs in levels, journals every function, and runs as many workers as memory allows
A level multiplies every budget of the defaults (L0 to L5: 1, 4, 16, 64, 256, 1024 times). Every function runs at L0; a function
whose budget ran out runs again at the next level, reading back what the lower level computed (the knowledge store; compiler and
comparator verdicts from the saved frontier, now written atomically), and past the last level stays `RESUMABLE`: a budget suspends a
function, it never decides it. Reach answers a budget that runs out as `exhausted`, never as a refusal. Each finished function is
appended to a journal and synced; a campaign started again reads it and does nothing twice at one level (a line cut short by an
abrupt end is closed and skipped). Workers (`core/workers.py`) start at one and grow one at a time while the memory left after another
worker of the largest size measured would stay above a reserve (a quarter of the machine, at least 2 GiB), shrink when it falls below,
and a worker that grows past half the machine is retired after its task. A worker that dies gives its task back; a task that kills
its worker twice is `INFRA` (`WORKER_DIED`), retried once in the next run. Progress lines carry states, rates, per-function times,
workers and memory, and the analysis counters apart: computed, reused and done twice.
