/* eslint-disable */
/**
 * Run-path / engine regression smoke (plan: proud-yawning-pearl).
 *
 * Proves the in-process pipeline: build a 4v4 via team preview, clone a
 * mid-battle state, play to a winner, and confirm determinism. Run:
 *   node ml/search/smoke.ts
 */
import {
  makeRootBattle,
  loadBundledTeam,
  clone,
  isTerminal,
  terminalValue,
  sideRequest,
  type Seed,
} from "./engine.ts";

const team = loadBundledTeam("goodstuff_01");
const seed: Seed = [1, 2, 3, 4];

function playOut(): { winner: string; turns: number; value: number } {
  const b = makeRootBattle(team, team, [1, 2, 3, 4], [1, 2, 3, 4], seed);
  let guard = 0;
  while (!isTerminal(b) && guard < 1000) {
    b.makeChoices(); // autoChoose both sides
    guard++;
  }
  return { winner: b.winner, turns: b.turn, value: terminalValue(b) };
}

const root = makeRootBattle(team, team, [1, 2, 3, 4], [1, 2, 3, 4], seed);
console.log("turn", root.turn, "| p1 req:", sideRequest(root, "p1").kind);

const c = clone(root);
console.log(
  "clone round-trip ok:",
  root.turn === c.turn &&
    root.p1.active.map((p: any) => p?.name).join() === c.p1.active.map((p: any) => p?.name).join()
);

const a = playOut();
const b = playOut();
console.log("game over: winner", JSON.stringify(a.winner), "turns", a.turns, "value(P1)", a.value);
console.log("determinism:", a.winner === b.winner && a.turns === b.turns);
