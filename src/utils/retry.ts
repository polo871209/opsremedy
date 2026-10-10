import type { SreTool, ToolOutput } from "../tools/types.ts";
import { log } from "./logger.ts";

const ATTEMPTS = 2;
const ATTEMPT_DEADLINE_MS = 60_000;

async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no response after ${ATTEMPT_DEADLINE_MS / 1000}s`)),
      ATTEMPT_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function withRetry(tool: SreTool): SreTool {
  return {
    ...tool,
    execute: async (args, tw) => {
      let last: ToolOutput | undefined;
      let lastErr: unknown;
      for (let i = 0; i < ATTEMPTS; i++) {
        try {
          const r = await withDeadline(tool.execute(args, tw));
          if (!r.isError) return r;
          last = r;
        } catch (e) {
          lastErr = e;
        }
        if (i + 1 < ATTEMPTS) {
          log.info("tool retry", { tool: tool.name, attempt: i + 1 });
          await new Promise((res) => setTimeout(res, 500));
        }
      }
      if (last) return last;
      return {
        content: [{ type: "text", text: `Error after ${ATTEMPTS} attempts: ${String(lastErr)}` }],
        isError: true,
      };
    },
  };
}
