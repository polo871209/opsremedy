import { describe, expect, test } from "bun:test";
import type { EventSummary, Evidence, LogEntry } from "../types.ts";
import { renderEvidence } from "./render-evidence.ts";

function logEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    severity: "INFO",
    textPreview: "preview",
    ...over,
  };
}

function event(over: Partial<EventSummary> = {}): EventSummary {
  return {
    namespace: "ns",
    involvedKind: "Pod",
    involvedName: "p",
    type: "Normal",
    reason: "r",
    message: "m",
    count: 1,
    lastSeen: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("renderEvidence", () => {
  test("returns {} text on empty evidence", () => {
    expect(renderEvidence({})).toBe("{}");
  });

  test("caps gcp_logs at 30 entries with _truncated marker", () => {
    const ev: Evidence = {
      gcp_logs: Array.from({ length: 50 }, (_, i) => logEntry({ textPreview: `e${i}` })),
    };
    const out = JSON.parse(renderEvidence(ev));
    expect(out.gcp_logs._truncated).toContain("50");
    expect(out.gcp_logs.entries.length).toBe(30);
  });

  test("does NOT add _truncated when under cap", () => {
    const ev: Evidence = {
      gcp_logs: [logEntry({ textPreview: "only one" })],
    };
    const out = JSON.parse(renderEvidence(ev));
    expect(Array.isArray(out.gcp_logs)).toBe(true);
    expect(out.gcp_logs.length).toBe(1);
  });

  test("drops payload field from log entries (too large for diagnoser)", () => {
    const ev: Evidence = {
      gcp_logs: [logEntry({ payload: { huge: "data" } })],
    };
    const out = JSON.parse(renderEvidence(ev));
    expect(out.gcp_logs[0].payload).toBeUndefined();
  });

  test("k8s_events sorted Warning-first then by lastSeen desc", () => {
    const ev: Evidence = {
      k8s_events: [
        event({ type: "Normal", reason: "n1", lastSeen: "2026-01-02" }),
        event({ type: "Warning", reason: "w1", lastSeen: "2026-01-01" }),
        event({ type: "Warning", reason: "w2", lastSeen: "2026-01-03" }),
      ],
    };
    const out = JSON.parse(renderEvidence(ev));
    expect(out.k8s_events[0].reason).toBe("w2");
    expect(out.k8s_events[1].reason).toBe("w1");
    expect(out.k8s_events[2].reason).toBe("n1");
  });

  test("truncates k8s_describe text over 4000 chars", () => {
    const ev: Evidence = {
      k8s_describe: { "pod/x@ns": "x".repeat(5000) },
    };
    const out = JSON.parse(renderEvidence(ev));
    const text = out.k8s_describe["pod/x@ns"];
    expect(text.length).toBeLessThan(5000);
    expect(text).toContain("[...truncated");
  });

  test("k8s_pod_logs keeps last 100 lines", () => {
    const ev: Evidence = {
      k8s_pod_logs: { "ns/p": Array.from({ length: 200 }, (_, i) => `line ${i}`) },
    };
    const out = JSON.parse(renderEvidence(ev));
    expect(out.k8s_pod_logs["ns/p"].length).toBe(100);
    expect(out.k8s_pod_logs["ns/p__truncated"]).toBeDefined();
  });

  test("omits empty top-level keys", () => {
    const ev: Evidence = {
      gcp_logs: [],
      prom_instant: {},
      k8s_events: [],
    };
    const out = JSON.parse(renderEvidence(ev));
    expect(out.gcp_logs).toBeUndefined();
    expect(out.prom_instant).toBeUndefined();
    expect(out.k8s_events).toBeUndefined();
  });
});
