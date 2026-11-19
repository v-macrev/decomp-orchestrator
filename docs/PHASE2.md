# Phase 2: capability routing and token-efficient context

Phase 2 makes a 500-function run cheaper and faster. Each packet goes to a model tier that fits
its difficulty. Each prompt carries only what that packet needs, in an order that providers can
cache, and verified facts from passing packets are shared with the rest of the run.

Everything is additive:

* Runs created before Phase 2 keep the old behaviour: no routing, legacy bundles.
* Flows and account pools without the new fields still resolve.
* The old two-tier preset is still covered by the engine tests.

## Results

### Real checkout (bundle sizes)

Measured on `awarebayes/skyrim_decomp`, 40 real `sr next` packets at `origin/main`, without
exposure consent (neither form contains listings). Command:
`npm run bench:context -w @decomp/server -- --repo … --host wsl`.

| | tokens / packet | vs legacy |
|---|---:|---:|
| Legacy bundle (all docs, whole headers, full unit) | 11.4k | |
| Budgeted bundle v2 | 3.7k | **−67%** |
| v2, billed equivalent with the static prefix read from cache (0.1×) | ≈2.7k | **−77%** |

Average per-section tokens in v2: static prefix 1,173, spec 149, local context 339, unit files
1,684, lessons 390.

### Simulator (whole runs)

500 functions, seed 42, list prices, no fault injection, `npm run bench:context`. The mock decides
pass or fail from each function's *true* difficulty, never from the prompt, so the comparison
isolates prompt and routing effects.

| config | attempts | input tokens | cache hit | tokens / matched fn | $ / matched fn |
|---|---:|---:|---:|---:|---:|
| 1 baseline: legacy bundles, cheap → strong | 657 | 9.70M | 0% | 19.9k | $0.0471 |
| 2 + budgeted context + caching (same flow) | 630 | 2.27M | 67% | 4.9k (−75%) | $0.0087 (−82%) |
| 3 Phase 2: routed fast → balanced → frontier | 525 | 1.77M | 48% | 3.8k (−81%) | $0.0099 (−79%) |

* Config 2 isolates context engineering.
* Config 3 adds routing: 17% fewer attempts than config 2 and fewer tokens per function, at
  similar cost, because hard packets go straight to the frontier tier. Its cache hit rate is lower
  because three models keep separate caches and promoted packets change model.
* The legacy system prompt (~500 tokens) is below the 512-token cacheable minimum, which is why
  the baseline cache hit rate is 0%. That matches real provider behaviour.

The simulator's baseline uses synthetic docs, headers and listings, so treat the real-checkout
numbers as authoritative. The reduction is −67% / −77% there, beyond the 40–60% goal.

### Pack feature extraction

Checked on the 78 real local packs in the checkout. The x64 classifier's counts match the repo's
own objdump listings on every pack: conditional branches 78/78, calls 78/78, SSE ops 78/78. The
scorer classifies those packs as 38 easy, 15 medium and 25 hard.

## Integration map

| Area | Changed | Added |
|---|---|---|
| Schemas (`packages/core`) | `ModelSpec` (capability, costWeight, cache-write price); `PoolBinding.capability`; `FlowNodeData` (capability, costWeight, stealDown); `FlowEdge.difficulties`; `RunConfig.routing`, `RunConfig.context`; `Task` (difficulty, complexity, attemptsAtDifficulty, assessment); `Attempt` (difficulty, context tokens); `WorkerOutput` (`edits`) | `Difficulty` (= `ComplexityTier`), `CapabilityTier`, `FunctionFeatures`, `ComplexityAssessment`, `RoutingConfig`, `ContextBudgets`/`ContextConfig`, `TaskContextBundle`, `KnowledgeEntry`, `UnitEdit` |
| Flow compiler | several dispatch edges; tier capability (declared or inferred); `plan.route` | `tierFor`, `stealSources`, `inferCapability` |
| Classifier | — | `core/complexity.ts` (pure scoring), `intel/x64features.ts` (pack → counts), `intel/complexity.ts` (backlog → routed packets, tie-break, refinement) |
| Queue | `lease` (work stealing), `nextReadyAt` (several tiers) | `StealSource` |
| Scheduler | `resolve` (capability preference with role fallback), score (cost weight) | — |
| Engine | enqueue (routed packets); slot loop (stealing); attempt (refine, v2 bundle, edits, knowledge); `route` (promotion) | `learn()` |
| Context | legacy `ContextBuilder` kept for `context.mode = legacy` | `TaskContextBuilder`, `intel/headerSlicer.ts` (tree-sitter), `intel/ruleDistiller.ts`, `intel/knowledge.ts`, `orchestrator/edits.ts` |
| Providers | Anthropic: user blocks with `cache_control`; OpenAI: `prompt_cache_key`; `costUsd` prices cache writes | `PromptBlock`, `uncachedCostUsd`, mock `PromptCacheSim` |
| Repo adapters | `includedHeaders` caps; `discover` reports cautions | `analyze()` and `readPackSlice()` (SrRepo reads `SR_LOCAL_DIR/contrib/packs`) |
| DB | migration v2 (additive, backfilled) | `run_knowledge_cache` |
| API / UI | metrics, flow validation | `/api/runs/:id/knowledge`, `/api/bundles/:hash`; difficulty badges, routing panel, token panel, dispatch-edge rules, capability inspector, bundle inspector |

