#!/usr/bin/env bash
# Launches the local pokemon-showdown server for psrl training.
# Champions mod formats (including gen9championsvgc2026regma) are registered
# automatically via config/formats.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${1:-8000}"

cd "$REPO_ROOT"

if [[ "${2:-}" == "--skip-build" ]] || [[ -d "$REPO_ROOT/dist/sim" ]]; then
  exec ./pokemon-showdown start --no-security --skip-build "$PORT"
fi

exec ./pokemon-showdown start --no-security "$PORT"
