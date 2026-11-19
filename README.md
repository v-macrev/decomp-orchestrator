# decomp-orchestrator

Bulk LLM orchestration for function matching in
[`awarebayes/skyrim_decomp`](https://github.com/awarebayes/skyrim_decomp).

* **Multi-provider, multi-account pool.** Claude (API keys, OAuth tokens, Claude Code CLI profiles),
  OpenAI, and any OpenAI-compatible endpoint, with several accounts or workspaces per provider. A
  rate-limit-aware scheduler adds token buckets, adaptive concurrency (AIMD), cooldowns, a circuit
  breaker and quota/budget states. One throttled account fails over without stalling the run.
* **Durable bulk engine.** Built for 500+ functions per run: an SQLite job queue with leases and
  heartbeats, pause/resume/cancel, budgets, dead-letter and quarantine queues, an escalation ladder
  across worker tiers, and crash recovery on restart.
* **Gate Keeper.** The repo's own `./sr compare` and `preflight` run behind anti-abuse guardrails:
  * Scope allowlist.
  * A port of the repo's leakgrep rules.
  * Cheat detection: byte arrays, absolute-address binding, pragma/macro tricks, stubs, edits to
    matched bodies, verifier tampering.
  * Integrity and tamper digests.
  * Bounded, env-scrubbed processes in per-slot git worktrees, with optional Docker.
  * Structured verdicts with exact `file:line` reasons that route back to workers.
* **Function gathering.** The Orchestrator builds each batch from the repository itself:
  * the public inventory (`data/progress.json`), joined with `sr next` for unit mapping, readiness
    and claims;
  * local claims and this tool's own in-flight work;
  * the unit sources (declared signature, existing draft or stub);
  * local packs and an optional function table for shape and xrefs.

  Filters by size, RVA range, namespace, module, unit and name origin. Every exclusion is counted.
* **Per-worker function cap.** Each worker instance may claim at most 60 functions per run
  (configurable), charged atomically with the lease. The run form warns when
  `workers × 60 < batch`, and a run that exhausts every eligible worker pauses with a clear
  message; the operator can raise the cap and resume. See [docs/PHASE4.md](docs/PHASE4.md).
* **Capability routing.** Each function is scored from its shape: branches, loops, virtual calls,
  SSE, EH funclets, earlier failures. Packets go to fast, balanced or frontier worker tiers. Idle
  higher tiers steal lower-tier backlog, and failing packets are promoted up the ladder.
* **Token-efficient context.** Each attempt gets a budgeted bundle:
  * a cached static prefix with distilled repo rules
  * tree-sitter-sliced headers
  * pattern-matched lessons
  * declarations verified earlier in the run
  * a structured retry delta
  * function-level edits for large units

  On real packets this sends 67% fewer tokens than full context (−77% with the cached prefix).
  See [docs/PHASE2.md](docs/PHASE2.md).
* **Self-improving skills.** A registry of compact matching recipes (`SKILL.md`, ≤ 600 tokens each)
  with deterministic triggers: listing regexes, symbol prefixes, shape counts, verdict codes. They
  are matched locally before each call, so no extra round-trips. A curator works between runs:
  * bootstraps skills from the repo's cookbook and PR history;
  * mines new ones from retry wins;
  * patches skills that keep failing;
  * promotes widely used skills into the cached prefix;
  * compresses bloated ones and deprecates harmful ones.

  Nothing reaches workers until it wins a shadow replay through the Gate Keeper. Skills never
  change a running run's cached prefix. See [docs/PHASE3.md](docs/PHASE3.md).
* **Visual flow builder.** A React Flow canvas for Orchestrator, Worker-tier and Gate Keeper
  topologies (fan-out, fan-in, retry loops, escalation, difficulty rules on dispatch edges), saved
  as named presets.
* **Live telemetry.** Queue depth, slots, pass/retry/escalate/dead/quarantine, per-account health
  and throughput, tokens and cost, and per-packet attempts, verdicts and diffs.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the design, data model, sandboxing and
trade-offs.

## Quickstart (simulation, no API keys)

```sh
npm install
npm run build:web
npm run dev            # server on http://127.0.0.1:8787 (sim mode, demo account pool)
```

Open http://127.0.0.1:8787, start a run on the **Runs** tab, and edit the topology on the **Flow
builder** tab. Headless end-to-end simulation (500 functions, injected 429s, outage, quota, a hard
crash at 40% and resume):

```sh
npm run sim -- --count 500 --crash-at 0.4 --speed 4
npm test               # scheduler, gate-rule corpus (0 FP / 0 FN), gate pipeline, engine + crash recovery, routing, context
npm run bench:context -w @decomp/server -- --count 500   # legacy vs budgeted vs routed: tokens and cost per matched function
npm run bench:skills -w @decomp/server -- --count 500    # skill loop: bootstrap → run → curate → run, skills off vs on per backlog
```

## Against a real skyrim_decomp checkout

1. Set up the target repo once on this machine following its own guide (`./sr go`, which needs
   your own copy of the game and your acceptance of Microsoft's licence).
2. `cp config/orchestrator.example.json config/orchestrator.json`, then set `repo.path`,
   `repo.localDir` (the absolute `SR_LOCAL_DIR`) and `slots`.
3. `cp config/accounts.example.json config/accounts.json` and point each `secretRef` at an
   environment variable (`env:ANTHROPIC_KEY_WS_A`) or file. Keys are never stored in the DB.
   Accounts can also be managed from the **Accounts** tab.
4. `npm run dev`, then start a run with source **sr next**. Leave *exposure consent* off unless you,
   as the owner of the game copy, agree to send locally made listings to your AI providers.
5. Accepted units are staged on local branches (`decomp/<run>-b<n>`), re-verified as a whole.
   Review them and submit with the repo's own `./sr submit`; nothing is pushed automatically.

Set `ORCH_API_TOKEN` to require a bearer token on the API (the UI asks for it). The server binds
to `127.0.0.1` by default.

## Layout

```
packages/core     Zod schemas (accounts, flows, tasks, attempts, verdicts) + flow validation/compilation
packages/skills   skill schemas, deterministic trigger matcher, SKILL.md format, compression, safety scans, cookbook parser
apps/server       engine, queue, account pool, providers, Gate Keeper, repo adapters, skill registry/curator/shadow evaluator, API, simulator
apps/web          React + React Flow UI
docs/             architecture
config/           example configs
```

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-or-later`).
