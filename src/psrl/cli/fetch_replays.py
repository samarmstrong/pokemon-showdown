"""Download raw Pokemon Showdown replay JSON for a battle format."""

from __future__ import annotations

import argparse
from pathlib import Path

from psrl.replays.api import ShowdownReplayClient, download_replays


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch public Pokemon Showdown replay JSON.")
    parser.add_argument("--format", default="gen9championsvgc2026regma", dest="format_id")
    parser.add_argument("--out-dir", default="data/replays/raw/gen9championsvgc2026regma")
    parser.add_argument("--max-replays", type=int, default=100)
    parser.add_argument("--max-pages", type=int, help="Maximum 50-result search pages to scan.")
    parser.add_argument("--min-rating", type=int)
    parser.add_argument("--before", type=int, help="Replay upload timestamp for pagination.")
    parser.add_argument("--include-unrated", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--delay-seconds", type=float, default=0.25)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    ns = parser.parse_args()

    client = ShowdownReplayClient(timeout_seconds=ns.timeout_seconds)
    stats = download_replays(
        client=client,
        format_id=ns.format_id,
        out_dir=Path(ns.out_dir),
        max_replays=ns.max_replays,
        min_rating=ns.min_rating,
        before=ns.before,
        max_pages=ns.max_pages,
        include_unrated=ns.include_unrated,
        overwrite=ns.overwrite,
        delay_seconds=ns.delay_seconds,
    )
    print(
        "fetch complete: "
        f"seen={stats.seen} fetched={stats.fetched} skipped_existing={stats.skipped_existing} "
        f"skipped_private={stats.skipped_private} skipped_unrated={stats.skipped_unrated} "
        f"skipped_rating={stats.skipped_rating}"
    )
