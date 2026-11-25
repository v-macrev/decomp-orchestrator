# Technical decisions (dated log)

Newest last. A decision names its evidence; a reversal is a new entry, not an edit.

## D-001 · 2026-11-25 · Engine language and shape
**Decision.** Python, standard library only for now, in `engine/recon/`; one process per request over JSON
Lines; TypeScript worker in `apps/server/src/recon/`.
**Why.** Upstream's comparator, PE and COFF readers, binder and permuter are Python
(`tools/compare.py`, `tools/pecoff.py`, `tools/verifier/*.py`); importing them in process avoids a second
implementation of the acceptance contract. The orchestrator is TypeScript and talks to the engine through its
existing `Host` (`repo/host.ts`). No C++ until a profile proves Python too slow.
**Consequence.** Zero third-party runtime dependencies today, so there is no dependency licence to record yet.

## D-002 · 2026-11-25 · Dependencies: none yet; recorded when added
Table kept here when the first is added. Required columns: name, version, sha256 of the artifact, licence,
AGPL-3.0-or-later compatibility, reason. Candidates, none installed: `iced_x86` (upstream's own pin
`1.21.0`; licence to be read from the package before use), `z3-solver` (MIT, for IR transformation checks),
`capstone` (BSD, only as an independent decoder in differential tests), `hypothesis` (MPL-2.0, tests only).
`pip` is absent in WSL and `venv` is present, so installation is a private venv under
`.local/orchestrator/recon/venv/` with a hashed lock file, created by an explicit step that `recon doctor`
names; nothing is installed implicitly.

**Update 2026-11-25 (Phase 2): two dependencies installed in the private venv** by `scripts/setup-venv.sh`
from `requirements.lock`, `--require-hashes --no-deps`:

| Package | Version | sha256 of the wheel | Licence | Compatible with AGPL-3.0-or-later | Reason |
|---|---|---|---|---|---|
| `iced-x86` | 1.21.0 | `489789377bfc1fe432bd2a8a5780c9f3e7c35be2e6133b0de5432cd901cad32c` | MIT (`License: MIT` in the wheel metadata) | yes | Instruction decoding; upstream's own pin, so the engine agrees with upstream's generators |
| `capstone` | 5.0.9 | `273fd8d747d2e35c88f91450be51a603ecfaafb00d96d9f315dcb8689c86193e` | BSD (`License :: OSI Approved :: BSD License`; `LICENSE.TXT` in the wheel) | yes | An independent decoder for differential checks only; never used to produce an answer |

Both wheels are manylinux x86-64 (`cp38-abi3` and `py3-none`), so they run on this machine's Python 3.14. Both
have no dependencies. `capstone.__version__` reports `5.0.7` for the 5.0.9 wheel; the lock names the wheel.
`z3-solver` is added when Phase 4 needs it.

## D-003 · 2026-11-25 · The engine runs in WSL, beside the checkout
**Evidence.** The checkout, packs and toolchain are in WSL (`config/orchestrator.json`, `repo.host`); the Windows
host has no Python (`REPOSITORY_AUDIT.md`, environment table), and `Host.run` already reaches WSL.
**Decision.** `engineDir` is translated to `/mnt/<drive>/…` for a WSL host (`process.ts` `toHostPath`); a
`local` host runs the same package with that host's `python`. A native `cl` on Windows is not measured and not
used.

## D-004 · 2026-11-25 · Tests that need the machine are skipped with a reason
Server tests that start the engine in WSL are skipped where WSL or the distribution is absent
(`describe.skipIf`, title says what is needed). Engine tests run anywhere with `pytest`.

## D-005 · 2026-11-25 · Two additions to the specified protocol
`checkout` in the request (`doctor` needs the private contrib config and the image path), and `command` plus
`report` in the result (one result type for all four commands). Both are optional or additive; the
specified fields are unchanged.

## D-006 · 2026-11-25 · Provenance wording for engine output — OPEN, conservative default
**Question for the user.** Upstream's card asks that `Code origin` be truthful and that a claim name "the actual
model id or agent/tool name"; R40 refuses a comment naming a tool or pipeline, and the Families rule asks for a
generator named by version and digest. Engine output is neither written by a model nor by a person.
**Default until decided (nothing is submitted by this project either way).** `Code origin:` states that the
body was produced by a deterministic reconstruction tool from the compared function's behaviour and community
declarations, without naming a product; `Adapted bodies: none`; the claim and attempt model is
`recon-engine-<version>`. Whether upstream's review accepts that, and whether a set of engine units falls under
the Families rule, is upstream's decision and the user's to take at submission. **No code writes this text yet.**

