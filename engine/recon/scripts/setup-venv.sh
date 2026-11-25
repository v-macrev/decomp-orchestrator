#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Create (or refresh) the engine's private venv and install the hashed lock into it.
#   scripts/setup-venv.sh <private data dir>     e.g. <checkout>/.local/orchestrator/recon
# The venv is <data dir>/venv. Packages come from PyPI and are refused unless their hash is in requirements.lock.
set -eu
data="${1:?usage: setup-venv.sh <private data dir>}"
here="$(cd "$(dirname "$0")/.." && pwd)"
python3 -m venv "$data/venv"
"$data/venv/bin/python" -m pip install --require-hashes --no-deps -r "$here/requirements.lock"
"$data/venv/bin/python" -c "import iced_x86, capstone; print('iced_x86', iced_x86.__name__, 'capstone', capstone.__version__)"
