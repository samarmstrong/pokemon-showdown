"""Build a turn-level JSONL dataset from raw replay JSON files."""

from __future__ import annotations

import argparse
from pathlib import Path

from psrl.replays.dataset import write_turn_dataset


def main() -> None:
    parser = argparse.ArgumentParser(description="Parse raw replay JSON into turn-level JSONL.")
    parser.add_argument("--raw-dir", default="data/replays/raw/gen9championsvgc2026regma")
    parser.add_argument("--out", default="data/replays/turns/gen9championsvgc2026regma.jsonl")
    parser.add_argument("--min-rating", type=int)
    parser.add_argument("--include-unrated", action="store_true")
    parser.add_argument("--min-turns", type=int, default=1)
    ns = parser.parse_args()

    stats = write_turn_dataset(
        raw_dir=Path(ns.raw_dir),
        out_path=Path(ns.out),
        min_rating=ns.min_rating,
        include_unrated=ns.include_unrated,
        min_turns=ns.min_turns,
    )
    print(
        "parse complete: "
        f"replays_seen={stats.replays_seen} replays_written={stats.replays_written} "
        f"turns_written={stats.turns_written} skipped_rating={stats.skipped_rating} "
        f"skipped_turns={stats.skipped_turns}"
    )
