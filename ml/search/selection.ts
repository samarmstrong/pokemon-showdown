/* eslint-disable */
/**
 * selection.ts — the team-preview SELECTION game (the counterpick payoff layer).
 *
 * VGC team preview is a single SIMULTANEOUS, secret choice: each side commits a
 * `team` string that fixes BOTH which 4 of its 6 to bring AND which 2 of those 4
 * lead. No information is revealed between the two sub-choices, so it is one joint
 * move, not a sequence. A side's pure strategy is therefore an (unordered) pair of
 * leads plus an (unordered) pair of back-mons:
 *
 *     |strategies| = C(6,2) · C(4,2) = 15 · 6 = 90 per side.
 *
 * (Lead ORDER and back ORDER are dropped: in doubles both lead slots are active at
 * once and either back-mon is equally switchable, so slot assignment doesn't change
 * the game — the conventional reduction. A single fixed-leads 4v4 — what `cli.ts`
 * solves — is ONE cell of this 90×90 matrix.)
 *
 * This is exactly the structure double-oracle was built for in `oracle.ts`: a large
 * zero-sum matrix whose every cell is expensive (here each cell is a full 4v4
 * `solve()`). So the OUTER selection game is solved EXACTLY by the same DO — growing
 * the support by best responses, touching only the cells it needs — while each cell
 * is an INNER `solve()` whose fidelity (depth / capped vs DO) is configurable. The
 * outer equilibrium is exact w.r.t. the inner payoff estimates; the inner estimates
 * carry whatever bias their params imply (see README). `refine` re-scores the
 * equilibrium support at higher fidelity as an honesty check.
 *
 * Plan: ~/.claude/plans/proud-yawning-pearl.md
 */
import { makeRootBattle, type Seed } from "./engine.ts";
import { solve, type SolveParams } from "./solve.ts";
import { solveDoubleOracle } from "./oracle.ts";
import { solveMatrix } from "./matrix.ts";

/** One pure strategy: which 4 to bring and which 2 of them lead. */
export interface SelStrategy {
  leads: number[]; // sorted 1-based slots brought as the two leads
  back: number[]; // sorted 1-based slots brought to the back
  bring: number[]; // [lead1, lead2, ...back] — the order handed to the `team` cmd
  team: string; // the `team` digits, e.g. "1234"
  label: string; // human label "12+34" (leads+back)
}

/** All k-combinations of `items` (order within a combination is the input order). */
function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > items.length) return [];
  const out: T[][] = [];
  const rec = (start: number, pick: T[]) => {
    if (pick.length === k) {
      out.push(pick.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      pick.push(items[i]);
      rec(i + 1, pick);
      pick.pop();
    }
  };
  rec(0, []);
  return out;
}

/**
 * Enumerate the pure team-preview strategies for a team of `teamSize`. Strategies
 * are generated in a canonical order (leads ascending, then back ascending), so
 * index 0 is always the "natural" pick (bring the first `numBring`, lead the first
 * `numLeads`) — DO seeds from index 0, which makes that a sensible anchor.
 */
export function enumerateSelections(
  teamSize: number,
  numBring = 4,
  numLeads = 2
): SelStrategy[] {
  const bring = Math.min(numBring, teamSize);
  const leadsN = Math.min(numLeads, bring);
  const slots: number[] = [];
  for (let i = 1; i <= teamSize; i++) slots.push(i);

  const out: SelStrategy[] = [];
  for (const leads of combinations(slots, leadsN)) {
    const leadSet = new Set(leads);
    const rest = slots.filter((s) => !leadSet.has(s));
    for (const back of combinations(rest, bring - leadsN)) {
      const order = [...leads, ...back];
      out.push({
        leads,
        back,
        bring: order,
        team: order.join(""),
        label: `${leads.join("")}+${back.join("")}`,
      });
    }
  }
  return out;
}

export interface SelectionParams {
  inner: Partial<SolveParams>; // per-cell 4v4 solve params (the payoff)
  rmIters: number; // outer DO restricted-solve regret-matching iters
  eps: number; // outer DO improvement threshold (absorbs RM noise)
  maxSupport: number; // safety cap on |S1|,|S2| in the outer DO
  numBring: number;
  numLeads: number;
  seed: Seed; // root-battle seed (search re-seeds per step, so this is inert)
  progressEvery: number; // log to stderr every N inner solves (0 = silent)
  refine: boolean; // re-score the equilibrium support at refineInner fidelity
  refineInner: Partial<SolveParams>; // higher-fidelity params for the refine pass
}

export const DEFAULT_SELECTION_PARAMS: SelectionParams = {
  // Default to the TRUSTWORTHY inner: depth-1 double-oracle (~5-10s/cell). A capped
  // inner is NOT a safe shortcut here — its width-bias corrupts the selection
  // payoffs by up to ~0.2 (measured on megazard-vs-rain: cap cells read 0.71 where
  // d1-DO reads 0.49), and DEPTH doesn't fix it (the error is the width cap, not the
  // horizon). So the cap-inner selection equilibrium is plausible-but-wrong. For a
  // fast ROUGH scan only, pass a capped inner (useOracle:false, small maxActions)
  // and treat the result as unverified; `refine` then upgrades the support to d1-DO.
  inner: { maxDepth: 1, samples: 4, useOracle: true, oracleDepth: 1, timeBudgetMs: 60000 },
  rmIters: 800,
  eps: 8e-3,
  maxSupport: 16,
  numBring: 4,
  numLeads: 2,
  seed: [1, 2, 3, 4],
  progressEvery: 25,
  refine: false,
  refineInner: { maxDepth: 1, samples: 6, useOracle: true, oracleDepth: 1, timeBudgetMs: 60000 },
};

