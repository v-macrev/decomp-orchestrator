# Repository audit (Phase 1)

Specification: [DETERMINISTIC_WORKER_PROMPT.md](../DETERMINISTIC_WORKER_PROMPT.md), section 4.
Overview: [PHASE5.md](../PHASE5.md).

## Pinned revisions

| What | Revision | How it was read |
|---|---|---|
| upstream `Mudcrab-Team/skyrim_decomp` | `39e7cb38b1028e500c692e953b76a4308babc4a6` (`origin/main`, "Refresh trend charts") | A detached worktree at that commit, made for the audit. The clone's own working tree stands on a contributor branch (`b07764bf01`) and was not used. |
| this repository | `242408c` plus the Phase 1 working tree | Direct reading |
| game image | `builds/target.json`: build `sse-steam-1-7-104`, sha256 `846efccf…1402f` | `recon doctor` hashed the configured image and it **equals** the pin |

Paths below are relative to the repository named in the heading. Upstream line numbers are at the pinned
revision and move with the base. A `recon audit` command that re-checks them **does not exist yet**
(Phase 6); until then a base move means re-reading.

## Method and limits of this audit

Read: upstream agent instructions, contributor card, clean-room text, code rules, the comparator entry
point and its runtime variant, the recipe list and alternatives, the verifier README, the module list;
and in this repository the run loop (`processTask`, `slotLoop`), host and process layers, attribution,
the flow and run schemas, the migration list and the Gate Keeper's cheat rules.

**Not yet audited** (each is a Phase 2 or 6 input, listed with the item of section 4.3 it answers):
`tools/verifier/bind.py` binding order beyond the card's text (13); `permute.py` importability (14);
the exact content of a pack (15); comparator reason-code list from source (17); `staging.ts` and
`history.ts` behaviour with a model-less attempt (18); how `sr compare` and the in-process comparator
differ in cost (7, measured below as *not yet measured*). They are not assumed.

Nothing game-derived was read: no pack, listing, byte run or decompiler output was opened.

## Findings

### The comparator is a pure function we can call

> **Corrected 2026-11-25.** The first version of this section named `tools/compare.py` 0.6.0 as the engine that
> decides. It is not: `sr compare` runs **`tools/compare_runtime.py` (0.6.1-runtime)** on both of its paths
> (`tools/contrib.py:2499-2531` `compare_with_local_dir`, used because this tool sets `SR_LOCAL_DIR`; and
> `tools/verifier/verify_function.py` `run`, which starts `compare_runtime.py`). It also said the build record comes from
> `unit_build.py`; on the `sr compare` path it is written by `contrib.compile_unit` (`tools/contrib.py:730-813`),
> which uses `unit_build`'s checks. The engine now calls these (`adapters/skyrim/comparator.py`).

`tools/compare.py:855` `compare(task, manifest, recipe_bytes, build_record, object_bytes, image_bytes,
symbol_map, diagnostics=None, private_root=ROOT/'.local')` returns a sanitized report and never raises for
a comparison failure (`tools/compare.py:857-858`). Versions at the pin: `COMPARATOR_VERSION '0.6.0'`,
`CONTRACT_VERSION 2` (`tools/compare.py:21-23`). `tools/compare_runtime.py` is a second engine for ordinary
functions with a verified CRT termination action (`COMPARATOR_VERSION '0.6.1-runtime'`,
`tools/compare_runtime.py:15`). The comparator's source digest is part of every report
(`tools/compare.py:49`, `:870`), so the engine's cache keys carry the digests of the files it imports
(`REPOSITORY_AUDIT` section "Imported modules").

`compare` needs the candidate COFF object, a *build record* (compiler binary hashes; checked by
`check_provenance`, `tools/compare.py:90`), the task JSON, the recipe bytes and the symbol map. The build
record is produced by `tools/verifier/unit_build.py` (`prepare_host` at `:425`, `make_task` at `:478`).
**Consequence:** a contract-equal local compare is feasible only if the engine's scratch build writes a build
record the comparator accepts; whether that is cheaper than a full `sr compare` is **not yet measured**
(gate item of Phase 1, see IMPLEMENTATION_ROADMAP).

