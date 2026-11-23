# Phase 4: function gathering and capped, capability-aware distribution

Phase 4 adds an Orchestrator **FunctionGatherer** that builds each batch from the repository itself,
and a **hard per-worker function cap** (default 60 distinct functions per worker instance per run).
The cap is enforced atomically in the queue's lease transaction and planned for before the run
starts.

Much of the Phase 4 brief already shipped in Phase 2 and is extended rather than rebuilt:
* the complexity classifier and its persisted tier and score;
* capability-tier routing, dynamic pulling, work stealing and retry escalation;
* the budgeted `TaskContextBundle` with its cache-friendly prefix;
* the `shared_run_discoveries` cache;
* per-account and per-run token, cache and cost telemetry.

See [PHASE2.md](PHASE2.md) and [PHASE3.md](PHASE3.md).

## Integration plan

| Area | Status | Files |
|---|---|---|
| Function gathering | **New** | `apps/server/src/intel/gatherer.ts`; `backlog()` on `repo/srRepo.ts` and `repo/simRepo.ts`; `GatherFilter` and the `gather` selection source in `packages/core/src/schemas.ts` |
| Complexity classification | Extended (Phase 2) | `packages/core/src/complexity.ts`: two new signals, templated names (+1) and incoming xrefs (up to +0.6). `tasks.difficulty` / `tasks.complexity` are exposed as `complexity_tier` / `complexity_score` through the `task_complexity` view |
| Tiered routing, stealing, retry escalation | Existing (Phase 2) | `packages/core/src/flow.ts`, `orchestrator/engine.ts`, `queue/taskQueue.ts`. Escalation after the tier's attempts (the flow node's `maxAttempts`, the only retry setting) carries the structured retry delta |
| Per-worker function cap | **New** | `queue/taskQueue.ts` (charge in the lease transaction, stall check, refunds), `orchestrator/capacity.ts` (planner), `orchestrator/engine.ts` (worker identities, capped slots, stall pause), `db/store.ts` |
| Pre-run capacity warning | **New** | `POST /api/flows/validate?batch=&cap=` (form), `run.capacity` event + `runs.capacity_json` (exact, after classification) |
| TaskContextBundle, prefix caching, discoveries, telemetry | Existing (Phase 2/3) | `orchestrator/contextBuilder.ts`, `providers/*`, `run_knowledge_cache` (also exposed as the `shared_run_discoveries` view) |
| UI | **New** | Runs: gather source with filters and preview, max functions per worker, live capacity warning, **Worker quotas** panel (`X / 60` per worker, capped/busy state, per-tier demand vs capacity, stall banner with "Raise cap & resume"), worker column on packets, gathering summary |

## Function Gatherer

Built from what the repository actually has. Nothing it reads leaves the machine, and listings
aren't read at all.

| Input | What it provides |
|---|---|
| `data/progress.json` at the base revision (public) | The inventory: every function's RVA, size, name, name origin and status (`matched` / `mapped`) |
| `sr next --count 100000 --max-size N` | The repo's own unit mapping (`reconstruction/<area>/<Class>.cpp`), readiness order and claim exclusion (others' claims when GitHub is reachable) |
| `SR_LOCAL_DIR/contrib/claims.json` | Local claims (locked) |
| This tool's database | Functions open in another run, or matched but not yet submitted (in flight) |
| The unit's `.h` / `.cpp` at the base revision | The declared signature, and whether a draft already exists: `present`, `stub` (a trivial body) or `none` |
| Local packs (`analyze`) | Shape counts: instructions, basic blocks, branches, loops, calls, indirect calls, SSE, EH |
| Optional function table (`repo.functionTable`, same opt-in as `sr next --function-table`) | Incoming and outgoing xrefs, block and instruction counts |

* **Filters:** `maxFunctions` (default 500, up to 5,000), min/max size, half-open RVA ranges,
  namespaces (qualified-name prefixes on `::` boundaries), modules (reconstruction areas), explicit
  units, excluded name origins (e.g. `GUESS`), locked, in flight, and drafted.
