/* eslint-disable */
/**
 * solve.ts — depth-limited expecti-minimax over the simultaneous-move game tree.
 *
 * At each decision ply we build a payoff matrix whose entries are the
 * chance-expected value of the successor (recursed to the depth limit, then
 * leafEval), and solve that matrix for the game value + mixed strategies. The
 * headline output `value` is P1's minimax win probability under this chance model
 * + horizon.
 *
 * Two node solvers:
 *   - DOUBLE-ORACLE (oracle.ts) over the FULL ~110-action set — exact equilibrium,
 *     no width-bias, with a convergence certificate. Used at the top `oracleDepth`
 *     plies (the root by default), where the reported value/strategy must be
 *     trustworthy.
 *   - CAPPED matrix — the action list trimmed to `maxActions` by a 1-ply myopic
 *     ranking, solved densely. Cheap; used at deeper plies to keep search
 *     affordable. Carries a residual width-bias (see README).
 *
 * Honesty: beyond `maxDepth` the value is an ESTIMATE (leaf heuristic). DO removes
 * width-bias from the reported value but the cells it equilibrates over are still
 * depth-limited. `forcedWin`/`forcedLoss` are asserted only when NO leaf estimate
 * was used anywhere in the search (the whole reachable tree resolved to terminals)
 * and no budget abort occurred — `ctx.usedLeafEstimate` tracks this exactly.
 */
import {
  type SimBattle,
  type Seed,
  isTerminal,
  isDecision,
  terminalValue,
  quickSig,
  step,
  autoChoice,
} from "./engine.ts";
import { enumerateSideChoices, type EnumOpts } from "./actions.ts";
import { successors } from "./chance.ts";
import { leafEval } from "./eval.ts";
import { solveMatrix } from "./matrix.ts";
import { solveDoubleOracle, type OracleSolution } from "./oracle.ts";

const RANK_SEED: Seed = [11, 22, 33, 44];

export interface SolveParams {
  maxDepth: number; // decision plies to expand
  samples: number; // chance seeds per joint action
  maxActions: number; // per-side width cap (CAPPED nodes only; DO uses the full set)
  rmIters: number; // regret-matching iterations per matrix
  nodeBudget: number; // hard cap on decision nodes
  timeBudgetMs: number; // wall-clock cap
  useTT: boolean; // transposition table (approximate: keyed on quickSig)
  useOracle: boolean; // double-oracle at the top `oracleDepth` plies
  oracleDepth: number; // # of plies from the root that use DO (rest are capped)
  oracleEps: number; // DO improvement threshold (absorbs RM noise)
  enumOpts?: EnumOpts;
}

export const DEFAULT_PARAMS: SolveParams = {
  maxDepth: 2,
  samples: 4,
  maxActions: 10,
  rmIters: 600,
  nodeBudget: 200000,
  timeBudgetMs: 120000,
  useTT: true,
  useOracle: true,
  oracleDepth: 1,
  oracleEps: 5e-3,
  enumOpts: {},
};

interface Ctx {
  p: SolveParams;
  nodes: number;
  cappedNodes: number;
  cellEvals: number; // distinct payoff-matrix cells actually evaluated
  start: number;
  aborted: boolean;
  usedLeafEstimate: boolean; // any leaf heuristic used → value is an estimate, not exact
  tt: Map<string, number>;
  ttHits: number;
}

const mixState = (h: number, x: number) => (Math.imul(h ^ (x >>> 0), 0x01000193) >>> 0);
function mix(...xs: number[]): number {
  let h = 0x811c9dc5 >>> 0;
  for (const x of xs) h = mixState(h, x);
  return h >>> 0;
}

/**
 * Rank a side's actions best-first by a 1-ply myopic lookahead: value of the
 * position after (this action vs the opponent's default attack), via the leaf
 * heuristic. Target- and damage-aware, so lines like "Solar Beam the 4x-weak mon"
 * are scored high rather than blindly dropped. Returns indices into `choices`.
 */
function rankActions(
  battle: SimBattle,
  sideId: "p1" | "p2",
  choices: string[],
  yardstick: string
): number[] {
  const idx = choices.map((_, i) => i);
  if (choices.length <= 1) return idx;
  const score = choices.map((c) => {
    const succ = sideId === "p1" ? step(battle, c, yardstick, RANK_SEED) : step(battle, yardstick, c, RANK_SEED);
    let v = succ ? leafEval(succ) : 0.5;
    if (sideId === "p2") v = 1 - v; // rank from the mover's perspective
    return v;
  });
  idx.sort((a, b) => score[b] - score[a]);
  return idx;
}

