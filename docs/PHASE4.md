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
| Tiered routing, stealing, retry escalation | Existing (Phase 2) | `packages/core/src/flow.ts`, `orchestrator/engine.ts`, `queue/taskQueue.ts`. Escalation after the 2nd failed attempt (`promoteAfterFailures: 2`) carries the structured retry delta |
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
| One pull request per batch, through the repo's own tooling | **Dry run**, then **Submit PR** (`POST /api/runs/:id/batches/:batchId/submit`). `sr submit` handles one task, and a task is one unit. So the batch is rebuilt on `decomp/<run>-b<n>-pr` from the base and every packet is re-verified, which also refreshes each task's `last-compare.json`. Every unit except the last is committed with the batch message (attribution and co-author trailers). `sr submit --drafted-by "<person>, assisted by <models>"` then runs on the last unit's task. It applies its own gates (pinned compiler, unit digest, intake preflight, push probe), commits that unit, pushes the branch to the fork and opens the PR. `sr submit` checks other people's open claims only for its own task, so each other task of the batch gets a `sr submit --dry-run` first: a collision blocks the real submission. A multi-unit PR is retitled `Reconstruct N functions` and its body gains a list of the other functions (`gh pr edit`). Submitting needs a clean dry run in the UI and `confirm: true` in the API. A submitted batch cannot be submitted twice |
| Submit the rest of a batch when other contributors claimed some of its functions during the run | **Drop colliding packets** (`POST /api/runs/:id/batches/:batchId/drop-collisions`). The adapter runs the repository's own collision rule (`open_items(refresh=True)` + `claim_state` from `tools/contrib.py`, the rule `sr submit` blocks on): only fresh claims and PRs by others count, not lapsed ones (a day without activity) or the operator's own. A unit's final file carries every packet of the unit, so a collision withholds the whole unit: its packets move to `withheld` and keep their local claims. The batch's local branches are deleted, it becomes `superseded`, and the other packets are re-verified as a new batch, which needs its own dry run. If claims cannot be checked, nothing changes. **Recheck withheld** (`POST /api/runs/:id/withheld/recheck`) checks again and batches every unit that is clear now. Nothing is pushed, and no `--ack-collision` is ever passed |
| Throw a run away | **Delete** (`DELETE /api/runs/:id`). Refused while the run is loaded or staging. Removes its tasks, attempts, verdicts, events, batches, workers and caches in one transaction. Releases the local claims it still holds, except functions in a submitted PR or open in another run |
| Try the failures again in a fresh run | Tick earlier runs under **Carry failed functions** when creating a run (`config.carry.fromRuns`). The server resolves their dead packets' RVAs into `config.carry.rvas`, and discovery adds them to the run's own selection (event `run.carried`). Choose the source *only failed functions carried over* to make them the whole run |

Not verified against GitHub: the real `Submit PR` path was not run (the tests cover it with a
stub adapter). The `sr submit --dry-run` JSON fields it reads (`ok`, `blockers`, `warnings`,
`plan`) were checked against a live dry run.
