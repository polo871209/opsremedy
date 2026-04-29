import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FixtureGcpLoggingClient, resetClients, setClients } from "@opsremedy/clients";
import { newContext } from "@opsremedy/core";
import type { Alert, LogEntry } from "@opsremedy/core/types";
import { makeGcpDiscoverTool } from "./gcp-discover.ts";

const ALERT: Alert = {
  alert_id: "t-1",
  alert_name: "Test",
  severity: "critical",
  fired_at: "2026-04-29T06:00:00.000Z",
  labels: {},
  annotations: { closed_at: "2026-04-29T06:30:00.000Z" },
  summary: "",
};

const LOGS: LogEntry[] = [
  // 6 k8s_container in payments
  ...Array.from({ length: 6 }, (_, i) => ({
    timestamp: "2026-04-29T06:10:00.000Z",
    severity: i < 4 ? "INFO" : "ERROR",
    textPreview: `payments log ${i}`,
    resourceType: "k8s_container",
    resource: { namespace_name: "payments", pod_name: "payment-transaction-abc", container_name: "app" },
  })),
  // 2 k8s_container in default
  ...Array.from({ length: 2 }, () => ({
    timestamp: "2026-04-29T06:11:00.000Z",
    severity: "WARNING",
    textPreview: "default log",
    resourceType: "k8s_container",
    resource: { namespace_name: "default", pod_name: "other-xyz", container_name: "sidecar" },
  })),
];

beforeEach(() => {
  resetClients();
  setClients({ gcp: new FixtureGcpLoggingClient({ logs: LOGS }) });
});

afterEach(() => {
  resetClients();
});

describe("discover_gcp_log_resources", () => {
  test("aggregates top resource.types, namespaces, severities", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = makeGcpDiscoverTool(ctx);
    const result = (await tool.execute("c1", { sample_size: 200 })) as {
      content: Array<{ text: string }>;
      details: {
        resourceTypes: Array<{ value: string; count: number }>;
        namespaces: Array<{ value: string; count: number }>;
        sampled: number;
      };
    };

    expect(result.details.sampled).toBe(8);
    expect(result.details.resourceTypes[0]?.value).toBe("k8s_container");
    expect(result.details.resourceTypes[0]?.count).toBe(8);
    expect(result.details.namespaces[0]?.value).toBe("payments");

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("k8s_container=8");
    expect(text).toContain("payments=6");
    expect(text).toContain("hint:");
  });

  test("returns helpful zero-result summary when nothing matches pre_filter", async () => {
    resetClients();
    setClients({ gcp: new FixtureGcpLoggingClient({ logs: [] }) });
    const ctx = newContext(ALERT, 5);
    const tool = makeGcpDiscoverTool(ctx);
    const result = (await tool.execute("c1", {})) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toContain("No logs in window");
  });
});
