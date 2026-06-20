/* eslint-disable */
/**
 * oracle.ts — double-oracle solver for a large zero-sum simultaneous-move game.
 *
 * The matrix game has m P1-actions (rows, maximizer) and n P2-actions (cols,
 * minimizer) with payoff `A[i][j] ∈ [0,1]` = P1 win prob. In doubles each side
 * has ~110 actions, so materializing the full m×n matrix is wasteful: the
 * equilibrium support is almost always a handful of actions. Double-oracle finds
 * the EXACT equilibrium of the full game while only ever evaluating the cells it
 * needs.
 *
 * Algorithm (Bosansky/McMahan double-oracle):
 *   - Keep a restricted game over action subsets S1 ⊆ rows, S2 ⊆ cols.
 *   - Solve it (regret matching) → mixed strategies (x*, y*) and value v.
 *   - Best-response oracles over the FULL action set:
 *       u1 = max_a Σ_j y*[j]·A[a][j]   (P1's best deviation vs y*)  — an UPPER bound on V
 *       u2 = min_b Σ_i x*[i]·A[i][b]   (P2's best deviation vs x*)  — a LOWER bound on V
 *     (minimax theorem: u2 ≤ V ≤ u1 for any restricted x*,y*.)
 *   - If P1 has a row outside S1 beating v, add it; likewise P2. Repeat.
 *   - Terminate when neither side can deviate profitably: then v is the exact
 *     value of the full game and (x*, y*) is a full-game equilibrium. The bracket
 *     gap = u1 − u2 is the residual exploitability and is reported for honesty.
 *
 * Why this beats a fixed width-cap: a cap of width w evaluates w² cells and may
 * still exclude the true support (a silent, P1-flattering bias — see README). DO
 * evaluates ≈ m·|S2| + n·|S1| cells, contains the support by construction, and
 * comes with a convergence certificate (the gap).
 *
 * The caller passes a MEMOIZED `payoff(i,j)`; the oracle re-reads cells freely
 * (the bracket scan revisits columns each iteration) and relies on memoization so
 * each distinct cell is computed at most once.
 */
import { solveMatrix } from "./matrix.ts";

export interface OracleOpts {
  rmIters?: number; // regret-matching iters for each restricted solve
  eps?: number; // improvement threshold; must absorb RM noise (default 5e-3)
  maxSupport?: number; // safety cap on |S1|,|S2| (guards pathological non-convergence)
  maxIters?: number; // safety cap on DO iterations
  p1Order?: number[]; // row indices best-first: seeds S1 and orders the BR scan
  p2Order?: number[]; // col indices best-first
}

export interface OracleSolution {
  value: number; // game value (= full-game value at convergence)
  p1: number[]; // full-length (m) mixed strategy, zero off-support
  p2: number[]; // full-length (n) mixed strategy, zero off-support
  lower: number; // u2: P1 can guarantee ≥ this against the full P2 action set
  upper: number; // u1: P2 can hold P1 to ≤ this against the full P1 action set
  gap: number; // upper − lower; restricted-solve RM residual, NOT a support gap
  iterations: number;
  converged: boolean; // DO terminated with no profitable deviation (support is complete)
  supportCapped: boolean; // a side wanted to deviate but hit maxSupport (suspect value)
  support: { p1: number; p2: number }; // |S1|, |S2| at termination
}

function range(k: number): number[] {
  const a = new Array(k);
  for (let i = 0; i < k; i++) a[i] = i;
  return a;
}

/**
 * Solve the m×n zero-sum game given a (memoized) `payoff(i,j)` ∈ [0,1] from P1's
 * perspective, evaluating only the cells double-oracle touches.
 */
