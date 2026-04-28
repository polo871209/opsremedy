import { runBench } from "@opsremedy/bench";
import { CliError, type CliOptions } from "../args.ts";
import { bootstrapAuth } from "../bootstrap.ts";

export async function cmdBench(opts: CliOptions): Promise<void> {
  const scenario = typeof opts.scenario === "string" ? opts.scenario : undefined;
  const asJson = opts.json === true;
  const quiet = opts.quiet === true;

  const { settings } = await bootstrapAuth();

  const result = await runBench({
    ...(scenario !== undefined && { scenario }),
    asJson,
    provider: settings.llm.provider,
    model: settings.llm.model,
    displayThinking: !quiet && !asJson,
  });

  if (!result.allPassed) throw new CliError("bench failures", 1);
}
