/* eslint-disable */
/**
 * Correctness checks for the double-oracle solver. The defining property: DO over
 * the full action set must return the SAME value as solving the full matrix
 * directly — while evaluating far fewer cells. Run: node ml/search/_test_oracle.ts
 */
import { solveDoubleOracle } from "./oracle.ts";
import { solveMatrix } from "./matrix.ts";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!cond) fails++;
}

/** Wrap a dense matrix as a counting, memoizing payoff oracle. */
function counting(A: number[][]) {
  const memo = new Map<number, number>();
  const n = A[0].length;
  let cells = 0;
  const fn = (i: number, j: number) => {
    const key = i * n + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    cells++;
    const v = A[i][j];
    memo.set(key, v);
    return v;
  };
  return { fn, get cells() { return cells; } };
}

// 1) Rock–paper–scissors (scaled to [0,1]): value 0.5, uniform strategies.
{
  const A = [
    [0.5, 0.0, 1.0],
    [1.0, 0.5, 0.0],
    [0.0, 1.0, 0.5],
  ];
  const c = counting(A);
  const sol = solveDoubleOracle(3, 3, c.fn);
  check("RPS value ≈ 0.5", Math.abs(sol.value - 0.5) < 1e-2, `v=${sol.value.toFixed(4)} gap=${sol.gap.toFixed(4)}`);
  check("RPS converged", sol.converged);
  check("RPS full support", sol.support.p1 === 3 && sol.support.p2 === 3);
}

// 2) Dominated actions: P1 row 0 dominates, P2 col 0 dominates → pure (0,0).
{
  const A = [
    [0.7, 0.8, 0.9],
    [0.1, 0.2, 0.3],
    [0.0, 0.1, 0.2],
  ];
  const full = solveMatrix(A, 4000).value;
  const c = counting(A);
  const sol = solveDoubleOracle(3, 3, c.fn);
  check("dominated value matches full", Math.abs(sol.value - full) < 1e-2, `do=${sol.value.toFixed(4)} full=${full.toFixed(4)}`);
  check("dominated picks pure (0,0)", sol.p1[0] > 0.99 && sol.p2[0] > 0.99);
  check("dominated stays small", sol.support.p1 <= 2 && sol.support.p2 <= 2, `supp=${sol.support.p1}x${sol.support.p2}`);
  check("dominated cheap (cells < 9)", c.cells < 9, `cells=${c.cells}`);
}

// 3) Random matrices: DO value must match the full-matrix value. (Random zero-sum
//    games have LARGE support ≈ m/2, so DO rightly touches most cells here — the
//    cell-savings claim is for small-support games, tested in (3b).) LCG, no rng.
{
  let seed = 0x12345678 >>> 0;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const M = 40, N = 40;
  let maxErr = 0;
  let allConverged = true;
  for (let trial = 0; trial < 12; trial++) {
    const A: number[][] = [];
    for (let i = 0; i < M; i++) {
      A[i] = new Array(N);
      for (let j = 0; j < N; j++) A[i][j] = rnd();
    }
    const full = solveMatrix(A, 6000).value;
    const c = counting(A);
    const sol = solveDoubleOracle(M, N, c.fn, { rmIters: 4000 });
    maxErr = Math.max(maxErr, Math.abs(sol.value - full));
    allConverged = allConverged && sol.converged;
  }
  check("random 40×40 DO == full (12 trials)", maxErr < 1.5e-2, `maxErr=${maxErr.toFixed(4)}`);
  check("random all converged", allConverged);
}

// 3b) Small-support (additive saddle) game — the regime real Pokémon turns live
//     in. A[i][j] = 0.5 + r[i] − c[j] has a PURE equilibrium, so DO should solve
//     a 50×50 game touching ≪ m·n cells. This is the cap-vs-DO efficiency win.
{
  let seed = 0x0badf00d >>> 0;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const K = 50;
  const r = Array.from({ length: K }, () => 0.2 * rnd());
  const c = Array.from({ length: K }, () => 0.2 * rnd());
  const A: number[][] = [];
  for (let i = 0; i < K; i++) {
    A[i] = new Array(K);
    for (let j = 0; j < K; j++) A[i][j] = 0.5 + r[i] - c[j]; // stays in [0.3,0.7]
  }
  const full = solveMatrix(A, 6000).value;
  const cnt = counting(A);
  const sol = solveDoubleOracle(K, K, cnt.fn);
  check("saddle 50×50 DO == full", Math.abs(sol.value - full) < 1e-2, `do=${sol.value.toFixed(4)} full=${full.toFixed(4)}`);
  check("saddle small support", sol.support.p1 <= 3 && sol.support.p2 <= 3, `supp=${sol.support.p1}x${sol.support.p2}`);
  check("saddle evaluates < 25% of cells", cnt.cells / (K * K) < 0.25, `cells=${cnt.cells}/${K * K}`);
}

// 4) Degenerate shapes: 1×N and N×1 reduce to argmin/argmax (RM averaging gives
//    ~1e-3 residue, well within search tolerance).
{
  const row = [[0.2, 0.9, 0.5, 0.1, 0.7]];
  const s1 = solveDoubleOracle(1, 5, counting(row).fn);
  check("1×N → min column", Math.abs(s1.value - 0.1) < 1e-2, `v=${s1.value.toFixed(4)}`);

  const col = [[0.2], [0.9], [0.5], [0.1], [0.7]];
  const s2 = solveDoubleOracle(5, 1, counting(col).fn);
  check("N×1 → max row", Math.abs(s2.value - 0.9) < 1e-2, `v=${s2.value.toFixed(4)}`);
}

// 5) Order hint must not change the value (only the path to it).
{
  let seed = 0xabad1dea >>> 0;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const K = 20;
  const A: number[][] = [];
  for (let i = 0; i < K; i++) {
    A[i] = new Array(K);
    for (let j = 0; j < K; j++) A[i][j] = rnd();
  }
  const natural = solveDoubleOracle(K, K, counting(A).fn, { rmIters: 4000 }).value;
  const reversed = solveDoubleOracle(K, K, counting(A).fn, {
    rmIters: 4000,
    p1Order: Array.from({ length: K }, (_, i) => K - 1 - i),
    p2Order: Array.from({ length: K }, (_, i) => K - 1 - i),
  }).value;
  check("order hint invariant", Math.abs(natural - reversed) < 1.5e-2, `nat=${natural.toFixed(4)} rev=${reversed.toFixed(4)}`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
