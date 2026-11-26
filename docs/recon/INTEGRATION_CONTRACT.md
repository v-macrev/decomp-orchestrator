# Integration contract

Specification: [DETERMINISTIC_WORKER_PROMPT.md](../DETERMINISTIC_WORKER_PROMPT.md), sections 7.4, 7.5, 19.1, 22.
Code: `apps/server/src/recon/{protocol,process}.ts`, `engine/recon/recon/protocol/__init__.py`. Both sides
validate strictly and have tests against the other's behaviour.

## Protocol, version 1

One request line, from the file `--request` names (the server's way) or on stdin; any number of `progress` lines then exactly one `result` line on stdout; exit 0.
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

## The deterministic tier in the orchestrator (Phase 6, implemented)

* `FlowNodeData.kind: 'llm' | 'deterministic'` (default `'llm'`, so every saved flow loads) and an optional
  `recon` block (`candidates`, `compiles`, `timeoutSec`, `maxFunctionBytes`). `deterministicFirstFlow()` in
  `packages/core/src/flow.ts` gives the two presets: engine only (`deterministic-only`), and engine first with
  the model ladder behind it (`deterministic-first`). The flow builder has a worker-kind field and a template.
* `processTask` branches after prepare and late classification into `engineAttempt`: no context bundle,
  `pool.acquire`, `providers.complete`, skill selection, prefix pre-warm or response parsing. Its answer goes
  through `answerTail`, the shared tail the model path and the free-attempt path also call.
* `modelHint` and the attempt's `model` are `recon-engine-<version>`; the account is null and tokens and cost are 0.
* The server sends: the packet (RVAs, sizes, community names, unit, allowed paths), the slot's worktree, the
  checkout, `dataDir` (`<localDir>/orchestrator/recon`), `modelName`, budgets, and options. `options.modelTextInUnit`
  is set when files of earlier packets of the unit are carried; the engine then reads the unit's header only at the
  base revision. Never sent: pack directories, carried file contents, stored candidates, `task.fix`.
* The request goes in a private file (`<dataDir>/requests/<id>.json`, `serve --request FILE`), removed afterwards,
  so stdin stays free for the cancel handshake (R-1).
* Configuration: `recon` in `config/orchestrator.json` (`enabled`, `python`, `pythonPath`, `engineDir`,
  `timeoutSec`). A flow with a deterministic tier is refused at run creation when no engine is configured.
* Scheduling for a deterministic tier: D-009 and D-036. A run with only deterministic tiers starts and finishes
  with no accounts, makes zero provider calls and needs no `exposureConsent`; `apps/server/test/deterministicTier.test.ts`
  asserts all three.

## Additive persistence (Phase 6, implemented)

Migration 8 appends `recon_results`: run, task, attempt, RVA, size, engine and rule-store versions, input digest,
status, reason code, counters, rule trail, origin labels, evidence summary, infrastructure kind, duration. Codes
and counts only. `TaskState` is not extended. A copy of the live database migrates 7 to 8 and every saved flow,
run, task and attempt loads; the live `data/real.db` is read-only for development.

## Limits found in the existing host layer

See the audit, "Process execution": stdout arrives at process end, and a request on stdin turns the WSL
cancel handshake off. Roadmap item R-1 moves the request to a file in the task directory.
