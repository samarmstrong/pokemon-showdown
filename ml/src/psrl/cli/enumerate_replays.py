"""Build a lossless summary index of an entire public replay corpus for a format."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from psrl.replays.api import ShowdownReplayClient, enumerate_format


def main() -> None:
    parser = argparse.ArgumentParser(description="Enumerate every public replay summary for a format.")
    parser.add_argument("--format", default="gen9championsvgc2026regma", dest="format_id")
    parser.add_argument("--index", default="data/replays/index/gen9championsvgc2026regma.jsonl")
    parser.add_argument("--before", type=int, help="Upload timestamp to start paginating from.")
    parser.add_argument("--max-pages", type=int, help="Cap on 51-result pages (omit to scan to launch).")
    parser.add_argument("--delay-seconds", type=float, default=0.2)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    parser.add_argument("--stats-out", help="Optional path to write the enumeration stats JSON.")
    ns = parser.parse_args()

    client = ShowdownReplayClient(timeout_seconds=ns.timeout_seconds)
    stats = enumerate_format(
        client=client,
        format_id=ns.format_id,
        index_path=Path(ns.index),
        before=ns.before,
        max_pages=ns.max_pages,
        delay_seconds=ns.delay_seconds,
    )
    payload = asdict(stats)
    if ns.stats_out:
        Path(ns.stats_out).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print("enumerate complete: " + json.dumps(payload))
