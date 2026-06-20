"""Version constants stamped into every checkpoint.

Bumping any of these is a deliberate, breaking change: checkpoints produced
under an older version will refuse to load unless a migration is registered.
"""

ENCODER_VERSION = "doubles_v1"
ACTION_SCHEME_VERSION = "doubles_v1"
VOCAB_VERSION = 1
