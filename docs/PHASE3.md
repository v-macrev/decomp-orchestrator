# Phase 3: skill registry and self-improving skill curator

Phase 3 adds a closed loop on top of the Phase 2 context layer:
* **create** matching skills (from the repository's cookbook, PR review history and this tool's own
  retry wins);
* **benchmark** every new skill and every edit in a shadow replay through the real Gate Keeper;
* **update** skills that keep failing;
* **cost-optimise** the library (core promotion into the cached prefix, compression, deprecation).

All of it happens without changing a byte of any running run's cached prefix.

Nothing here rewrites earlier phases. Runs created before this upgrade keep skills off. With an
empty registry, skills-on runs behave like Phase 2 runs, apart from a slightly longer contract line
in the prefix.

## Results

`npm run bench:skills -w @decomp/server -- --count 500`
* **Setup:** simulator with matching traps, routed + budgeted context, list prices.
* **History:** one database for all rounds, so skills and history accumulate as in production.
* **Comparison:** each round runs a fresh backlog twice, skills off and skills on, so every
  comparison is on identical functions.

| Run | Matched | Attempts / fn | Tokens / fn | Cache hit | $ / fn | Skills injected / held out | Core | Static prefixes |
|---|---|---|---|---|---|---|---|---|
| round 0 · A · off | 481/500 (96.2%) | 1.53 | 5.7k | 57% | 0.0136 | – | 0 | 1 |
| *bootstrap: 2 cookbook skills, both accepted by shadow replay* | | | | | | | | |
| round 1 · B · off | 492/500 (98.4%) | 1.47 | 5.7k | 56% | 0.0146 | – | 0 | 1 |
| round 1 · B · on | **499/500 (99.8%)** | **1.17** | **4.0k (−30%)** | 53% | **0.0101 (−31%)** | 224 / 31 | 0 | 1 |
| *curate: mined 3 from 60 retry wins (+1 over-broad lesson, rejected); 2 patches, rejected; 1 skill promoted to core (38% coverage)* | | | | | | | | |
| round 2 · C · off | 479/500 (95.8%) | 1.59 | 6.1k | 56% | 0.0150 | – | 0 | 1 |
| round 2 · C · on | **500/500 (100%)** | **1.07** | **3.7k (−39%)** | 54% | **0.0091 (−39%)** | 80 / 11 | 1 | 1 |

What the numbers show:
* **Fewer retries.** Skills address the failure modes that cause second and third attempts, so
  attempts per matched function fall by a third, and tokens and cost with them.
* **The shared prefix never moved.** Every run sent exactly **one** static prefix, including round 2,
  whose prefix carried a core skill. That holds even though the curator promoted, rejected and
  proposed between runs.
* **Cache-hit rate drops slightly (56% → 54%)** because there are fewer retries, and retries are
  what re-read the per-packet cache block. No cache entry was invalidated: absolute cached tokens
  per function went down with total tokens.
* **The core skill costs cached-prefix price.** The promoted "virtual slots" skill (119 tokens)
  fired on 38% of round 1's functions. In round 2 it rides in the cached prefix at 0.1× instead
  of being injected at full price, which is why round 2 injects far fewer dynamic skills (80 vs
  224) with a better result.
* **The gate works both ways.** Measured lift against the held-out control group after round 1:
  +13 points for "virtual slots" and +32 for "bit test". The over-broad mined lesson was rejected
  (5 wins / 9 losses in its replay), and two redundant patches were rejected.
* **Curator cost.** Bootstrap, mining and seven shadow evaluations cost $4.26 at Opus/Sonnet/Haiku
  list prices. That pays back in about 1.5 runs of 500 functions at round 2's saving of
  $0.0059 per function.

Effect sizes come from the simulator's trap model (see Trade-offs), so these numbers validate the
mechanics, not a real model's improvement.

