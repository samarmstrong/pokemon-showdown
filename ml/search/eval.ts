/* eslint-disable */
/**
 * eval.ts — heuristic leaf evaluation, P1 perspective, in [0,1].
 *
 * Used when the search hits its depth limit. Deliberately simple for v1: the
 * dominant signals are how many Pokemon each side has left and their HP. M2
 * measures how much the leaf eval matters (depth-convergence study) before
 * investing in richer features (status, hazards, field, momentum).
 */
import { type SimBattle } from "./engine.ts";

/** Strength of one side: each alive mon contributes a base + HP fraction. */
function sideStrength(side: any): number {
  let s = 0;
  for (const p of side.pokemon) {
    if (!p || p.fainted) continue;
    const frac = p.maxhp > 0 ? p.hp / p.maxhp : 0;
    // Being alive is worth a lot; HP scales the rest. A statused mon is slightly
    // devalued.
    let mon = 0.35 + 0.65 * frac;
    if (p.status === "slp" || p.status === "frz") mon -= 0.12;
    else if (p.status) mon -= 0.05;
    s += mon;
  }
  return s;
}

/** Leaf value in [0,1] from P1's perspective. */
export function leafEval(battle: SimBattle): number {
  const p1 = sideStrength(battle.sides[0]);
  const p2 = sideStrength(battle.sides[1]);
  const diff = p1 - p2; // each side max ~4.0
  // Squash to [0,1]; scale chosen so a one-healthy-mon lead ≈ 0.65.
  const SCALE = 2.2;
  const v = 0.5 + 0.5 * Math.tanh(diff / SCALE);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
