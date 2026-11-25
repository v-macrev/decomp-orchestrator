# Integration contract

Specification: [DETERMINISTIC_WORKER_PROMPT.md](../DETERMINISTIC_WORKER_PROMPT.md), sections 7.4, 7.5, 19.1, 22.
Code: `apps/server/src/recon/{protocol,process}.ts`, `engine/recon/recon/protocol/__init__.py`. Both sides
validate strictly and have tests against the other's behaviour.

## Protocol, version 1

One request line on stdin; any number of `progress` lines then exactly one `result` line on stdout; exit 0.
Nothing else on stdout. Every object rejects unknown fields; every string is bounded.

**Request** (`EngineRequest`):

```text
{ protocol: 1, requestId, command: "solve" | "doctor" | "analyze" | "explain",
  packet?: { functions: [{ rva: "0x1de5e0", size, name? }] (1 to 4), unit, allowedPaths (1 to 8) },
  worktree?, taskDir?, packDirs?, checkout?, dataDir?,
  carriedUnitState?: [{ path, content }], modelName?, budgets?, options? }
```

`packet` is required except for `doctor`. `budgets` keys: `candidates, compiles, solverUnits, irNodes,
expansions`, integers (operation counts). `options` values are booleans, integers or short strings.
`checkout` is an addition to the specification: `doctor` needs the checkout, which holds the private contrib
config and the image path (D-005).

**Progress**: `{ type: "progress", protocol, stage, counters }`; the stage is a lower-case name and counters
are integers. Safe for events and logs.

**Result** (`EngineResult`): `{ type: "result", protocol, requestId, command, inputDigest, engineVersion,
ruleStoreVersion, functions[], edits[], codeOrigin?, adaptedBodies?, report? }`.

* `functions[]`: `{ rva, status: solved|unsolved|unsupported|blocked, reasonCode, counters, ruleTrail,
  originLabels, evidenceSummary }`. A result covers exactly the packet's functions (checked by the server).
* `edits[]` is the orchestrator's `UnitEdit[]` (`packages/core/src/schemas.ts:487`), and holds only solved
  functions. Edits without a solved function are refused by the server.
* `report` carries the payload of `doctor` (checks with `ok|missing|mismatch|error|skipped`, a one-line
  detail and the command that would fix it) or `{implemented}` for `analyze` and `explain`. `command` and
  `report` are additions to the specification so that one result type serves every command (D-005).

There is no field for bytes, listings, operands or addresses inside code.

**Exit codes**: 0 a result was written; 2 the request was malformed (the server's defect); 3 internal error.

## Outcome mapping (section 19.1)

The server returns an `EngineRun`; every non-`ok` kind is an *infrastructure* failure.

| Engine outcome | Orchestrator handling |
|---|---|
| `ok`, some or all functions `solved` | One attempt with their edits (`modelName` `recon-engine-<version>`, account null, zero tokens and cost); shared tail; Gate Keeper; normal route |
| Gate Keeper passes | `accept`, then staging per the run's `staging` setting (`branches` or `off`) |
| Gate Keeper rejects an engine answer | An engine defect: record the disagreement, keep the packet, escalate; no second identical attempt |
| `ok`, nothing solved | No files written, no gate call. `escalate` to the next tier, or `dead_letter` with the reason codes on the last |
| `unsupported` or `blocked` | Same, with that reason; the packet is eligible again when engine, rules or declarations change |
| `spawn`, `timeout`, `exit`, `no-result`, `malformed`, `mismatch` | Slot reset, packet requeued within `maxInfraFailures` (`config/orchestrator.json`, `engine.maxInfraFailures`), not charged, not a strike, the run continues |
| `aborted` (run cancel) | Checkpoint kept; packet released as today |
| Lease lost | Route `stale`, as today |

One attempt of a deterministic tier is one complete budgeted search; `maxAttempts` defaults to 1 for such a
node because the same inputs give the same answer.

## The deterministic tier in the orchestrator (Phase 6, not yet implemented)

* `FlowNodeData` gains `kind: 'llm' | 'deterministic'` (default `'llm'`, so every saved flow loads) and an
  optional `recon` block (search budgets, compile jobs, size limit). Account-pool fields are not required for
  a deterministic node.
* `processTask` branches after prepare and late classification (`engine.ts:2831-2903`) and before
  `contextV2.build` (`:2928`): no context bundle, `pool.acquire`, `providers.complete`, skill selection,
  prefix pre-warm or response parsing.
* The shared tail (`engine.ts:3031-3150`) is **factored into one function** that the LLM path, the
  free-attempt path and the engine path call. It is not copied.
* `modelHint` (`engine.ts:2853`) is `recon-engine-<version>` for such a node, so claims never name the
  private config's default model.
* Scheduling decisions for a deterministic tier are in [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md), D-009.
* A run with only deterministic tiers must start and finish with no accounts, make zero provider calls and
  need no `exposureConsent`. A test asserts all three.

## Additive persistence (Phase 6)

New tables, appended to `MIGRATIONS` (`db/database.ts:12`), for example `recon_functions` and `recon_results`:
function id, RVA, size, executable digest, inventory revision, engine revision, analysis, IR and candidate
digests, recipe and dependency digests, verification codes and counts, attempt count, failure classification
and "what would have to change", checkpoint reference (a private file), labels and rule-trail ids,
timestamps. `TaskState` is not extended. Every saved flow, run, task and attempt must still load, and a copy
of the live database must migrate; the live `data/real.db` is read-only for development.

## Limits found in the existing host layer

See the audit, "Process execution": stdout arrives at process end, and a request on stdin turns the WSL
cancel handshake off. Roadmap item R-1 moves the request to a file in the task directory.