Migrations stay in the existing SQL migration system (`db/database.ts`) instead of moving to
Drizzle. Introducing an ORM mid-project would rewrite every repository for no behavioural gain.
The migration is plain additive DDL, readable in one place.

## Schemas and migration

```ts
export const Difficulty = z.enum(['easy', 'medium', 'hard']);          // spec name: ComplexityTier
export const CapabilityTier = z.enum(['fast', 'balanced', 'frontier']);

ModelSpec      += capability?: CapabilityTier, costWeight?: number, priceCacheWritePerMTok?: number
FlowNodeData   += capability?: CapabilityTier, costWeight?: number, stealDown = true
FlowEdge       += difficulties?: Difficulty[]          // dispatch edges: routing rule
RunConfig      += routing: RoutingConfig, context: ContextConfig
Task           += difficulty, complexity, attemptsAtDifficulty, assessment: ComplexityAssessment | null
Attempt        += difficulty, contextTokens, contextRawTokens
WorkerOutput    = { files?: File[], edits?: UnitEdit[], notes? }   // at least one of files/edits

TaskContextBundle = {
  version: 2, hash, taskId, difficulty, allowedPaths, staticPrefixHash,
  sections: ContextSection[],   // kind, content, tokens, budgetTokens, rawTokens, truncated, privacy
  tokens: { sent, raw, staticPrefix, taskPrefix }, outputMode, elidedFunctions, patterns, containsPrivate
}
```

```sql
-- v2 (database.ts)
ALTER TABLE tasks    ADD difficulty, complexity, attempts_at_difficulty, assessment_json;
ALTER TABLE attempts ADD difficulty, input_tokens, cached_input_tokens, cache_write_tokens,
                         output_tokens, context_tokens, context_raw_tokens;   -- backfilled from usage_json
ALTER TABLE runs     ADD input_tokens, cached_input_tokens, cache_write_tokens, output_tokens;  -- backfilled
ALTER TABLE lessons  ADD tags_json;
CREATE TABLE run_knowledge_cache (run_id, kind, symbol, content, symbols_json, source_task_id,
                                  source_unit, verified_at, uses, PRIMARY KEY (run_id, kind, symbol));
```

## 1. Complexity classification and routing

**Features.** Each function gets these features:

* size
* instruction count
* basic blocks
* conditional branches
* loops (back edges)
* direct calls
* virtual/indirect calls (`call [reg+disp]`)
* indirect jumps (switch tables)
* SSE/AVX ops
* RIP-relative references
* unwind entries (more than one means EH funclets)
* tail call
* failed attempts in earlier runs
* name confidence
* backlog cautions

The source of the features:

* `sr next` only reports size, and a function's pack only exists after `sr start`.
* At discovery, functions with a local pack get real counts. The rest get a size-only estimate on
  the same scale.
* After `prepare`, size-only estimates are refined from the new pack. A task that turns out harder
  moves to the right tier before its first attempt, without spending one.
* Only counts are kept. No bytes, mnemonics or addresses leave `x64features.ts`, so features are
  safe to persist and display without exposure consent.

**Score → difficulty.** Scoring is pure and deterministic (`core/complexity.ts`), and every score
carries its reasons, for example "6 conditional branches (+3.6)". Default thresholds: medium at
2.5 or more, hard at 5.5 or more.

* Packets are grouped by difficulty within a unit: easy up to `packetMaxFunctions`, medium half
  that, hard alone. One hard sibling never drags easy functions to the frontier tier.
* Optional LLM tie-breaker: borderline scores go to the Orchestrator's model in batches of 25.
  It sees shape counts only, may move a function one step across the nearby threshold, and is
  capped per run.

**Routing.**

* Worker tiers declare a capability, or have one inferred from ladder position.
* Dispatch edges carry rules ("easy → fast") that show on the canvas. A difficulty without a rule
  goes to the tier with the nearest capability, ties to the cheaper tier.
* Account selection prefers models that declare the tier's capability. If no account in the
  binding declares it, selection falls back to role matching, so old pools keep working.

**Work stealing.** A slot with nothing ready in its own tier takes packets from lower-capability
tiers, but only the surplus beyond that tier's idle slots, so it never takes work a cheap slot is
about to pick up. A stolen packet moves to the stealer's tier.

**Retry promotion.** After `promoteAfterFailures` failed attempts (default 2) at a difficulty, the
packet is promoted (easy → medium → hard) and moves to the tier for the new difficulty, never down.
The next attempt carries the structured retry delta. Climbing the ladder through exhausted attempts
also raises difficulty to at least the new tier's level.

## 2. TaskContextBundle v2

