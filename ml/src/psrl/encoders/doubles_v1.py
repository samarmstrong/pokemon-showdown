"""Encoder `doubles_v1` — crude v0 features, versioned v1 schema.

The feature *set* is deliberately minimal for M0; the *schema shape* (dict
keys, dtypes, dimensions) is the part that's frozen and baked into
checkpoints. Subsequent milestones enrich the feature content without
bumping the schema version, unless the shape itself changes.

Output keys (all `float32`):

* `self_active`:  (2, D_MON) — active side's two active pokemon
* `self_bench`:   (4, D_MON) — up to four reserve pokemon
* `opp_active`:   (2, D_MON)
* `opp_bench`:    (4, D_MON)
* `field`:        (D_FIELD,) — weather, terrain, turn, tera-used flags
"""

from __future__ import annotations

from typing import Any

import numpy as np
import numpy.typing as npt
from gymnasium import spaces
from poke_env.battle.double_battle import DoubleBattle
from poke_env.battle.pokemon import Pokemon

VERSION = "doubles_v1"

# Type one-hots (18 standard types + "???" sentinel). Order matters for
# schema stability — do not reorder without bumping VERSION.
TYPES: tuple[str, ...] = (
    "NORMAL", "FIRE", "WATER", "ELECTRIC", "GRASS", "ICE", "FIGHTING",
    "POISON", "GROUND", "FLYING", "PSYCHIC", "BUG", "ROCK", "GHOST",
    "DRAGON", "DARK", "STEEL", "FAIRY",
)
N_TYPES = len(TYPES)

STATUSES: tuple[str, ...] = ("brn", "par", "slp", "frz", "psn", "tox")
N_STATUSES = len(STATUSES)

BOOST_STATS: tuple[str, ...] = ("atk", "def", "spa", "spd", "spe", "accuracy", "evasion")
N_BOOSTS = len(BOOST_STATS)

# Per-pokemon feature vector: HP%, fainted, 2 types one-hot, status one-hot, boosts
D_MON: int = 1 + 1 + N_TYPES * 2 + N_STATUSES + N_BOOSTS  # 1+1+36+6+7 = 51

WEATHERS: tuple[str, ...] = ("sunnyday", "raindance", "sandstorm", "hail", "snow")
N_WEATHERS = len(WEATHERS)

TERRAINS: tuple[str, ...] = ("electricterrain", "grassyterrain", "mistyterrain", "psychicterrain")
N_TERRAINS = len(TERRAINS)

# turn (scaled), weather one-hot, terrain one-hot, trick-room, tera-used-self, tera-used-opp
D_FIELD: int = 1 + N_WEATHERS + N_TERRAINS + 1 + 1 + 1  # 1+5+4+1+1+1 = 13


def _type_oh(type_str: str | None) -> npt.NDArray[np.float32]:
    out = np.zeros(N_TYPES, dtype=np.float32)
    if type_str is None:
        return out
    key = type_str.upper()
    for i, t in enumerate(TYPES):
        if t == key:
            out[i] = 1.0
            return out
    return out


def _encode_pokemon(p: Pokemon | None) -> npt.NDArray[np.float32]:
    out = np.zeros(D_MON, dtype=np.float32)
    if p is None:
        return out
    out[0] = float(p.current_hp_fraction) if p.current_hp_fraction is not None else 0.0
    out[1] = 1.0 if p.fainted else 0.0
    off = 2
    types = list(p.types) if p.types else []
    for i in range(2):
        t = types[i] if i < len(types) else None
        t_name = t.name if t is not None and hasattr(t, "name") else (str(t) if t else None)
        out[off : off + N_TYPES] = _type_oh(t_name)
        off += N_TYPES
    # status one-hot
    status_name = p.status.name.lower() if p.status is not None and hasattr(p.status, "name") else None
    for i, s in enumerate(STATUSES):
        if status_name == s:
            out[off + i] = 1.0
    off += N_STATUSES
    # boosts (normalized by 6)
    boosts = getattr(p, "boosts", {}) or {}
    for i, stat in enumerate(BOOST_STATS):
        out[off + i] = float(boosts.get(stat, 0)) / 6.0
    return out