Real repository: bootstrap from your checkout's `docs/matching-cookbook.md` (read-only) finds
**28 recipes**:
* **5** have triggers derivable without a model, for example `shr eax,N` / `test al,N` for the
  bit-index helper, indirect calls + `destructor` + `function-size-mismatch` for the deleting
  destructor, and shape triggers for the loop and switch recipes;
* the remaining 23 need a model to draft triggers;
* the "Unsolved patterns" section is skipped.

## Architecture and cache-safety flow

```
                       ┌──────────────────────── between runs ────────────────────────┐
  repo cookbook ──┐    │  SkillCurator                                                 │
  PR review       ├──▶ │   bootstrap · mine retry wins · patch clusters · optimize     │
  comments (gh) ──┘    │        │ drafts (sanitized, scanned, ≤600 tok, safe regexes)  │
                       │        ▼                                                      │
                       │   skill_versions: proposed ──▶ ShadowEvaluator ──▶ accepted / rejected
                       │                               (10–15 historical packets ×     │
                       │                                baseline vs candidate arms,    │
                       │                                real Gate Keeper + compare)    │
                       └───────────────────────────────────┬──────────────────────────┘
                                                           │ registry state
   run start ──▶ RunSkillSnapshot (frozen in runs.skills_json; reused verbatim on resume)
                   core:    promoted_to_core bodies → <core_skills> block, ≤1.5k tok
                   dynamic: active skills as id@version (+ lift), bodies from immutable versions
                     │
                     ├─▶ static prefix = contract + distilled rules + <core_skills>   ← breakpoint 1
                     │      pre-warmed once per (account, model) before slots fan out
                     │
   every attempt ──▶ SkillMatcher (local, deterministic, no tool round-trip)
                     │   listing regexes · symbol prefixes · shape counts · patterns · verdict codes
                     ├─▶ packet skills (packet-static triggers) → per-packet block    ← breakpoint 2
                     └─▶ retry skills (only eligible via the last verdict) → volatile block
```

Why the caches survive:

1. **Breakpoint 1 is frozen per run.** The core block comes from the run snapshot, which is
   written on the run's first start and read back verbatim on every resume. A promotion, a
   compression or a new skill during the run changes the *next* run's snapshot only.
   * Tests assert one `staticPrefixHash` across all attempts while skills are promoted mid-run.
   * The dashboard shows "static prefix frozen" per run.
2. **Dynamic skills render after breakpoint 1**, so selecting them can never invalidate the
   shared prefix. Any number of parallel workers on the same model keep reading it.
3. **Packet skills keep breakpoint 2 valid across retries.** Their placement and ranking use only
   packet-static inputs (listing, symbols, features, patterns), and the number of packet slots
   depends only on the snapshot. A packet's retries therefore select the same packet skills and
   re-read its cached block.
   * Skills that fire only because of the previous verdict go in the volatile block.
   * Tests assert identical `dynamic_skills` content across every packet's attempts.
4. **Pre-warm.** Before the slots fan out, one tiny request per (account, model) carries the exact
   static prefix with its breakpoint. N parallel first calls then all read the cache instead of
   all paying the write.
5. **Shadow evaluation never runs during a bulk run.** It needs worktree slots, so it goes through
   `engine.exclusive()`: it is refused while a run is active, and a run can't start while it holds
   the slots. Proposals stay pending until the run finishes.

## Skill model and triggers

A skill is a body (rules plus at most one before/after example, hard cap **600 tokens**) and a
trigger. The context builder evaluates triggers locally before every model call.

| Group | Weight | Matches | Example |
|---|---|---|---|
| `mnemonics` | 3 | case-insensitive regexes over the target listing | `\bshr\s+eax\s*,\s*(?:0x)?[0-9a-f]+` |
| `failures` | 2.5 | previous verdict: category, finding code or comparator reason | `BYTE_MISMATCH`, `function-size-mismatch` |
| `symbols` | 2 | prefixes of function/class/namespace names and referenced identifiers | `RE::`, `BST`, `hk`, `GFx` |
| `features` | 1.5 | shape thresholds from the pack (any function of the packet) | `{"minIndirectCalls":1,"destructor":true}` |
| `patterns` | 1 | Phase 2 pattern tags | `vtable`, `sse`, `loop`, `eh`, `switch` |

