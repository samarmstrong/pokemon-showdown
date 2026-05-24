"""Sanity checks on the versioned encoder + action scheme shapes.

These run without needing a live PS server — they only check dimensional
invariants and the feature_spec snapshot.
"""

from __future__ import annotations

import numpy as np

from psrl.actions import doubles_v1 as actions
from psrl.encoders import doubles_v1 as encoder
from psrl.utils import versioning


def test_version_constants_match_module_tags() -> None:
    assert actions.VERSION == versioning.ACTION_SCHEME_VERSION
    assert encoder.VERSION == versioning.ENCODER_VERSION


def test_per_slot_size_matches_gen9_formula() -> None:
    # act_size = 1 + 6 + 4 * 5 * (num_gimmicks + 1), gen9 -> num_gimmicks=4
    assert actions.PER_SLOT_SIZE == 1 + 6 + 4 * 5 * 5
    assert actions.PER_SLOT_SIZE == 107


def test_feature_spec_shapes_are_consistent() -> None:
    spec = encoder.feature_spec()
    assert spec["version"] == "doubles_v1"
    d_mon = spec["dims"]["D_MON"]
    d_field = spec["dims"]["D_FIELD"]
    shapes = spec["shapes"]
    assert shapes["self_active"] == (2, d_mon)
    assert shapes["self_bench"] == (4, d_mon)
    assert shapes["opp_active"] == (2, d_mon)
    assert shapes["opp_bench"] == (4, d_mon)
    assert shapes["field"] == (d_field,)


def test_observation_space_matches_feature_spec() -> None:
    space = encoder.observation_space()
    spec = encoder.feature_spec()
    for key, shape in spec["shapes"].items():
        assert space.spaces[key].shape == shape, key
        assert space.spaces[key].dtype == np.float32, key
