import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static, TSchema } from "typebox";

/**
 * Helper: build an `AgentTool` while keeping full TypeBox parameter inference.
 * Without this helper, explicit type annotations on tools collapse `params` to `unknown`.
 */
export function defineTool<TParams extends TSchema, TDetails = unknown>(def: {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  execute: (
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<TDetails>>;
}): AgentTool<TParams, TDetails> {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute: def.execute,
  };
}
