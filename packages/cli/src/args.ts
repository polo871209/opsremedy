export type CliOptions = Record<string, string | boolean>;

export const USAGE = [
  "opsremedy onboard",
  "opsremedy investigate (-i <alert.json> | --url <gcp-monitoring-url>) [--markdown <path>] [--trace <path>] [--max-tool-calls N] [--quiet] [--lark | --no-lark]",
  "opsremedy bench [--scenario <id>] [--json] [--quiet]",
].join("\n");

const VALUE_FLAGS = new Set(["url", "markdown", "trace", "max-tool-calls", "scenario"]);
const BOOL_FLAGS = new Set(["json", "quiet", "lark", "no-lark"]);

export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: number = 2,
  ) {
    super(message);
  }
}

export function parseArgs(argv: string[]): { cmd: string; opts: CliOptions } {
  const [, , cmd, ...rest] = argv;
  if (!cmd) throw new CliError(USAGE);
  const opts: CliOptions = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;

    if (arg === "-i") {
      const value = rest[i + 1];
      if (!value) throw new CliError(`-i requires a path argument\n${USAGE}`);
      opts.input = value;
      i++;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new CliError(`Unexpected argument: ${arg}\n${USAGE}`);
    }

    const key = arg.slice(2);
    if (BOOL_FLAGS.has(key)) {
      opts[key] = true;
      continue;
    }

    if (VALUE_FLAGS.has(key)) {
      const value = rest[i + 1];
      if (value === undefined) throw new CliError(`--${key} requires a value\n${USAGE}`);
      opts[key] = value;
      i++;
      continue;
    }

    throw new CliError(`Unknown flag: --${key}\n${USAGE}`);
  }

  return { cmd, opts };
}
