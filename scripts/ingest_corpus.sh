#!/usr/bin/env bash
# Full replay-corpus ingest: enumerate the whole format -> download a rating tier -> dataset card.
# Usage: scripts/ingest_corpus.sh [FORMAT] [MIN_RATING] [WORKERS]
set -euo pipefail

FMT="${1:-gen9championsvgc2026regma}"
MIN_RATING="${2:-1630}"
WORKERS="${3:-4}"

INDEX="data/replays/index/${FMT}.jsonl"
RAW="data/replays/raw/${FMT}"
CARD="data/replays/cards/${FMT}"

echo "[$(date +%H:%M:%S)] === enumerate full corpus: $FMT ==="
uv run psrl-enumerate-replays --format "$FMT" --index "$INDEX" \
  --delay-seconds 0.2 --stats-out "data/replays/index/${FMT}.stats.json"

echo "[$(date +%H:%M:%S)] === download tier >=$MIN_RATING ==="
uv run psrl-download-replays --index "$INDEX" --out-dir "$RAW" \
  --min-rating "$MIN_RATING" --workers "$WORKERS" --delay-seconds 0.2

echo "[$(date +%H:%M:%S)] === dataset card ==="
uv run psrl-replay-card --format "$FMT" --index "$INDEX" \
  --raw-dir "$RAW" --download-min-rating "$MIN_RATING" --out "$CARD"

echo "[$(date +%H:%M:%S)] === DONE ==="
