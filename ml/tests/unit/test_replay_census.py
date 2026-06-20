from __future__ import annotations

from pathlib import Path
from typing import Any

from psrl.replays.api import ReplaySummary, select_summaries
from psrl.replays.stats import corpus_stats, download_yield_stats
from tests.unit.test_replay_api import FakeClient


def _page(ids_and_times: list[tuple[int, int]], rating: int = 1700) -> list[dict[str, Any]]:
    return [
        {
            "id": f"gen9championsvgc2026regma-{i}",
            "uploadtime": t,
            "format": "[Gen 9 Champions] VGC 2026 Reg M-A",
            "players": ["p1", "p2"],
            "rating": rating,
            "private": 0,
            "password": None,
        }
        for i, t in ids_and_times
    ]


def test_iter_full_keeps_all_51_and_dedupes_overlap() -> None:
    # 51 results signals "more pages"; the 51st (oldest) becomes the next `before`.
    first = _page([(i, 1000 - i) for i in range(51)])
    # Overlap the boundary id 50 to exercise dedup; then a short final page.
    second = _page([(50, 950), (51, 949), (52, 948)])
    client = FakeClient([first, second])

    results = list(client.iter_full("gen9championsvgc2026regma", delay_seconds=0))
    ids = [r.id for r in results]

    assert len(ids) == len(set(ids)), "iter_full must dedupe by id"
    assert ids[-3:] == [
        "gen9championsvgc2026regma-50",
        "gen9championsvgc2026regma-51",
        "gen9championsvgc2026regma-52",
    ]
    assert len(results) == 53  # 51 from page 1 + 2 new from page 2 (duplicated id 50 dropped)


def test_select_summaries_filters_rating_unrated_and_private() -> None:
    rows = [
        ReplaySummary("a", 10, "f", ("x", "y"), 1800, False, None),
        ReplaySummary("b", 9, "f", ("x", "y"), 1600, False, None),
        ReplaySummary("c", 8, "f", ("x", "y"), None, False, None),
        ReplaySummary("d", 7, "f", ("x", "y"), 1900, True, "pw"),
    ]
    keep = select_summaries(rows, min_rating=1630)
    assert {s.id for s in keep} == {"a"}
    keep_unrated = select_summaries(rows, min_rating=1630, include_unrated=True)
    assert {s.id for s in keep_unrated} == {"a", "c"}
    keep_private = select_summaries(rows, min_rating=1630, include_private=True)
    assert {s.id for s in keep_private} == {"a", "d"}


def test_corpus_stats_buckets_and_span() -> None:
    rows = [
        ReplaySummary("a", 1_000_000, "f", (), 1490, False, None),
        ReplaySummary("b", 1_086_400, "f", (), 1640, False, None),  # +1 day
        ReplaySummary("c", 1_000_100, "f", (), 1800, False, None),
        ReplaySummary("d", 1_000_200, "f", (), None, False, None),
    ]
    stats = corpus_stats(rows)
    assert stats["total_replays"] == 4
    assert stats["rated_replays"] == 3
    assert stats["unrated_replays"] == 1
    assert stats["rating_buckets"] == {"unrated": 1, "<1500": 1, "1500-1629": 0, "1630-1759": 1, ">=1760": 1}
    assert stats["rating_cumulative"] == {">=1500": 2, ">=1630": 2, ">=1760": 1}
    assert stats["max_rating"] == 1800
    assert stats["span_days"] == 1.0


def test_download_yield_stats_counts_turns_bots_forfeits(tmp_path: Path) -> None:
    import json

    good = {
        "id": "gen9championsvgc2026regma-1",
        "players": ["alice", "bob"],
        "rating": 1700,
        "log": "\n".join(
            [
                "|player|p1|alice|n|1700",
                "|player|p2|bob|n|1700",
                "|turn|1",
                "|move|p1a: A|Tackle|p2a: B",
                "|upkeep",
                "|turn|2",
                "|move|p2a: B|Tackle|p1a: A",
                "|upkeep",
                "|win|alice",
            ]
        ),
    }
    botforfeit = {
        "id": "gen9championsvgc2026regma-2",
        "players": ["carol", "pcrlbot02888784c1"],
        "rating": 1650,
        "log": "\n".join(["|player|p1|carol|n|1650", "|turn|1", "|-message|carol forfeited.", "|win|pcrlbot02888784c1"]),
    }
    for r in (good, botforfeit):
        (tmp_path / f"{r['id']}.json").write_text(json.dumps(r), encoding="utf-8")

    stats = download_yield_stats(tmp_path)
    assert stats["replays"] == 2
    assert stats["turns_per_game"]["max"] == 2
    assert stats["total_decision_points"] == 4  # good game: 2 decision-turns * 2 sides; forfeit game: 0 actions
    assert stats["bot_games"] == 1
    assert stats["forfeit_games"] == 1
    assert stats["short_games_lt5_turns"] == 2
