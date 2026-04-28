#!/usr/bin/env bun
import { CliError, parseArgs, USAGE } from "./args.ts";
import { cmdBench } from "./commands/bench.ts";
import { cmdInvestigate } from "./commands/investigate.ts";
import { runOnboard } from "./onboard/index.ts";

async function dispatch(): Promise<void> {
  const { cmd, opts } = parseArgs(process.argv);
  switch (cmd) {
    case "onboard":
      await runOnboard();
      return;
    case "investigate":
      await cmdInvestigate(opts);
      return;
    case "bench":
      await cmdBench(opts);
      return;
    default:
      throw new CliError(USAGE);
  }
}

try {
  await dispatch();
} catch (err) {
  if (err instanceof CliError) {
    console.error(err.message);
    process.exit(err.code);
  }
  console.error((err as Error).message);
  process.exit(1);
}
