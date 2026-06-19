# Closed-Sheet Observation & Opponent-Belief Contract — `doubles_v2`

Status: DRAFT (2026-06-07). Supersedes the open-sheet-tolerant `doubles_v1` (M0).
Owner: psrl. Target: real Switch ranked ladder = **closed-sheet Bo1**.

## 0. Why this is the load-bearing decision

The deployment target is the real Pokémon Champions Switch ranked ladder (decided
2026-06-07). We cannot bot that target, so the deliverable is a decision-support
engine — but the policy and the matchup/lead evaluator must reason under the **same
information a closed-sheet player has**. This document defines exactly what the agent
may observe.

It is expensive to reverse because the encoder schema is baked into checkpoints, and
the self-play opponents, the team-preview evaluator (M5), and any reward shaping all
read from it. Get the information partition wrong now and every artifact downstream is
quietly trained on information it will never have at deployment.

## 1. Prime Directive (INV-0)

> The observation at time *t* is a pure function of the information a closed-sheet
> player would legally possess at time *t*. No field of `DoubleBattle` that encodes
> **un-revealed** opponent state may enter the observation except through the explicit
> belief module (§4).

Two immediate consequences for code that exists today:

- **`VgcDoublesEnv.__init__` defaults `accept_open_team_sheet=True`**
  (`src/psrl/env/vgc_doubles_env.py:47`). With both players accepting, poke-env fills
  `opponent_team` with full sets and every downstream consumer silently trains
  open-sheet. **Flip the default to `False` and ensure the opponent Player also
  declines.** This is Step 0 (§8) and is independent of the rest of the work.
- The current encoder reads opponent `Pokemon` attributes directly out of
  `battle.opponent_team` (`src/psrl/encoders/doubles_v1.py:147,152`). That is safe for
  *revealed* attributes (species/types/HP%/status/boosts) but is precisely the surface
  where leakage will creep in as we enrich features. After v2, the **belief module is
  the only path** for any un-revealed opponent attribute.

## 2. Mechanics that define "hidden" (verified against the champions mod, 2026-06-07)

- Format `gen9championsvgc2026regma` ruleset: `['Flat Rules', 'VGC Timer', 'Open Team
  Sheets']`. Flat Rules → **Bring 6 / Pick 4** (Picked Team Size = Auto for doubles),
  Level 50, Item Clause = 1, Species Clause. 2 active slots per side.
- **OTS is opt-in** (`data/rulesets.ts:1979`, `openteamsheets.onTeamPreview` shows an
  Accept/Deny prompt; nothing revealed unless accepted). Only the Bo3 variant uses
  `Force Open Team Sheets` (`data/rulesets.ts:2001`). ⇒ self-play bots are closed-sheet
  by default once Step 0 lands.
- **Terastallization is DISABLED** in Champions: the mod overrides `canTerastallize`
  to `return null` unconditionally (`data/mods/champions/scripts.ts:114`), so no Pokémon
  can ever Tera. The Tera/Stellar machinery elsewhere in the mod (and the
  `teratypepreview` rule) is inherited from the gen9 base and never activates. ⇒ Tera
  type is **not** a hidden variable and Tera is **not** a legal action.
- **Mega Evolution is the one dynamic mechanic** (`canMegaEvo` implemented,
  `data/mods/champions/scripts.ts:117`). Mega capability = holding the mega stone, which
  is just a held **item** — so it lives inside the item belief (§4); the mega-evolve
  *action* and the resulting forme are revealed when it happens.
- Preview reveals about each opponent Pokémon: **species** (cover-legend formes
  obscured to `-*`), gender, level (=50), shiny. Nothing else.

## 3. Information partition (the heart of the contract)

Own side: **everything known** — species, ability, item, moves+PP, Effort-Level spread,
nature, mega capability, and live battle state.

Opponent: classify every attribute into {known-at-preview, revealed-in-battle (when),
hidden→belief}.

