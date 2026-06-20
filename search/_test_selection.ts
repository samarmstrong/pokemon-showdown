/* eslint-disable */
/**
 * _test_selection.ts — correctness of the team-preview selection game.
 *
 * Proves the NEW wiring (the DO-on-synthetic-matrices equivalence is already
 * covered by _test_oracle.ts):
 *   1. enumeration: C(6,2)·C(4,2)=90 distinct, valid `team` strings, index 0 natural;
 *   2. every strategy builds a real root battle that reaches an in-battle decision;
 *   3. on a REAL reduced game (numBring=2, 15×15), the selection DO value equals the
 *      brute-force FULL-matrix value while touching fewer cells (the integration test);
 *   4. mirror symmetry: a team against itself → value ≈ 0.5.
 *
 * Run: node ml/search/_test_selection.ts
 */
import { readFileSync } from "fs";
import { makeRootBattle, loadTeam, isDecision, type Seed } from "./engine.ts";
import { solve, type SolveParams } from "./solve.ts";
import { solveMatrix } from "./matrix.ts";
import { enumerateSelections, solveSelection } from "./selection.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

const SEED: Seed = [1, 2, 3, 4];
const megazard = loadTeam(readFileSync("ml/search/teams/megazard.txt", "utf8"));
const rain = loadTeam(readFileSync("ml/search/teams/rain.txt", "utf8"));

// 1) Enumeration.
const full = enumerateSelections(6, 4, 2);
check("enumeration count = 90", full.length === 90, `got ${full.length}`);
const keys = new Set(full.map((s) => s.leads.join(".") + "|" + s.back.join(".")));
check("enumeration distinct", keys.size === 90, `got ${keys.size}`);
check("index 0 is natural (1,2 lead / 3,4 back)", full[0].team === "1234", full[0].label);
const allFourDistinct = full.every((s) => new Set(s.bring).size === 4 && s.bring.length === 4);
check("every strategy brings 4 distinct slots", allFourDistinct);

// 2) Each strategy builds a battle that reaches an in-battle decision.
let reached = 0;
for (const s of full) {
  const b = makeRootBattle(megazard, rain, s.bring, [1, 2, 3, 4], SEED);
  if (isDecision(b)) reached++;
}
check("all 90 P1 strategies reach a decision node", reached === 90, `${reached}/90`);

// 3) Reduced REAL game (numBring=2 → 15 strategies/side). Brute-force full matrix
//    vs the selection DO, on identical deterministic payoffs.
const inner: Partial<SolveParams> = {
  maxDepth: 1,
  samples: 2,
  maxActions: 5,
  useOracle: false,
  timeBudgetMs: 20000,
};
const p1strats = enumerateSelections(6, 2, 2);
const p2strats = enumerateSelections(6, 2, 2);
const t0 = Date.now();
const A: number[][] = [];
for (let i = 0; i < p1strats.length; i++) {
  A[i] = new Array(p2strats.length);
  for (let j = 0; j < p2strats.length; j++) {
    const root = makeRootBattle(megazard, rain, p1strats[i].bring, p2strats[j].bring, SEED);
    A[i][j] = solve(root, inner).value;
  }
}
const fullSol = solveMatrix(A, 1500);
const cellsFull = p1strats.length * p2strats.length;
console.log(`  full matrix: value=${fullSol.value.toFixed(4)} cells=${cellsFull} ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const doSol = solveSelection(megazard, rain, { inner, numBring: 2, numLeads: 2, progressEvery: 0, seed: SEED });
console.log(`  selection DO: value=${doSol.value.toFixed(4)} cells=${doSol.innerSolves} support ${doSol.support.p1}x${doSol.support.p2} gap=${doSol.gap.toFixed(4)}`);
check("DO value == full-matrix value (reduced real game)", Math.abs(doSol.value - fullSol.value) < 0.02, `|${doSol.value.toFixed(4)} - ${fullSol.value.toFixed(4)}|`);
check("DO touches ≤ full-matrix cells", doSol.innerSolves <= cellsFull, `${doSol.innerSolves} vs ${cellsFull}`);

// 4) Mirror symmetry: megazard vs megazard, reduced, → ≈ 0.5.
const mirror = solveSelection(megazard, megazard, { inner, numBring: 2, numLeads: 2, progressEvery: 0, seed: SEED });
console.log(`  mirror: value=${mirror.value.toFixed(4)} cells=${mirror.innerSolves} support ${mirror.support.p1}x${mirror.support.p2}`);
check("mirror selection value ≈ 0.5", Math.abs(mirror.value - 0.5) < 0.03, mirror.value.toFixed(4));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
