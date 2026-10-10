import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Diagnosis } from "../diagnosis.ts";
import type { HandoffDoc } from "../harness/docs.ts";
import type { ThreadMeta } from "../harness/threads.ts";

type Formatter = (args: Record<string, unknown>) => string | undefined;
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const win = (a: Record<string, unknown>): string =>
  a.startTime || a.endTime ? ` [${s(a.startTime) ?? "window start"} .. ${s(a.endTime) ?? "window end"}]` : "";
const ns = (a: Record<string, unknown>, extra: string[]): string => {
  const parts = [`namespace=${s(a.namespace) ?? "*"}`];
  for (const k of extra) if (s(a[k])) parts.push(`${k}=${a[k]}`);
  return parts.join(" ");
};

export const QUERY_FORMATTERS: Record<string, Formatter> = {
  gcp_logging_query: (a) => s(a.filter),
  promql_instant: (a) => (s(a.query) ? `${a.query}${a.time ? ` @ ${a.time}` : ""}` : undefined),
  promql_range: (a) => (s(a.query) ? `${a.query}${a.step ? ` step=${a.step}` : ""}${win(a)}` : undefined),
  prom_list_metrics: (a) => (s(a.contains) ? `contains=${a.contains}` : undefined),
  prom_metric_metadata: (a) => (s(a.metric) ? `metric=${a.metric}` : undefined),
  prom_label_names: (a) => (Array.isArray(a.match) ? `match=${a.match.join(",")}` : undefined),
  prom_series: (a) => (Array.isArray(a.match) ? a.match.join(", ") : undefined),
  prom_label_values: (a) =>
    s(a.label) ? `label=${a.label}${Array.isArray(a.match) ? ` match=${a.match.join(",")}` : ""}` : undefined,
  jaeger_get_trace: (a) => (s(a.traceId) ? `traceId=${a.traceId}` : undefined),
  kafka_describe_group: (a) => (s(a.groupId) ? `groupId=${a.groupId}` : undefined),
  kafka_describe_topic: (a) => (s(a.topic) ? `topic=${a.topic}` : undefined),
  k8s_get_pods: (a) => ns(a, ["labelSelector", "fieldSelector"]),
  k8s_pod_logs: (a) =>
    s(a.namespace) && s(a.name)
      ? `${a.namespace}/${a.name}${a.container ? `:${a.container}` : ""}${a.previous ? " (previous)" : ""}`
      : undefined,
  k8s_get_events: (a) => ns(a, ["involvedObjectName", "type"]),
  k8s_get_deployments: (a) => ns(a, ["labelSelector"]),
  k8s_rollout_history: (a) => (s(a.namespace) && s(a.name) ? `${a.namespace}/${a.name}` : undefined),
  promql_movers: (a) =>
    s(a.fleet)
      ? `fleet=${a.fleet}${s(a.query) ? ` query=${a.query}` : ""} spike=[${s(a.spikeStart) ?? "?"} .. ${s(a.spikeEnd) ?? "?"}]`
      : undefined,
  kafka_list_groups: () => "all consumer groups",
  kafka_list_topics: () => "all topics",
};

export function formatToolQuery(tool: string, args: Record<string, unknown>): string | undefined {
  return QUERY_FORMATTERS[tool]?.(args);
}

function projectFromLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  try {
    return new URL(link).searchParams.get("project") ?? undefined;
  } catch {
    return undefined;
  }
}