* **Order:** applied before the cap, by readiness (the repo's order), size or RVA.
* **Exclusions are counted** in the report (`matched`, `not_startable`, `locked`, `in_flight`,
  `size`, `rva_range`, `namespace`, `module`, `unit`, `name_origin`, `drafted`, `over_cap`), so a
  short batch explains itself.
* **Persistence:** per-function metadata goes to `gathered_functions`, and the report to
  `runs.gather_json`.

**Real checkout** (read-only, 70 s, temporary worktree removed afterwards):
* `data/progress.json`: **31,252** functions, 30,049 matched, **1,203** still to do.
* `sr next` offered 430 at ≤256 B. The gatherer selected **430** functions in 206 units (41 KB).
* Excluded: 397 larger than 256 B, 362 not startable (no unit mapping yet), 14 claimed.
* Source scan: declared signatures for 119, an existing unit file for 374, drafts for 28 (2 of them
  stubs).
* Shape: only 1 function has a local pack today, so most tiers start size-based and are refined
  after `prepare` (Phase 2 re-routing). No function table exists in this checkout, so incoming
  xrefs are reported as unknown, not guessed.
* Tiers: 170 easy / 176 medium / 84 hard.
* `sr next` couldn't reach GitHub from WSL, so others' claims weren't excluded; the report and UI
  say so.

## Per-worker function cap

* **Identity.** A worker is one instance of a worker node in the flow: `<node id>#<n>`, stable across
  restarts. `run_workers` holds `max_functions` (from `RunConfig.maxFunctionsPerWorker`, default
  **60**) and `assigned_function_count`.
* **Atomic charge.** In the same `BEGIN IMMEDIATE` transaction as the lease:
  ```sql
  UPDATE run_workers SET assigned_function_count = assigned_function_count + :fn, assigned_tasks = assigned_tasks + 1
   WHERE run_id = :run AND worker_id = :worker AND assigned_function_count + :fn <= max_functions
  ```
  If no row changes, the lease is undone and the worker looks at the next packet, since a smaller
  one may still fit. The condition is `count + packet ≤ max`, not `count < max`: a worker at 58/60
  must not take a 4-function packet. A `CHECK (assigned_function_count <= max_functions)`
  constraint makes an over-cap count impossible even outside the queue.
* **Charged once.** `worker_assignments` records (worker, packet). A worker prefers its own packets
  when leasing, and their retries are free. A packet re-routed by pack analysis before its first
  attempt is refunded.
* **Capped workers stop claiming.** They keep finishing their own packets but no longer count as
  idle capacity for work-stealing thresholds, so higher tiers absorb the backlog instead.
* **Stalls are explicit.** When every pending packet is blocked (no worker of its tier, or with
  stealing of a higher tier, can fit it) and nothing is in flight, the run pauses with
  `run.capacity_exhausted`, naming the packets and functions left. The operator can raise the cap
  for that run (never lower it), via `POST /api/runs/:id/capacity` or the button, and it resumes.
* **Escalations use capacity.** A packet that climbs to another tier is charged to the worker that
  takes it there. The sum of per-worker counts can therefore exceed the batch (230 for 200 in the
  demo below), and the planner warns when headroom is thin.

### Capacity planning

`planCapacity()` compares demand with `workers × cap`:
* before the run, from the batch size alone (the New Run form, as you type);
* at run start, per tier after classification (`run.capacity` event, `runs.capacity_json`).

Idle higher tiers absorb a lower tier's overflow when work stealing is on; nothing flows downwards.

Warnings:
* fewer than `⌈batch / cap⌉` workers, e.g. "500 functions need at least 9 worker instance(s) at 60
  functions each; this run has 8";
* a tier that can't be served;
* the flow scaled down to the repository's worktree slots;
* less than 15% headroom for escalations.

With the real repository's default 8 worktree slots and the default flow, 8 workers × 60 = 480
cover the 430 gathered functions. The planner still flags the balanced tier: 176 medium functions
for 2 workers (120) overflow into the frontier tier, which has room for only 36 of the 56.

### Fix along the way

`allocateSlots` (Phase 1) rounded down when scaling a flow to fewer worktrees and left slots idle:
20 wanted on 8 slots started only 7 workers. It now uses largest-remainder allocation, so every
slot runs a worker. With a per-worker cap, an idle slot is lost capacity.

## Demo (simulator, browser-verified)

A gather run of 200 functions with the cap set to 8, on 20 workers (capacity 160):
1. The form warned before starting.
2. The run matched 137 functions and then paused, with 63 functions in 47 packets left.
3. The Worker quotas panel showed every worker at `8 / 8`, capped, with per-tier overflow.
4. "Raise cap & resume" to 16: the run completed 200/200, with workers at 9–15 of 16.

## Schemas and migration (v4)

Additive only.

* **`run_workers`**: (run, worker) → node, tier, capability, `max_functions`,
  `assigned_function_count`, `assigned_tasks`; `CHECK (assigned_function_count <= max_functions)`.
* **`worker_assignments`**: (run, worker, task) → functions, assigned_at.
* **`gathered_functions`**: (run, rva) → name, name origin, size, unit, header, signature, draft,
  readiness, xrefs in/out, basic blocks, instructions, branches, sources.
* **`tasks.assigned_worker`**, **`attempts.worker_id`**.
* **`runs.gather_json`**, **`runs.capacity_json`**.
* Views: **`task_complexity`** (`complexity_tier`, `complexity_score`, `assigned_worker`) and
  **`shared_run_discoveries`** (the Phase 2 `run_knowledge_cache`).
* **Zod:** `GatherFilter`, the `gather` variant of `SelectionSpec`, `RunConfig.maxFunctionsPerWorker`
  (1–5,000, default 60), and `FunctionFeatures.templated`.

Backward compatibility: runs created before Phase 4 load without a cap (5,000).

Default changes for new databases:
* the default flow's frontier tier has 4 instances (was 3), so its 20 workers give 1,200
  functions of capacity at 60 each;
* the simulator has 20 worktree slots (was 16).

Saved flows are not changed.

## Trade-offs and deviations

* **SQL migrations and REST, not Drizzle and tRPC**, as in Phases 2–3: the project's migration
  runner, typed repositories and Fastify API serve every page, and splitting them buys nothing.
* **Spec names map to existing columns.** `complexity_tier` / `complexity_score` are
  `tasks.difficulty` / `tasks.complexity` (Phase 2), exposed under those names by a view rather
  than duplicated. Likewise `shared_run_discoveries` is a view over `run_knowledge_cache`.
* **Incoming xrefs need a function table.** Packs list outgoing references only. Without the
  opt-in table, xrefs-in stays unknown and adds nothing to the score.
* **"In flight" includes matched-but-unsubmitted work** (passed or staged in this tool's database),
  so a second run doesn't redo a batch waiting for review. Once the PR merges, `progress.json`
  marks the functions as matched.
* **A stall pauses the run; it doesn't fail it.** Raising the cap is the in-run remedy. Adding
  worker instances needs a new run, because a run's flow is a snapshot.

## Not verified yet

* A real run against the checkout (claims, compare, staging) with real models.
* `sr next` with GitHub reachable (the claim exclusion of others' claims).
* The function-table path with a real exporter output: the parser accepts common key names
  (`xrefs_in` / `callers` / `incoming`, `basic_blocks` / `blocks`, …) but has only been exercised by
  the simulator's table.

## First real run (12 gathered functions, Claude Code login) and the fixes it led to

The run used staging off and no listing exposure, and was capped at $3 API-equivalent. It matched
**7 of 12** functions under the repo's own compare; 3 were dead-lettered, and 2 were pending at
the cap. Most failed attempts were header conventions, not matching, and each one escalated the
packet to a costlier tier. Opus took 83% of the spend.

| Problem seen | Fix |
|---|---|
| Skeleton `SKELETON_TODO` placeholders left in the header, or kept next to the worker's own line | `orchestrator/headerRepair.ts` runs before the Gate Keeper: a placeholder is dropped once the worker has stated the key, duplicate keys and banned lines (Task, Recipe, Drafted by, disclaimers) the worker added are removed, and lines already in the file are kept. Replaying the run's rejected attempts: convention findings went from 19 to 7 |
| Edits-mode answers never touch the header, so placeholders survive | The output contract asks for `codeOrigin` and `adaptedBodies` (required in the JSON schema); the repair writes the worker's own statements into the placeholders |
| A changed `.h` without a `Code origin:` line (repo preflight) | The repair adds the worker's statement to any changed file that lacks one |
| A header edit containing an `#include` failed the whole attempt | Non-comment lines move to the declarations |
| Formatting failures escalated packets to Sonnet and Opus | Up to 3 format-only rejections per packet (header, lint, scope line, output contract, no comparator failure) retry on the same tier without counting toward promotion |
| Idle Opus slots stole easy Haiku packets | `routing.stealMaxGap` (default 1): a slot steals only from the tier directly below it. The capacity planner and stall check use the same rule |
| `claude` could not be started on Windows (npm `.cmd` shim) | The CLI adapter resolves bare names to the real executable; a missing binary is a configuration error, not a retried server error |

The explicit header rules made the cached static prefix larger, so its budget is now 1,400 tokens
(was 1,200).

### Several subscription logins in one pool

Each `cli_profile` account is one login in its own config directory, so separate subscriptions
(and separate workspaces of one Claude account, which have separate usage limits) run side by side:

- **Second Claude workspace:** sign in once into a new directory, picking the other organisation in
  the browser, then add an account whose `auth.configDir` points at it:
  `$env:CLAUDE_CONFIG_DIR = 'C:\Users\<you>\.claude-workspace2'; claude auth login --claudeai`.
  `CLAUDE_CONFIG_DIR=<dir> claude auth status` shows the `orgId` to confirm it is a different one.
- **ChatGPT plan via Codex:** a `codex_cli` account with `configDir` = the `CODEX_HOME` that holds
  the login (`codex login status`). Workers run `codex exec --ignore-user-config --ignore-rules
  --ephemeral -s read-only`, so the operator's own `config.toml` (sandbox mode, notify hooks,
  computer use, MCP servers) never applies to them. The structured-output schema goes through
  `--output-schema`. The models carry no list prices, so they do not count against a run budget.
- A weekly or daily limit on one login parks only that account until the stated reset. The run
  keeps going on the others, because flow nodes draw from the pool by capability tier.

### Retries that learn from every failed attempt

In the 12-function retry run the four hard packets each burned 20+ attempts without converging.
The attempt log showed why:

| Problem seen | Fix |
|---|---|
| A retry saw only the attempt right before it, so workers ping-ponged between two guesses (`GetInventoryChanges`: "deleted flag → nullptr", then "ActorCharacter → nullptr", then back, six times each) | `orchestrator/history.ts` gives every retry an `<history>` section: each distinct earlier candidate of the failing functions with its outcome, best first, and a line when the last attempt went backwards ("start again from #7") |
| Rewrites that only renamed a constant were tried as new ideas | Attempts are grouped by the hash of the machine code they compiled to (`code_section_sha256` from the comparator), so the worker sees "3 different sources, identical machine code" |
| The same code was resubmitted and compiled again | A candidate whose code (comments and spacing aside) equals an earlier one the compiler judged is refused before compiling as `REPEATED_CANDIDATE`, naming the attempt it repeats |
| Only "bytes exact in place" was read: one wrong first byte meant 0, so every attempt scored 0, patience ran out and nobody knew which attempt was closest | The comparator's own aligned-bytes metric (`progress.aligned_matching_bytes`, a count only) is kept per function, shown to the worker and on the dashboard, and resets the no-improvement streak when it rises |
| "Candidate failed to compile (no comparison evidence)" with no reason: `GetSkill` failed 23 times on an include the compiler could not open | The compiler's error lines from `sr compare --json` (worktree paths made repo-relative) are in the finding and the retry |
| `#include <cstdio>` was refused 10 times with a generic message | The finding names the refused header and lists the allowed ones |
| Stand-in headers with 100+ `virtual void Unk_NN();` lines pushed the class's real members past the unit budget | Prompts show each run of placeholder slots as one marker line; a complete file returned with the marker gets the lines back verbatim |

Everything shown comes from the candidate's own compiled code or from counts; no target bytes or
listing text reach a worker without exposure consent.

### Feedback the workers were not shown

The 100-function run of 22 November matched one packet in about 130 attempts. Its retries showed
the models circling (`BSTask::GetDescription`: drop `<cstdio>`, then `sprintf_s` undeclared, then a
blank origin line, then the wrong size again, fifteen times):

| Problem seen | Fix |
|---|---|
| After every compare, `sr` writes an aligned target/candidate listing (`align.txt`, `side-by-side.txt`) that the drafter card tells a contributor to read; workers only got "first mismatch at +0x4, 20 bytes align" | With exposure consent, a retry carries `<compare_listing>`: that listing for the last attempt (and the best one), read from the comparator's private run directory. The verdict stores only the directory path; the stored bundle redacts the text |
| `UNBOUND reference <name>`: the drafter card says to add the name with the address from the pack's reference table to the task's `bind-hints.json`, which workers cannot write, so a candidate loading a string literal or a global could never match | `repo/binding.ts` pairs each unbound name with the address the comparator's own alignment puts it against (pack-listed addresses only, ambiguous names left alone), writes the hint and compares once more |
| Every `PREFLIGHT_PROBLEM` came with one canned line about the `Code origin:` header, and the run-wide pitfalls repeated it 56 times; the real problems were include paths, undeclared adapted bodies and label grammar | The guidance says to apply the preflight's own `fix:`; pitfalls name each preflight rule with that fix, and leave out `REPEATED_CANDIDATE` and parse slips, which say nothing to another packet |
| Our compile-error advice said to write includes as `../../area/Y.h`; the preflight rejects any parent step (`include-outside-roots`, 10×), and a root path (`area/Y.h`) does not compile either: the recipe searches only the unit's directory | The advice is the unit's own header only, with any other type or callee declared in that header as a STANDIN; the Gate Keeper's include check is now exactly the repository screen's (its standard-header list, no `.`/`..` step), so `<algorithm>`, `<memory>` and `"../x.h"` are refused before the compiler runs |
| Messages were cut at 400 characters, previous bodies at 160 tokens, the retry section at 600 and the history at 1,200 | Messages up to 1,500 (2,400 for compiler errors), bodies 700 tokens, `retry_delta` 2,000, `attempt_history` 2,500; runs created with the old budgets get these floors too |
| A reply that was not the output JSON was told only that | The finding names the schema problem and quotes how the reply began |
| `COMPARE_FUNCTION_SYMBOL_MISSING` (16×) had no guidance | It says to declare and define the function exactly as the header and the task signature say, out of line |

Later in the same run:

| Problem seen | Fix |
|---|---|
| `BSPCOrbisGamepadDevice`: both functions matched (67 B exact) eleven times, and every time the preflight blocked on `#include <algorithm>` (line 11), already in the file and needed by the upstream `SetRumble` body the packet may not touch | A preflight problem on a line that was already in the file before the packet, outside its own function bodies, is `PREFLIGHT_PREEXISTING`. The worker gets one retry to change it; after a second such verdict (or the same code again), the packet is **held**: state `set_aside`, route `hold`, the reason in `tasks.hold_json`. The run panel counts it under "Matched, file blocked by a line it did not write", the task drawer names the lines, and **Put back** returns it once the line is fixed upstream |
| `CHEAT_MATCHED_BODY_MODIFIED` on `BSOrderedNode::OnVisible` (15×, then quarantine): the base had an unmatched upstream draft of the packet's own target | The matched-body rule skips the packet's own targets, named qualified or by bare method name |
| "38/50 bytes exact" on a function the comparator passed | 12 bytes were relocated fields that point at the same target (3 REL32): the comparator counts them separately. The task drawer shows "Bytes that agree" = exact + by reference |
| 83 of the run's 100 functions are claim-time functions: on the published target-hash list and offered by `contributor-targets.json`, with no `data/progress.json` entry until their claim is recorded (`sr next` names them `Class::Function<rva>`, GUESS). The batch check called them "no longer tracked upstream" and set their unit aside | The upstream check counts an RVA that the base revision publishes and offers as tracked |
| `COMPARE_FUNCTION_SYMBOL_MISSING` (41×): most candidates had simply not defined the function (they returned the unit with only the other functions) | The finding says so ("your files do not define X at all"), or, when a definition exists, that it must be an out-of-line member with the declared signature |

### Rebuilding set-aside units on upstream

A pull request sends whole unit files. A unit set aside because upstream has since matched (or
stopped publishing) some of its functions still holds functions nobody else has, but they cannot go
upstream inside our old file: it would overwrite upstream's matched bodies and still name the dropped
functions. **Rebuild on upstream** (`POST /api/runs/:id/set-aside/rebuild`, button in the set-aside
list) narrows each set-aside packet of those units to the functions upstream still needs and requeues
it as a `rebuild` fix. Every attempt of such a packet starts from upstream's current files with the
packet's accepted definitions spliced in (`orchestrator/splice.ts`: the definitions, their `0x<rva>`
header lines, missing includes and file-scope declarations, a declaration in the class and its
label). The **first attempt is the splice itself, with no model call**; the Gate Keeper compiles and
compares it like any candidate. A unit the splice does not get through (say its body needs a member
upstream's class does not have, which the splice never adds because it could move upstream's
offsets) goes on to the workers, who see the spliced files and the compiler's or comparator's
findings. The free attempt carries the accepted file's own `Code origin:` and `Adapted bodies:`
statements; where `sr start` appended its placeholder to a statement upstream's file already makes,
the header repair keeps that statement and adds ours after it.

### Which compare results count

`sr start` keeps one task per class and adds every function ever started in it, so `sr compare` also
checks the functions of dead packets and those a rebuild dropped. No candidate of the current packet
can make those pass. The Gate Keeper therefore counts only the packet's own results and those of
packets of the same unit the run accepted earlier (the carried functions); batches narrow the task
the same way (`focusTasks`). Packets that died or were quarantined before this, although some
candidate matched all their functions, go back with `POST /api/runs/:id/regate-matched`: each
becomes a `regate` fix whose first attempt submits that candidate again, with no model call.

### Throughput for the hardest packets

| Problem seen | Fix |
|---|---|
| A flow asking for 34 workers got 3 worktrees, one per tier, so the last hard packets queued behind a single frontier slot while the other worktrees sat idle | `routing.helpUp` (default on): a slot with nothing on its own tier or below runs a higher tier's ready packet with that tier's node and models; the packet keeps its tier, only the worktree is lent |
| "Retry failed tasks" sent packets that had died at the frontier back to the fast tier, spending attempts on the tiers that had already failed | Retries go back to the tier where each packet stopped (its history carries over); `{"from":"fast"}` on `POST /api/runs/:id/retry-failed` restarts the ladder |
| On a large unit (edits mode) the worker could not change an `#include` in the header: complete files were forbidden | A complete `.h` is allowed in every mode; only a complete `.cpp` is refused in edits mode, because its accepted bodies are elided |
| A shared header (`reconstruction/declarations/TESForm.h`) cannot compile with the pinned compile, and the packet may not edit it | When a compiler error points into a file outside the packet, the finding says so and tells the worker to stop including it and declare minimal STANDIN types in the unit's own header |
| One model (free to the scheduler, so always picked first) made every last attempt at a stalled packet, cycling its own ideas | Model rotation: after two attempts without progress, the accounts that made them are deprioritised (soft: still used when nothing else is free), so another model gets the next turn |

### Lifecycle boundaries

An outside review of the source found places where parts that each work alone could disagree
about the state once they met. Each now has a regression test in `test/lifecycle.test.ts`.

| Problem | Fix |
|---|---|
| A batch that failed its final re-verification was still committed to a branch, and its packets were marked `staged` | No commit without verification: the staging worktree is reset, the batch is recorded `failed` with its problems, and its packets stay `passed`. `POST /api/runs/:id/stage` (or `engine.restage`) stages them again under the slot lock |
| A finished run left `active` before staging ended, so another run could start and reset the shared staging worktree mid-commit | The slot lock (`exclusiveHolder`) is held from the moment a run leaves `active` until staging is over. `waitFor()` waits for staging too, and skill curation starts only after the lock is released |
| A worker whose lease was lost could still insert an `accept` verdict and emit `task.passed`, even though the lease-guarded state change did nothing | Inserting the verdict and changing the state are one transaction. A lost lease files the verdict under the new route `stale`, moves nothing and emits `task.stale` |
| Retrying failed packets of a paused run requeued them, but the slot loops stayed parked on the resume signal | Retrying resumes the run. A paused run that is not loaded (after a restart) starts as running. The response reports the stored status, not a snapshot |
| The API token was accepted as `?token=` on every route, and URLs end up in logs and history | Bearer header everywhere, compared in constant time. The query token is accepted only on the SSE stream. A non-loopback bind without a token is refused unless `ORCH_ALLOW_UNAUTHENTICATED=1` |

### Attribution: the model that finished the function

The target repo asks contributors to name their actual model. Its contributor card says "name your
actual model", its lint requires a `Drafted by` line in every unit source, and its main branch
reads `// Drafted by gpt-6.1-terra.` or `// Drafted by <person>, assisted by claude-sonnet-5-5`.
Claims record the model (`sr claim --model`) and tasks record a `drafter_model`, which the
project's model-trend statistics read. The orchestrator got all three wrong, and with rotation and
help-up a packet can pass on a different model from the one it started on.

| Before | Now (`orchestrator/attribution.ts`) |
|---|---|
| Header repair stripped `Drafted by` as a banned line, and the gate counted it against the header budget | The orchestrator writes the line itself from the gated attempt's model: `// Drafted by <person>, assisted by <model>.` (or the model alone when the run has no person). The skeleton's placeholder is replaced, a worker's own line is dropped, and models accumulate as more packets of the unit pass. Another contributor's line is kept, with `; later functions by ...` appended. The line is not counted against the budget |
| The claim named the flow node's label (`Workers · frontier`) as the model | Until a packet passes, the claim names the agent (`decomp-orchestrator`, or the node's pinned model). On a pass, `sr claim --model <finishing model>` rewrites the local claim, and the task's `drafter_model` is set to the same model (`recordAttribution`) |
| Staged commits named no model | Each function line names the model that drafted it, a `Drafted by <person>, assisted by <models>.` line gives the value for `sr submit --drafted-by`, and Claude models get `Co-Authored-By` trailers in the repo's own form. The batch detail keeps `draftedBy` and `models` |

