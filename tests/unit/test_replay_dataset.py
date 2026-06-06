from __future__ import annotations

from psrl.replays.dataset import SCHEMA_VERSION, parse_replay_turns


def test_parse_replay_turns_extracts_resolved_actions_and_board() -> None:
    replay = {
        "id": "gen9championsvgc2026regma-1",
        "formatid": "gen9championsvgc2026regma",
        "format": "[Gen 9 Champions] VGC 2026 Reg M-A",
        "players": ["alice", "bob"],
        "rating": 1800,
        "uploadtime": 1770000000,
        "log": "\n".join(
            [
                "|player|p1|alice|265|1800",
                "|player|p2|bob|n|1800",
                "|poke|p1|Dragonite, L50, M|",
                "|poke|p1|Torkoal, L50, F|",
                "|poke|p2|Lycanroc-Midnight, L50, F|",
                "|poke|p2|Talonflame, L50, F|",
                "|teampreview|4",
                "|start",
                "|switch|p1a: Dragonite|Dragonite, L50, M|100/100",
                "|switch|p1b: Torkoal|Torkoal, L50, F|100/100",
                "|switch|p2a: Lycanroc|Lycanroc-Midnight, L50, F|100/100",
                "|switch|p2b: Talonflame|Talonflame, L50, F|100/100",
                "|turn|1",
                "|move|p2b: Talonflame|Tailwind|p2b: Talonflame",
                "|move|p2a: Lycanroc|Stone Edge|p1b: Torkoal",
                "|-damage|p1b: Torkoal|0 fnt",
                "|faint|p1b: Torkoal",
                "|upkeep",
                "|switch|p1b: Hatterene|Hatterene, L50, F|100/100",
                "|turn|2",
                "|switch|p1a: Charizard|Charizard, L50, M|100/100",
                "|move|p2a: Lycanroc|Rock Slide|p1a: Charizard|[spread] p1a,p1b",
                "|upkeep",
                "|win|bob",
            ]
        ),
    }

    examples = parse_replay_turns(replay)

    assert len(examples) == 2
    assert examples[0]["schema_version"] == SCHEMA_VERSION
    assert examples[0]["winner"] == "bob"
    assert examples[0]["team_preview"] == {
        "p1": ["Dragonite", "Torkoal"],
        "p2": ["Lycanroc-Midnight", "Talonflame"],
    }
    assert [action["kind"] for action in examples[0]["actions"]] == ["move", "move"]
    assert examples[0]["actions"][0]["move"] == "Tailwind"
    assert examples[0]["state"]["board"]["active"]["p1b"]["details"] == "Torkoal, L50, F"

    assert [action["kind"] for action in examples[1]["actions"]] == ["switch", "move"]
    assert examples[1]["actions"][0]["details"] == "Charizard, L50, M"
    assert examples[1]["state"]["board"]["active"]["p1b"]["details"] == "Hatterene, L50, F"


def test_parse_replay_turns_records_mechanics() -> None:
    replay = {
        "id": "gen9championsvgc2026regma-2",
        "log": "\n".join(
            [
                "|player|p1|alice|265|1800",
                "|player|p2|bob|n|1800",
                "|start",
                "|switch|p1a: Gengar|Gengar, L50|100/100",
                "|switch|p2a: Sneasler|Sneasler, L50|100/100",
                "|turn|1",
                "|-mega|p1a: Gengar|Gengar-Mega",
                "|move|p1a: Gengar|Shadow Ball|p2a: Sneasler",
                "|move|p2a: Sneasler|Dire Claw|p1a: Gengar",
                "|win|alice",
            ]
        ),
    }

    examples = parse_replay_turns(replay)

    assert [action["kind"] for action in examples[0]["actions"]] == ["mechanic", "move", "move"]
    assert examples[0]["actions"][0]["mechanic"] == "mega"
