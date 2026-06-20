/* eslint-disable */
/**
 * cli.ts — solve one fixed 4v4 matchup and print JSON.
 *
 * Examples:
 *   node ml/search/cli.ts                       # mirror: goodstuff_01 vs itself
 *   node ml/search/cli.ts --depth 3 --samples 6 --max-actions 12
 *   node ml/search/cli.ts --p1 @goodstuff_01 --p2 ./enemy.packed \
 *        --p1-bring 1,2,3,4 --p2-bring 2,3,5,6 --pretty
 *
 * Team args accept: "@name" (bundled packed team), a file path, or a raw packed
 * team string.
 */
import { existsSync, readFileSync } from "fs";
import { makeRootBattle, loadTeam, loadBundledTeam, type Seed } from "./engine.ts";
import { solve, DEFAULT_PARAMS, type SolveParams } from "./solve.ts";

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

function parseBring(s: string | undefined): number[] {
  if (!s) return [1, 2, 3, 4];
  return s.split(/[,\s]+/).filter(Boolean).map(Number);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const p1team = loadTeamArg(args.p1 ?? "@goodstuff_01");
  const p2team = loadTeamArg(args.p2 ?? "@goodstuff_01");
  const p1bring = parseBring(args["p1-bring"]);
  const p2bring = parseBring(args["p2-bring"]);
  const seed: Seed = args.seed
    ? (args.seed.split(",").map(Number) as Seed)
    : [1, 2, 3, 4];

  const params: Partial<SolveParams> = {
    maxDepth: args.depth ? Number(args.depth) : DEFAULT_PARAMS.maxDepth,
    samples: args.samples ? Number(args.samples) : DEFAULT_PARAMS.samples,
    maxActions: args["max-actions"] ? Number(args["max-actions"]) : DEFAULT_PARAMS.maxActions,
    rmIters: args["rm-iters"] ? Number(args["rm-iters"]) : DEFAULT_PARAMS.rmIters,
    nodeBudget: args["node-budget"] ? Number(args["node-budget"]) : DEFAULT_PARAMS.nodeBudget,
    timeBudgetMs: args["time-budget"] ? Number(args["time-budget"]) : DEFAULT_PARAMS.timeBudgetMs,
    useTT: args["no-tt"] ? false : true,
    useOracle: args["no-oracle"] ? false : true,
    oracleDepth: args["oracle-depth"] ? Number(args["oracle-depth"]) : DEFAULT_PARAMS.oracleDepth,
    oracleEps: args["oracle-eps"] ? Number(args["oracle-eps"]) : DEFAULT_PARAMS.oracleEps,
    enumOpts: { switches: args["no-switch"] ? false : true },
  };

  const root = makeRootBattle(p1team, p2team, p1bring, p2bring, seed);
  const result = solve(root, params);

  const report = {
    matchup: {
      p1: args.p1 ?? "@goodstuff_01",
      p2: args.p2 ?? "@goodstuff_01",
      p1bring,
      p2bring,
    },
    params,
    result,
  };
  console.log(JSON.stringify(report, null, args.pretty ? 2 : 0));
}

main();
