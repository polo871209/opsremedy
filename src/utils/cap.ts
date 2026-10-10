import type { SreTool } from "../tools/types.ts";
import { log } from "./logger.ts";

const MAX_CHARS = 32_000;

export function withMaxOutput(tool: SreTool): SreTool {
  return {
    ...tool,
    execute: async (args, tw) => {
      const r = await tool.execute(args, tw);
      let total = 0;
      for (const c of r.content) total += c.type === "text" ? c.text.length : 0;
      if (total <= MAX_CHARS) return r;
      log.warn("tool output truncated", { tool: tool.name, total, max: MAX_CHARS });
      const head = Math.floor(MAX_CHARS * 0.7);
      const tail = MAX_CHARS - head - 100;
      const joined = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      const truncated =
        joined.slice(0, head) +
        `\n\n... [truncated ${total - MAX_CHARS} chars from the middle; head and tail kept, so omitted signals are unknown, ` +
        `not absent. Re-run scoped tighter: narrow the filter/selector/time window, or for file reads use offset+limit] ...\n\n` +
        joined.slice(-tail);
      return { ...r, content: [{ type: "text", text: truncated }] };
    },
  };
}
