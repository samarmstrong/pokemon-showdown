"""Action scheme `doubles_v1`.

Thin wrapper over poke-env's built-in Gen-9 doubles action space
(`MultiDiscrete([107, 107])`). poke-env's `DoublesEnv.action_to_order` /
`order_to_action` are authoritative for the index layout; we add:

* a versioned identifier stamped into checkpoints,
* a legal-action mask derived from `battle.valid_orders`,
* typed accessors so callers don't reach into poke-env internals.

Per-slot index layout (from poke_env/environment/doubles_env.py:87):

    -2            default order (sentinel, not used in mask)
    -1            forfeit      (sentinel, not used in mask)
     0            pass
     1..6         switch to team slot
     7..26        move 1..4, target -2..+2
    27..46        + mega
    47..66        + z-move
    67..86        + dynamax
    87..106       + terastallize

The mask reports valid *executable* choices as booleans; negative sentinels are
never set.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt
from poke_env.battle.double_battle import DoubleBattle
from poke_env.environment.doubles_env import DoublesEnv

VERSION = "doubles_v1"

# Gen 9 doubles: num_gimmicks = 4 (mega, z, dynamax, tera). Compare
# DoublesEnv.__init__:82 — act_size = 1 + 6 + 4 * 5 * (num_gimmicks + 1).
PER_SLOT_SIZE: int = 1 + 6 + 4 * 5 * (4 + 1)  # 107
assert PER_SLOT_SIZE == 107
N_SLOTS: int = 2


def legal_action_mask(battle: DoubleBattle) -> npt.NDArray[np.bool_]:
    """Return a `(N_SLOTS, PER_SLOT_SIZE)` bool mask of executable actions.

    Values come from `battle.valid_orders[pos]`; we encode each via poke-env's
    static helper to map order → action index. If a slot has no legal actions
    we fall back to the `pass` index so downstream sampling always has a legal
    action (poke-env will re-emit a request if the choice is rejected).
    """
    mask = np.zeros((N_SLOTS, PER_SLOT_SIZE), dtype=bool)
    valid_orders = getattr(battle, "valid_orders", None) or [[], []]
    for pos in range(N_SLOTS):
        for order in valid_orders[pos]:
            try:
                idx = DoublesEnv._order_to_action_individual(
                    order, battle, fake=False, pos=pos
                )
            except Exception:
                continue
            i = int(idx)
            if 0 <= i < PER_SLOT_SIZE:
                mask[pos, i] = True
        if not mask[pos].any():
            mask[pos, 0] = True  # pass
    return mask


def flat_mask(battle: DoubleBattle) -> npt.NDArray[np.bool_]:
    """MaskablePPO-friendly flat mask: per-dimension concat, shape `(214,)`."""
    return legal_action_mask(battle).reshape(-1)