def _pad_side(monlist: list[Pokemon | None], length: int) -> npt.NDArray[np.float32]:
    out = np.zeros((length, D_MON), dtype=np.float32)
    for i in range(min(length, len(monlist))):
        out[i] = _encode_pokemon(monlist[i])
    return out


def _encode_field(battle: DoubleBattle) -> npt.NDArray[np.float32]:
    out = np.zeros(D_FIELD, dtype=np.float32)
    out[0] = float(getattr(battle, "turn", 0) or 0) / 20.0
    off = 1
    weather = getattr(battle, "weather", None)
    if weather:
        # `weather` is a dict {WeatherEnum: turn_started} in poke-env.
        for w in weather:
            name = w.name.lower() if hasattr(w, "name") else str(w).lower()
            for i, ws in enumerate(WEATHERS):
                if name == ws:
                    out[off + i] = 1.0
    off += N_WEATHERS
    fields = getattr(battle, "fields", None)
    if fields:
        for f in fields:
            name = f.name.lower() if hasattr(f, "name") else str(f).lower()
            for i, ts in enumerate(TERRAINS):
                if name == ts:
                    out[off + i] = 1.0
            if name == "trickroom":
                out[off + N_TERRAINS] = 1.0
    off += N_TERRAINS + 1
    # Tera used flags — poke-env surfaces this on the Pokemon level; aggregate per side.
    def _tera_used(team: dict[str, Pokemon]) -> float:
        for m in team.values():
            if getattr(m, "is_terastallized", False):
                return 1.0
        return 0.0
    out[off] = _tera_used(battle.team or {})
    out[off + 1] = _tera_used(battle.opponent_team or {})
    return out


def embed_battle(battle: DoubleBattle) -> dict[str, npt.NDArray[np.float32]]:
    """Encode a `DoubleBattle` into the frozen `doubles_v1` dict schema."""
    # poke-env exposes active_pokemon (list of len 2, entries may be None) and
    # the full team via battle.team (dict[str, Pokemon]).
    self_actives: list[Pokemon | None] = list(battle.active_pokemon or [None, None])
    while len(self_actives) < 2:
        self_actives.append(None)
    opp_actives: list[Pokemon | None] = list(battle.opponent_active_pokemon or [None, None])
    while len(opp_actives) < 2:
        opp_actives.append(None)
    self_bench = [m for m in (battle.team or {}).values() if m not in self_actives]
    opp_bench = [m for m in (battle.opponent_team or {}).values() if m not in opp_actives]
    return {
        "self_active": _pad_side(self_actives[:2], 2),
        "self_bench": _pad_side(self_bench, 4),
        "opp_active": _pad_side(opp_actives[:2], 2),
        "opp_bench": _pad_side(opp_bench, 4),
        "field": _encode_field(battle),
    }


def observation_space() -> spaces.Dict:
    return spaces.Dict(
        {
            "self_active": spaces.Box(low=-1.0, high=1.0, shape=(2, D_MON), dtype=np.float32),
            "self_bench": spaces.Box(low=-1.0, high=1.0, shape=(4, D_MON), dtype=np.float32),
            "opp_active": spaces.Box(low=-1.0, high=1.0, shape=(2, D_MON), dtype=np.float32),
            "opp_bench": spaces.Box(low=-1.0, high=1.0, shape=(4, D_MON), dtype=np.float32),
            "field": spaces.Box(low=-1.0, high=1.0, shape=(D_FIELD,), dtype=np.float32),
        }
    )


def feature_spec() -> dict[str, Any]:
    """Schema snapshot — stored beside checkpoints to detect accidental drift."""
    return {
        "version": VERSION,
        "dims": {"D_MON": D_MON, "D_FIELD": D_FIELD},
        "shapes": {
            "self_active": (2, D_MON),
            "self_bench": (4, D_MON),
            "opp_active": (2, D_MON),
            "opp_bench": (4, D_MON),
            "field": (D_FIELD,),
        },
        "vocabs": {"types": TYPES, "statuses": STATUSES, "boosts": BOOST_STATS,
                   "weathers": WEATHERS, "terrains": TERRAINS},
    }