export interface SelEntry {
  team: string;
  leads: number[];
  back: number[];
  label: string;
  prob: number;
}

export interface SelectionResult {
  value: number; // P1 game value of the selection game (cheap-inner payoffs)
  refinedValue?: number; // support re-scored at refineInner fidelity (if refine)
  p1: SelEntry[]; // P1 equilibrium mix (support only), prob-desc
  p2: SelEntry[];
  support: { p1: number; p2: number };
  gap: number; // outer DO bracket gap (residual exploitability)
  converged: boolean;
  supportCapped: boolean;
  iterations: number;
  innerSolves: number; // distinct cells evaluated (== inner solve() calls, memoized)
  refineSolves: number; // extra inner solves spent on the refine pass
  strategiesPerSide: number;
  elapsedMs: number;
  // The payoff over the joint equilibrium support, for inspection.
  supportMatrix: { p1: string; cells: { p2: string; value: number }[] }[];
}

/**
 * Solve the team-preview selection game for two fixed teams. P1 (rows) maximizes
 * its win probability; P2 (cols) minimizes. Returns the game value and each side's
 * equilibrium mixture over (bring-4, leads-2) strategies.
 */
export function solveSelection(
  p1team: any[],
  p2team: any[],
  params: Partial<SelectionParams> = {}
): SelectionResult {
  const p: SelectionParams = { ...DEFAULT_SELECTION_PARAMS, ...params };
  const start = Date.now();

  const p1strats = enumerateSelections(p1team.length, p.numBring, p.numLeads);
  const p2strats = enumerateSelections(p2team.length, p.numBring, p.numLeads);
  const m = p1strats.length;
  const n = p2strats.length;

  // Memoized payoff: cell(i,j) = P1's solved value for (P1 brings i) vs (P2 brings j).
  const memo = new Map<number, number>();
  let solves = 0;
  const rawPayoff = (i: number, j: number, inner: Partial<SolveParams>): number => {
    const root = makeRootBattle(p1team, p2team, p1strats[i].bring, p2strats[j].bring, p.seed);
    return solve(root, inner).value;
  };
  const payoff = (i: number, j: number): number => {
    const key = i * n + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const v = rawPayoff(i, j, p.inner);
    memo.set(key, v);
    solves++;
    if (p.progressEvery > 0 && solves % p.progressEvery === 0) {
      const dt = ((Date.now() - start) / 1000).toFixed(1);
      process.stderr.write(
        `  [selection] ${solves} cells, ${dt}s (last ${p1strats[i].team} vs ${p2strats[j].team} = ${v.toFixed(3)})\n`
      );
    }
    return v;
  };

  // DO defaults to index order; index 0 is the natural strategy (bring the first 4,
  // lead the first 2), a sensible neutral seed. A custom best-first ordering only
  // changes the seed (the BR scan adds the true best deviator regardless of order),
  // so it isn't worth the extra anchor-row/col solves it would cost.
  const sol = solveDoubleOracle(m, n, payoff, {
    rmIters: p.rmIters,
    eps: p.eps,
    maxSupport: p.maxSupport,
  });

  const entries = (strats: SelStrategy[], probs: number[]): SelEntry[] =>
    strats
      .map((s, i) => ({ team: s.team, leads: s.leads, back: s.back, label: s.label, prob: probs[i] ?? 0 }))
      .filter((e) => e.prob > 1e-3)
      .sort((a, b) => b.prob - a.prob);

  const p1Entries = entries(p1strats, sol.p1);
  const p2Entries = entries(p2strats, sol.p2);

  // Support index sets (post-equilibrium weight, not the DO scratch sets).
  const s1 = p1strats.map((_, i) => i).filter((i) => sol.p1[i] > 1e-3);
  const s2 = p2strats.map((_, j) => j).filter((j) => sol.p2[j] > 1e-3);

  const supportMatrix = s1.map((i) => ({
    p1: p1strats[i].team,
    cells: s2.map((j) => ({ p2: p2strats[j].team, value: payoff(i, j) })),
  }));

  // Optional fidelity check: re-score the support submatrix at higher fidelity and
  // re-solve it. A small drift from `value` means the cheap inner was trustworthy.
  let refinedValue: number | undefined;
  let refineSolves = 0;
  if (p.refine && s1.length && s2.length) {
    const A: number[][] = [];
    for (let a = 0; a < s1.length; a++) {
      A[a] = new Array(s2.length);
      for (let b = 0; b < s2.length; b++) {
        A[a][b] = rawPayoff(s1[a], s2[b], p.refineInner);
        refineSolves++;
        if (p.progressEvery > 0) {
          const dt = ((Date.now() - start) / 1000).toFixed(1);
          process.stderr.write(`  [refine] ${refineSolves}/${s1.length * s2.length} cells, ${dt}s\n`);
        }
      }
    }
    refinedValue = solveMatrix(A, p.rmIters).value;
  }

  return {
    value: sol.value,
    refinedValue,
    p1: p1Entries,
    p2: p2Entries,
    support: sol.support,
    gap: sol.gap,
    converged: sol.converged,
    supportCapped: sol.supportCapped,
    iterations: sol.iterations,
    innerSolves: solves,
    refineSolves,
    strategiesPerSide: m,
    elapsedMs: Date.now() - start,
    supportMatrix,
  };
}
