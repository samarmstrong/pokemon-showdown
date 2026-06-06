"""Parse public replay logs into imitation-learning JSONL examples."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "psrl.resolved_turn.v1"


@dataclass(frozen=True)
class ParseStats:
    replays_seen: int = 0
    replays_written: int = 0
    turns_written: int = 0
    skipped_rating: int = 0
    skipped_turns: int = 0


def load_replay(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def iter_replay_files(raw_dir: Path) -> Iterator[Path]:
    for path in sorted(raw_dir.glob("*.json")):
        if path.name == "manifest.json":
            continue
        yield path


def parse_replay_turns(replay: dict[str, Any]) -> list[dict[str, Any]]:
    """Return turn examples with public log prefix and resolved action events."""
    log = str(replay.get("log", ""))
    lines = [line for line in log.splitlines() if line]
    metadata = _metadata(replay, lines)
    turn_indices = [i for i, line in enumerate(lines) if line.startswith("|turn|")]
    examples: list[dict[str, Any]] = []

    for idx, start in enumerate(turn_indices):
        turn = int(lines[start].split("|")[2])
        end = turn_indices[idx + 1] if idx + 1 < len(turn_indices) else len(lines)
        segment = lines[start + 1 : end]
        actions = _resolved_actions(segment)
        if not actions:
            continue
        prefix = lines[: start + 1]
        examples.append(
            {
                "schema_version": SCHEMA_VERSION,
                "replay_id": metadata["replay_id"],
                "formatid": metadata["formatid"],
                "format": metadata["format"],
                "rating": metadata["rating"],
                "uploadtime": metadata["uploadtime"],
                "players": metadata["players"],
                "winner": metadata["winner"],
                "turn": turn,
                "team_preview": metadata["team_preview"],
                "state": {
                    "public_log_prefix": prefix,
                    "board": _board_from_prefix(prefix),
                },
                "actions": actions,
                "label_kind": "resolved_public_actions",
            }
        )
    return examples


def write_turn_dataset(
    *,
    raw_dir: Path,
    out_path: Path,
    min_rating: int | None = None,
    include_unrated: bool = False,
    min_turns: int = 1,
) -> ParseStats:
    """Parse all raw replay JSON files in `raw_dir` into one JSONL file."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    stats = ParseStats()

    with out_path.open("w", encoding="utf-8") as out:
        for path in iter_replay_files(raw_dir):
            replay = load_replay(path)
            stats = ParseStats(**{**stats.__dict__, "replays_seen": stats.replays_seen + 1})
            rating = replay.get("rating")
            if rating is None and not include_unrated:
                stats = ParseStats(**{**stats.__dict__, "skipped_rating": stats.skipped_rating + 1})
                continue
            if min_rating is not None and (rating is None or int(rating) < min_rating):
                stats = ParseStats(**{**stats.__dict__, "skipped_rating": stats.skipped_rating + 1})
                continue

            examples = parse_replay_turns(replay)
            if len(examples) < min_turns:
                stats = ParseStats(**{**stats.__dict__, "skipped_turns": stats.skipped_turns + 1})
                continue
            for example in examples:
                out.write(json.dumps(example, ensure_ascii=False, sort_keys=True) + "\n")
            stats = ParseStats(
                **{
                    **stats.__dict__,
                    "replays_written": stats.replays_written + 1,
                    "turns_written": stats.turns_written + len(examples),
                }
            )

    return stats


def _metadata(replay: dict[str, Any], lines: list[str]) -> dict[str, Any]:
    players: dict[str, str] = {}
    preview: dict[str, list[str]] = {"p1": [], "p2": []}
    winner: str | None = None

    for line in lines:
        parts = line.split("|")
        if len(parts) < 2:
            continue
        tag = parts[1]
        if tag == "player" and len(parts) >= 4:
            players[parts[2]] = parts[3]
        elif tag == "poke" and len(parts) >= 4:
            side = parts[2]
            species = parts[3].split(",", 1)[0]
            if side in preview:
                preview[side].append(species)
        elif tag == "win" and len(parts) >= 3:
            winner = parts[2]

    replay_players = replay.get("players") or []
    return {
        "replay_id": str(replay.get("id", "")),
        "formatid": str(replay.get("formatid", "")),
        "format": str(replay.get("format", "")),
        "rating": replay.get("rating"),
        "uploadtime": replay.get("uploadtime"),
        "players": {
            "p1": players.get("p1", str(replay_players[0]) if len(replay_players) > 0 else ""),
            "p2": players.get("p2", str(replay_players[1]) if len(replay_players) > 1 else ""),
        },
        "winner": winner,
        "team_preview": preview,
    }


def _resolved_actions(segment: list[str]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    move_seen = False
    action_phase_open = True

    for line in segment:
        if line.startswith("|upkeep") or line.startswith("|win|"):
            action_phase_open = False
        if not action_phase_open:
            continue

        parts = line.split("|")
        if len(parts) < 2:
            continue
        tag = parts[1]
        if tag == "move" and len(parts) >= 5:
            move_seen = True
            actions.append(
                {
                    "kind": "move",
                    "player": _actor_player(parts[2]),
                    "slot": _actor_slot(parts[2]),
                    "actor": parts[2],
                    "move": parts[3],
                    "target": parts[4],
                    "raw": line,
                    "modifiers": parts[5:],
                }
            )
        elif tag == "switch" and len(parts) >= 5 and not move_seen:
            actions.append(
                {
                    "kind": "switch",
                    "player": _actor_player(parts[2]),
                    "slot": _actor_slot(parts[2]),
                    "actor": parts[2],
                    "details": parts[3],
                    "hp_status": parts[4],
                    "raw": line,
                }
            )
        elif tag in {"-mega", "-terastallize", "-zpower"} and len(parts) >= 3:
            actions.append(
                {
                    "kind": "mechanic",
                    "mechanic": tag.removeprefix("-"),
                    "player": _actor_player(parts[2]),
                    "slot": _actor_slot(parts[2]),
                    "actor": parts[2],
                    "raw": line,
                    "details": parts[3:],
                }
            )
    return actions


def _board_from_prefix(prefix: list[str]) -> dict[str, Any]:
    active: dict[str, dict[str, str]] = {}
    hp_status: dict[str, str] = {}
    fainted: set[str] = set()

    for line in prefix:
        parts = line.split("|")
        if len(parts) < 2:
            continue
        tag = parts[1]
        if tag == "switch" and len(parts) >= 5:
            slot = _actor_slot(parts[2])
            if slot is not None:
                active[slot] = {"actor": parts[2], "details": parts[3], "hp_status": parts[4]}
                hp_status[parts[2]] = parts[4]
        elif tag in {"-damage", "-heal"} and len(parts) >= 4:
            hp_status[parts[2]] = parts[3]
        elif tag == "faint" and len(parts) >= 3:
            fainted.add(parts[2])

    return {
        "active": active,
        "hp_status": hp_status,
        "fainted": sorted(fainted),
    }


def _actor_player(actor: str) -> str | None:
    return actor[:2] if len(actor) >= 2 and actor[:2] in {"p1", "p2"} else None


def _actor_slot(actor: str) -> str | None:
    if len(actor) >= 3 and actor[:2] in {"p1", "p2"} and actor[2] in {"a", "b", "c", "d"}:
        return actor[:3]
    return None
