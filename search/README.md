# search — brute-force game-tree solver for VGC matchups

Computes how good a fixed set of Pokémon is into a fixed enemy team, by treating a
battle as a two-player zero-sum game and solving it with depth-limited
expecti-minimax over the **real Showdown simulator** (driven in-process — no
websocket, no `poke_env`). The headline output is `value ∈ [0,1]`: P1's minimax
win probability under the chance model and search horizon.

Plan: `~/.claude/plans/proud-yawning-pearl.md`. Format: `gen9championsvgc2026regma`
(doubles, Open Team Sheets → complete-information assumption is realistic; the
`champions` mod disables Terastallization and adds +2 base damage).

## Run

Requires the compiled sim in `dist/` (run `./build` from the repo root after any
`config/` or `sim/` change). Node 24 runs the `.ts` files directly.

```bash
# mirror sanity check (must be ≈ 0.5)
node ml/search/cli.ts --depth 1 --pretty

# a real matchup (megas: this format = Gen 9 + Mega Evolution, no Tera).
# Double-oracle solves the FULL action set at the root by default — no width-cap.
node ml/search/cli.ts --p1 ml/search/teams/megazard.txt --p2 ml/search/teams/rain.txt \
  --p1-bring 1,2,3,4 --p2-bring 1,2,3,4 --depth 1 --samples 4
```

> **Run one solve at a time.** Each solve saturates a core; launching several
> `cli.ts` processes concurrently starves them, so a run overruns `--time-budget`
> and returns a mangled partial. Use the foreground, sequentially.

### Selection game (which 4 to bring + which 2 to lead)

`cli.ts` solves ONE fixed-leads 4v4 — a single cell of the real counterpick
question. `select-cli.ts` solves the whole **90×90 team-preview game** (each side
picks a 4-of-6 bring + a 2-of-4 lead = C(6,2)·C(4,2)=90 pure strategies), by
double-oracle over the strategy matrix where every cell is an inner 4v4 `solve()`.

```bash
# default: cheap depth-1 capped inner per cell (~0.7s/cell), live progress on stderr
node ml/search/select-cli.ts --p1 ml/search/teams/megazard.txt \
  --p2 ml/search/teams/rain.txt --pretty

# higher fidelity: depth-2 inner; re-score the equilibrium support at d1-DO
node ml/search/select-cli.ts --p1 @goodstuff_01 --p2 ./enemy.packed \
  --depth 2 --max-actions 10 --refine --pretty
```

Key flags: `--depth`/`--samples`/`--max-actions` set the **inner** per-cell solve;
`--inner-oracle` runs DO per cell (slow, ~5s/cell); `--refine` re-scores the
equilibrium support at d1-DO fidelity as an honesty check (reports `refinedValue`);
`--bring`/`--leads` change the selection sizes (e.g. `--bring 2` for a fast
leads-only game); `--eps`/`--max-support`/`--rm-iters` tune the outer DO. Per-cell
fidelity is the cost/accuracy dial — the outer equilibrium is exact *given* the
inner payoffs, which carry whatever bias their `--depth`/`--max-actions` imply.

Team args: `@name` (bundled packed team in `src/psrl/data/teams/vgc2026_regma/`),
a file path (`.txt` export or `.packed`), or a raw packed string. Example teams in
`ml/search/teams/` (`megazard.txt`, `rain.txt`). Output is JSON (`--pretty`).

Key flags: `--depth` (decision plies), `--samples` (chance seeds per joint
action), `--rm-iters`, `--node-budget`, `--time-budget` (ms), `--seed a,b,c,d`,
`--no-switch`, `--no-tt`. Double-oracle: on by default; `--no-oracle` reverts to
the capped matrix, `--oracle-depth N` runs DO for the top N plies (default 1 =
root), `--oracle-eps`. `--max-actions` is the width cap for capped (non-DO) plies.

## Modules