The person is the run's `draftedBy` (the contributor's name or login). The schema's placeholder
`operator` counts as no person.

### Slots that lose their worktree

In the retry run, `TESObjectARMO::GetSkill` reached an exact 31/31 match on Opus. That attempt was
rejected for a comment the repo's label grammar misread. The packet was later dead-lettered by
three infrastructure failures, all `Unable to create .../worktrees/slot-2/index.lock: File
exists`. The WSL host wraps every command in `timeout -k`, and aborting an attempt kills
`wsl.exe`. A git killed mid-reset leaves its lock behind, every later reset of that slot fails, and
each failure was charged to whichever packet the slot had just leased.

| Problem | Fix |
|---|---|
| A stale `index.lock` failed every reset until an operator deleted it | `SrRepo.reset` clears the lock only when it is provably abandoned: no live git process works in or on the worktree (checked through `/proc`, by working directory and command line), and the lock is at least 10 s old. Then it resets once more. A host where processes cannot be inspected never has a lock removed. Resets of one slot are serialized. Each recovery is reported as `slot.lock_recovered` |
| A slot that could not be restored dead-lettered packets: three of them and a packet was gone | The reset failure is the slot's fault: the packet goes back to the queue uncharged, and the slot is parked (`slot.parked`, back-off 15 s doubling to 5 min). It takes no work until a reset succeeds (`slot.recovered`), and work-stealing does not count it as idle |
| The infrastructure-failure path inserted a `retry` verdict and then tried the lease-guarded move separately | Same transaction as `settle()`: a lost lease files the verdict as `stale`, moves nothing and emits `task.stale` instead of `task.infra` |

