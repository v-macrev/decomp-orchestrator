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