| file | role |
|------|------|
| `engine.ts` | the only module that touches `sim/`: build root (team preview), clone (decoupled JSON round-trip), step under a seed, terminal/decision classification, state signature |
| `actions.ts` | enumerate legal joint side-choices; candidates generated from the sim's target convention, then validated by the sim itself |
| `chance.ts` | weighted successor distribution via seed-sampling, with a determinism-collapse for no-RNG turns |
| `matrix.ts` | zero-sum simultaneous-move solver (regret matching) → value + mixed strategies; also solves DO's restricted subgames |
| `oracle.ts` | **double-oracle**: exact equilibrium over the FULL ~110-action set by growing the support with best responses; returns value, strategies, and a convergence gap, touching only the cells it needs |
| `eval.ts` | leaf heuristic (alive count + HP, light status penalty), P1 perspective |
| `solve.ts` | depth-limited expecti-minimax: DO at the top `oracleDepth` plies (full action set), capped matrix deeper; memoized payoff cells; chance recursion |
| `selection.ts` | the **team-preview selection game**: each side's 90 (bring-4 + leads-2) strategies as a matrix whose cells are inner `solve()`s, solved EXACTLY by the same double-oracle (oracle.ts) |
| `cli.ts` | solve one fixed 4v4, print JSON |
| `select-cli.ts` | solve the full selection game (which 4 to bring + which 2 to lead), print JSON |
| `smoke.ts`, `_test_enum.ts` | run-path / enumeration regression checks |
| `_test_oracle.ts` | double-oracle correctness: DO value == full-matrix value; small-support games solved exactly touching ≪ m·n cells |
| `_test_selection.ts` | selection-game correctness: 90-strategy enumeration valid; DO value == brute-force full-matrix value on a real reduced game; mirror → 0.5 |

## Status

**M1 done — approximate value on one fixed 4v4.** Validated:
- mirror matchup → ≈0.50 at depth 1–2: the value a symmetric game must have;
- goodstuff vs Splash-only Magikarp → 0.76 / 0.84 / 0.93 at depth 1/2/3: correctly
  favors P1 and climbs toward 1.0 with depth;
- clones are fully decoupled (stepping a clone never mutates another state);
- same seed → identical successor (determinism);
- megas work: `move N mega` → e.g. Charizard-Mega-Y, sets sun.

**M2 done — double-oracle at the root.** The reported value, strategies, and PV now
come from an exact equilibrium over the full action set (no width-cap), with a
convergence certificate. Validated:
- mirror → 0.499 at depth 1, converged (gap 0.001) — the value a symmetric game
  must have, preserved by DO;
- megazard-vs-rain depth-1 → **0.5016**, gap 0.0012, support 4×5 of 110 actions,
  970 cells, ≈5s — while the cap drifts 0.511→0.539 (see below);
- `_test_oracle.ts`: DO value == full-matrix value on RPS, dominated, random, and
  saddle games; a 50×50 small-support game solved EXACTLY touching only 7.8% of
  cells; degenerate 1×N/N×1 reduce to argmin/argmax.

**M3 done — team-preview SELECTION game (`selection.ts`, `select-cli.ts`).** The
real counterpick question: each side picks a 4-of-6 bring + a 2-of-4 lead =
C(6,2)·C(4,2)=**90 pure strategies**, forming a 90×90 zero-sum matrix whose every
cell is a full 4v4 `solve()`. Same structure as the in-battle game, so it's solved
by the **same double-oracle** (`oracle.ts`) — exact equilibrium, growing the support
by best responses, touching only the cells it needs. Validated (`_test_selection.ts`):
- enumeration is 90 distinct, valid `team` strings, all reaching a decision node;
- on a real reduced game (numBring=2, 15×15) the selection-DO value **exactly equals
  the brute-force full-matrix value** (0.5094 == 0.5094) touching 104 of 225 cells;
- mirror → 0.498.

On megazard-vs-rain, the trustworthy run (**d1-DO inner**) converges in **3 DO
iterations, support 2×2, touching 356 of 8100 cells (4.4%), in 44 min** to
**value 0.502** — a near-pure equilibrium: P1 brings `1356` (Charizard+Sneasler
lead, Incineroar+Amoonguss back; benches Kingambit & Flutter Mane) at 99.9%, P2 the
standard rain `1234` (Pelipper+Swampert lead) at 99.8%, and P1's `1356` scores ≥0.50
against both P2 brings (robust). The payoff layer pays off: the naive `1234` bring
is counter-bring-able down to ~0.30, so picking the equilibrium bring is worth ~0.2
of win prob. The headline depends entirely on the **inner** per-cell fidelity — and
it is decisive (see next paragraph).

### Inner fidelity matters — the selection game must use d1-DO cells
The selection *solver* is exact, but its answer is only as good as the per-cell
payoffs. A **capped inner is NOT a safe shortcut here.** Re-scoring the
megazard-vs-rain equilibrium support at three fidelities:

| cell | d1-cap8 | d2-cap10 | **d1-DO** |
|------|---------|----------|-----------|
| 2513 vs 3412 | 0.708 | 0.709 | **0.489** |
| 4512 vs 3412 | 0.493 | 0.441 | **0.351** |
| 2513 vs 2413 | 0.339 | 0.344 | **0.440** |