### After a run: edit, batch, submit, carry over

| Need | How |
|---|---|
| Name the right person on a run that already ran (`draftedBy` was a placeholder) | **Edit** on the run (`PATCH /api/runs/:id`). The old name goes to `config.formerDraftedBy`. Held claims are re-recorded with `sr claim` under the new name, and this run's own `Drafted by <old>, assisted by …` header lines are renamed when its functions are batched or submitted. Lines naming anyone else are left alone. `runDefaults.draftedBy` in the server config prefills new runs |
| Batch the passed functions of a finished run, including one that ran with staging off | **Batch passed functions** (`POST /api/runs/:id/stage`). A staging-off run gave its claims back when it finished, so they are taken again first. Batches are whole units, up to the run's functions per PR. Each is re-verified in a clean tree before its local branch is created |
| One pull request per batch, through the repo's own tooling | **Dry run**, then **Submit PR** (`POST /api/runs/:id/batches/:batchId/submit`). `sr submit` handles one task, and a task is one unit. So the batch is rebuilt on `decomp/<run>-b<n>-pr` from the base and every packet is re-verified, which also refreshes each task's `last-compare.json`. `sr submit --drafted-by "<person>, assisted by <models>"` then runs on the last unit's task, whose unit list names every file of the batch while it runs (restored afterwards): it applies its own gates (pinned compiler, unit digest, intake preflight over the staged index of every file, push probe), commits the whole batch as one commit, pushes the branch to the fork and opens the PR. `sr submit` checks other people's open claims only for its own task, so the other packets' functions get the same rule (`open_items` + `claim_state`) in one GitHub read, run alongside the last task's `sr submit --dry-run`: a collision blocks the real submission. Before any of that, the batch is checked against upstream (`data/progress.json` and the files it writes at the base; seconds, no compiler) and stops there if upstream already matched a function, no longer tracks one, or changed a file since the batch was built. Re-verification is fast: each unit's `sr` task is first narrowed to the batch's own functions (it lists every function ever started in the unit, dead packets' too, which used to fail re-verification with `function-symbol-missing`), then compared once per `sr` task, and not at all while its `last-compare.json` still proves the tree: `sr`'s own `submit_task_blockers` passes and the compare ran at this base (an `orch-verified.json` mark, or written before a branch built on this base). Unchanged claim records are not re-recorded. A multi-unit PR then becomes one piece of work: the commit is re-made with a message listing every function by unit and force-pushed with a lease, and the PR's title (`Reconstruct <names> (<RVAs>)`, or a count plus as many names as fit in 200 characters) and description (sr's own, with every function's row, a units section and every unit's comparator report) are set through the REST API (`gh pr edit` fails on the retired Projects classic API). Claims stay local until then: once a real submit has opened the PR, one claim issue for exactly its functions is published with sr's own claim builder (`claims.parts`, the project's title, body and marker block) with the PR linked under it, the local claims are marked published, and the PR description links the claim (`Claim issue for these functions: …`). `sr claim` itself would file nothing here, since it counts a PR naming the functions as the claim. Dry runs, staging and runs never publish. **Make it one commit naming every function** (`POST /api/runs/:id/batches/:batchId/tidy-pr`, `confirm: true`) does the same for a PR opened before, opening its claim issue if it has none; it refuses a merged or closed PR and a fork branch someone else pushed to. Submitting needs a clean dry run in the UI and `confirm: true` in the API. A submitted batch cannot be submitted twice |
| Submit the rest of a batch when other contributors claimed some of its functions during the run | **Drop colliding packets** (`POST /api/runs/:id/batches/:batchId/drop-collisions`). The adapter runs the repository's own collision rule (`open_items(refresh=True)` + `claim_state` from `tools/contrib.py`, the rule `sr submit` blocks on): only fresh claims and PRs by others count, not lapsed ones (a day without activity) or the operator's own. A unit's final file carries every packet of the unit, so a collision withholds the whole unit: its packets move to `withheld` and keep their local claims. The batch's local branches are deleted, it becomes `superseded`, and the other packets are re-verified as a new batch, which needs its own dry run. If claims cannot be checked, nothing changes. **Recheck withheld** (`POST /api/runs/:id/withheld/recheck`) checks again and batches every unit that is clear now. Nothing is pushed, and no `--ack-collision` is ever passed |
| Get a finished run's batches ready for pull requests in one go | **Prepare all for PR** (`POST /api/runs/:id/prepare`, answers once started; progress in `GET /api/operation`, whose label reads "step N of 4"). One slot-holding operation: batch matched packets that have no batch and re-verify failed batches; set aside what upstream already has or changed; dry-run every batch without a clean dry run at this base; set aside units a dry run blames and withhold units others claimed (never acknowledged), then dry-run the replacement batches (at most four rounds). It submits nothing and lists what still needs the operator. While the engine holds every slot (no run active), staging and dry runs give the idle worker slots the batch tree and re-compare sr tasks side by side (`RepoAdapter.useIdleSlots`); the finish-of-run staging, which may run beside other runs, stays on the staging slot |
| Deal with whatever still blocks a batch, one step at a time | Each batch card on the PR batches tab shows its state in plain words and one button; **Run one step yourself** holds the run-wide steps. Failed batches: **Re-verify failed batches** (`POST /api/runs/:id/batches/restage-failed`; one batch: **Re-verify again**). Units a dry run blamed: **Set aside blocking units** (`POST /api/runs/:id/batches/:batchId/set-aside`) moves them to `set_aside` with the findings and re-verifies the rest. A finding on an upstream file the batch does not write (the origin lint reaches files that include a header the batch changes) is blamed on the unit whose file it includes, or whose files reach it through their includes (`GET …/blocking` previews this). When upstream changed such a file after the base the last dry run checked (recorded as `lastSubmit.base`; older dry runs fall back to the staged branch's base), the finding may be stale and set-aside refuses (`fixedUpstream`, `drift` in the preview): dry-run again, after restarting the server when only the upstream branch has the change (a restart fetches the base branch and pins its current head). **Check against upstream** (`POST /api/runs/:id/batches/set-aside-upstream`) does the same for every staged batch with the upstream findings. **Put back** (`POST /api/runs/:id/set-aside/put-back`, optional `units`) re-verifies set-aside units once the cause is gone. Withheld packets are rechecked on their own when the first blocking claim lapses (`GET /api/runs/:id/withheld/next-lapse`), only while nothing else holds the slots and at most every 30 minutes |
| Follow a pull request after submission | Each PR batch keeps `detail.prStatus` (`RepoAdapter.pullRequestStatus`: four `gh api` reads, the PR and its conversation, inline comments and reviews; comments by the operator's own account are marked `mine` and never count). Read on `POST /api/runs/:id/pull-requests/refresh` (`{ batchId }` for one), when the PR batches tab opens and the last read is over 3 minutes old, and every 10 minutes for open PRs of completed runs; a merged PR is final. State changes and new comments are events. **Explain the comments** (`POST /api/runs/:id/batches/:batchId/explain-review`): one model call on the run's top worker tier (cost added to the run), comments framed as untrusted data, JSON `{summary, points[{author, about, plain, action}], nextStep}` cached in `detail.prExplain` until the comments change (`orchestrator/review.ts`) |
| Fix a pull request from its review | **Fix from the comments** (`POST /api/runs/:id/batches/:batchId/fix-review`; refused for a merged PR or one without comments from others). A comment on a file goes to the packets that write it, one on the whole PR to every packet (`reviewTargets`). Those packets go back to `pending` with `fix_json` `{check: "review", reasons, pr, prOpen}`; their first attempt gets a `REVIEW_FIX` retry section with the comments as requests (never orders), and the run goes through its flow again. Open PR: the batch stays `submitted` (`detail.reviewFix`), the fixed packets are staged as a batch of their own (`detail.updatesPr`), and **Push the fixes to #N** (`POST .../push-review-fixes`, `{confirm: true}`; `RepoAdapter.updatePullRequest`) checks out the PR branch, refuses if the PR closed or the fork moved, writes the files, re-verifies every packet of the PR, commits "Address review comments…" and pushes a fast-forward. Closed PR: the batch is `superseded`, its other packets go back to `passed`, and everything is batched for a new PR |
| Ride out an AI account outage | Every 5 s (`outageCheckMs`), and right after a provider error, the engine asks the pool (`AccountPool.health`) about every account the run's worker tiers resolve to. Down: `disabled`, `quota_exhausted` or over its daily budget, `circuit_open`, or `cooling` for more than a minute; rate limits and concurrency waits are not down. All down: the run is paused (in-flight attempts finish), `runs.outage_json` records `{ since, nextBackAt, accounts }`, `run.outage_paused` is emitted, and the failed call's packet goes back without a provider-failure charge. Paused runs with `outage_json` are checked on every tick, loaded or not (so after a restart too): once any account is up, the mark is cleared, `run.outage_resumed` is emitted and the run resumes (not over budget, and only when no other run holds the slots). A manual pause sets no mark, so the server never resumes it; a manual resume clears the mark. The run screen shows the accounts, their state and when each should be back (`metrics.run.outage`) |
| Open pull requests while the run goes on (before others claim the same functions) | **Rolling batches**. After every verdict that takes a packet out of the queue, the engine checks (coalesced per run, 250 ms; one aggregate query, `Store.readyUnits`) whether the matched functions of *ready* units (no packet of the unit pending, leased or gating; open-PR review fixes apart; units in a failed batch apart) reach `prBatchSize`. If so it packs them by whole unit (`packUnits`) and stages every bin of at least 90% of the batch size (`readyThreshold`) at once, under the slot lock with `besideRun` (staging worktree only, never the workers' slots), and emits `run.batched_early`. A ready set that packed into no full bin is remembered and not re-packed until it changes. The lease query orders packets of already-started units first (after the worker's own packets), so units finish sooner. Every PR step accepts a `running` or `paused` run (`PIPELINE_STATES`) and runs beside the workers on the staging worktree; while the run goes on with staging on, **Prepare all for PR** batches only ready units that fill a batch. The run's end waits for a step holding the slot lock, and goes on instead of finishing if that step sent packets back to the agents. `GET /api/runs/:id/batching`: `{ batchSize, fullAt, rolling, ready, fresh, waiting, batching }` (functions, packets, units). The PR batches tab shows it as **Next PR batch: N of 40**; the Packets tab pages (`limit`/`offset`, 50–500 per page, remembered per browser) and shows functions per state next to packets. It sorts on any column and filters per column (`GET /api/runs/:id/packets?q=<json>` → `Store.queryTasks`: whitelisted sort columns, parametrized filters, `{ rows, total, functions, facets }` where each value-list column's counts apply every other column's filter) |
| Fewer, bigger pull requests | **Combine into N batches** next to **Prepare all for PR** (`POST /api/runs/:id/batches/rebalance`, optional `{ max }` up to 60; `GET` returns the plan: today's batches and the sizes after). Shown only when it would mean fewer batches. Every unsubmitted staged batch (no PR, no real submission attempt) has its local branches deleted and becomes `superseded` (`detail.rebalanced`); their packets are re-verified as new batches packed first-fit decreasing by whole unit (`packUnits`, `stageRun(..., { pack: "dense" })`). The new batches need a dry run again |
| Fix a batch whose check failed with the AI agents | **Fix with AI agents** on its card (`POST /api/runs/:id/batches/:batchId/fix`; plan in `RunEngine.fixPlan`). A batch that failed re-verification sends the packets its combined tree no longer matched (`detail.failedTaskIds`, or the packets its problem lines name); a staged batch whose dry run failed sends the packets of the units the dry run blamed, never for claims or upstream findings. Each goes back to `pending` at the tier that matched it with fresh per-tier counters and `tasks.fix_json` (the check and its lines). The worker starts from the unit's other accepted packets (carried files), and its first fix attempt gets a `BATCH_FIX` retry section with what the check reported instead of a rejection; later attempts get the Gate Keeper's feedback as usual. The batch becomes `superseded` (`detail.fixed`) and the run runs again; when it finishes, every matched packet is batched and re-verified. Refused unless the run is completed, within budget, and the slots are free |
| Throw a run away | **Delete** (`DELETE /api/runs/:id`). Refused while the run is loaded or staging. Removes its tasks, attempts, verdicts, events, batches, workers and caches in one transaction. Releases the local claims it still holds, except functions in a submitted PR or open in another run |
| Try the failures again in a fresh run | Tick earlier runs under **Carry failed functions** when creating a run (`config.carry.fromRuns`). The server resolves their dead packets' RVAs into `config.carry.rvas`, and discovery adds them to the run's own selection (event `run.carried`). Choose the source *only failed functions carried over* to make them the whole run |

Not verified against GitHub: the real `Submit PR` path was not run (the tests cover it with a
stub adapter). The `sr submit --dry-run` JSON fields it reads (`ok`, `blockers`, `warnings`,
`plan`) were checked against a live dry run.
