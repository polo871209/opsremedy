import { Agent } from "@mariozechner/pi-agent-core";
import { makeAllTools } from "@opsremedy/tools";
import { emitInvestigationEvent, type InvestigationEventSink } from "./events.ts";
import { missingRequiredPlannedTools, planGatherTools } from "./planner.ts";
import { gatherSystemPrompt } from "./prompts.ts";
import type { InvestigationContext } from "./types.ts";
import { resolveModel } from "./util/model.ts";
import { ThinkingStream } from "./util/thinking.ts";
import { sumUsage, type UsageTotal } from "./util/usage.ts";

/**
 * Pre-tool-call budget gate. Returns the pi-mono `block` shape when no slot
 * is available, otherwise reserves a slot by bumping `inflight` and returns
 * undefined. The companion decrement lives in `tools/define.ts`.
 *
 * Exported so tests can exercise the parallel-execution edge case where N
 * concurrent calls would otherwise all squeeze past a single remaining slot.
 */
export function reserveToolCallSlot(ctx: InvestigationContext): { block: true; reason: string } | undefined {
  if (ctx.loop_count + ctx.inflight >= ctx.max_tool_calls) {
    return { block: true, reason: "Exceeded tool call budget" };
  }
  ctx.inflight++;
  return undefined;
}

export function reserveToolCallSlotWithRequiredEvidence(
  ctx: InvestigationContext,
  toolName: string,
): { block: true; reason: string } | undefined {
  const missing = missingRequiredPlannedTools(
    ctx.alert,
    ctx.tools_called.map((tool) => tool.name),
  );
  if (missing.some((entry) => entry.tool === toolName)) return reserveToolCallSlot(ctx);

  const remainingSlots = ctx.max_tool_calls - ctx.loop_count - ctx.inflight;
  if (missing.length > 0 && remainingSlots <= missing.length) {
    return {
      block: true,
      reason: `Tool budget reserved for missing evidence: ${missing.map((entry) => entry.tool).join(", ")}`,
    };
  }
  return reserveToolCallSlot(ctx);
}

export interface GatherOptions {
  provider: string;
  model: string;
  /** Called for progress logging (e.g. tool starts/ends). Optional. */
  onEvent?: InvestigationEventSink;
  /** Render LLM thinking on stderr. Default true. */
  displayThinking?: boolean;
  /**
   * Optional hint injected into the user prompt for reroute passes (loop>0).
   * Carries a focused checklist of what to fetch next, derived in code from
   * gaps in the first-pass evidence. Ignored when empty.
   */
  rerouteHint?: string;
}

/**
 * Phase 1 — run the gatherer agent until it stops calling tools.
 * Side effects: mutates ctx.evidence and ctx.tools_called via tool executions.
 * Returns aggregate token usage from this phase.
 */
export async function gatherEvidence(ctx: InvestigationContext, options: GatherOptions): Promise<UsageTotal> {
  const plan = planGatherTools(ctx.alert, ctx.loop, options.rerouteHint);
  ctx.plan_audit.push(plan);
  emitInvestigationEvent(options.onEvent, "tool_plan", plan);

  const tools = makeAllTools(
    ctx,
    plan.selectedTools.map((entry) => entry.tool),
  );
  const model = resolveModel(options.provider, options.model);

  const agent = new Agent({
    initialState: {
      systemPrompt: gatherSystemPrompt(ctx.alert, ctx.max_tool_calls),
      model,
      thinkingLevel: "medium",
      tools,
    },
    toolExecution: "parallel",
    beforeToolCall: async (toolContext) => {
      return reserveToolCallSlotWithRequiredEvidence(ctx, toolContext.toolCall.name);
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
      emitInvestigationEvent(options.onEvent, "tool_started", { name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      options.onEvent?.("tool_end", { toolCallId: event.toolCallId });
      emitInvestigationEvent(options.onEvent, "tool_finished", { toolCallId: event.toolCallId });
    } else if (event.type === "agent_end") {
      options.onEvent?.("gather_end");
    }
  });

  const planText = plan.selectedTools.map((entry) => `- ${entry.tool}: ${entry.reason}`).join("\n");
  const baseInstruction = `Investigate the alert. Call tools to gather evidence.

Deterministic tool plan:
${planText}

Use the plan as the preferred evidence checklist. For metric/rate/latency alerts, fetch Prometheus range evidence before stopping unless another tool proves the metric is irrelevant. When you have enough, stop calling tools and reply with "READY_TO_DIAGNOSE" so the diagnosis agent can take over.`;
  const userPrompt = options.rerouteHint
    ? `${baseInstruction}

The first investigation pass was inconclusive. Targeted follow-up:
${options.rerouteHint}

Use the existing evidence; do NOT re-run tool calls that already returned data. Focus on the gaps above.`
    : baseInstruction;

  await agent.prompt(userPrompt);

  const missing = missingRequiredPlannedTools(
    ctx.alert,
    ctx.tools_called.map((tool) => tool.name),
  );
  if (missing.length > 0 && ctx.loop_count + ctx.inflight < ctx.max_tool_calls) {
    await agent.prompt(
      `Required planned evidence is still missing: ${missing.map((entry) => `${entry.tool} (${entry.reason})`).join(", ")}. Call the missing tool(s) now, then reply READY_TO_DIAGNOSE.`,
    );
  }

  return sumUsage(agent.state.messages as never);
}
