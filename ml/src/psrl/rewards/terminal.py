"""Terminal-only reward: +1 on win, -1 on loss, 0 otherwise.

Baseline for M0. Richer reward functions (HP delta, KO-shaped,
value-bootstrapped) live in sibling modules and are selected via config.
"""

from __future__ import annotations

from poke_env.battle.abstract_battle import AbstractBattle

KIND = "terminal"


def calc_reward(battle: AbstractBattle) -> float:
    if not battle.finished:
        return 0.0
    if battle.won is True:
        return 1.0
    if battle.won is False:
        return -1.0
    return 0.0