## D-007 · 2026-11-25 · The engine never reads what a model wrote
Section 3 of the specification, applied: no `attempts.files_json`, stored candidates, `task.fix` candidates,
batch branches, give-up sources, skills, lessons or run knowledge; not the unit source of the function being
reconstructed; no decompiler output. Phase 6 enforces it in the loader and a test proves it. The Phase 1
engine reads nothing but the request.

## D-008 · 2026-11-25 · Canonical serialisation refuses floats
`core/canonical.py` accepts integers, strings, booleans, null, lists and objects with string keys. A float has
no canonical text across languages and platforms, so it is refused rather than rounded.

## D-009 · 2026-11-25 · How scheduling features treat a deterministic tier — planned, Phase 6
| Feature | Decision |
|---|---|
| Difficulty routing, `capability` | An engine tier takes every difficulty it is configured for; its reach is coverage, not score |
| `stealDown`, `helpUp` (`engine.ts:2745-2770`) | An LLM tier does not steal a packet the engine has not tried; an idle engine slot does not take an LLM-only packet |
| `maxFunctionsPerWorker` (`db/database.ts:295`) and `capacityBlocked` (`engine.ts:2777-2789`) | Not applied to an engine node |
| Budget pause (`engine.ts:2736-2744`) | Never triggers on zero cost |
| Outage pause (`engine.ts:3011-3016`), `NoEligibleAccountError` (`:3136-3141`) | Must not stop engine work or dead-letter its packets |
| Fix packets (`task.fix`) | Only their free attempts; the rest passes on uncharged |
| Skills, curator, LLM review, pre-warm | Never fire for an engine-only run |
| Attribution | Attempt model `recon-engine-<version>` (satisfies `MODEL_TOKEN`, tested), account null, zero tokens and cost |
| Staging | `branches` or `off` as today; live-backlog evaluation runs default to `off` |

## D-010 · 2026-11-25 · Machine-wide compile limit: reuse upstream's lock, do not invent one
**Evidence.** Upstream has a machine-wide heavy-job cap with file locks (`tools/local_load.py:33`,
`local_max_heavy`, `SR_LOCAL_MAX_HEAVY`), but `.local/verifier/runners.json` is absent here, so the cap is
unset. **Decision (to confirm when compile jobs exist in Phase 5).** Engine compile jobs take slots from the
same lock the Gate Keeper's compares use, rather than a second counter in the server. The prompt's
`limits.ts` is therefore not created until measurement shows the lock cannot serve.

## D-011 · 2026-11-25 · No pack, listing or game byte is read by the implementing agent
Applies to this development, not to the engine. The audit and the tests used only upstream's published
documents and code, hashes, counts and booleans. A function the engine cannot solve is debugged from its
reason codes and counters, and from synthetic fixtures built to reproduce the shape (section 3, "A rule whose
only evidence is one target function is not a rule").

## D-012 · 2026-11-25 · Function boundary: the inventory range, checked against `.pdata`, never replaced by it
**Evidence.** On the 62,247 unmatched targets the inventory range and `.pdata` agree in every case that has
unwind data (55,265 exact) and 6,982 have none (leaf functions). **Decision.** RVA and size come from upstream's
offered list. A disagreement (an entry crossing the range, overlapping entries, a range not readable from the
file) blocks the function with upstream's reason; the engine never picks between sources. In this image there
is nothing to block on, so this rule is exercised by synthetic tests only.

## D-013 · 2026-11-25 · Decode with iced-x86 behind an adapter; the table rule is explicit
iced is the decoder (upstream's pin, section 8's default); upstream's length decoder and capstone are checks, not
alternatives. MSVC puts switch tables after a function's code inside its range, so a whole-range sweep
mis-decodes them. The range's data start is the lowest forward address that a RIP-relative operand or an
image-relative displacement (value of at least 0x1000, below 2^31) reaches, and the code before it must decode
cleanly to exactly there. The known weakness (a forward reference to code) is documented by a test and reported
as `other-data` so it is visible rather than silent.

## D-014 · 2026-11-25 · Aggregates only leave the engine
Commands print counts; rows go only under a directory that has a `.local` component; the survey's mnemonic
demand is private. Public documents carry totals and categories, never instruction names or per-function data.
