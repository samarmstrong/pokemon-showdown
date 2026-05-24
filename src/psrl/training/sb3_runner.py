"""SB3 PPO runner for the M0 smoke.

Plain PPO (not yet MaskablePPO): poke-env's `DoublesEnv` re-rolls to a random
legal action when given an illegal one with `strict=False`, so the agent
learns against a soft boundary rather than a masked one. Masking is an M2
concern once the encoder is meaningful.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import structlog
from poke_env.environment.single_agent_wrapper import SingleAgentWrapper
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback

from psrl.data.teams import load_packed
from psrl.encoders import doubles_v1 as encoder
from psrl.env.vgc_doubles_env import VgcDoublesEnv
from psrl.opponents import random as random_opponent
from psrl.utils.versioning import ACTION_SCHEME_VERSION, ENCODER_VERSION, VOCAB_VERSION

log = structlog.get_logger(__name__)


@dataclass
class RunConfig:
    run_name: str
    total_timesteps: int
    seed: int
    battle_format: str
    team_format: str        # e.g. "vgc2026_regma"
    team_name: str          # e.g. "goodstuff_01"
    n_steps: int
    batch_size: int
    learning_rate: float
    artifacts_dir: Path


def _load_team(team_format: str, team_name: str) -> str:
    return load_packed(team_format, team_name)


def _build_env(cfg: RunConfig) -> SingleAgentWrapper:
    team = _load_team(cfg.team_format, cfg.team_name)
    env = VgcDoublesEnv(
        battle_format=cfg.battle_format,
        team=team,
        strict=False,
    )
    opponent = random_opponent.build(cfg.battle_format)
    # Give the opponent the same team pool so VGC team-preview works.
    opponent.update_team(team)
    return SingleAgentWrapper(env, opponent)


def run(cfg: RunConfig) -> Path:
    cfg.artifacts_dir.mkdir(parents=True, exist_ok=True)
    run_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{cfg.run_name}"
    run_dir = cfg.artifacts_dir / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    # Stamp the versions + resolved config next to the checkpoint.
    (run_dir / "versions.json").write_text(
        json.dumps(
            {
                "encoder": ENCODER_VERSION,
                "action_scheme": ACTION_SCHEME_VERSION,
                "vocab": VOCAB_VERSION,
                "feature_spec": encoder.feature_spec(),
            },
            default=list,
            indent=2,
        )
    )

    log.info("starting_run", run_id=run_id, cfg=cfg.__dict__)
    wrapper = _build_env(cfg)
    np.random.seed(cfg.seed)

    model = PPO(
        policy="MultiInputPolicy",
        env=wrapper,
        learning_rate=cfg.learning_rate,
        n_steps=cfg.n_steps,
        batch_size=cfg.batch_size,
        seed=cfg.seed,
        tensorboard_log=str(run_dir / "tb"),
        verbose=1,
    )
    ckpt_cb = CheckpointCallback(
        save_freq=max(cfg.n_steps, 1),
        save_path=str(run_dir / "ckpts"),
        name_prefix="ppo",
    )
    try:
        model.learn(total_timesteps=cfg.total_timesteps, callback=ckpt_cb)
    finally:
        final_path = run_dir / "ckpt_final.zip"
        model.save(str(final_path))
        log.info("saved_final_checkpoint", path=str(final_path))
        wrapper.close()
    return final_path
