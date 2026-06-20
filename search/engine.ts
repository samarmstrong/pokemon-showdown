/* eslint-disable */
/**
 * engine.ts — the ONLY module that touches the Showdown sim.
 *
 * Wraps the in-process sim with the primitives the search needs:
 *   - build a root battle for a fixed 4v4 (teams + bring-4 + leads via team preview)
 *   - clone a mid-battle state (serialize -> deserialize; RNG preserved)
 *   - step a (cloned) state by a joint choice under a chosen seed
 *   - classify the decision at a node and read terminal value
 *
 * Plan: ~/.claude/plans/proud-yawning-pearl.md
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import simPkg from "../../dist/sim/index.js";
import statePkg from "../../dist/sim/state.js";
const { Battle, Teams, PRNG } = simPkg as any;
const { State } = statePkg as any;

const HERE = dirname(fileURLToPath(import.meta.url));

export const FORMAT = "gen9championsvgc2026regma";
export const P1 = "P1";
export const P2 = "P2";

// Opaque to the rest of the search; only engine.ts dereferences sim internals.
export type SimBattle = any;
export type Seed = [number, number, number, number];

export type SideReq =
  | { kind: "move"; active: any[] }
  | { kind: "switch"; forceSwitch: boolean[] }
  | { kind: "teampreview" }
  | { kind: "wait" };

/** Unpack a packed team string (or PS export text) into a PokemonSet[]. */
export function loadTeam(packedOrText: string): any[] {
  const team = Teams.unpack(packedOrText.trim()) ?? Teams.import(packedOrText);
  if (!team) throw new Error("loadTeam: could not parse team");
  return team;
}

/** Load a packed team bundled in the psrl data dir, e.g. "goodstuff_01". */
export function loadBundledTeam(name: string, formatKey = "vgc2026_regma"): any[] {
  const p = join(HERE, `../src/psrl/data/teams/${formatKey}/${name}.packed`);
  return loadTeam(readFileSync(p, "utf8"));
}

/**
 * Construct a battle and resolve team preview to fix the brought 4 + leads.
 * `bring` is a 1-based ordering of team slots; first two are the doubles leads.
 * Returns the battle sitting at the first in-battle decision.
 */
export function makeRootBattle(
  p1team: any[],
  p2team: any[],
  p1bring: number[],
  p2bring: number[],
  seed: Seed
): SimBattle {
  const battle = new Battle({
    formatid: FORMAT,
    seed,
    p1: { name: P1, team: p1team },
    p2: { name: P2, team: p2team },
    strictChoices: false,
    send: () => {},
  });
  // First request is team preview for both sides.
  battle.makeChoices(`team ${p1bring.join("")}`, `team ${p2bring.join("")}`);
  return battle;
}

/**
 * Serialize a battle to a snapshot STRING (RNG state included).
 *
 * Note: the string form is deliberate. `State.serializeBattle` returns an object
 * that still shares references into the live battle (e.g. PokemonSet `.set`), so
 * deserializing from that object yields a battle that ALIASES the original and
 * corrupts it when stepped. Round-tripping through JSON fully decouples the copy.
 */
export function serialize(battle: SimBattle): string {
  return JSON.stringify(State.serializeBattle(battle));
}

/** Rebuild a battle from a snapshot (string or already-decoupled object). */
export function deserialize(snap: string | object): SimBattle {
  const b = State.deserializeBattle(snap);
  b.send = () => {};
  return b;
}

/**
 * Deep, fully-decoupled clone of a mid-battle state. Uses structuredClone of the
 * serialized object (faster than a JSON string round-trip); structuredClone
 * deep-copies the references that `serializeBattle` shares with the live battle,
 * so the clone never aliases/corrupts the original.
 */
export function clone(battle: SimBattle): SimBattle {
  const b = State.deserializeBattle(structuredClone(State.serializeBattle(battle)));
  b.send = () => {};
  return b;
}

