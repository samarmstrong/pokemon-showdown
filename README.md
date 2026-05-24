# psrl — RL agent for Pokémon Champions VGC 2026 Reg M-A

Personal ML/RL project. Target format: `gen9championsvgc2026regma` (doubles, Flat Rules, Open Team Sheets, `bestOfDefault`).

Plan: `~/.claude/plans/i-want-to-work-iridescent-sunrise.md`

## Setup

Requires Node 20+, Python 3.11+, `uv`.

```bash
# From pokemon-showdown repo root
./build                                # compile PS TypeScript (one-time; rerun after git pull)

# From this directory (ml/)
uv sync                                # resolve + install deps into .venv
uv pip install -e .                    # install psrl in editable mode
```

## Run a local PS server

Champions mod formats live in the main `config/formats.ts` and are registered automatically when the server starts.

```bash
./scripts/start_ps_server.sh           # wraps `./pokemon-showdown start --no-security 8000`
```

Keep this running in a dedicated terminal for training/eval.

## Smoke test (M0)

```bash
uv run psrl-train --config configs/exp/smoke_random.yaml
uv run psrl-eval --a artifacts/runs/<ts>-smoke/ckpt_final.pt --b random --n 20
```

## Package layout

- `src/psrl/env/` — sole `poke_env` import site
- `src/psrl/encoders/`, `actions/` — versioned, format-aware interfaces
- `src/psrl/rewards/`, `opponents/`, `policies/` — pluggable components
- `src/psrl/training/` — SB3 runner, self-play
- `src/psrl/eval/` — arena, tournament, replay diff
- `configs/` — OmegaConf YAML, validated against `psrl.config` pydantic models

## Milestones

See the plan file. Current: **M0 (end-to-end smoke)**.