| Attribute            | Status for the opponent |
|----------------------|-------------------------|
| Species (all 6)      | **Known at preview** (forme `-*` for cover legends; likely N/A in this dex) |
| Which 4 are picked   | Hidden at preview; revealed incrementally on switch-in (may never see their 4th) |
| Ability              | Hidden → belief; collapses on trigger / announce-on-switch (Intimidate, Drizzle…) |
| Item                 | Hidden → belief; revealed on use/consume/Knock Off/Trick; **mega stone revealed on Mega-Evolve** |
| Each move            | Hidden → belief; revealed on first use |
| EL spread / nature   | Hidden → belief; **never directly revealed** — inferred from observed damage, speed order, HP |
| HP                   | Shown as **%** (not exact) once the mon is/was active |
| Volatiles (boosts, status, mega-evolved, item-consumed) | Known once on field |

The defining property: opponent knowledge starts as **6 species + diffuse priors** at
preview and **sharpens monotonically** as the battle leaks information.

## 4. `BeliefState` — the single source of truth

A per-battle object, reset on battle start, updated every step *before* encoding.

- **`SetBelief` per opponent species**: a categorical distribution over a curated list
  of *K* plausible **complete builds** (ability, item [incl. the possible mega stone],
  4-move set, spread bucket, nature), prior-weighted from the Smogon **chaos JSON** for
  this format/month. Rationale: chaos gives marginals + some conditionals; a naive
  factored product yields impossible builds, so we enumerate the realistic archetypes
  actually seen (common spreads × common move combinations) — tractable and
  human-meaningful.
- **Update rule (Bayesian filter)**: on each observation *o* (move used, item/ability
  revealed, mega-evolve, damage roll, speed order), posterior ∝ prior × likelihood(*o* |
  build). Categorical reveals hard-zero inconsistent builds and renormalize; continuous
  evidence (damage, speed) soft-updates the spread component. A Mega-Evolution collapses
  the item belief to the mega stone.
- **Seeding**: `seed_from_chaos(species, format, month)` → prior weights. Teammate
  conditioning (chaos teammate tables) is a v2.1 refinement.
- **Two projections** come off the one belief object:
  1. `to_features(...)` → fixed-size belief-summary tensors for the **policy net** (§5).
  2. `sample_opponent_team(belief, rng)` → concrete determinized sets for the
     **matchup evaluator / rollouts** (M5) and any future MCTS-style search.

## 5. Encoder projection → `doubles_v2` tensor schema (policy net)

Keep the v1 dict-of-Boxes style (SB3 `MultiInputPolicy`-compatible). Adding belief
features is a **shape change**, so we bump the schema version to `doubles_v2` (v1's own
doc: enrich content freely, bump only when the shape changes). Freeze the key set +
ordering; store `feature_spec()` beside checkpoints as v1 does.

Blocks:

- **Own** (`self_active` ×2, `self_bench` ×4): enrich the v1 per-mon vector with the
  now-relevant *known* fields — ability embed, item embed, move ids + PP, EL-derived
  stats, `can_mega` flag, `has_mega_evolved` flag. (No Tera — disabled.) No belief.