type CliFormatter = (
  args: Record<string, unknown>,
  ctx: { project?: string; alertStartedAt?: string; alertEndedAt?: string },
) => string | undefined;
const CLI_FORMATTERS: Record<string, CliFormatter> = {
  gcp_logging_query: (a, ctx) => {
    const filter = s(a.filter);
    if (!filter) return undefined;
    const start = s(a.startTime) ?? ctx.alertStartedAt;
    const end = s(a.endTime) ?? ctx.alertEndedAt;
    const bounds = start && end ? ` AND timestamp>="${start}" AND timestamp<"${end}"` : "";
    const proj = ctx.project ? ` --project=${ctx.project}` : "";
    return `gcloud logging read '${filter}${bounds}' --order=desc --limit=20${proj}`;
  },
  promql_instant: (a, ctx) => {
    const query = s(a.query);
    if (!query) return undefined;
    const time = s(a.time) ?? ctx.alertEndedAt;
    const timeArg = time ? ` --data-urlencode "time=${time}"` : "";
    return `curl -sG "$PROM/api/v1/query" --data-urlencode "query=${query}"${timeArg}`;
  },
  promql_range: (a, ctx) => {
    const query = s(a.query);
    if (!query) return undefined;
    const start = s(a.startTime) ?? ctx.alertStartedAt;
    const end = s(a.endTime) ?? ctx.alertEndedAt;
    const step = s(a.step) ?? "30s";
    const range = start && end ? ` --data-urlencode "start=${start}" --data-urlencode "end=${end}"` : "";
    return `curl -sG "$PROM/api/v1/query_range" --data-urlencode "query=${query}"${range} --data-urlencode "step=${step}"`;
  },
};

function firstText(result: ToolResultMessage | undefined): string | undefined {
  const first = result?.content[0];
  return first?.type === "text" ? first.text : undefined;
}

function logsExplorerLink(result: ToolResultMessage | undefined): string | undefined {
  return firstText(result)?.match(/^Logs Explorer: (\S+)/m)?.[1];
}

const MAX_EVIDENCE = 30;

interface Evidence {
  tool: string;
  query: string;
  link?: string;
  cli?: string;
}

function toolResultFor(messages: Message[], fromIndex: number, toolCallId: string): ToolResultMessage | undefined {
  for (let j = fromIndex; j < messages.length; j++) {
    const m = messages[j];
    if (m?.role === "toolResult" && m.toolCallId === toolCallId) return m;
  }
  return undefined;
}

function collectEvidence(
  messages: Message[],
  alertWindow: { alertStartedAt?: string; alertEndedAt?: string },
): { evidence: Evidence[]; totalCalls: number } {
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  let totalCalls = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    for (const tc of m.content) {
      if (tc.type !== "toolCall") continue;
      totalCalls++;
      const query = formatToolQuery(tc.name, tc.arguments);
      if (!query) continue;
      const key = `${tc.name}\u0000${query}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const link =
        tc.name === "gcp_logging_query" ? logsExplorerLink(toolResultFor(messages, i + 1, tc.id)) : undefined;
      const cli = CLI_FORMATTERS[tc.name]?.(tc.arguments, { project: projectFromLink(link), ...alertWindow });
      evidence.push({ tool: tc.name, query, link, cli });
    }
  }
  return { evidence, totalCalls };
}

function acceptedDiagnosis(messages: Message[]): Diagnosis | undefined {
  let found: Diagnosis | undefined;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    for (const tc of m.content) {
      if (tc.type !== "toolCall") continue;
      if (tc.name !== "submit_diagnosis") continue;
      const result = toolResultFor(messages, i + 1, tc.id);
      if (result && !result.isError) found = tc.arguments as Diagnosis;
    }
  }
  return found;
}

function lastAssistantText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const txt = m.content
      .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
      .join("\n")
      .trim();
    if (txt) return txt;
  }
  return undefined;
}

function renderEvidence(evidence: Evidence[], totalCalls: number): string[] {
  const shown = evidence.slice(0, MAX_EVIDENCE);
  const byTool = new Map<string, Evidence[]>();
  for (const e of shown) {
    if (!byTool.has(e.tool)) byTool.set(e.tool, []);
    byTool.get(e.tool)!.push(e);
  }
  const lines: string[] = [
    `${evidence.length} distinct quer${evidence.length === 1 ? "y" : "ies"} across ${totalCalls} tool calls this session.`,
    "",
  ];
  byTool.forEach((items, tool) => {
    lines.push(`**${tool}**`);
    for (const e of items) {
      lines.push(e.link ? `- \`${e.query}\` — ${e.link}` : `- \`${e.query}\``);
      if (e.cli) lines.push(`  \`${e.cli}\``);
    }
  });
  if (evidence.length > shown.length)
    lines.push(`\n_${evidence.length - shown.length} more — see full transcript below._`);
  return lines;
}

