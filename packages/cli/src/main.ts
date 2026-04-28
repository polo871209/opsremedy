#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { runBench } from "@opsremedy/bench";
import { type Alert, type RCAReport, runInvestigation, TraceWriter } from "@opsremedy/core";
import { buildRcaCard, buildSendUuid, type LarkConfig, sendLarkCard, shouldSend } from "@opsremedy/notify";
import pc from "picocolors";
import { bootstrapAuth, bootstrapRealClients } from "./bootstrap.ts";
import { fetchAlertFromGcp, parseGcpAlertUrl } from "./gcp-alert.ts";
import { runOnboard } from "./onboard/index.ts";

/**
 * Suppress noisy events. tool_end is omitted because tool_start already shows
 * the call; the trailing toolCallId line adds no information for humans.
 */
const SUPPRESSED_EVENTS = new Set(["tool_end"]);

/**
 * Write an event line to stderr with explicit gray foreground. Sets an ANSI
 * foreground so terminals that auto-tint stderr (stderred / iTerm2 profiles)
 * don't override it to red.
 */
function logEvent(kind: string, detail?: unknown): void {
  const line = `[${kind}]${detail ? ` ${JSON.stringify(detail)}` : ""}`;
  process.stderr.write(`${pc.gray(line)}\n`);
}

/** Throw to exit cleanly from a command handler. Caught by the dispatcher. */
class CliError extends Error {
  constructor(
    message: string,
    public readonly code: number = 2,
  ) {
    super(message);
  }
}

const USAGE = [
  "opsremedy onboard",
  "opsremedy investigate (-i <alert.json> | --url <gcp-monitoring-url>) [--markdown <path>] [--trace <path>] [--max-tool-calls N] [--quiet] [--lark | --no-lark]",
  "opsremedy bench [--scenario <id>] [--json] [--quiet]",
].join("\n");

/** Long-option flags that always take a value (`--name VALUE`). */
const VALUE_FLAGS = new Set(["url", "markdown", "trace", "max-tool-calls", "scenario"]);
/** Long-option flags that never take a value (`--name`). */
const BOOL_FLAGS = new Set(["json", "quiet", "lark", "no-lark"]);

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string | boolean> } {
  const [, , cmd, ...rest] = argv;
  if (!cmd) throw new CliError(USAGE);
  const opts: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;

    if (arg === "-i") {
      const value = rest[i + 1];
      if (!value) throw new CliError(`-i requires a path argument\n${USAGE}`);
      opts.input = value;
      i++;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new CliError(`Unexpected argument: ${arg}\n${USAGE}`);
    }
    const key = arg.slice(2);

    if (BOOL_FLAGS.has(key)) {
      opts[key] = true;
      continue;
    }
    if (VALUE_FLAGS.has(key)) {
      const value = rest[i + 1];
      if (value === undefined) throw new CliError(`--${key} requires a value\n${USAGE}`);
      opts[key] = value;
      i++;
      continue;
    }
    throw new CliError(`Unknown flag: --${key}\n${USAGE}`);
  }
  return { cmd, opts };
}

async function cmdInvestigate(opts: Record<string, string | boolean>): Promise<void> {
  const input = typeof opts.input === "string" ? opts.input : undefined;
  const url = typeof opts.url === "string" ? opts.url : undefined;
  if (!input && !url) {
    throw new CliError("Missing -i <alert.json> or --url <gcp-monitoring-url>");
  }
  if (input && url) {
    throw new CliError("Pass either -i or --url, not both");
  }

  let alert: Alert;
  let alertUrl: string | undefined;
  if (input) {
    alert = JSON.parse(readFileSync(input, "utf8")) as Alert;
  } else {
    alertUrl = url as string;
    const parsed = parseGcpAlertUrl(alertUrl);
    console.error(`[fetch] GCP ${parsed.kind} ${parsed.id} in ${parsed.projectId}...`);
    alert = await fetchAlertFromGcp(parsed);
    console.error(`[fetch] alert: ${alert.alert_name} severity=${alert.severity}`);
  }

  const maxToolCalls =
    typeof opts["max-tool-calls"] === "string" ? Number(opts["max-tool-calls"]) : undefined;
  const quiet = opts.quiet === true;

  const { settings } = await bootstrapRealClients();

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
      displayThinking: !quiet,
      onEvent: (kind, detail) => {
        // Thinking events are rendered by ThinkingStream itself; only persist them.
        if (!kind.startsWith("thinking_") && !SUPPRESSED_EVENTS.has(kind)) {
          logEvent(kind, detail);
        }
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

    await maybeSendLark(report, alert, settings.lark, opts, alertUrl);
  } finally {
    trace?.close();
  }
}

/**
 * Push the report to Lark when configured + policy allows. Failures here
 * never bubble up to fail the investigation; they're logged only.
 */
async function maybeSendLark(
  report: RCAReport,
  alert: Alert,
  lark: LarkConfig | undefined,
  opts: Record<string, string | boolean>,
  alertUrl: string | undefined,
): Promise<void> {
  if (opts["no-lark"] === true) {
    console.error("[lark] skipped (--no-lark)");
    return;
  }
  if (!lark) {
    console.error("[lark] not configured; run `opsremedy onboard` to enable");
    return;
  }
  if (opts.lark !== true && !shouldSend(report, lark.sendOn, lark)) {
    console.error(`[lark] skipped (policy=${lark.sendOn}, category=${report.root_cause_category})`);
    return;
  }
  console.error(`[lark] sending card (policy=${lark.sendOn}, receive=${lark.receiveId})...`);
  try {
    const card = buildRcaCard(report, alert, {
      ...(alertUrl !== undefined && { alertUrl }),
      evidenceLinks: report.evidence_links ?? {},
    });
    const uuid = buildSendUuid(alert.alert_id);
    const res = await sendLarkCard(lark, card, uuid);
    console.error(`[lark] sent message_id=${res.messageId}`);
  } catch (e) {
    console.error(`[lark] error: ${(e as Error).message}`);
  }
}

async function cmdBench(opts: Record<string, string | boolean>): Promise<void> {
  const scenario = typeof opts.scenario === "string" ? opts.scenario : undefined;
  const asJson = opts.json === true;
  const quiet = opts.quiet === true;

  const { settings } = await bootstrapAuth();

  const result = await runBench({
    ...(scenario !== undefined && { scenario }),
    asJson,
    provider: settings.llm.provider,
    model: settings.llm.model,
    displayThinking: !quiet && !asJson,
  });
  if (!result.allPassed) throw new CliError("bench failures", 1);
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

async function dispatch(): Promise<void> {
  const { cmd, opts } = parseArgs(process.argv);
  switch (cmd) {
    case "onboard":
      await runOnboard();
      return;
    case "investigate":
      await cmdInvestigate(opts);
      return;
    case "bench":
      await cmdBench(opts);
      return;
    default:
      throw new CliError(USAGE);
  }
}

try {
  await dispatch();
} catch (err) {
  if (err instanceof CliError) {
    console.error(err.message);
    process.exit(err.code);
  }
  console.error((err as Error).message);
  process.exit(1);
}
