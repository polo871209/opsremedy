
import type { InvestigationResult } from "../agent.ts";
import { userFacingError } from "../utils/model-error.ts";

function clean(s: string): string {
  return s.replace(/^\s*(?:[-*•]|\d+[.)]|[a-zA-Z][.)])\s+/, "").trim();
}

export function replyCard(text: string): unknown {
  return {
    schema: "2.0",
    // v2 only supports shared cards — `update_multi:true` is required.
    config: { update_multi: true, width_mode: "fill" },
    body: { elements: [{ tag: "markdown", content: text }] },
  };
}

export function progressCard(status: string): unknown {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "fill" },
    body: { elements: [{ tag: "markdown", content: `⏳ ${status}` }] },
  };
}

function collapsedPanel(title: string, lines: string[]): unknown {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: { tag: "markdown", content: `**${title}** (${lines.length})` },
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    elements: [{ tag: "markdown", content: lines.map((l) => `- ${clean(l)}`).join("\n") }],
  };
}

export function diagnosisCard(result: InvestigationResult): unknown {
  const d = result.diagnosis;
  if (!d) {
    return replyCard(
      `**Investigation stopped:** ${result.stopped}${result.error ? `\n${userFacingError(result.error)}` : ""}`,
    );
  }
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: `**Root cause** (${d.rootCauseCategory} · ${d.confidence} confidence)\n${d.rootCause}`,
    },
  ];
  if (d.evidence.length) elements.push(collapsedPanel("Evidence", d.evidence));
  if (d.remediationSteps?.length) elements.push(collapsedPanel("Remediation", d.remediationSteps));
  if (result.cost != null) {
    elements.push({
      tag: "markdown",
      content: `<font color='grey'>~$${result.cost.toFixed(3)} · ${result.turns} turns</font>`,
    });
  }
  return { schema: "2.0", config: { update_multi: true, width_mode: "fill" }, body: { elements } };
}