export function solveDoubleOracle(
  m: number,
  n: number,
  payoff: (i: number, j: number) => number,
  opts: OracleOpts = {}
): OracleSolution {
  const rmIters = opts.rmIters ?? 1000;
  const eps = opts.eps ?? 5e-3;
  const maxSupport = Math.min(opts.maxSupport ?? 64, Math.max(m, n));
  const maxIters = opts.maxIters ?? m + n + 8;
  const p1Order = opts.p1Order ?? range(m);
  const p2Order = opts.p2Order ?? range(n);

  if (m === 0 || n === 0) {
    return {
      value: 0.5, p1: [], p2: [], lower: 0.5, upper: 0.5, gap: 0,
      iterations: 0, converged: true, supportCapped: false, support: { p1: 0, p2: 0 },
    };
  }

  // Seed the restricted game with each side's top-ranked action.
  const S1 = [p1Order[0]];
  const S2 = [p2Order[0]];
  const inS1 = new Set(S1);
  const inS2 = new Set(S2);

  let value = 0.5;
  let xRestricted: number[] = [1]; // P1 mix over S1 (push-order)
  let yRestricted: number[] = [1]; // P2 mix over S2 (push-order)
  let lower = 0;
  let upper = 1;
  let iterations = 0;
  let addedSomething = true;
  let wantP1 = false; // a profitable P1 deviation exists (independent of the cap)
  let wantP2 = false;
  let supportCapped = false;

  while (addedSomething && iterations < maxIters) {
    iterations++;

    // 1) Solve the restricted submatrix over S1 × S2.
    const sub: number[][] = [];
    for (let s = 0; s < S1.length; s++) {
      sub[s] = new Array(S2.length);
      for (let t = 0; t < S2.length; t++) sub[s][t] = payoff(S1[s], S2[t]);
    }
    const sol = solveMatrix(sub, rmIters);
    value = sol.value;
    xRestricted = sol.p1;
    yRestricted = sol.p2;

    // 2) P1 best response vs y*: scan all rows, track u1 (bracket) and the best
    //    NEW row. f1(a) = Σ_t y*[t]·payoff(a, S2[t]).
    upper = -Infinity;
    let bestA = -1;
    let bestAVal = -Infinity;
    for (const a of p1Order) {
      let f = 0;
      for (let t = 0; t < S2.length; t++) f += yRestricted[t] * payoff(a, S2[t]);
      if (f > upper) upper = f;
      if (!inS1.has(a) && f > bestAVal) {
        bestAVal = f;
        bestA = a;
      }
    }

    // 3) P2 best response vs x*: scan all cols, track u2 and the best NEW col.
    //    f2(b) = Σ_s x*[s]·payoff(S1[s], b); P2 minimizes.
    lower = Infinity;
    let bestB = -1;
    let bestBVal = Infinity;
    for (const b of p2Order) {
      let f = 0;
      for (let s = 0; s < S1.length; s++) f += xRestricted[s] * payoff(S1[s], b);
      if (f < lower) lower = f;
      if (!inS2.has(b) && f < bestBVal) {
        bestBVal = f;
        bestB = b;
      }
    }

    // 4) Grow the support by any profitable deviation. A "want" that the support
    //    cap blocks is recorded so the value is flagged as unconverged.
    wantP1 = bestA >= 0 && bestAVal > value + eps;
    wantP2 = bestB >= 0 && bestBVal < value - eps;
    const addP1 = wantP1 && S1.length < maxSupport;
    const addP2 = wantP2 && S2.length < maxSupport;
    if (wantP1 && !addP1) supportCapped = true;
    if (wantP2 && !addP2) supportCapped = true;
    if (addP1) {
      S1.push(bestA);
      inS1.add(bestA);
    }
    if (addP2) {
      S2.push(bestB);
      inS2.add(bestB);
    }
    addedSomething = addP1 || addP2;
  }

  // Expand the restricted mixes to full-length strategy vectors.
  const p1 = new Array(m).fill(0);
  const p2 = new Array(n).fill(0);
  for (let s = 0; s < S1.length; s++) p1[S1[s]] = xRestricted[s];
  for (let t = 0; t < S2.length; t++) p2[S2[t]] = yRestricted[t];

  const gap = upper - lower;
  return {
    value,
    p1,
    p2,
    lower,
    upper,
    gap,
    iterations,
    // Converged when neither side has a profitable full-set deviation left and we
    // didn't run out of iterations. Then v is the exact value of the full game.
    converged: !wantP1 && !wantP2 && iterations < maxIters,
    supportCapped,
    support: { p1: S1.length, p2: S2.length },
  };
}
