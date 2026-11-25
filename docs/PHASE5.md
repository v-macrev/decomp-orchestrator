# Phase 5 — the deterministic reconstruction engine

The orchestrator ([PHASE2](PHASE2.md) to [PHASE4](PHASE4.md)) discovers, queues, gates, stages and prepares work. This phase adds a **deterministic
worker**: a flow node whose answer is produced by software, with no model, no account and no network, and
then judged by the same Gate Keeper as any other answer. Orchestration is not rebuilt; the engine is plugged
in between "prepare" and "materialise edits".

Specification: [DETERMINISTIC_WORKER_PROMPT.md](DETERMINISTIC_WORKER_PROMPT.md).

| Document | Contents |
|---|---|
| [recon/REPOSITORY_AUDIT.md](recon/REPOSITORY_AUDIT.md) | Pinned revisions, what was read, findings with file and line, discrepancies |
| [recon/ARCHITECTURE.md](recon/ARCHITECTURE.md) | Processes, layers, determinism contract, evidence states, privacy |
| [recon/INTEGRATION_CONTRACT.md](recon/INTEGRATION_CONTRACT.md) | The JSON Lines protocol, outcome mapping, the tier in the orchestrator |
| [recon/TECHNICAL_DECISIONS.md](recon/TECHNICAL_DECISIONS.md) | Dated decision log, dependencies, open questions |
| [recon/IMPLEMENTATION_ROADMAP.md](recon/IMPLEMENTATION_ROADMAP.md) | Status per phase as measured, blockers, next increments |

Code: `engine/recon/` (Python, standard library only so far), `apps/server/src/recon/` (protocol and process).
Run the engine's checks with `python3 -m recon doctor --worktree <upstream worktree> --checkout <checkout>`
in the checkout's host; tests: `python3 -m pytest` in `engine/recon` and `npm test` for the server.

State: Phases 1 and 2. The engine loads and verifies the pinned image, maps addresses, reads the offered inventory,
decodes every unmatched function range (in agreement with upstream's decoder), reads unwind data and RTTI, and refuses
what upstream's comparator refuses. It reconstructs nothing yet and says so (`ENGINE_NOT_IMPLEMENTED`). Only the user
submits; nothing here opens a pull request or publishes a claim.
