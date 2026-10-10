import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { buildModel, completeSimple } from "../model.ts";
import { HANDOFF_SYSTEM_PROMPT, untrusted } from "../prompt.ts";
import { log } from "../utils/logger.ts";
import { noteModelError } from "../utils/model-error.ts";
import { formatToolQuery } from "./handoff-doc.ts";
import type { HandoffDoc } from "../harness/docs.ts";
import { getHandoff, saveHandoff, type AlertMeta } from "../harness/threads.ts";

const TIMEOUT_MS = 90_000;

const RESULT_CHARS = 400;
const TEXT_CHARS = 1500;
const MAX_TRACE_CHARS = 60_000;
const HEAD_SHARE = 0.4;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+$/, "");
  return t.length <= max ? t : `${t.slice(0, max)}… (truncated)`;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n")
    .trim();
}

function diagnosisLine(args: Record<string, unknown>): string {
  const parts = [`DIAGNOSIS SUBMITTED: ${String(args.rootCause ?? "")}`];
  if (args.rootCauseCategory || args.confidence)
    parts.push(`  category=${args.rootCauseCategory ?? "?"} confidence=${args.confidence ?? "?"}`);
  for (const e of (args.evidence as string[] | undefined) ?? []) parts.push(`  evidence: ${e}`);
  for (const r of (args.remediationSteps as string[] | undefined) ?? []) parts.push(`  remediation: ${r}`);
  return parts.join("\n");
}

function compactTranscript(messages: Message[]): string {
  const lines: string[] = [];
  const results = new Map<string, ToolResultMessage>();
  for (const m of messages) if (m.role === "toolResult") results.set(m.toolCallId, m);
  for (const m of messages) {
    if (m.role === "user") {
      const text = blockText(m.content);
      if (text) lines.push(`USER: ${clip(text, TEXT_CHARS)}`);
      continue;
    }
    if (m.role !== "assistant") continue;
    const text = blockText(m.content);
    if (text) lines.push(`AGENT: ${clip(text, TEXT_CHARS)}`);
    for (const tc of m.content) {
      if (tc.type !== "toolCall") continue;
      if (tc.name === "submit_diagnosis") {
        lines.push(diagnosisLine(tc.arguments));
        continue;
      }
      const query = formatToolQuery(tc.name, tc.arguments);
      lines.push(`TOOL ${tc.name}${query ? `: ${query}` : ""}`);
      const result = results.get(tc.id);
      const body = blockText(result?.content);
      if (result?.isError) lines.push(`  FAILED: ${clip(body || "tool error", RESULT_CHARS)}`);
      else if (body) lines.push(`  RESULT: ${clip(body, RESULT_CHARS)}`);
    }
  }
  return budget(lines);
}

function budget(lines: string[]): string {
  const trace = lines.join("\n");
  if (trace.length <= MAX_TRACE_CHARS) return trace;
  const head: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length > MAX_TRACE_CHARS * HEAD_SHARE) break;
    head.push(l);
    used += l.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const l = lines[i]!;
    if (used + l.length > MAX_TRACE_CHARS * (1 - HEAD_SHARE)) break;
    tail.unshift(l);
    used += l.length + 1;
  }
  const dropped = lines.length - head.length - tail.length;
  return [
    ...head,
    `… ${dropped} middle events omitted for length. The full transcript link sits in the doc.`,
    ...tail,
  ].join("\n");
}

function buildHandoffPayload(meta: AlertMeta, messages: Message[], partial: boolean, focus?: string): string {
  const facts = [
    `Alert: ${meta.alertName || "unknown"}`,
    `Started: ${meta.alertStartedAt ?? "unknown"}`,
    `Ended: ${meta.alertEndedAt ?? "still open"}`,
    partial
      ? "Investigation status: still running, so the thread below is incomplete. Say what holds now."
      : "Investigation status: finished.",
  ].join("\n");
  const ask = focus ? `\n\nFocus requested with this handoff:\n${untrusted("focus_request", focus)}` : "";
  return `${facts}${ask}\n\nThread, oldest first:\n${untrusted("thread", compactTranscript(messages))}`;
}

async function compileHandoff(
  cfg: Config,
  meta: AlertMeta,
  messages: Message[],
  partial = false,
  focus?: string,
): Promise<HandoffDoc> {
  const model = buildModel(cfg, cfg.model.synthesis);
  const started = Date.now();
  const msg = await completeSimple(
    model,
    {
      systemPrompt: HANDOFF_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildHandoffPayload(meta, messages, partial, focus), timestamp: Date.now() }],
    },
    {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      reasoning: model.reasoning ? (cfg.model.reasoning ?? "low") : undefined,
    },
  );
  const markdown = blockText(msg.content);
  if (!markdown) throw new Error("handoff compile returned no text");
  log.info("handoff compiled", {
    model: cfg.model.synthesis,
    ms: Date.now() - started,
    chars: markdown.length,
    messages: messages.length,
    partial,
    focus,
  });
  return {
    markdown,
    messageCount: messages.length,
    model: cfg.model.synthesis,
    compiledAt: Date.now(),
    partial,
    focus,
  };
}

export async function ensureHandoff(
  threadKey: string,
  cfg: Config,
  meta: AlertMeta,
  messages: Message[],
  focus?: string,
  force = false,
): Promise<HandoffDoc | undefined> {
  const stored = await getHandoff(threadKey).catch(() => undefined);
  if (messages.length === 0) return stored;
  if (!force && stored && stored.messageCount === messages.length && (stored.focus ?? "") === (focus ?? "")) {
    log.info("handoff compile reused", { thread: threadKey, messages: messages.length, focus });
    return stored;
  }
  try {
    const doc = await compileHandoff(cfg, meta, messages, meta.complete !== true, focus);
    await saveHandoff(threadKey, doc);
    return doc;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (!noteModelError(err, { thread: threadKey }))
      log.warn("handoff compile failed", { thread: threadKey, error: err, hadStored: !!stored });
    return stored;
  }
}