* A skill is eligible when its score reaches `minScore`, every `require` group matched and no
  `exclude` entry hit.
* At most `maxDynamic` skills are injected per attempt (default 2). One slot is reserved for
  retry skills when the snapshot has any.
* Regexes are checked when they are written: no nested quantifiers and no backreferences, so they
  can't backtrack catastrophically. Listings longer than 300k characters are cut before matching.
* **Privacy:** the listing is read locally for matching only. It reaches a provider only through
  the existing consent-gated `disassembly_slice` section and is never persisted. Injection
  telemetry records which trigger groups matched, not listing text.

**Lift without guesswork.** A deterministic share of eligible (packet, skill) pairs is held out:
10% by default, the same draw for every retry of a packet. The slot stays empty, which gives each
skill a real control group. Lift is the pass rate when injected minus the held-out pass rate.
Until the holdout has data, lift falls back to a baseline of attempts where the skill wasn't
eligible, labelled as confounded in the UI.

## Curator workflows

| Workflow | Input | Output |
|---|---|---|
| **Bootstrap** (repo history) | `docs/matching-cookbook.md` recipes; optionally PR review comments via your `gh` login | Candidates. Recipes with a derivable trigger become skills deterministically (target-side asm spans → regexes, named reason codes → failure triggers, shape words → features). For the rest, a frontier model drafts triggers. PR comments are clustered by topic and synthesised by the model only. |
| **Mine** (retry wins) | Tasks of a run that passed after ≥2 attempts: shape counts, first failure (category, codes, compare results), the failed and passing versions of the target functions; a listing excerpt only if that run had exposure consent | Candidates with triggers, one per root cause shared by ≥2 wins |
| **Update** (failure clusters) | Injected attempts that failed, grouped by (skill version, category, code); clusters of ≥3 | A version + 1 proposal: **tighten** (deterministic: failures fire without the strong signal that passing packets had → `require` it), **add a rule** (frontier model with contrastive failing/passing evidence), or, without a model, the Gate Keeper's own guidance for that code |
| **Optimize** | Per-run coverage and lift | **Core promotion** of active skills that fired on >25% of a run's functions (never one with negative lift); **compression** proposals for bodies >300 tokens (deterministic, or the model if shorter; must save ≥15%); **deprecation** for clearly negative lift (≥1 SE below zero, ≥5 points, ≥12 attempts) |
| **Curate** | A finished run | mine → update → optimize → shadow-evaluate everything pending. Runs automatically after a run when `skills.autoCurate` is on |

Every draft goes through the same registry gate, whoever wrote it:
* sanitization (URLs, @mentions and provenance RVAs are stripped);
* a scan for prompt injection, advice the Gate Keeper forbids (inline asm, `#pragma`, byte arrays,
  absolute-address casts, stubs, verifier files) and leaks (decompiler identifiers, byte runs,
  image addresses, host paths);
* the 600-token cap (compressing over-long drafts first);
* regex safety;
* deduplication against every existing skill, deprecated ones included, so a rejected idea isn't
  re-mined every run.

## Shadow evaluation (safe promotion)

For each proposal:
1. **Benchmark selection.** Pick 10–15 historical packets from finished runs where the candidate
   (or the version it replaces) fires: about ¾ previous failures, ¼ first-try passes as a
   regression check. Quarantined packets are excluded. The order is deterministic per skill.
2. **Replay.** Run each packet through the real pipeline: fresh worktree → `prepare` → bundle →
   model → materialise → Gate Keeper with compare.
   * Two arms per case: **baseline** (without the skill, or its current version) and
     **candidate**.
   * Same model tier per case, holdout off, and the skill under test forced in, so the arms differ
     only in the skill text.
   * Arm order alternates between repeats.
   * Retry-only skills replay as attempt 2, with the packet's historical first failure as feedback.
