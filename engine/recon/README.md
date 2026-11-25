<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# recon: deterministic reconstruction engine

No model, no network, no randomness. Specification: `docs/DETERMINISTIC_WORKER_PROMPT.md`; design: `docs/recon/`.
The engine runs where the upstream checkout runs (WSL here). Game-derived data stays under the checkout's
`.local/orchestrator/recon/`, never in this repository.

## Set up

```sh
engine/recon/scripts/setup-venv.sh <checkout>/.local/orchestrator/recon   # private venv, hashed lock (requirements.lock)
```

## Commands (run from `engine/recon`, with the venv's python)

```sh
python -m recon doctor    --worktree <upstream worktree at the pinned base> --checkout <checkout> --data-dir <private dir>
python -m recon inventory --worktree W --unmatched
python -m recon analyze   --worktree W --checkout C --address 0x<rva>        # counts only
python -m recon survey    --worktree W --checkout C --unmatched --out <dir under .local>
python -m recon crosscheck --worktree W --checkout C --unmatched --capstone-every 5
python -m recon rtti      --worktree W --checkout C
python -m recon coverage  --worktree W --checkout C --unmatched --out <dir under .local>   # lift and analyse; private demand report
python -m recon coverage  --worktree W --checkout C --unmatched --ir --jobs 3 --out D     # also the IR of every function: built, validated, normalised, admitted
python tests/image_check.py --worktree W --checkout C --every 30              # real functions run as instructions and as IR; counts only
python -m recon validate-lift [--only ADD] [--write]                          # differential tests on this processor; --write records the table
python -m recon measure-compare --worktree W --checkout C --out <dir under .local> --units 5
python -m recon serve                                                         # JSON Lines protocol on stdio
```

Every command prints counts, never bytes, operands or listings; a command that writes rows refuses any
directory that is not under a `.local` directory.

After any change to `lift.py`, `lift_sse.py`, `hwexec.py`, `validate.py`, `core/sem.py`, `core/evaluate.py` or `core/softfloat.py`,
run `validate-lift --write` (about 6 minutes): until then the recorded table does not fit the sources and every instruction is refused.

## Tests

```sh
RECON_UPSTREAM_WORKTREE=<worktree> PYTHONPATH=<venv>/lib/python3.*/site-packages python3 -m pytest
```

Without the worktree, the venv packages or the game image, the tests that need them are skipped with the reason
(markers in `pyproject.toml`); everything else runs anywhere.
