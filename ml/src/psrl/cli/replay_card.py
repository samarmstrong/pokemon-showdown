"""Emit a dataset card (JSON + Markdown) summarizing the replay corpus and download set."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from psrl.replays.stats import build_card, render_markdown


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a replay dataset card.")
    parser.add_argument("--format", default="gen9championsvgc2026regma", dest="format_id")
    parser.add_argument("--index", default="data/replays/index/gen9championsvgc2026regma.jsonl")
    parser.add_argument("--raw-dir", help="Downloaded raw replay dir to measure yield (optional).")
    parser.add_argument("--download-min-rating", type=int, default=1630)
    parser.add_argument("--out", default="data/replays/cards/gen9championsvgc2026regma")
    ns = parser.parse_args()

    card = build_card(
        format_id=ns.format_id,
        index_path=Path(ns.index),
        raw_dir=Path(ns.raw_dir) if ns.raw_dir else None,
        download_min_rating=ns.download_min_rating,
    )
    out = Path(ns.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.with_suffix(".json").write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")
    md = render_markdown(card)
    out.with_suffix(".md").write_text(md, encoding="utf-8")
    print(md)
    print(f"wrote {out.with_suffix('.json')} and {out.with_suffix('.md')}")