function nestHeadings(md: string): string {
  let fenced = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : line.replace(/^#{1,6}[ \t]+/, "### ");
    })
    .join("\n");
}

function renderCompiled(doc: HandoffDoc, messageCount: number): string[] {
  const at = new Date(doc.compiledAt).toISOString();
  const stale =
    doc.messageCount < messageCount ? `, ${messageCount - doc.messageCount} later messages not included` : "";
  return [
    "## Findings",
    "",
    `_Compiled ${at} from ${doc.messageCount} thread messages${stale}._` +
      (doc.focus ? ` _Focus requested: ${doc.focus}_` : "") +
      (doc.partial ? " _The investigation was still running, so these findings are partial._" : ""),
    "",
    nestHeadings(doc.markdown.trim()),
    "",
  ];
}

export function buildHandoffMarkdown(
  threadKey: string,
  meta: ThreadMeta,
  messages: Message[],
  rawSessionUrl?: string,
  compiled?: HandoffDoc,
): string {
  const diagnosis = acceptedDiagnosis(messages);
  const fallbackText = diagnosis || compiled ? undefined : lastAssistantText(messages);

  const lines: string[] = [];
  lines.push(`# Handoff: ${meta.alertName}`);
  lines.push("");
  lines.push(
    `Session \`${threadKey}\` · started ${meta.alertStartedAt ?? "unknown"}` +
      (meta.alertEndedAt ? ` · ended ${meta.alertEndedAt}` : " · still open"),
  );
  lines.push("");

  if (compiled) lines.push(...renderCompiled(compiled, messages.length));

  if (diagnosis) {
    lines.push(
      `## Diagnosis submitted in-thread (${diagnosis.rootCauseCategory} · ${diagnosis.confidence} confidence)`,
    );
    lines.push("");
    lines.push(diagnosis.rootCause);
    lines.push("");
    if (diagnosis.evidence.length) {
      lines.push("**Evidence**");
      lines.push(...diagnosis.evidence.map((e) => `- ${e}`));
      lines.push("");
    }
    if (diagnosis.remediationSteps?.length) {
      lines.push("**Suggested remediation**");
      lines.push(...diagnosis.remediationSteps.map((st) => `- ${st}`));
      lines.push("");
    }
  } else {
    lines.push("## Status");
    lines.push("");
    if (fallbackText) {
      lines.push("No diagnosis submitted yet. Last agent output:");
      lines.push("");
      lines.push(`> ${fallbackText.replace(/\n/g, "\n> ")}`);
    } else if (compiled) {
      lines.push("No diagnosis card landed for this alert. The findings above hold the conclusions.");
    } else {
      lines.push("No diagnosis submitted; investigation may have errored or is still running.");
    }
    lines.push("");
  }

  const { evidence, totalCalls } = collectEvidence(messages, {
    alertStartedAt: meta.alertStartedAt,
    alertEndedAt: meta.alertEndedAt,
  });
  if (evidence.length) {
    lines.push("## Evidence gathered — exact queries this session ran");
    lines.push("");
    lines.push(
      "Cite as-is, or re-run directly — gcp_logging_query / promql_* calls include a ready-to-paste CLI command " +
        "(gcloud logging read / curl $PROM). These are the concrete basis for the diagnosis above, not a paraphrase.",
    );
    lines.push("");
    lines.push(...renderEvidence(evidence, totalCalls));
    lines.push("");
  }

  lines.push("## Full transcript");
  lines.push("");
  lines.push(
    rawSessionUrl
      ? `Raw tool calls + results (JSON): ${rawSessionUrl}`
      : "Raw session dump unavailable (OPSREMEDY_SESSION_SECRET not set).",
  );
  lines.push("");

  return lines.join("\n");
}