/** Trim to the `n` strongest actions by the myopic ranking (CAPPED-node path). */
function capActions(
  battle: SimBattle,
  sideId: "p1" | "p2",
  choices: string[],
  yardstick: string,
  n: number,
  ctx: Ctx
): string[] {
  if (choices.length <= n) return choices;
  ctx.cappedNodes++;
  return rankActions(battle, sideId, choices, yardstick).slice(0, n).map((i) => choices[i]);
}

/**
 * A memoized payoff-cell evaluator over the given action lists: cell(i,j) is the
 * chance-expected value of applying (p1Acts[i], p2Acts[j]), recursed to the depth
 * limit. Memoization is what makes double-oracle cheap — its bracket scan revisits
 * columns each iteration, but each distinct (i,j) is computed at most once.
 */
function makeCell(
  battle: SimBattle,
  p1Acts: string[],
  p2Acts: string[],
  depth: number,
  ctx: Ctx,
  salt: number
): (i: number, j: number) => number {
  const cols = p2Acts.length;
  const memo = new Map<number, number>();
  return (i, j) => {
    const key = i * cols + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    ctx.cellEvals++;
    const salt2 = mix(salt, i, j, depth);
    const succs = successors(battle, p1Acts[i], p2Acts[j], ctx.p.samples, salt2);
    let v: number;
    if (succs.length === 0) {
      ctx.usedLeafEstimate = true; // non-resolving line → status quo estimate
      v = leafEval(battle);
    } else {
      v = 0;
      for (const s of succs) v += s.weight * valueOf(s.battle, depth - 1, ctx, mix(salt2, 7));
    }
    memo.set(key, v);
    return v;
  };
}

interface NodeSolution {
  value: number;
  exploitability: number;
  p1Acts: string[];
  p2Acts: string[];
  p1: number[]; // mixed strategy aligned to p1Acts
  p2: number[]; // mixed strategy aligned to p2Acts
  fullP1: number; // pre-cap legal action counts
  fullP2: number;
  oracle?: OracleSolution; // present iff DO solved this node
}

/** Solve a single decision node — double-oracle (full action set) or capped matrix. */
function solveNode(battle: SimBattle, depth: number, ctx: Ctx, salt: number): NodeSolution {
  const enumP1 = enumerateSideChoices(battle, "p1", ctx.p.enumOpts);
  const enumP2 = enumerateSideChoices(battle, "p2", ctx.p.enumOpts);
  const yard2 = autoChoice(battle, "p2");
  const yard1 = autoChoice(battle, "p1");
  const depthFromRoot = ctx.p.maxDepth - depth;
  const useDO = ctx.p.useOracle && depthFromRoot < ctx.p.oracleDepth;

  if (useDO) {
    // Full action set, no width-cap. The myopic ranking only seeds and orders the
    // best-response scan — it cannot exclude an action from the equilibrium.
    const cell = makeCell(battle, enumP1, enumP2, depth, ctx, salt);
    const p1Order = rankActions(battle, "p1", enumP1, yard2);
    const p2Order = rankActions(battle, "p2", enumP2, yard1);
    const sol = solveDoubleOracle(enumP1.length, enumP2.length, cell, {
      rmIters: ctx.p.rmIters,
      eps: ctx.p.oracleEps,
      p1Order,
      p2Order,
    });
    return {
      value: sol.value,
      exploitability: sol.gap,
      p1Acts: enumP1,
      p2Acts: enumP2,
      p1: sol.p1,
      p2: sol.p2,
      fullP1: enumP1.length,
      fullP2: enumP2.length,
      oracle: sol,
    };
  }

  // Capped dense matrix.
  const p1Acts = capActions(battle, "p1", enumP1, yard2, ctx.p.maxActions, ctx);
  const p2Acts = capActions(battle, "p2", enumP2, yard1, ctx.p.maxActions, ctx);
  const cell = makeCell(battle, p1Acts, p2Acts, depth, ctx, salt);
  const m = p1Acts.length;
  const n = p2Acts.length;
  const A: number[][] = [];
  for (let i = 0; i < m; i++) {
    A[i] = new Array(n);
    for (let j = 0; j < n; j++) A[i][j] = cell(i, j);
  }
  const msol = solveMatrix(A, ctx.p.rmIters);
  return {
    value: msol.value,
    exploitability: msol.exploitability,
    p1Acts,
    p2Acts,
    p1: msol.p1,
    p2: msol.p2,
    fullP1: enumP1.length,
    fullP2: enumP2.length,
  };
}