- **Opponent — split into two blocks** (replaces v1's direct `opp_active`/`opp_bench`):
  - `opp_revealed` (≤4 slots = 2 active + up to 2 revealed bench): **confirmed/observed
    attributes only** — species, HP%, status, boosts, revealed-moves bitmap, revealed
    item/ability if known, `mega_evolved` flag.
  - `opp_belief` (6 preview slots): per preview species — species embed (known) +
    belief-summary features: marginal P(item) over top-N items (incl. the mega stone —
    that is how Mega capability is modeled), per-candidate-move inclusion probabilities,
    expected stats + uncertainty (std), ability marginals, a revealed-fraction / entropy
    scalar, and `P(picked)` (prob this mon is one of their 4) until known.
- **`field`**: v1 set + Trick Room / Tailwind timers, etc.; **drop v1's per-side
  tera-used flags** (Tera disabled). (Enrich; shape changes ⇒ v2.)
- **Action mask**: source is `actions.doubles_v1` over `battle.valid_orders`. Note the
  mega-evolve action must be *expressible* (see §9 risk) and tera actions are always
  illegal here.

Design choice (recommended): feed the **policy** belief-*summary* features
(differentiable, fixed-size, smooth); use **determinization** for the evaluator and any
search. Same `BeliefState` feeds both — do not fork the source of truth.

## 6. Interfaces (where the code goes)

- **`psrl.belief`** (pure, **no poke-env import**): `SetBelief`, `BeliefState`,
  `seed_from_chaos`, `update(observation)`, `sample_opponent_team`, `to_features`.
  Operates on plain dataclasses, honoring the "poke-env only inside `psrl.env`" rule.
- **`psrl.env` observation adapter** (the *only* `DoubleBattle` reader): extracts (a)
  own full state and (b) opponent **revealed** facts; feeds (b) into
  `BeliefState.update`; then calls the v2 encoder with (own_state, revealed, belief).
- **`psrl.encoders.doubles_v2`**: pure projection (own + revealed + belief) → tensor
  dict; mirrors v1 (`embed_battle`, `observation_space`, `feature_spec`).
- **`psrl.data.chaos`**: P(build | species) tables for the format/month; ties into the
  existing replay/stats pipeline and the planned `champions_mod_dex`.
- The env owns a per-battle `BeliefState` (reset on battle start, updated each step).

## 7. Invariants & tests (the guard rails)

- **INV-0 leakage**: observation is a pure fn of legal info. *Leakage test*: build a
  battle where the opponent has a known-but-unrevealed set; assert the `doubles_v2`
  observation + belief features are **identical** whether or not the hidden fields are
  populated in `opponent_team`. (Catches the `accept_open_team_sheet` regression and any
  direct-read leak.)
- **INV-1 consistency**: revealed facts ⇒ posterior prob 1; contradicted builds ⇒ 0;
  distribution normalized.
- **INV-2 symmetry**: the self-play opponent's observation is built by the identical
  pipeline from its own perspective.
- **INV-3 calibration**: on held-out replays, the seeded prior predicts actual reveals
  above chance; track Brier / log-loss. (Doubles as part of the project's validation
  story for the un-bottable target.)
- **INV-4 schema freeze**: `feature_spec()` snapshot stored with checkpoints; drift is a
  hard error.
- Tests: extend `tests/unit/test_shapes.py` for v2 shapes; add `tests/unit/test_belief.py`
  (update math, leakage, calibration smoke).

## 8. Sequencing

0. **Flip `accept_open_team_sheet` → False** and make the opponent decline. One-line +
   opponent config; immediately makes self-play closed-sheet. Lock with a leakage
   assertion.
1. Land `psrl.belief` with chaos seeding + categorical update (moves / items [incl. mega
   stone] / ability). Spread & speed likelihood start as a point estimate from the modal
   spread; full continuous update is v2.1.
2. Land `doubles_v2` encoder + observation adapter; wire `BeliefState` into the env.
3. Swap training/eval to v2; keep v1 importable for comparison.
4. (Feeds M5) expose `sample_opponent_team` for the matchup/lead evaluator.

## 9. Open items to confirm while implementing

- Exact poke-env surface for "revealed" opponent attributes under
  `accept_open_team_sheet=False`: confirm `opponent_team` carries only revealed
  mons/attrs and that `Pokemon.ability/item/moves` are `None` until revealed. (empirical)
- Does poke-env expose the **6 preview species** when closed-sheet (the belief needs
  the full roster)? If not, scrape the `|poke|` protocol lines. (empirical)
- **RISK — can poke-env emit a Mega-Evolution action?** Mega isn't a gen9 mechanic, so
  poke-env's gen9 `DoublesEnv` action mapping may encode only tera (illegal here) and
  *not* mega. If mega can't be expressed, the agent can never choose to Mega-Evolve —
  the format's only dynamic mechanic — and `actions.doubles_v1` needs extending. This is
  the action-side analog of the known gen9-dex mega `KeyError`. Verify
  `DoubleBattleOrder` / `action_to_order` mega support before M3. (empirical)
- EL-spread belief granularity: **DEFAULT = bucketed by the common chaos spreads.**
  Rationale: chaos data is already a histogram over discrete spreads, so bucketing
  matches its native form and keeps the belief a single categorical over complete builds
  (no separate continuous estimator). Revisit continuous in v2.1 if calibration (INV-3)
  shows spread precision matters. (reversible default — flagged because you were unsure)
