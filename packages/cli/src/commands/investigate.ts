import { readFileSync, writeFileSync } from "node:fs";
import { type Alert, type RCAReport, runInvestigation, TraceWriter } from "@opsremedy/core";
import { buildRcaCard, buildSendUuid, type LarkConfig, sendLarkCard, shouldSend } from "@opsremedy/notify";
import pc from "picocolors";
import { CliError, type CliOptions } from "../args.ts";
import { bootstrapRealClients } from "../bootstrap.ts";
import { fetchAlertFromGcp, parseGcpAlertUrl } from "../gcp-alert.ts";
import { renderMarkdown } from "../markdown.ts";

const SUPPRESSED_EVENTS = new Set(["tool_end"]);

function logEvent(kind: string, detail?: unknown): void {
  const line = `[${kind}]${detail ? ` ${JSON.stringify(detail)}` : ""}`;
  process.stderr.write(`${pc.gray(line)}\n`);
}

export async function cmdInvestigate(opts: CliOptions): Promise<void> {
  const input = typeof opts.input === "string" ? opts.input : undefined;
  const url = typeof opts.url === "string" ? opts.url : undefined;
  if (!input && !url) throw new CliError("Missing -i <alert.json> or --url <gcp-monitoring-url>");
  if (input && url) throw new CliError("Pass either -i or --url, not both");

  const { alert, alertUrl } = await loadAlert(input, url);
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
        if (!kind.startsWith("thinking_") && !SUPPRESSED_EVENTS.has(kind)) logEvent(kind, detail);
        trace?.write(kind, detail);
      },
    });

    trace?.write("report", report);
    console.log(JSON.stringify(report, null, 2));
    writeMarkdown(opts, report);
    logUsage(report, tracePath);
    await maybeSendLark(report, alert, settings.lark, opts, alertUrl);
  } finally {
    trace?.close();
  }
}

async function loadAlert(
  input: string | undefined,
  url: string | undefined,
): Promise<{ alert: Alert; alertUrl?: string }> {
  if (input) return { alert: JSON.parse(readFileSync(input, "utf8")) as Alert };

  const alertUrl = url as string;
  const parsed = parseGcpAlertUrl(alertUrl);
  console.error(`[fetch] GCP ${parsed.kind} ${parsed.id} in ${parsed.projectId}...`);
  const alert = await fetchAlertFromGcp(parsed);
  console.error(`[fetch] alert: ${alert.alert_name} severity=${alert.severity}`);
  return { alert, alertUrl };
}

function writeMarkdown(opts: CliOptions, report: RCAReport): void {
  if (typeof opts.markdown !== "string") return;
  writeFileSync(opts.markdown, renderMarkdown(report));
  console.error(`[markdown] wrote ${opts.markdown}`);
}

function logUsage(report: RCAReport, tracePath: string | undefined): void {
  console.error(
    `[usage] ${report.usage.total_tokens} tokens (in=${report.usage.input_tokens} out=${report.usage.output_tokens} cacheR=${report.usage.cache_read_tokens}) cost=$${report.usage.cost_usd.toFixed(4)} duration=${report.duration_ms}ms`,
  );
  if (tracePath) console.error(`[trace] wrote ${tracePath}`);
}

async function maybeSendLark(
  report: RCAReport,
  alert: Alert,
  lark: LarkConfig | undefined,
  opts: CliOptions,
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
    const res = await sendLarkCard(lark, card, buildSendUuid(alert.alert_id));
    console.error(`[lark] sent message_id=${res.messageId}`);
  } catch (e) {
    console.error(`[lark] error: ${(e as Error).message}`);
  }
}
