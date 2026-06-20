"""Dataset-card statistics for the replay corpus.

Two layers:
  * corpus stats from the lossless summary index (counts, rating tiers, time span)
  * yield stats from downloaded raw logs (turns, decision points, forfeit/bot rates)

Together they answer "how much high-quality data can we actually get".
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean, median
from typing import Any

from psrl.replays.api import ReplaySummary
from psrl.replays.dataset import iter_replay_files, load_replay, parse_replay_turns

# Heuristic: ladder bot accounts (e.g. "pcrlbot02888784c1"). Best-effort, not authoritative.
BOT_NAME_RE = re.compile(r"bot\d|^.*bot\d|crlbot|\bbot\b", re.IGNORECASE)
FORFEIT_RE = re.compile(r"forfeit", re.IGNORECASE)
RATING_TIERS = (1500, 1630, 1760)


def _utc(ts: int | None) -> str | None:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%d %H:%M") if ts else None


def corpus_stats(summaries: Iterable[ReplaySummary]) -> dict[str, Any]:
    """Aggregate the summary index: how many replays exist, at what rating, over what span."""
    total = private = unrated = 0
    ratings: list[int] = []
    oldest = newest = None
    for s in summaries:
        total += 1
        if s.private or s.password:
            private += 1
        if s.rating is None:
            unrated += 1
        else:
            ratings.append(s.rating)
        oldest = s.uploadtime if oldest is None else min(oldest, s.uploadtime)
        newest = s.uploadtime if newest is None else max(newest, s.uploadtime)

    span_days = round((newest - oldest) / 86400, 2) if (oldest and newest) else None
    buckets = {
        "unrated": unrated,
        "<1500": sum(r < 1500 for r in ratings),
        "1500-1629": sum(1500 <= r < 1630 for r in ratings),
        "1630-1759": sum(1630 <= r < 1760 for r in ratings),
        ">=1760": sum(r >= 1760 for r in ratings),
    }
    cumulative = {f">={t}": sum(r >= t for r in ratings) for t in RATING_TIERS}
    return {
        "total_replays": total,
        "rated_replays": len(ratings),
        "unrated_replays": unrated,
        "private_or_pw": private,
        "rating_buckets": buckets,
        "rating_cumulative": cumulative,
        "max_rating": max(ratings) if ratings else None,
        "oldest_uploadtime": oldest,
        "newest_uploadtime": newest,
        "oldest_utc": _utc(oldest),
        "newest_utc": _utc(newest),
        "span_days": span_days,
        "replays_per_day": round(total / span_days, 1) if span_days else None,
    }


def _log_yield(replay: dict[str, Any]) -> dict[str, Any]:
    log = str(replay.get("log", ""))
    lines = [ln for ln in log.splitlines() if ln]
    turn_nums = [int(ln.split("|")[2]) for ln in lines if ln.startswith("|turn|")]
    max_turn = max(turn_nums) if turn_nums else 0
    decision_turns = len(parse_replay_turns(replay))
    names = [str(p) for p in (replay.get("players") or [])]
    has_bot = any(BOT_NAME_RE.search(n) for n in names)
    is_forfeit = bool(FORFEIT_RE.search(log))
    return {
        "max_turn": max_turn,
        "decision_turns": decision_turns,
        "player_decisions": 2 * decision_turns,  # ~both sides choose each decision-turn (upper bound)
        "bytes": len(log),
        "has_bot": has_bot,
        "is_forfeit": is_forfeit,
        "short": max_turn < 5,
    }


def download_yield_stats(raw_dir: Path) -> dict[str, Any]:
    """Walk downloaded raw replay JSON and measure trajectory yield + quality flags."""
    turns: list[int] = []
    decision_turns: list[int] = []
    player_decisions = total_bytes = bot_games = forfeit_games = short_games = 0
    n = 0
    for path in iter_replay_files(raw_dir):
        y = _log_yield(load_replay(path))
        n += 1
        turns.append(y["max_turn"])
        decision_turns.append(y["decision_turns"])
        player_decisions += y["player_decisions"]
        total_bytes += y["bytes"]
        bot_games += y["has_bot"]
        forfeit_games += y["is_forfeit"]
        short_games += y["short"]
    if n == 0:
        return {"replays": 0}
    return {
        "replays": n,
        "turns_per_game": {
            "mean": round(mean(turns), 2),
            "median": median(turns),
            "min": min(turns),
            "max": max(turns),
        },
        "decision_turns_per_game_mean": round(mean(decision_turns), 2),
        "total_decision_points": player_decisions,
        "total_log_bytes": total_bytes,
        "mean_log_bytes": round(total_bytes / n),
        "bot_games": bot_games,
        "bot_game_pct": round(100 * bot_games / n, 1),
        "forfeit_games": forfeit_games,
        "forfeit_pct": round(100 * forfeit_games / n, 1),
        "short_games_lt5_turns": short_games,
        "short_pct": round(100 * short_games / n, 1),
    }


def build_card(*, format_id: str, index_path: Path, raw_dir: Path | None, download_min_rating: int | None) -> dict[str, Any]:
    from psrl.replays.api import load_index

    card: dict[str, Any] = {
        "format": format_id,
        "index_path": str(index_path),
        "corpus": corpus_stats(load_index(index_path)),
    }
    if raw_dir is not None and raw_dir.exists():
        card["downloaded_set"] = {
            "raw_dir": str(raw_dir),
            "min_rating": download_min_rating,
            **download_yield_stats(raw_dir),
        }
    return card


def render_markdown(card: dict[str, Any]) -> str:
    c = card["corpus"]
    lines = [
        f"# Replay dataset card — `{card['format']}`",
        "",
        "## Corpus (full summary index)",
        f"- Total replays indexed: **{c['total_replays']:,}** "
        f"({c['rated_replays']:,} rated, {c['unrated_replays']:,} unrated)",
        f"- Span: **{c['oldest_utc']} → {c['newest_utc']}** "
        f"({c['span_days']} days, ~**{c['replays_per_day']:,}/day**)",
        f"- Max rating observed: **{c['max_rating']}**",
        "",
        "| Rating tier | Count | Cumulative ≥ |",
        "|---|---|---|",
    ]
    b = c["rating_buckets"]
    cum = c["rating_cumulative"]
    lines += [
        f"| unrated | {b['unrated']:,} | — |",
        f"| <1500 | {b['<1500']:,} | — |",
        f"| 1500-1629 | {b['1500-1629']:,} | >=1500: {cum['>=1500']:,} |",
        f"| 1630-1759 | {b['1630-1759']:,} | >=1630: {cum['>=1630']:,} |",
        f"| ≥1760 | {b['>=1760']:,} | ≥1760: {cum['>=1760']:,} |",
    ]
    if "downloaded_set" in card:
        d = card["downloaded_set"]
        tpg = d["turns_per_game"]
        lines += [
            "",
            f"## Downloaded set (min_rating={d['min_rating']})",
            f"- Replays downloaded: **{d['replays']:,}**",
            f"- Turns/game: mean **{tpg['mean']}**, median {tpg['median']} (min {tpg['min']}, max {tpg['max']})",
            f"- Total decision points (both sides): **{d['total_decision_points']:,}**",
            f"- Raw size: {d['total_log_bytes'] / 1e6:.1f} MB ({d['mean_log_bytes']:,} bytes/game)",
            f"- Quality flags: bot games **{d['bot_game_pct']}%**, "
            f"forfeit **{d['forfeit_pct']}%**, <5-turn **{d['short_pct']}%**",
        ]
    return "\n".join(lines) + "\n"