3. **Decision.** Accept when the candidate wins clearly: gain ≥ max(1, 10% of trials) and a
   one-sided sign test on the cases where the arms disagree, p ≤ 0.15. An edit of an existing
   skill may also win by holding the pass rate while sending ≥3% fewer tokens. Anything else
   discards the edit; a never-activated candidate is deprecated.
4. **No guessing.** With fewer than 3 usable cases the evaluation is an error and the proposal
   stays pending.

Measured sensitivity in the simulator, at 140-function histories and 12 cases × 2 replays: a
genuinely helpful skill is accepted in **8 of 12** evaluations. Most misses are evaluations where
history offered only 12–16 usable trials. The deliberately over-generalised mined lesson was
rejected every time. The gate leans conservative on purpose: the operator can **re-open** a
rejected candidate for another evaluation, and the size is configurable
(`skills.shadowCases`, `skills.shadowRepeats`).

## Integration map

| File | Change |
|---|---|
| `packages/skills/*` (new) | Schemas, `SkillMatcher`, SKILL.md render/parse, `compressSkillBody`, sanitizer and scans, cookbook parser, lift stats |
| `packages/core/src/schemas.ts` | `SkillsConfig` on `RunConfig`; `dynamic_skills` / `retry_skills` section kinds and budgets; `SkillSelection` and `coreSkillsHash` on the bundle |
| `apps/server/src/db/database.ts` | Migration v3 |
| `apps/server/src/db/store.ts` | Runs without a `skills` key load with skills off |
| `apps/server/src/skills/registry.ts` (new) | Validation, versions, snapshots, telemetry, clusters, SKILL.md mirror and import |
| `apps/server/src/skills/curator.ts` (new) | Bootstrap, mine, update, optimize, curate; jobs |
| `apps/server/src/skills/shadow.ts` (new) | Benchmark selection, paired replay, decision |
| `apps/server/src/skills/synth.ts` (new) | Curator model client (frontier first; Zod-validated JSON) |
| `apps/server/src/orchestrator/contextBuilder.ts` | Core block in the static prefix (keyed by snapshot), dynamic and retry skill sections, cookbook lessons superseded by registry skills |
| `apps/server/src/orchestrator/prompts.ts` | Contract line for skill tags; packet skills in the stable block, retry skills in the volatile block |
| `apps/server/src/orchestrator/engine.ts` | Run snapshot, prefix pre-warm, injection and outcome telemetry, `exclusive()`, `afterRun` hook |
| `apps/server/src/orchestrator/lessons.ts` | `failureCategory`, `failureSignals`, `primaryFailure` (shared by the retry delta, triggers and clusters) |
| `apps/server/src/repo/*` | `docFile` (full cookbook), `packFor` (listing for matching replay cases); simulator traps |
| `apps/server/src/providers/mock.ts` | Trap-aware odds, curator answers (mine / patch / compress) |
| `apps/server/src/api/server.ts` | `/api/skills…` endpoints |
| `apps/web/src/pages/Skills.tsx` (new) | Skills & optimization tab |
| `apps/web/src/pages/Runs.tsx` | Skills / curate-after-run options; "Skills in this run" panel |

## Schemas and migration (v3)

Additive only.

* **`skills`**: id, name, description, status (`candidate | active | promoted_to_core | deprecated`),
  current version, origin, token_count, triggers_json, body, provenance, status_reason; telemetry
  counters: trigger / inject / pass / fail / holdout / holdout_pass / tokens_injected. Counters
  restart when a new version is accepted; the history stays in `skill_injections`.
* **`skill_versions`**: immutable (skill_id, version), body, triggers, tokens, state
  (`proposed | accepted | rejected | superseded`), change_kind
  (`create | patch | tighten | compress | manual`), rationale, evidence, parent, eval_run_id.
