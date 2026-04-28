import type { RCAReport } from "@opsremedy/core";

export function renderMarkdown(report: RCAReport): string {
  const lines = [
    `# Incident Report — ${report.alert_id}\n`,
    `**Category:** ${report.root_cause_category}  `,
    `**Confidence:** ${(report.confidence * 100).toFixed(0)}%  `,
    `**Duration:** ${report.duration_ms}ms  `,
    `**Tokens:** ${report.usage.total_tokens} (in=${report.usage.input_tokens}, out=${report.usage.output_tokens}, cacheR=${report.usage.cache_read_tokens})  `,
    `**Cost:** $${report.usage.cost_usd.toFixed(4)}\n`,
    "## Root cause\n",
    `${report.root_cause}\n`,
    "## Causal chain\n",
    ...report.causal_chain.map((step, i) => `${i + 1}. ${step}`),
    "\n## Validated claims\n",
    ...report.validated_claims.map(
      (claim) => `- ${claim.claim} _(sources: ${claim.evidence_sources.join(", ") || "—"})_`,
    ),
  ];

  if (report.unverified_claims.length > 0) {
    lines.push("\n## Unverified claims\n", ...report.unverified_claims.map((claim) => `- ${claim}`));
  }

  if (report.remediation.length > 0) {
    lines.push("\n## Remediation (dry-run)\n");
    for (const item of report.remediation) {
      lines.push(`### ${item.description} _(risk: ${item.risk})_`);
      if (item.command) lines.push(`\`\`\`\n${item.command}\n\`\`\``);
    }
  }

  lines.push("\n## Tools called\n", report.tools_called.join(", ") || "(none)");
  return lines.join("\n");
}
