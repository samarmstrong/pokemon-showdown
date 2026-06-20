"""`psrl-eval` entry point — plays N games of a checkpoint vs a baseline."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import structlog
from poke_env.environment.single_agent_wrapper import SingleAgentWrapper
from stable_baselines3 import PPO

from psrl.data.teams import load_packed
from psrl.env.vgc_doubles_env import VgcDoublesEnv
from psrl.opponents import random as random_opponent

log = structlog.get_logger(__name__)


def _wilson_95(wins: int, n: int) -> tuple[float, float]:
    if n == 0:
        return 0.0, 0.0
    z = 1.96
    phat = wins / n
    denom = 1 + z**2 / n
    center = (phat + z**2 / (2 * n)) / denom
    half = z * ((phat * (1 - phat) + z**2 / (4 * n)) / n) ** 0.5 / denom
    return max(0.0, center - half), min(1.0, center + half)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a psrl checkpoint.")
    parser.add_argument("--ckpt", required=True, help="Path to a PPO .zip checkpoint")
    parser.add_argument("--opponent", default="random", choices=["random"])
    parser.add_argument("--n", type=int, default=20)
    parser.add_argument("--battle-format", default="gen9championsvgc2026regma")
    parser.add_argument("--team-format", default="vgc2026_regma")
    parser.add_argument("--team-name", default="goodstuff_01")
    ns = parser.parse_args()

    team = load_packed(ns.team_format, ns.team_name)
    env = VgcDoublesEnv(battle_format=ns.battle_format, team=team, strict=False)
    opponent = random_opponent.build(ns.battle_format)
    opponent.update_team(team)
    wrapper = SingleAgentWrapper(env, opponent)

    model = PPO.load(ns.ckpt, env=wrapper)

    wins = 0
    losses = 0
    draws = 0
    total_turns = 0
    total_reward = 0.0
    try:
        for i in range(ns.n):
            obs, _ = wrapper.reset()
            terminated = truncated = False
            ep_reward = 0.0
            turns = 0
            while not (terminated or truncated):
                action, _ = model.predict(obs, deterministic=False)
                obs, reward, terminated, truncated, _ = wrapper.step(action)
                ep_reward += float(reward)
                turns += 1
            total_reward += ep_reward
            total_turns += turns
            if ep_reward > 0:
                wins += 1
            elif ep_reward < 0:
                losses += 1
            else:
                draws += 1
            log.info("game_done", i=i + 1, reward=ep_reward, turns=turns)
    finally:
        wrapper.close()

    lo, hi = _wilson_95(wins, ns.n)
    print(
        f"games={ns.n}  wins={wins}  losses={losses}  draws={draws}\n"
        f"winrate={wins/ns.n:.3f} (95% CI [{lo:.3f}, {hi:.3f}])  "
        f"avg_turns={total_turns/max(ns.n,1):.1f}  avg_reward={total_reward/max(ns.n,1):+.3f}"
    )
