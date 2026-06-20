/* eslint-disable */
import { makeRootBattle, loadBundledTeam, step, sideRequest, isTerminal } from "./engine.ts";
import { enumerateSideChoices } from "./actions.ts";

const team = loadBundledTeam("goodstuff_01");
const seed: [number, number, number, number] = [1, 2, 3, 4];
const root = makeRootBattle(team, team, [1, 2, 3, 4], [1, 2, 3, 4], seed);

console.log("turn", root.turn, "| p1 req kind:", sideRequest(root, "p1").kind);

const p1c = enumerateSideChoices(root, "p1");
const p2c = enumerateSideChoices(root, "p2");
console.log(`\np1 choices: ${p1c.length}`);
console.log(p1c.slice(0, 24).join("\n"));
console.log(`\np2 choices: ${p2c.length}`);

console.log("\nhas tera choice:", p1c.some((c) => c.includes("terastallize")));
console.log("has switch choice:", p1c.some((c) => c.includes("switch")));
console.log("has ally-target (neg loc):", p1c.some((c) => /move \d -\d/.test(c)));

const succ = step(root, p1c[0], p2c[0], seed);
console.log("\nafter step:", p1c[0], "|", p2c[0]);
console.log("  ended:", isTerminal(succ), "turn:", succ.turn);
if (!isTerminal(succ)) {
  console.log("  reqs:", sideRequest(succ, "p1").kind, "/", sideRequest(succ, "p2").kind);
  console.log("  p1 choices now:", enumerateSideChoices(succ, "p1").length);
}

const succ2 = step(root, p1c[0], p2c[0], seed);
const hp = (b: any) => b.sides.flatMap((s: any) => s.pokemon.map((p: any) => p.hp)).join(",");
console.log("\nstep determinism (hp equal):", hp(succ) === hp(succ2));
