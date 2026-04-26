import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { InvestigationContext } from "@opsremedy/core/types";
import type { Static, TSchema } from "typebox";
import { recordToolCall } from "./shared.ts";

/**
 * Result returned by a tool's `run` body. The wrapper converts this into the
 * `AgentToolResult` shape pi-mono expects. `summary` is the short text the
 * gathering agent sees; `details` is structured metadata for traces.
 */
export interface ToolRunResult<TDetails = unknown> {
  summary: string;
  details?: TDetails;
}

/**
 * Define an `AgentTool` with shared boilerplate (timing, audit, error capture)
 * lifted into the wrapper. Tool body just does the work and returns a summary;
 * recordToolCall + try/catch + AgentToolResult shaping happen here.
 *
 * The wrapper:
 *  - times the call
 *  - records ok=true on success / ok=false with `error` on throw (then re-throws)
 *  - converts {summary, details} into the AgentToolResult content array
 */
export function defineTool<TParams extends TSchema, TDetails = unknown>(def: {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  ctx: InvestigationContext;
  run: (params: Static<TParams>, signal?: AbortSignal) => Promise<ToolRunResult<TDetails>>;
}): AgentTool<TParams, TDetails> {
  const execute = async (
    _toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<TDetails>> => {
    const t0 = Date.now();
    try {
      const { summary, details } = await def.run(params, signal);
      recordToolCall(def.ctx, { name: def.name, args: params, ok: true, ms: Date.now() - t0 });
      return {
        content: [{ type: "text", text: summary }],
        details: details as TDetails,
      };
    } catch (err) {
      recordToolCall(def.ctx, {
        name: def.name,
        args: params,
        ok: false,
        ms: Date.now() - t0,
        error: (err as Error).message,
      });
      throw err;
    } finally {
      // Pair with the bump in gather.ts:beforeToolCall. Decrement even on
      // throw so a failing tool doesn't leak budget against the inflight cap.
      if (def.ctx.inflight > 0) def.ctx.inflight--;
    }
  };

  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute,
  };
}
