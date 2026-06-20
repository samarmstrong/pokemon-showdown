/* eslint-disable */
/**
 * select-cli.ts — solve the team-preview SELECTION game and print JSON.
 *
 * Unlike `cli.ts` (one fixed 4v4 = one cell), this solves the full 90×90 game of
 * "which 4 to bring + which 2 to lead" for both sides, by double-oracle over the
 * strategy matrix (oracle.ts) with each cell an inner 4v4 `solve()`.
 *
 * Examples:
 *   # megazard vs rain — cheap depth-1 capped inner (the default), live progress
 *   node ml/search/select-cli.ts --p1 ml/search/teams/megazard.txt \
 *        --p2 ml/search/teams/rain.txt --pretty
 *
 *   # higher fidelity: depth-2 inner, and re-score the equilibrium support at d1-DO
 *   node ml/search/select-cli.ts --p1 @goodstuff_01 --p2 ./enemy.packed \
 *        --depth 2 --max-actions 10 --refine --pretty
 *
 * Run ONE solve at a time (concurrent runs starve each other — see README).
 */
import { existsSync, readFileSync } from "fs";
import { loadTeam, loadBundledTeam, type Seed } from "./engine.ts";
import {
  solveSelection,
  DEFAULT_SELECTION_PARAMS,
  type SelectionParams,
} from "./selection.ts";
import { type SolveParams } from "./solve.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = "true";
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function loadTeamArg(arg: string): any[] {
  if (arg.startsWith("@")) return loadBundledTeam(arg.slice(1));
  if (existsSync(arg)) return loadTeam(readFileSync(arg, "utf8"));
  return loadTeam(arg);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const p1team = loadTeamArg(args.p1 ?? "@goodstuff_01");
  const p2team = loadTeamArg(args.p2 ?? "@goodstuff_01");
  const seed: Seed = args.seed ? (args.seed.split(",").map(Number) as Seed) : [1, 2, 3, 4];

  // Inner per-cell solve. Default is the TRUSTWORTHY depth-1 double-oracle. Passing
  // --inner-cap N opts into a fast-but-rough capped inner (width N) — NOT trustworthy
  // (the cap's width-bias corrupts selection payoffs; see README/--refine).
  const cap = args["inner-cap"] ? Number(args["inner-cap"]) : 0;
  const inner: Partial<SolveParams> = {
    maxDepth: args.depth ? Number(args.depth) : 1,
    samples: args.samples ? Number(args.samples) : 4,
    maxActions: cap || 8,
    useOracle: cap ? false : true,
    oracleDepth: args["inner-oracle-depth"] ? Number(args["inner-oracle-depth"]) : 1,
    timeBudgetMs: args["time-budget"] ? Number(args["time-budget"]) : 60000,
    enumOpts: { switches: args["no-switch"] ? false : true },
  };
  if (cap) process.stderr.write(`  [selection] WARNING: capped inner (width ${cap}) — values are a rough scan, not trustworthy. Use --refine or drop --inner-cap.\n`);

  const params: Partial<SelectionParams> = {
    inner,
    rmIters: args["rm-iters"] ? Number(args["rm-iters"]) : DEFAULT_SELECTION_PARAMS.rmIters,
    eps: args.eps ? Number(args.eps) : DEFAULT_SELECTION_PARAMS.eps,
    maxSupport: args["max-support"] ? Number(args["max-support"]) : DEFAULT_SELECTION_PARAMS.maxSupport,
    numBring: args.bring ? Number(args.bring) : 4,
    numLeads: args.leads ? Number(args.leads) : 2,
    seed,
    progressEvery: args["no-progress"] ? 0 : args["progress-every"] ? Number(args["progress-every"]) : 25,
    refine: args.refine ? true : false,
    refineInner: {
      maxDepth: args["refine-depth"] ? Number(args["refine-depth"]) : 1,
      samples: args["refine-samples"] ? Number(args["refine-samples"]) : 6,
      useOracle: true,
      oracleDepth: 1,
      timeBudgetMs: 60000,
    },
  };

  const result = solveSelection(p1team, p2team, params);

  const report = {
    matchup: { p1: args.p1 ?? "@goodstuff_01", p2: args.p2 ?? "@goodstuff_01" },
    params: { inner, rmIters: params.rmIters, eps: params.eps, maxSupport: params.maxSupport, refine: params.refine },
    result,
  };
  console.log(JSON.stringify(report, null, args.pretty ? 2 : 0));
}

main();