### The target is pinned and verified

`builds/target.json` pins `build_id sse-steam-1-7-104`, `architecture x86-64`, and `image_sha256`. The engine
checks the configured image against it on every load (`adapters/skyrim/environment.py`).

### Imported modules (Phase 1 set, digests are computed at run time)

`tools/pecoff.py`, `tools/compare.py`, `tools/compare_internal.py`, `tools/compare_runtime.py`,
`tools/analysis/x64.py`, `tools/analysis/imagemodel.py`, `tools/verifier/{bind,align,disasm,permute,unit_build}.py`.
All 11 exist at the pin, and `import pecoff, compare` succeeds under `python3 -I` with only
`tools/` on the path (`recon doctor`, check `upstream.import`).

### Compiler recipes

`reconstruction/recipes/` holds 42 JSON recipes (counted: 6 compilers `19.00.24247` to `19.15.26731` with
plain, `-reconstruction` and `-root-includes` forms; `19.16.27054` with `o2`, `o2-noeh`; `o2-fpfast`,
`o2-os` and their `noeh` forms; two "represented" wrappers). `data/recipe-alternatives.json` lets
`msvc-19.16.27054-o2*.json` also be accepted as the `noeh` recipe when `requires: target-no-eh-frame`
(`data/recipe-alternatives.json:3-13`). The unit's `Recipe:` line chooses the recipe
(`tools/contrib.py:2544`, `:2574`: "only once the unit's `Recipe:` line names that recipe").
`sr compare` retries an alternative flag set only without `--no-retry` (`tools/contrib.py:3399-3400`).

### Source rules that shape engine output

`docs/code-rules.md`: R4 typed members, no offset casts (`:47`); R14 `goto` only where control flow needs
it (`:57`, severity *checked*); R17 no fake code (`:60`); R38 no codegen steering, `noinline` needs a
`// noinline: <evidence>` comment (`:81`); R39 no decompiler leftovers (`:82`); R40 no model, tool or
pipeline name, `generated by`, `.local/`, host path or e-mail in a comment (`:83`, `:103`). R38 to R40 are
refused at intake before any compare (`docs/code-rules.md:108`).

### Provenance wording for tool-made source

`docs/contributor-card.md` (Header section): the skeleton header is at most 6 counted lines (Source exposure,
SPDX, `Code origin`, `// 0x<rva> Name`, `Adapted bodies`, include); `Drafted by`, `Task`, `Labels`, `Evidence`,
`Recipe` (unless non-default) are left out. A claim names "the actual model id or agent/tool name". Rule R40
refuses a comment naming a model, tool or pipeline. The `Code origin` sentence and the `--model` value for engine
output (section 4.3, point 10) were the user's question; on 2026-11-26 they kept the conservative default
(`TECHNICAL_DECISIONS.md`, D-006). Nothing is submitted by this project in any case.

### Clean-room and private inputs

`AGENTS.md` ("Keep private inputs private") and `docs/clean-room.md`: nothing game-derived in commits, PRs,
issues, logs or CI; do not upload game-derived material to an AI service without owner authorisation. The
engine reads the image locally and sends nothing anywhere. **For this project's own development** it means
the implementing agent does not open packs or listings; diagnosis that quotes instructions is written only
under `.local/orchestrator/recon/` and read by software.

### Environment of the checkout (measured 2026-11-25)

| Fact | Value | Source |
|---|---|---|
| Checkout host | WSL distro `Ubuntu`, 4 CPUs, 7896 MB memory | `recon doctor` |
| Python in WSL | 3.14.4; `pytest` present; `iced_x86`, `z3`, `capstone`, `hypothesis` absent; `pip` absent, `venv` present | probe |
| Python on the Windows host | 3.13 and 3.10, through the `py` launcher. **Corrected 2026-11-25**: the first probe tried only `python` (a Store stub) and wrongly reported "absent" | `py -0p` |
| Memory of the host | 15.9 GB, with a fixed commit limit; WSL was stopped twice by Windows under memory pressure during measurement (event 2004). Engine jobs must stay small (D-010) | event log |
| Pinned image on the Windows host | present in a Steam library, sha256 equals the pin, so the image-only commands also run there | hash |
| Wine | `wine-10.0` | `recon doctor` |
| `llvm-objdump` | present in WSL | probe |
| MSVC toolchain directory | present (path in the private contrib config) | `recon doctor` |
| `.local/verifier/runners.json` | **absent**, so upstream's machine-wide heavy-job cap (`local_max_heavy`, `tools/local_load.py:33`) is unset | probe |
| Slot worktrees | six, detached at `dc1b52fddc`, older than `origin/main` | `git worktree list` |

