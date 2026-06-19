"""Download full replay JSON for a rating-filtered slice of a summary index."""

from __future__ import annotations

import argparse
from dataclasses import asdict
from pathlib import Path

from psrl.replays.api import ShowdownReplayClient, download_summaries, load_index, select_summaries


def main() -> None:
    parser = argparse.ArgumentParser(description="Download replays selected from a summary index.")
    parser.add_argument("--index", default="data/replays/index/gen9championsvgc2026regma.jsonl")
    parser.add_argument("--out-dir", default="data/replays/raw/gen9championsvgc2026regma")
    parser.add_argument("--min-rating", type=int, default=1630)
    parser.add_argument("--include-unrated", action="store_true")
    parser.add_argument("--include-private", action="store_true")
    parser.add_argument("--limit", type=int, help="Cap the number of replays downloaded (newest first).")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--delay-seconds", type=float, default=0.2)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    ns = parser.parse_args()

    selected = select_summaries(
        load_index(Path(ns.index)),
        min_rating=ns.min_rating,
        include_unrated=ns.include_unrated,
        include_private=ns.include_private,
    )
    selected.sort(key=lambda s: s.uploadtime, reverse=True)
    if ns.limit is not None:
        selected = selected[: ns.limit]
    print(f"selected {len(selected)} replays from index (min_rating={ns.min_rating})")

    client = ShowdownReplayClient(timeout_seconds=ns.timeout_seconds)
    stats = download_summaries(
        client=client,
        summaries=selected,
        out_dir=Path(ns.out_dir),
        max_workers=ns.workers,
        delay_seconds=ns.delay_seconds,
        overwrite=ns.overwrite,
    )
    print("download complete: " + str(asdict(stats)))
