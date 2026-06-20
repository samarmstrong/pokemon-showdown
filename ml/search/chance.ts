/* eslint-disable */
/**
 * chance.ts — the distribution over successor states for a joint action.
 *
 * v1 backend: seed-sampling. Run the same (state, jointAction) under K distinct
 * RNG seeds and treat the empirical outcomes as the chance node. A
 * determinism-collapse short-circuits turns with no randomness (status moves,
 * guaranteed KOs) so we don't burn K samples on a single outcome.
 *
 * Pluggable later (M2): forced-roll quadrature — pin the random(16) damage roll
 * to a few representative values with exact weights for lower-variance values.
 */
import { type SimBattle, type Seed, step, quickSig } from "./engine.ts";

export interface Successor {
  battle: SimBattle;
  weight: number;
}

/** Deterministic 4x16-bit seed from a salt and sample index (no Date/random). */
export function seedFor(salt: number, i: number): Seed {
  let h = (salt ^ (i * 0x9e3779b1)) >>> 0;
  const next = () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;
    h >>>= 0;
    return h & 0xffff;
  };
  return [next(), next(), next(), next()];
}

/**
 * Weighted successor states for applying (p1Choice, p2Choice) to `battle`.
 * `samples` is the max number of seeds; `salt` decorrelates sampling across the
 * tree. Identical outcomes are merged (weights summed).
 */
export function successors(
  battle: SimBattle,
  p1Choice: string,
  p2Choice: string,
  samples: number,
  salt: number
): Successor[] {
  const first = step(battle, p1Choice, p2Choice, seedFor(salt, 0));
  // A line the sim refuses to resolve contributes no successors.
  if (first === null) return [];
  if (samples <= 1) return [{ battle: first, weight: 1 }];

  const second = step(battle, p1Choice, p2Choice, seedFor(salt, 1));
  const sigFirst = quickSig(first);
  if (second !== null && quickSig(second) === sigFirst) {
    // Looks deterministic — don't waste the remaining samples.
    return [{ battle: first, weight: 1 }];
  }

  const bySig = new Map<string, Successor>();
  let n = 0;
  const add = (b: SimBattle | null) => {
    if (b === null) return;
    n++;
    const sig = quickSig(b);
    const ex = bySig.get(sig);
    if (ex) ex.weight += 1;
    else bySig.set(sig, { battle: b, weight: 1 });
  };
  add(first);
  add(second);
  for (let i = 2; i < samples; i++) add(step(battle, p1Choice, p2Choice, seedFor(salt, i)));

  const out = [...bySig.values()];
  if (n > 0) for (const s of out) s.weight /= n;
  return out;
}