### Orchestrator seams (where a model is assumed)

`apps/server/src/orchestrator/engine.ts`:

| Lines | What | Deterministic tier |
|---|---|---|
| `2710-2812` `slotLoop` | leasing, stealing (`2745-2770`), `capacityBlocked` stall (`2777-2789`), budget pause (`2736-2744`) | stealing and capacity rules must not apply (decision D-009) |
| `2814` `processTask` | one packet from lease to route | branch point |
| `2831-2880` | reset, taken check, carried files, `repo.prepare`, thunk skip, splice | stays as is |
| `2882-2903` | late classification by pack | stays; the engine tier takes every difficulty |
| `2906-2940` | `contextV2.build` (reads the pack, depends on `exposureConsent`) | **bypassed** |
| `2941-2949` | attempt row, `skills.recordSelections` | row kept, skill selection skipped |
| `2953-2962` | free attempt (splice, stored candidate): no model call | the precedent |
| `2963-3027` | `pool.acquire`, `providers.complete`, outage pause (`3011-3016`) | **bypassed** |
| `3031-3108` | parse, materialise, restore accepted, declare members, repair, repeat check | **shared tail** |
| `3110-3127` | gate, `learn`, `route`, `splitMatched`, `recordAttribution` | **shared tail** |
| `3129-3150` | abort and failure handling, slot reset in `finally` | shared |
| `3136-3141` | `NoEligibleAccountError` dead-letters the packet | must not occur for an engine node |

Other assumptions: `modelHint = node.data.pool.model ?? 'decomp-orchestrator'` names the claim
(`engine.ts:2853`), so an engine node must pass its own model name or the claim carries the generic one;
`srRepo.prepare` passes `--model` to `sr claim` and `sr start` (`repo/srRepo.ts:416`, `:423`) and
`sr compare` passes none (`:585`), taking the claim's. The private contrib config names a default model
(read from `.local/contrib/config.json`; its value is not repeated here), which upstream falls
back to (`tools/contrib.py:1975`, `:2129`, `:2634`): **an engine attempt must never reach a call without its
own model name.** `exposureConsent` is read at `engine.ts:2922`, `:2928` and in the context builders
(`contextBuilder.ts:135`, `:331`), nowhere else, so an engine tier needs none.

Per-worker cap: `maxFunctionsPerWorker` (default 60) lives in the run config and the queue
(`db/database.ts:295`, `api/server.ts:150-168`, `queue/taskQueue.ts`).

### Process execution

`repo/host.ts`: `Host.run(cmd, args, {cwd, env, timeoutMs, signal, stdin, maxOutputBytes})`. The WSL host
runs `wsl.exe -d <distro> --cd <cwd> --exec env K=V ... timeout -k 10 <s> cmd` (`host.ts:57-76`). Only when
a signal is given **without** stdin does it wrap the command in a script that stops its own child when the
host writes a newline (`host.ts:68-71`, script at `:94`). `util/proc.ts` scrubs the environment: names matching
KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, AUTH, COOKIE or SESSION never pass (`proc.ts:38,44`), output is capped,
and the process tree is killed on timeout or abort (`proc.ts:53,93-100`).

**Limits found (both feed roadmap item R-1):**

1. `Host.run` returns stdout when the process ends, so `progress` lines are available after the engine
   finishes, not live. Heartbeats come from `processTask`'s own interval (`engine.ts:2821-2823`) and do not
   depend on engine output.