The cap reads cells wrong by up to **~0.22**, and **depth does not fix it** (d2-cap
tracks d1-cap; the error is the *width* cap excluding actions, exactly the M2
pathology). The consequence is not just a mis-valued game — it's the **wrong team**:
the cheap d1-cap8 run "converged" to value 0.495 recommending P1 bring `4512`
(Kingambit+Incineroar lead) and P2 `2413`, whereas the trustworthy d1-DO run gives
0.502 with P1 `1356` (Charizard+Sneasler lead, Kingambit benched) and P2 `1234` —
**entirely different brings on both sides**. So the default inner is **d1-DO**
(`select-cli.ts` with no `--inner-cap`); `--inner-cap N` is an explicit
fast-but-rough scan that prints a not-trustworthy warning, and `--refine` re-scores
a cheap run's support at d1-DO. Cost: the full d1-DO selection game is ~350–650
cells × ~5–12s ≈ 45–90 min (runtime is the wall, as always).

**Perf:** clone via `structuredClone` (not JSON string) + a transposition table
keyed on `quickSig`@depth. The capped path is cheap (depth-2 cap-6 ≈ 1s) and root
DO at depth 1 ≈ 5s. But **depth-2 root-DO does not finish** on megazard-vs-rain: it
runs out the 600s `--time-budget` (94k cells, ~1800 capped subnodes) and aborts, so
its value is a budget-truncated estimate, not trustworthy. Runtime, not depth, is
the wall — each of the ~970 root best-response cells expands a full depth-1 subtree.
Deeper DO needs the cheaper best-response oracles in **Next**; for now depth-1 is
the validated certified layer — and as M3 shows, the selection game's many cells
must each be a d1-DO solve to be trustworthy (a capped inner is biased), which is
why the full selection game runs ~1–1.5h.

### Double-oracle removes the width-bias (the point of M2)
Doubles has ~110 actions/side. A fixed width-cap (`--max-actions`) has to guess
which actions matter, and the guess is decisive — *and unreliable*. On
megazard-vs-rain (depth 1) the 1-ply myopic cap drifts monotonically with width and
never settles:

| solver | value | cells |
|--------|-------|-------|
| cap-10 | 0.5113 | 100 |
| cap-24 | 0.5213 | 576 |
| cap-40 | 0.5393 | 1600 |
| **double-oracle (full 110)** | **0.5016** | **970** |

(An earlier version of this note claimed the myopic cap "stabilized" the value —
it does not. It drifts P1-flatteringly as the cap admits more mediocre actions, the
same pathology the old static cap had, just milder.)

**Double-oracle** (`oracle.ts`, default on at the root) solves the full action set
exactly: keep a small restricted game, repeatedly add each side's best response
computed over ALL ~110 actions, and stop when neither can deviate profitably — then
the restricted-game value *is* the full-game value. It returns that value with a
**convergence gap** (here 0.0012 — the certificate a cap cannot provide) over a 4×5
support, evaluating only `≈ |actions|·(|S1|+|S2|)` cells. It touches FEWER cells
than cap-40 (970 < 1600) while being correct: cheaper than a trustworthy-width cap
*and* exact. Cost scales with the best-response scan (all ~110 actions × support),
so DO is run at the root by default and capped deeper (`--oracle-depth`).

### Other caveats (by design)
- DO removes the *width*-bias from the reported value, but the cells it
  equilibrates over are still **depth-limited**: beyond `--depth`, each cell ends in
  `leafEval`, so `value` is an estimate, not a proof. DO gives the exact value *of
  the depth-limited game*.
- `forcedWin`/`forcedLoss` are asserted only when NO leaf estimate was used
  anywhere in the search (the whole reachable tree resolved to terminals) and no
  budget abort occurred — tracked exactly by `ctx.usedLeafEstimate`. At depth 2–3
  on real teams this essentially never fires (games run longer), which is honest.
- Internal (capped, deeper-than-root) plies still carry the width-bias; the root
  value is only as good as those cells. Raise `--oracle-depth` (slow) or widen
  `--max-actions` to push the bias deeper.
- Value also shifts with depth parity (leaf-eval horizon effect).

### Next
- **Counter-team search** (the next layer up): now that one matchup's selection
  value is computable, search over candidate team *edits* (swap a mon / spread /
  item) to maximize the selection value against a fixed meta team. The selection
  game is its inner objective — but at ~1–1.5h per evaluation, this needs the cheaper
  oracles below first.
- **Cheaper best-response oracles** (myopic-bounded / damage-pruned scans) so each
  d1-DO cell — and hence the whole selection game — is affordable. This is now the
  top bottleneck: the BR scan over all ~110 actions is what makes a cell ~5–12s, and
  the selection game needs hundreds of them. (A capped inner is NOT the shortcut —
  M3 shows it biases the selection value by up to ~0.2.)
- Endgame unit tests with known values + forced-win detection.
- Forced-roll damage quadrature in `chance.ts` (lower variance than seed-sampling).