* **`skill_eval_runs`**: baseline vs candidate pass counts, tokens, exact bytes, cost, decision,
  reason, per-case details.
* **`skill_injections`**: one row per (attempt, eligible skill): placement, injected or held out,
  tokens, score, matched groups, and, once routed, the verdict decision, category and code.
* **`skill_jobs`**: curator job log.
* **`runs.skills_json`**: the frozen `RunSkillSnapshot`.

Zod types live in `@decomp/skills` (`Skill`, `SkillVersion`, `SkillEvalRun`, `SkillTrigger`,
`SkillJob`, `SkillDraft`) and in `@decomp/core` (`SkillsConfig`, `SkillSelection`).

**SKILL.md** files are mirrored to `skillsDir` (default `data/skills/<id>/SKILL.md`, every version
as `vN.md`):
* frontmatter, with the trigger as one JSON line plus a readable `# trigger:` comment;
* then the markdown body.

**Import SKILL.md** reads new folders as candidates and edits to known skills as manual proposals.
Both still need a shadow evaluation.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/skills` | Registry, pending proposals with before/after SKILL.md, jobs, evals, curator status, last-run coverage, next-run snapshot |
| GET | `/api/skills/:id` | Versions (with SKILL.md), evals, lift |
| POST | `/api/skills/jobs/:kind` | `bootstrap` (`github`, `useModel`, `evaluate`), `mine`, `update`, `optimize`, `curate`, `shadow`; returns 202 and a job id, with progress streamed as `skills.*` events |
| POST | `/api/skills/:id/versions/:v/(evaluate\|reject\|reopen)` | Shadow-evaluate, discard, or re-open a proposal |
| POST | `/api/skills/:id/status` | Deprecate / demote / reactivate. Candidates can't be activated by hand |
| POST | `/api/skills/import` | Import SKILL.md edits from disk |

## Trade-offs and deviations

* **SQL migrations instead of Drizzle; REST instead of tRPC.** The project already has a versioned
  SQL migration runner, typed repositories and a Fastify REST + SSE API used by every page.
  Introducing an ORM and a second RPC layer for one feature would split the data and API layers
  without changing behaviour. The v3 migration and the `/api/skills` endpoints follow the existing
  conventions, and the Zod types are shared with the UI the same way.
* **The simulator's effect sizes are assumptions.** The trap model (`repo/simContent.ts`) decides
  how much a matching skill helps: a trapped function is matched at half the odds unless guidance
  states the fix, and each irrelevant injected skill costs 3 points (12 for the deliberately
  misleading mined lesson). The benchmark shows that the machinery finds, gates, prices and caches
  skills correctly. It does not measure how much real models improve.
* **Mining needs a model.** Retry-win mining, model-drafted triggers for the remaining cookbook
  recipes and PR-comment synthesis need a frontier (or any orchestrator/worker) model in the pool.
  Without one, bootstrap still turns recipes with derivable triggers into skills, and the updater
  still tightens triggers and adds Gate Keeper guidance.
* **Shadow evaluation costs real calls and slots.** Each evaluation is cases × repeats × 2 model
  calls and compares, and runs between bulk runs. On the real repo, replays go through `prepare`
  (local claims); claims of replayed packets that no run will submit are released afterwards.
* **Core skills can't be measured per attempt** because every attempt carries them. They are
  demoted by hand (UI), not by lift.
* **Stealing, promotion and the frozen snapshot interact by design.** A skill promoted during a
  run stays dynamic for the rest of that run, so the run's cache prefix never moves.

## Not verified yet

* Real model calls: mining, patching and shadow replays against live providers, and pre-warm
  against Anthropic or OpenAI caches.
* PR-history bootstrap against `awarebayes/skyrim_decomp` with a real model. The `gh` fetch and
  clustering code path is written but has only run against the mock, which answers PR clusters
  with no skills.
* Shadow replay on the real repository (`prepare`, claims, compare).