2. The engine request goes by stdin. With stdin given, the WSL cancel handshake is off (`host.ts:68`): an
   abort kills `wsl.exe` on Windows, and the Linux child ends when its pipes close or at the `timeout -k`
   expiry. For a bounded engine that is acceptable, but it is not the clean stop the other commands get.
   The fix is a request file in the task directory instead of stdin, which lets the handshake run.
   `runEngine`'s cancellation test runs on the local host only.

### Gate Keeper

The cheat rules live in `gatekeeper/rules.ts` (`CHEAT_STUB` at `:213`, the block list at `:285`);
the comparator runs through `repo.compare` in `gatekeeper/gatekeeper.ts` with `protectedDigest` checked
before and after (`:139`, `:202`). A body trivial for a target of 24 bytes or more is a cheat stub
(`rules.ts:213`), so the engine never sends partial bodies.

## Discrepancies between the prompt and the code

| # | Prompt says | Found | Effect |
|---|---|---|---|
| 1 | The Windows host has Python 3.13 and a native `cl` | Python 3.13 **is** there (first audit was wrong); a native run of the *pinned* compiler is not measured | D-015 |
| 2 | `Host.run` offers live progress and clean cancellation for the engine | Stdout is returned at exit; with stdin the WSL cancel handshake is off | R-1 in the roadmap |
| 3 | Counts of section 4.4 | `data/progress.json`: 42,221 functions, 41,235 matched, 986 mapped: **equal** | none |
| 4 | Slot worktrees stand on the base | They stand on `dc1b52fddc`; `origin/main` is `39e7cb38b1` | The input digest names the unit content and the upstream files actually imported, not the ref |

## Phase 2 additions (2026-11-25)

Answers to section 4.3, point 1 (discovery and identity) and parts of 2, 15, 17.

* **Offered targets** are `data/target-hashes/contributor-targets-part-NNN.json` (22 parts, `functions[]` of
  `{rva, size, extent_source, window}`): **64,010 distinct functions**. The index `contributor-targets.json` states
  `next_candidate_count 64197`, 187 more than the parts hold. **Explained 2026-11-25** from
  `tools/target_hash_offers.py:276-303`: the count is `len(next_)`, which includes startable functions that already have
  a progress entry, while the rows are `(wanted | next_) - known`. 63,771 rows carry the window flag and 239 (claimed or
  on demand) do not, so 426 recorded candidates are counted and not listed: 63,771 + 426 = 64,197 and
  63,771 + 239 = 64,010. The parts are the right list.
* **Progress entries**: `data/progress.json` holds 42,221 functions (41,235 matched, 986 mapped; fields `rva, size,
  status, name, name_origin, name_source, owner, evidence, report`). **None of the 62,247 unmatched offered
  targets has an entry**; that is by construction (the list is `... - known`), not a finding. The 986 `mapped` entries are
  therefore unmatched work outside the offered list; the inventory now carries them as a population of their own. A target without an entry
  has no recorded name, owner or status; its unit and class come from `sr next` and the facts files, which
  Phase 6 reads.
* **Boundaries**: the inventory range equals the contiguous `.pdata` coverage for all 55,265 unmatched functions
  that have unwind data; 6,982 have none. The comparator refuses a `.pdata` entry that crosses the range
  (`tools/compare.py:582-583`, `unwind-entry-crosses-boundary`) and entries that overlap (`:593-594`); the survey
  applies the same rules before any search.
* **Unwind refusals** that can be known from the image alone: `unsupported-unwind` for version other than 1 and
  for a chain that carries a handler (`tools/pecoff.py:345-348`). The handler names the comparator accepts
  (`__CxxFrameHandler3`, `__GSHandlerCheck_EH`, `__C_specific_handler`, `__GSHandlerCheck_SEH`,
  `__GSHandlerCheck`, `tools/pecoff.py:354-360`) belong to the *candidate's* object; the image holds handler
  addresses, not names, so the engine classifies the handler data (`FuncInfo` magic) and does not name handlers.
* **Upstream's image model** (`tools/analysis/imagemodel.py`) needs a Ghidra export that is not present on this
  machine, so the engine finds RTTI and vtables itself (`adapters/x64_msvc/rtti.py`).
* **Machine**: the private venv (pip 25.1.1) was created under the checkout's `.local/orchestrator/recon/`.
