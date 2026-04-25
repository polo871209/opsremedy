import { Agent } from "@mariozechner/pi-agent-core";
import { makeAllTools } from "@opsremedy/tools";
import { gatherSystemPrompt } from "./prompts.ts";
import type { InvestigationContext } from "./types.ts";
import { resolveModel } from "./util/model.ts";
import { ThinkingStream } from "./util/thinking.ts";
import { sumUsage, type UsageTotal } from "./util/usage.ts";

export interface GatherOptions {
  provider: string;
  model: string;
  /** Called for progress logging (e.g. tool starts/ends). Optional. */
  onEvent?: (kind: string, detail?: unknown) => void;
  /** Render LLM thinking on stderr. Default true. */
  displayThinking?: boolean;
}

/**
 * Phase 1 — run the gatherer agent until it stops calling tools.
 * Side effects: mutates ctx.evidence and ctx.tools_called via tool executions.
 * Returns aggregate token usage from this phase.
 */
export async function gatherEvidence(ctx: InvestigationContext, options: GatherOptions): Promise<UsageTotal> {
  const tools = makeAllTools(ctx);
  const model = resolveModel(options.provider, options.model);

  const agent = new Agent({
    initialState: {
      systemPrompt: gatherSystemPrompt(ctx.alert, ctx.max_tool_calls),
      model,
      thinkingLevel: "medium",
      tools,
    },
    toolExecution: "parallel",
    beforeToolCall: async () => {
      if (ctx.loop_count >= ctx.max_tool_calls) {
        return { block: true, reason: "Exceeded tool call budget" };
      }
    },
  });

  const thinking = new ThinkingStream({
    phase: "gather",
    display: options.displayThinking ?? true,
    ...(options.onEvent && { onEvent: options.onEvent }),
  });

  agent.subscribe(async (event) => {
    if (event.type === "message_update") {
      thinking.handleAssistantEvent(event.assistantMessageEvent);
    } else if (event.type === "tool_execution_start") {
      options.onEvent?.("tool_start", { name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      options.onEvent?.("tool_end", { toolCallId: event.toolCallId });
    } else if (event.type === "agent_end") {
      options.onEvent?.("gather_end");
    }
  });

  await agent.prompt(
    `Investigate the alert. Call tools to gather evidence. When you have enough, stop calling tools and reply with "READY_TO_DIAGNOSE" so the diagnosis agent can take over.`,
  );

  return sumUsage(agent.state.messages as never);
}