/** Overwrite a battle's RNG with a fresh stream for the given seed. */
export function setSeed(battle: SimBattle, seed: Seed): void {
  battle.prng = new PRNG(seed);
}

/**
 * Apply a joint choice to a fresh clone of `battle` under `seed`, returning the
 * successor state. `p1Choice`/`p2Choice` are full side-choice strings (""=skip,
 * used when a side is waiting). Does not mutate `battle`.
 *
 * Returns null when the sim aborts the turn (its "Infinite loop" / "Stack
 * overflow" / line-limit guards). Those are real, rare interactions Showdown
 * itself refuses to resolve; callers treat the line as non-resolving.
 */
export function step(
  battle: SimBattle,
  p1Choice: string,
  p2Choice: string,
  seed: Seed
): SimBattle | null {
  const b = clone(battle);
  setSeed(b, seed);
  try {
    b.makeChoices(p1Choice, p2Choice);
  } catch {
    return null;
  }
  return b;
}

export function isTerminal(battle: SimBattle): boolean {
  return !!battle.ended;
}

/** Terminal value from P1's perspective: 1 win, 0 loss, 0.5 tie. */
export function terminalValue(battle: SimBattle): number {
  if (battle.winner === P1) return 1;
  if (battle.winner === P2) return 0;
  return 0.5; // tie / forced draw
}

export function sideRequest(battle: SimBattle, sideId: "p1" | "p2"): SideReq {
  const req = battle[sideId].activeRequest;
  if (!req || req.wait) return { kind: "wait" };
  if (req.teamPreview) return { kind: "teampreview" };
  if (req.forceSwitch) return { kind: "switch", forceSwitch: req.forceSwitch };
  if (req.active) return { kind: "move", active: req.active };
  return { kind: "wait" };
}

/** The sim's default choice for a side (first legal move, no switch) — a cheap
 *  "opponent attacks" yardstick for ranking. Leaves the battle's choice cleared. */
export function autoChoice(battle: SimBattle, sideId: "p1" | "p2"): string {
  const side = battle[sideId];
  side.clearChoice();
  try {
    side.autoChoose();
  } catch {
    side.clearChoice();
    return "";
  }
  const c = typeof side.getChoice === "function" ? side.getChoice() : "";
  side.clearChoice();
  return c;
}

/** True when at least one side owes a choice (i.e. this is a decision node). */
export function isDecision(battle: SimBattle): boolean {
  if (battle.ended) return false;
  const a = sideRequest(battle, "p1").kind;
  const b = sideRequest(battle, "p2").kind;
  return a !== "wait" || b !== "wait";
}

/**
 * Cheap, mostly-complete state signature — for collapsing identical chance
 * outcomes and as a rough transposition key. Covers turn/terminal, every mon's
 * hp+status, active boosts, and field. Omits PP/volatiles/exact side conditions,
 * so it is NOT a perfect canonical key (good enough for v1).
 */
export function quickSig(battle: SimBattle): string {
  const parts: (string | number)[] = [battle.turn];
  if (battle.ended) parts.push("E" + battle.winner);
  for (const side of battle.sides) {
    for (const p of side.pokemon) parts.push(`${p.hp}.${p.status || ""}`);
    parts.push(
      "A" +
        side.active
          .map((a: any) => {
            if (!a) return "x";
            const b = a.boosts;
            return `${a.position}:${b.atk},${b.def},${b.spa},${b.spd},${b.spe},${b.accuracy},${b.evasion}`;
          })
          .join(";")
    );
  }
  const f = battle.field;
  parts.push(`F${f.weather || ""}/${f.terrain || ""}/${Object.keys(f.pseudoWeather || {}).join(",")}`);
  return parts.join("|");
}

// Re-export sim handles that other engine-adjacent modules (actions.ts) need.
export const _sim = { Battle, Teams, PRNG, State };
