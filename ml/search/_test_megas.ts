/* eslint-disable */
import { makeRootBattle, loadTeam, step, quickSig, type Seed } from "./engine.ts";
import { enumerateSideChoices } from "./actions.ts";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => loadTeam(readFileSync(join(HERE, "teams", f), "utf8"));

const p1 = load("megazard.txt");
const p2 = load("rain.txt");
console.log("megazard mons:", p1.map((s: any) => `${s.species || s.name}@${s.item}`).join(", "));
console.log("rain mons:", p2.map((s: any) => `${s.species || s.name}@${s.item}`).join(", "));

const seed: Seed = [1, 2, 3, 4];
// Bring Charizard(1)+Flutter(2) lead so Charizard is active and can mega.
const root = makeRootBattle(p1, p2, [1, 2, 3, 4], [2, 1, 3, 4], seed);
console.log("\nturn", root.turn, "p1 active:", root.p1.active.map((p: any) => p?.name));

const req0 = root.p1.activeRequest.active[0];
console.log("Charizard slot canMegaEvo:", req0.canMegaEvo, "| keys:", Object.keys(req0));

const p1c = enumerateSideChoices(root, "p1");
const megaChoices = p1c.filter((c) => c.includes("mega"));
console.log("\np1 total choices:", p1c.length, "| mega choices:", megaChoices.length);
console.log(megaChoices.slice(0, 6).join("\n"));

// Decoupling sanity with structuredClone-based clone + real mega step.
const p2c = enumerateSideChoices(root, "p2");
const before = quickSig(root);
const succ = step(root, megaChoices[0], p2c[0], seed);
console.log("\nmega step:", megaChoices[0], "|", p2c[0]);
console.log("-> Charizard forme:", succ.p1.active[0].species.name, "| weather:", succ.field.weather);
console.log("root unchanged by clone+step:", before === quickSig(root));
