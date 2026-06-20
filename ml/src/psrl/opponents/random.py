"""Random opponent — wraps poke-env's `RandomPlayer`.

`SingleAgentWrapper` only calls `opponent.choose_move(battle)`, so the
opponent does **not** need its own WebSocket connection. We disable
`start_listening` to keep it a pure decision function.
"""

from __future__ import annotations

from poke_env.player.baselines import RandomPlayer

KIND = "random"


def build(battle_format: str) -> RandomPlayer:
    return RandomPlayer(
        battle_format=battle_format,
        start_listening=False,
        accept_open_team_sheet=True,
    )