function valueOf(battle: SimBattle, depth: number, ctx: Ctx, salt: number): number {
  if (isTerminal(battle)) return terminalValue(battle);
  if (!isDecision(battle)) {
    ctx.usedLeafEstimate = true;
    return leafEval(battle);
  }
  if (depth <= 0) {
    ctx.usedLeafEstimate = true;
    return leafEval(battle);
  }
  if (ctx.nodes >= ctx.p.nodeBudget || Date.now() - ctx.start > ctx.p.timeBudgetMs) {
    ctx.aborted = true;
    ctx.usedLeafEstimate = true;
    return leafEval(battle);
  }

  let key = "";
  if (ctx.p.useTT) {
    key = quickSig(battle) + "@" + depth;
    const cached = ctx.tt.get(key);
    if (cached !== undefined) {
      ctx.ttHits++;
      return cached;
    }
  }
  ctx.nodes++;

  const val = solveNode(battle, depth, ctx, salt).value;
  if (ctx.p.useTT) ctx.tt.set(key, val);
  return val;
}

export interface SolveResult {
  value: number;
  exploitability: number;
  solver: "oracle" | "matrix"; // root node solver
  p1Strategy: { choice: string; prob: number }[];
  p2Strategy: { choice: string; prob: number }[];
  principalVariation: { p1: string; p2: string };
  forcedWin: boolean;
  forcedLoss: boolean;
  rootActions: { p1: number; p2: number }; // full legal-action counts
  oracle?: {
    iterations: number;
    gap: number;
    lower: number;
    upper: number;
    converged: boolean;
    supportCapped: boolean;
    support: { p1: number; p2: number };
  };
  nodes: number;
  cappedNodes: number;
  cellEvals: number;
  ttHits: number;
  aborted: boolean;
  elapsedMs: number;
}

/** Solve the matchup from `battle` (which must be at a decision node). */
export function solve(battle: SimBattle, params: Partial<SolveParams> = {}): SolveResult {
  const p: SolveParams = { ...DEFAULT_PARAMS, ...params };
  const ctx: Ctx = {
    p,
    nodes: 0,
    cappedNodes: 0,
    cellEvals: 0,
    start: Date.now(),
    aborted: false,
    usedLeafEstimate: false,
    tt: new Map(),
    ttHits: 0,
  };

  ctx.nodes++;
  const node = solveNode(battle, p.maxDepth, ctx, 12345);

  const strat = (acts: string[], probs: number[]) =>
    acts
      .map((choice, i) => ({ choice, prob: probs[i] ?? 0 }))
      .filter((x) => x.prob > 1e-3)
      .sort((a, b) => b.prob - a.prob);
  const p1Strategy = strat(node.p1Acts, node.p1);
  const p2Strategy = strat(node.p2Acts, node.p2);

  // forced-win/-loss only when the whole reachable tree resolved to terminals
  // (no leaf estimate anywhere) and no budget abort — the honest exactness gate.
  const fullyResolved = !ctx.usedLeafEstimate && !ctx.aborted;
  const forcedWin = fullyResolved && node.value >= 0.999;
  const forcedLoss = fullyResolved && node.value <= 0.001;

  return {
    value: node.value,
    exploitability: node.exploitability,
    solver: node.oracle ? "oracle" : "matrix",
    p1Strategy,
    p2Strategy,
    principalVariation: {
      p1: p1Strategy[0]?.choice ?? node.p1Acts[0],
      p2: p2Strategy[0]?.choice ?? node.p2Acts[0],
    },
    forcedWin,
    forcedLoss,
    rootActions: { p1: node.fullP1, p2: node.fullP2 },
    oracle: node.oracle
      ? {
          iterations: node.oracle.iterations,
          gap: node.oracle.gap,
          lower: node.oracle.lower,
          upper: node.oracle.upper,
          converged: node.oracle.converged,
          supportCapped: node.oracle.supportCapped,
          support: node.oracle.support,
        }
      : undefined,
    nodes: ctx.nodes,
    cappedNodes: ctx.cappedNodes,
    cellEvals: ctx.cellEvals,
    ttHits: ctx.ttHits,
    aborted: ctx.aborted,
    elapsedMs: Date.now() - ctx.start,
  };
}