| Section | Budget (tokens) | Content |
|---|---:|---|
| `static_system_prefix` | 800–1,200 | Output contract + distilled repo rules. Byte-identical for every call of a run. |
| `function_spec` | 150–300 | JSON: RVA, name, class, signature (from headers), calling convention, size, shape counts, difficulty, output mode. |
| `disassembly_slice` | 500–2,500 | Exposure consent only. Mnemonic listing (denser than the byte listing), head and tail kept, decompiler output only for hard packets. |
| `minimal_local_context` | 400–2,000 | Tree-sitter slice of included headers: the packet's class and bases (data members, virtual methods, referenced methods), their `static_assert`s, referenced types, enums, globals. |
| `unit_files` | ≤ 5,000 | The packet's own files. Above budget, accepted bodies are elided and the worker must return edits. |
| `matched_pr_lessons` | 200–500 | Lessons and cookbook recipes whose tags match the packet's patterns (sse, vtable, eh, loop, switch, …). |
| `shared_run_discoveries` | 100–400 | Verified declarations from earlier packets of this run. |
| `retry_delta` | 200–600 | Retries only: category, comparator and Gate Keeper lines, a 2–3 sentence summary, and only the failing functions' previous bodies. |

A bundle never contains full docs, whole unrelated headers, previous complete files or chat
history. Each section records `rawTokens`, what the unsliced sources would have cost, so the
dashboard shows measured savings per attempt.

**RepoRuleDistiller** turns ~25k characters of contributor docs into about 500 tokens of universal
rules for the static prefix. Each cookbook section becomes a pattern-tagged recipe in the lessons
table. It is deterministic by design: same docs, same bytes, same cache key.

**Edits.** Workers on large units return only the functions they add or change:

```json
{"edits": [{"path": "...", "header?": "...", "declarations?": "...",
            "functions": [{"name": "...", "code": "..."}]}]}
```

* The orchestrator splices them into the current unit: same-name definitions are replaced, new
  ones appended.
* The Gate Keeper always evaluates the complete materialised files, so scope, cheat and
  matched-body protection are unchanged.
* An edit that returns an elided placeholder, or complete files while bodies are elided, is a
  contract error, not a cheat strike.

## 3. Prompt caching

```
system   contract + distilled rules                               cache_control  ← whole run
user[0]  task_spec · listing · local_context · unit · lessons     cache_control  ← this packet's retries
user[1]  run_discoveries · pitfalls · retry delta · <attempt n/>  (never cached)
```

* **Breakpoint 1** is shared by every call to the same account and model.
* **Breakpoint 2** is placed only when a retry is likely: medium or hard, or easy from attempt 2,
  and at least 512 tokens. A 5-minute cache write costs 1.25×, so it pays off only when a read
  follows. Retries arrive seconds later, within the TTL.
* The attempt number and other volatile data sit after the last breakpoint.
* OpenAI and compatible endpoints cache prefixes automatically. The system prompt is the stable
  prefix, and `prompt_cache_key` keeps same-prefix requests on one cache shard.
* The Claude CLI adapter already reports cache reads and writes.

**Telemetry.** Input, cached, cache-write and output tokens, context sent vs raw, cost, and cost
saved by caching, per attempt, account, model, difficulty × tier, and run. Streamed over SSE with
the run metrics.

## 4. Run knowledge cache

When a packet passes, its accepted files are mined for facts the comparator just vouched for:

* callee declarations that bound to real symbols (verified helper signatures)
* the matched functions' signatures
* struct and class layouts with their `static_assert`s
* externs and enums

Only facts new relative to the base revision (or the carried files) are kept. Rejected candidates
are never mined, so a bad guess cannot spread. Later packets are offered matching entries by symbol
or by mention: the packet's class, its bases from the header slice, and referenced names. Use
counts appear on the dashboard. In the 120-function simulator run, 162 entries were delivered
820–970 times.

## Trade-offs

| Decision | Choice | Alternative / risk |
|---|---|---|
| Classifier | Static, explainable scoring + optional LLM tie-break on features | An LLM classifier per function costs tokens on every function and is not reproducible. Static weights need calibration against real pass rates; the routing matrix on the dashboard shows where they are off. |
| Size-only first, refine after prepare | Avoids generating packs for the whole backlog up front | A refined task may move once (no attempt spent). Batch-generating packs at discovery would remove the move but take minutes and write local packs for functions that may never be dispatched. |
| Work stealing only downward | Cheap tiers never take frontier work | When the hard queue is the bottleneck, cheap slots idle. An upward "try first" mode would waste attempts; adding frontier capacity is the fix. |
| Deterministic rule distillation | Stable cache key, no model call | Misses rules phrased as prose. Recipes and the full docs cover the long tail. |
| Edits output | Fewer input and output tokens on large units | Splicing relies on a lexical function finder. Unparseable edits are rejected with a precise reason, and the Gate Keeper still evaluates whole files. |
| Header slicing | tree-sitter (WASM, no native build), lexical fallback | Templates and macros are kept verbatim when matched, not expanded. Per-class compaction keeps layout-relevant members only. |
| Second cache breakpoint | Only when a retry is likely | Writing it for every first attempt would waste 25% of that block's input price on the easy packets that pass first time. |
| Mock skill from ground truth | Benchmarks cannot be gamed by prompt changes | The simulator models difficulty vs capability, not prompt quality. Real gains from better context show up only in real runs; the dashboard measures them. |
