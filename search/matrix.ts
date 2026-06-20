/* eslint-disable */
/**
 * matrix.ts — zero-sum simultaneous-move game solver via regret matching.
 *
 * Payoff matrix A is from P1's perspective, entries in [0,1] = P1 win prob.
 * P1 (rows) maximizes; P2 (cols) minimizes. Returns the game value and both
 * sides' optimal mixed strategies. Regret matching converges to a Nash
 * equilibrium of a zero-sum game; this is exactly what resolves the
 * "rock-paper-scissors" turns the brute-force plan is built around.
 */

export interface MatrixSolution {
  value: number; // P1 game value in [0,1]
  p1: number[]; // P1 mixed strategy over rows
  p2: number[]; // P2 mixed strategy over cols
  exploitability: number; // sum of both sides' regret-to-best-response (0 = solved)
}

function fromRegrets(regret: number[]): number[] {
  let sum = 0;
  const s = regret.map((r) => (r > 0 ? r : 0));
  for (const v of s) sum += v;
  if (sum <= 0) return regret.map(() => 1 / regret.length);
  return s.map((v) => v / sum);
}

/**
 * Solve the matrix game. `iters` regret-matching rounds (default 1000).
 * Handles degenerate 1xN / Nx1 shapes correctly (RM reduces to argmax/argmin).
 */
export function solveMatrix(A: number[][], iters = 1000): MatrixSolution {
  const m = A.length;
  const n = A[0]?.length ?? 0;
  if (m === 0 || n === 0) return { value: 0.5, p1: [], p2: [], exploitability: 0 };
  if (m === 1 && n === 1) return { value: A[0][0], p1: [1], p2: [1], exploitability: 0 };

  const r1 = new Array(m).fill(0);
  const r2 = new Array(n).fill(0);
  const sum1 = new Array(m).fill(0);
  const sum2 = new Array(n).fill(0);

  for (let t = 0; t < iters; t++) {
    const s1 = fromRegrets(r1);
    const s2 = fromRegrets(r2);
    for (let i = 0; i < m; i++) sum1[i] += s1[i];
    for (let j = 0; j < n; j++) sum2[j] += s2[j];

    // P1 action values vs s2; P1 maximizes A.
    const u1 = new Array(m).fill(0);
    let v1 = 0;
    for (let i = 0; i < m; i++) {
      let u = 0;
      for (let j = 0; j < n; j++) u += A[i][j] * s2[j];
      u1[i] = u;
      v1 += s1[i] * u;
    }
    for (let i = 0; i < m; i++) r1[i] += u1[i] - v1;

    // P2 action values vs s1; P2 maximizes (1 - A).
    const u2 = new Array(n).fill(0);
    let v2 = 0;
    for (let j = 0; j < n; j++) {
      let u = 0;
      for (let i = 0; i < m; i++) u += (1 - A[i][j]) * s1[i];
      u2[j] = u;
      v2 += s2[j] * u;
    }
    for (let j = 0; j < n; j++) r2[j] += u2[j] - v2;
  }

  const norm = (a: number[]) => {
    const s = a.reduce((x, y) => x + y, 0);
    return s > 0 ? a.map((x) => x / s) : a.map(() => 1 / a.length);
  };
  const p1 = norm(sum1);
  const p2 = norm(sum2);

  // Game value under the average strategies.
  let value = 0;
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) value += p1[i] * A[i][j] * p2[j];

  // Exploitability: how much each side could gain by best-responding.
  let p1Best = -Infinity;
  for (let i = 0; i < m; i++) {
    let u = 0;
    for (let j = 0; j < n; j++) u += A[i][j] * p2[j];
    if (u > p1Best) p1Best = u;
  }
  let p2Best = -Infinity; // best P2 response minimizes A
  for (let j = 0; j < n; j++) {
    let u = 0;
    for (let i = 0; i < m; i++) u += A[i][j] * p1[i];
    if (-u > p2Best) p2Best = -u;
  }
  const exploitability = p1Best - value + (p2Best - -value);

  return { value, p1, p2, exploitability };
}
