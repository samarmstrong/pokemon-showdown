"""`VgcDoublesEnv` — the sole `poke_env` import site for battle I/O.

Subclasses poke-env's `DoublesEnv` and overrides:

* `embed_battle`      — our versioned `doubles_v1` encoder
* `observation_space` — matches the encoder's feature spec
* `calc_reward`       — pluggable reward (M0: terminal only)

Everything else (action encoding, websocket plumbing, request/choice
dispatch, battle log capture) is inherited.

This class is single-agent-ready when wrapped in poke-env's
`SingleAgentWrapper` with a fixed opponent.
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Union

import numpy as np
import numpy.typing as npt
from gymnasium import spaces
from poke_env.battle.abstract_battle import AbstractBattle
from poke_env.environment.doubles_env import DoublesEnv
from poke_env.ps_client import (
    AccountConfiguration,
    LocalhostServerConfiguration,
    ServerConfiguration,
)
from poke_env.teambuilder import Teambuilder

from psrl.encoders import doubles_v1 as encoder
from psrl.rewards import terminal as terminal_reward

RewardFn = Callable[[AbstractBattle], float]


class VgcDoublesEnv(DoublesEnv[dict[str, npt.NDArray[np.float32]]]):
    """Gen-9 doubles env wired to the `doubles_v1` encoder."""

    def __init__(
        self,
        battle_format: str,
        team: Union[str, Teambuilder, None] = None,
        *,
        reward_fn: Optional[RewardFn] = None,
        accept_open_team_sheet: bool = True,
        server_configuration: ServerConfiguration = LocalhostServerConfiguration,
        account_configuration1: Optional[AccountConfiguration] = None,
        account_configuration2: Optional[AccountConfiguration] = None,
        start_listening: bool = True,
        strict: bool = False,
        log_level: Optional[int] = None,
    ) -> None:
        super().__init__(
            battle_format=battle_format,
            team=team,
            accept_open_team_sheet=accept_open_team_sheet,
            server_configuration=server_configuration,
            account_configuration1=account_configuration1,
            account_configuration2=account_configuration2,
            start_listening=start_listening,
            strict=strict,
            log_level=log_level,
        )
        self._reward_fn: RewardFn = reward_fn or terminal_reward.calc_reward
        self._obs_space = encoder.observation_space()
        self.observation_spaces = {agent: self._obs_space for agent in self.possible_agents}

    # --- overrides ----------------------------------------------------

    def embed_battle(self, battle: AbstractBattle) -> dict[str, npt.NDArray[np.float32]]:
        # poke-env calls this with the relevant battle for each agent. Our
        # encoder is doubles-only; cast is safe inside a DoublesEnv.
        return encoder.embed_battle(battle)  # type: ignore[arg-type]

    def observation_space(self, agent: str) -> spaces.Space[Any]:  # type: ignore[override]
        return self._obs_space

    def calc_reward(self, battle: AbstractBattle) -> float:  # type: ignore[override]
        return self._reward_fn(battle)
