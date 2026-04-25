import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { InvestigationContext } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";
import { recordToolCall } from "./shared.ts";

export function makeProposeRemediationTool(ctx: InvestigationContext): AgentTool {
  return defineTool({
    name: "propose_remediation",
    label: "Propose remediation (dry-run)",
    description:
      "Record a remediation suggestion (kubectl command or yaml patch). " +
      "This tool NEVER executes anything. Use it to capture proposed fixes you want in the final report. " +
      "Include a clear description, the exact command a human could run, and a risk tier.",
    parameters: Type.Object({
      description: Type.String({ description: "One-line explanation of what this fixes." }),
      command: Type.Optional(
        Type.String({
          description:
            "Exact kubectl command or yaml patch. May be empty when the suggestion is organizational.",
        }),
      ),
      risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    }),
    execute: async (_toolCallId, params) => {
      const t0 = Date.now();
      const list = ctx.evidence.remediation_proposals ?? [];
      list.push({
        description: params.description,
        ...(params.command !== undefined && { command: params.command }),
        risk: params.risk,
      });
      ctx.evidence.remediation_proposals = list;
      recordToolCall(ctx, {
        name: "propose_remediation",
        args: params,
        ok: true,
        ms: Date.now() - t0,
      });
      return {
        content: [{ type: "text", text: `Recorded remediation: ${params.description}` }],
        details: { count: list.length },
      };
    },
  });
}
