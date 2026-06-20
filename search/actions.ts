/* eslint-disable */
/**
 * actions.ts — enumerate legal full side-choice strings at a decision node.
 *
 * Strategy: generate a generous set of candidate per-slot sub-choices using the
 * sim's own target convention (positive loc = foe, negative = ally; see
 * sim/pokemon.ts getLocOf), take the cartesian product across active slots, then
 * VALIDATE each joint string against the sim (side.choose -> check error ->
 * clearChoice). The sim is the source of truth, so cross-slot rules (no two
 * switches to the same bench mon, one terastallization per side, trapping, etc.)
 * are enforced for free.
 */
import { type SimBattle, sideRequest } from "./engine.ts";

const CHOOSABLE = new Set([
  "normal",
  "any",
  "adjacentAlly",
  "adjacentAllyOrSelf",
  "adjacentFoe",
]);

export interface EnumOpts {
  /** Allow targeting your own ally with normal/any offensive moves (default off). */
  allowAllyTarget?: boolean;
  /** Enumerate gimmick variants — mega/ultra/tera/dynamax/z (default on).
   *  Note: the champions mod disables tera; item megas still apply. */
  gimmicks?: boolean;
  /** Allow switching (default on). */
  switches?: boolean;
}

const DEFAULTS: Required<EnumOpts> = {
  allowAllyTarget: false,
  gimmicks: true,
  switches: true,
};

/** Gimmick keywords currently legal for this slot, read from the request. */
function gimmickKeywords(slotReq: any, moveIndex: number): string[] {
  const gk: string[] = [];
  if (slotReq.canMegaEvo) gk.push("mega");
  if (slotReq.canUltraBurst) gk.push("ultra");
  if (slotReq.canTerastallize) gk.push("terastallize");
  if (slotReq.canDynamax) gk.push("dynamax");
  if (slotReq.canZMove && slotReq.canZMove[moveIndex]) gk.push("zmove");
  return gk;
}

/** Target suffixes (" 1", " -2", or "" for no explicit target) for a move. */
function targetSuffixes(
  battle: SimBattle,
  pokemon: any,
  targetType: string,
  allowAlly: boolean
): string[] {
  if (!CHOOSABLE.has(targetType) || pokemon.side.active.length < 2) return [""];
  const locs: number[] = [];
  for (const loc of [1, 2, -1, -2]) {
    if (Math.abs(loc) > battle.activePerHalf) continue;
    if (!battle.validTargetLoc(loc, pokemon, targetType)) continue;
    const t = pokemon.getAtLoc(loc);
    if (!t || t.fainted) continue;
    const isFoe = loc > 0;
    if (!isFoe && !allowAlly && (targetType === "normal" || targetType === "any")) {
      continue;
    }
    locs.push(loc);
  }
  return locs.length ? locs.map((l) => ` ${l}`) : [""];
}

/** Candidate sub-choices for one active slot in a move request. */
function moveSlotCandidates(
  battle: SimBattle,
  side: any,
  slotReq: any,
  pokemon: any,
  opts: Required<EnumOpts>
): string[] {
  const cands: string[] = [];
  if (slotReq && slotReq.moves) {
    for (let mi = 0; mi < slotReq.moves.length; mi++) {
      const m = slotReq.moves[mi];
      if (m.disabled) continue;
      const n = mi + 1;
      const suffixes = targetSuffixes(battle, pokemon, m.target || "normal", opts.allowAllyTarget);
      const gk = opts.gimmicks ? gimmickKeywords(slotReq, mi) : [];
      for (const suf of suffixes) {
        cands.push(`move ${n}${suf}`);
        for (const g of gk) cands.push(`move ${n}${suf} ${g}`);
      }
    }
  }
  if (opts.switches && slotReq && !slotReq.trapped) {
    for (let k = 1; k <= side.pokemon.length; k++) cands.push(`switch ${k}`);
  }
  if (!cands.length) cands.push("pass");
  return cands;
}

/** Candidate sub-choices for one slot in a force-switch request. */
function switchSlotCandidates(side: any, mustSwitch: boolean): string[] {
  if (!mustSwitch) return ["pass"];
  const cands: string[] = [];
  for (let k = 1; k <= side.pokemon.length; k++) cands.push(`switch ${k}`);
  cands.push("pass"); // legal when no eligible bench mon remains
  return cands;
}

function cartesian(lists: string[][]): string[][] {
  return lists.reduce<string[][]>(
    (acc, list) => acc.flatMap((prefix) => list.map((x) => [...prefix, x])),
    [[]]
  );
}

/** Validate a full side-choice string using the sim itself (no turn committed). */
function isValidSideChoice(side: any, str: string): boolean {
  side.clearChoice();
  const ok = side.choose(str);
  const valid = !!ok && !side.choice.error && side.isChoiceDone();
  side.clearChoice();
  return valid;
}

/**
 * All legal full side-choice strings for `sideId` at the current decision.
 * Returns [""] when the side is waiting (no choice owed this decision).
 */
export function enumerateSideChoices(
  battle: SimBattle,
  sideId: "p1" | "p2",
  opts: EnumOpts = {}
): string[] {
  const o = { ...DEFAULTS, ...opts };
  const req = sideRequest(battle, sideId);
  const side = battle[sideId];
  if (req.kind === "wait") return [""];

  let perSlot: string[][];
  if (req.kind === "move") {
    perSlot = req.active.map((slotReq: any, i: number) =>
      slotReq ? moveSlotCandidates(battle, side, slotReq, side.active[i], o) : ["pass"]
    );
  } else if (req.kind === "switch") {
    perSlot = req.forceSwitch.map((must: boolean) => switchSlotCandidates(side, must));
  } else {
    return [""]; // teampreview not handled in-search
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const combo of cartesian(perSlot)) {
    const str = combo.join(", ");
    if (seen.has(str)) continue;
    seen.add(str);
    if (isValidSideChoice(side, str)) out.push(str);
  }
  // Safety net: never strand a live decision with zero choices.
  if (!out.length) {
    side.clearChoice();
    side.autoChoose();
    const fallback = typeof side.getChoice === "function" ? side.getChoice() : "";
    side.clearChoice();
    if (fallback) out.push(fallback);
  }
  return out;
}
