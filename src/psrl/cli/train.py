"""`psrl-train` entry point — loads an OmegaConf YAML, runs SB3 training."""

from __future__ import annotations

import argparse
from pathlib import Path

from omegaconf import OmegaConf

from psrl.training.sb3_runner import RunConfig, run


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a psrl agent.")
    parser.add_argument("--config", required=True, help="Path to experiment YAML")
    parser.add_argument(
        "--artifacts-dir",
        default="artifacts",
        help="Where runs/ and replays/ are written (default: ./artifacts)",
    )
    ns = parser.parse_args()

    raw = OmegaConf.load(ns.config)
    cfg = RunConfig(
        run_name=str(raw.run.name),
        total_timesteps=int(raw.run.total_timesteps),
        seed=int(raw.run.seed),
        battle_format=str(raw.env.battle_format),
        team_format=str(raw.env.team_format),
        team_name=str(raw.env.team_name),
        n_steps=int(raw.train.n_steps),
        batch_size=int(raw.train.batch_size),
        learning_rate=float(raw.train.learning_rate),
        artifacts_dir=Path(ns.artifacts_dir),
    )
    run(cfg)
