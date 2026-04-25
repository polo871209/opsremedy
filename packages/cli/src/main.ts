#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { runBench } from "@opsremedy/bench";
import { type Alert, runInvestigation, TraceWriter } from "@opsremedy/core";
import { bootstrapAuth, bootstrapRealClients } from "./bootstrap.ts";
import { fetchAlertFromGcp, parseGcpAlertUrl } from "./gcp-alert.ts";
import { runOnboard } from "./onboard.ts";

function usage(): never {
  console.error(
    [
      "opsremedy onboard",
      "opsremedy investigate (-i <alert.json> | --url <gcp-monitoring-url>) [--markdown <path>] [--trace <path>] [--max-tool-calls N]",
      "opsremedy bench [--scenario <id>] [--json]",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string | boolean> } {
  const [, , cmd, ...rest] = argv;
  if (!cmd) usage();
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg === "-i") {
      const value = rest[i + 1];
      if (!value) usage();
      opts.input = value;
      i++;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("-")) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    }
  }
  return { cmd, opts };
}

async function cmdInvestigate(opts: Record<string, string | boolean>): Promise<void> {
  const input = typeof opts.input === "string" ? opts.input : undefined;
  const url = typeof opts.url === "string" ? opts.url : undefined;
  if (!input && !url) {
    console.error("Missing -i <alert.json> or --url <gcp-monitoring-url>");
    process.exit(2);
  }
  if (input && url) {
    console.error("Pass either -i or --url, not both");
    process.exit(2);
  }

  let alert: Alert;
  if (input) {
    alert = JSON.parse(readFileSync(input, "utf8")) as Alert;
  } else {
    try {
      const parsed = parseGcpAlertUrl(url as string);
      console.error(`[fetch] GCP ${parsed.kind} ${parsed.id} in ${parsed.projectId}...`);
      alert = await fetchAlertFromGcp(parsed);
      console.error(`[fetch] alert: ${alert.alert_name} severity=${alert.severity}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  }

  const maxToolCalls =
    typeof opts["max-tool-calls"] === "string" ? Number(opts["max-tool-calls"]) : undefined;

  let settings: Awaited<ReturnType<typeof bootstrapRealClients>>["settings"];
  try {
    settings = (await bootstrapRealClients()).settings;
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  const tracePath = typeof opts.trace === "string" ? opts.trace : undefined;
  const trace = tracePath ? new TraceWriter(tracePath) : undefined;
  trace?.write("alert", alert);

  try {
    const report = await runInvestigation(alert, {
      provider: settings.llm.provider,
      model: settings.llm.model,
      max_tool_calls:
        maxToolCalls !== undefined && !Number.isNaN(maxToolCalls)
          ? maxToolCalls
          : settings.agent.maxToolCalls,
      onEvent: (kind, detail) => {
        console.error(`[${kind}]${detail ? ` ${JSON.stringify(detail)}` : ""}`);
        trace?.write(kind, detail);
      },
    });

    trace?.write("report", report);

    const json = JSON.stringify(report, null, 2);
    console.log(json);

    if (typeof opts.markdown === "string") {
      writeFileSync(opts.markdown, renderMarkdown(report));
      console.error(`[markdown] wrote ${opts.markdown}`);
    }

    console.error(
      `[usage] ${report.usage.total_tokens} tokens (in=${report.usage.input_tokens} out=${report.usage.output_tokens} cacheR=${report.usage.cache_read_tokens}) cost=$${report.usage.cost_usd.toFixed(4)} duration=${report.duration_ms}ms`,
    );
    if (tracePath) console.error(`[trace] wrote ${tracePath}`);
  } finally {
    trace?.close();
  }
}

async function cmdBench(opts: Record<string, string | boolean>): Promise<void> {
  const scenario = typeof opts.scenario === "string" ? opts.scenario : undefined;
  const asJson = opts.json === true;

  let settings: Awaited<ReturnType<typeof bootstrapAuth>>["settings"];
  try {
    settings = (await bootstrapAuth()).settings;
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  const result = await runBench({
    ...(scenario !== undefined && { scenario }),
    asJson,
    provider: settings.llm.provider,
    model: settings.llm.model,
  });
  process.exit(result.allPassed ? 0 : 1);
}

function renderMarkdown(report: Awaited<ReturnType<typeof runInvestigation>>): string {
  const lines: string[] = [];
  lines.push(`# Incident Report — ${report.alert_id}\n`);
  lines.push(`**Category:** ${report.root_cause_category}  `);
  lines.push(`**Confidence:** ${(report.confidence * 100).toFixed(0)}%  `);
  lines.push(`**Duration:** ${report.duration_ms}ms  `);
  lines.push(
    `**Tokens:** ${report.usage.total_tokens} (in=${report.usage.input_tokens}, out=${report.usage.output_tokens}, cacheR=${report.usage.cache_read_tokens})  `,
  );
  lines.push(`**Cost:** $${report.usage.cost_usd.toFixed(4)}\n`);
  lines.push("## Root cause\n");
  lines.push(`${report.root_cause}\n`);
  lines.push("## Causal chain\n");
  report.causal_chain.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });
  lines.push("\n## Validated claims\n");
  for (const c of report.validated_claims) {
    lines.push(`- ${c.claim} _(sources: ${c.evidence_sources.join(", ") || "—"})_`);
  }
  if (report.unverified_claims.length > 0) {
    lines.push("\n## Unverified claims\n");
    for (const c of report.unverified_claims) lines.push(`- ${c}`);
  }
  if (report.remediation.length > 0) {
    lines.push("\n## Remediation (dry-run)\n");
    for (const r of report.remediation) {
      lines.push(`### ${r.description} _(risk: ${r.risk})_`);
      if (r.command) lines.push(`\`\`\`\n${r.command}\n\`\`\``);
    }
  }
  lines.push("\n## Tools called\n");
  lines.push(report.tools_called.join(", ") || "(none)");
  return lines.join("\n");
}

const { cmd, opts } = parseArgs(process.argv);
switch (cmd) {
  case "onboard":
    await runOnboard();
    break;
  case "investigate":
    await cmdInvestigate(opts);
    break;
  case "bench":
    await cmdBench(opts);
    break;
  default:
    usage();
}
