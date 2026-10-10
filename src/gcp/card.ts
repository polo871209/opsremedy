
import type { Incident } from "./incident.ts";
import { findSubject, rewriteLinkTimeRange } from "./incident.ts";
import type { AlertGroup } from "../session/store.ts";
import { state as appState } from "../state.ts";

export function formatCardTime(epochSeconds: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date(epochSeconds * 1000))
      .map((p) => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : String(parts.timeZoneName).replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`;
}

function writeLabels(lines: string[], labels: Record<string, string> | undefined, skipKey?: string) {
  if (!labels) return;
  const keys = Object.keys(labels)
    .filter((k) => k !== skipKey)
    .sort();
  for (const k of keys) lines.push(`**${k}:** ${labels[k]}`);
}

function severityStyle(severity: string, closed: boolean): { template: string; tagColor: string } {
  if (closed) return { template: "green", tagColor: "green" };
  const s = severity.toLowerCase();
  if (s.includes("critical") || s.includes("error")) return { template: "red", tagColor: "red" };
  if (s.includes("warn")) return { template: "orange", tagColor: "orange" };
  if (s.includes("info")) return { template: "blue", tagColor: "blue" };
  return { template: "red", tagColor: "neutral" };
}

function textTag(content: string, color: string): unknown {
  return { tag: "text_tag", text: { tag: "plain_text", content }, color };
}

export function buildAlertCard(inc: Incident, sessionUrl?: string, group?: AlertGroup): unknown {
  const state = (inc.state ?? "").toUpperCase();
  const closed = inc.state === "closed";
  const severity = inc.severity || "No severity";
  const style = severityStyle(severity, closed);
  const title = `[${state}] ${inc.policy_name}`;

  const subj = findSubject(inc);
  const isLogAlert = !inc.metric?.type;

  const tags: unknown[] = [textTag(severity, style.tagColor)];
  tags.push(textTag(isLogAlert ? "Log" : "Metric", "turquoise"));

  const info: string[] = [];
  if (subj) info.push(`🎯 **${subj.display}:** \`${subj.value}\``, "");
  if (inc.condition_name) info.push(`**Condition:** ${inc.condition_name}`);
  if (inc.resource_type_display_name || inc.resource_display_name) {
    info.push(`**Resource:** ${inc.resource_type_display_name ?? ""} - ${inc.resource_display_name ?? ""}`);
  }
  if (inc.scoping_project_id) info.push(`**Project:** ${inc.scoping_project_id}`);
  const tz = appState().cfg.timezone;
  if (inc.started_at) info.push(`**Started:** ${formatCardTime(inc.started_at, tz)}`);
  if (inc.ended_at) info.push(`**Ended:** ${formatCardTime(inc.ended_at, tz)}`);
  if (group && group.opens > 1) {
    const since = Date.parse(group.firstOpenedAt);
    const first = Number.isNaN(since) ? "" : ` since ${formatCardTime(since / 1000, tz)}`;
    info.push(`**Re-opened:** ${group.opens}\u00d7${first}`);
  }

  const metric: string[] = [];
  if (isLogAlert) {
    writeLabels(metric, inc.resource?.labels, subj?.key);
  } else {
    metric.push(`**Metric:** ${inc.metric?.type}`);
    if (inc.observed_value) metric.push(`**Observed:** ${inc.observed_value}`);
    if (inc.threshold_value) metric.push(`**Threshold:** ${inc.threshold_value}`);
    writeLabels(metric, inc.metric?.labels, subj?.key);
  }

  const hr = { tag: "hr", margin: "4px 0" };
  const elements: unknown[] = [{ tag: "markdown", content: info.join("\n") }, hr];
  if (metric.length) {
    elements.push({ tag: "markdown", content: metric.join("\n") }, hr);
  }
  const doc = inc.documentation?.content || inc.summary;
  if (doc) {
    elements.push({ tag: "markdown", content: doc }, hr);
  }

  const buttons: unknown[] = [];
  if (inc.url) {
    buttons.push(v2Button("View Incident", inc.url, "primary"));
  }
  if (sessionUrl) {
    buttons.push(v2Button("Session", sessionUrl, "default"));
  }
  // Real GCP webhook ships PascalCase (`DisplayName`, `URL`); docs claim
  // camelCase; REST API uses camelCase; we accept all three.
  for (const link of inc.documentation?.links ?? []) {
    const rawUrl = link.URL || link.url;
    if (!rawUrl) continue;
    const label = link.DisplayName || link.displayName || link.display_name || "Open Link";
    const url = rewriteLinkTimeRange(rawUrl, inc.started_at, inc.ended_at);
    buttons.push(v2Button(label, url, "default"));
  }
  if (buttons.length) {
    elements.push({
      tag: "column_set",
      horizontal_spacing: "small",
      horizontal_align: "left",
      columns: buttons.map((b) => ({ tag: "column", width: "auto", elements: [b] })),
    });
  }

  // Chat-list preview text. Without summary.content Lark falls back to the first
  // body element which often renders as a JSON blob in the message preview.
  const stateDot = closed ? "\ud83d\udfe2" : style.template === "orange" ? "\ud83d\udfe0" : "\ud83d\udd34";
  const previewSubj = subj ? ` — ${subj.value}` : "";

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
      summary: { content: `${stateDot} [${state}] ${inc.policy_name}${previewSubj}` },
    },
    header: {
      template: style.template,
      title: { tag: "plain_text", content: title },
      text_tag_list: tags,
    },
    body: { elements },
  };
}

function v2Button(label: string, url: string, type: "primary" | "default"): unknown {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{ type: "open_url", default_url: url }],
  };
}
