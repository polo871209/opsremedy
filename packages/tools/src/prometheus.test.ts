import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FixturePromClient, resetClients, setClients } from "@opsremedy/clients";
import { newContext } from "@opsremedy/core";
import type { Alert, PromMetricMetadata, PromTarget } from "@opsremedy/core/types";
import { makePromListMetricsTool, makePromMetricMetadataTool, makePromTargetsTool } from "./prometheus.ts";

const ALERT: Alert = {
  alert_id: "t-1",
  alert_name: "Test",
  severity: "warning",
  fired_at: "2026-04-29T06:00:00.000Z",
  labels: {},
  annotations: {},
  summary: "",
};

const METRICS = [
  "http_requests_total",
  "http_request_duration_seconds",
  "container_cpu_usage_seconds_total",
  "kube_pod_status_phase",
];

const METADATA: PromMetricMetadata[] = [
  {
    metric: "http_requests_total",
    type: "counter",
    help: "Total HTTP requests received.",
    unit: "",
  },
  {
    metric: "kube_pod_status_phase",
    type: "gauge",
    help: "The pods current phase.",
  },
];

const TARGETS: PromTarget[] = [
  {
    job: "payments",
    instance: "10.0.0.1:8080",
    health: "up",
    labels: { job: "payments", instance: "10.0.0.1:8080" },
  },
  {
    job: "payments",
    instance: "10.0.0.2:8080",
    health: "down",
    lastError: "connection refused",
    labels: { job: "payments", instance: "10.0.0.2:8080" },
  },
  {
    job: "billing",
    instance: "10.0.1.1:8080",
    health: "up",
    labels: { job: "billing", instance: "10.0.1.1:8080" },
  },
];

beforeEach(() => {
  resetClients();
  setClients({
    prom: new FixturePromClient({
      metrics: METRICS,
      metadata: METADATA,
      targets: TARGETS,
    }),
  });
});

afterEach(() => {
  resetClients();
});

describe("list_prom_metrics", () => {
  test("returns all metrics by default", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = makePromListMetricsTool(ctx);
    const res = (await tool.execute("c1", {})) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("Got 4 metric name(s)");
    expect(ctx.evidence.prom_metrics).toHaveLength(4);
  });

  test("filters by case-insensitive substring", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = makePromListMetricsTool(ctx);
    const res = (await tool.execute("c1", { contains: "HTTP" })) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain('matching "HTTP"');
    expect(ctx.evidence.prom_metrics).toEqual(["http_requests_total", "http_request_duration_seconds"]);
  });

  test("returns empty-state summary when no match", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = makePromListMetricsTool(ctx);
    const res = (await tool.execute("c1", { contains: "nope" })) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("No metric names matched");
  });
});

describe("get_prom_metric_metadata", () => {
  test("renders single-metric type/help", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = makePromMetricMetadataTool(ctx);
    const res = (await tool.execute("c1", { metric: "http_requests_total" })) as {
      content: Array<{ text: string }>;
    };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("http_requests_total");
    expect(text).toContain("type=counter");
    expect(text).toContain("Total HTTP requests");
  });

  test("aggregates when no metric specified", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = makePromMetricMetadataTool(ctx);
    const res = (await tool.execute("c1", {})) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("Got 2 metadata entries");
  });
});

describe("get_prom_targets", () => {
  test("reports down targets with lastError", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = makePromTargetsTool(ctx);
    const res = (await tool.execute("c1", { job: "payments" })) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("Got 2 targets");
    expect(text).toContain("1 down");
    expect(text).toContain("connection refused");
  });

  test("all-up summary when no targets are down", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = makePromTargetsTool(ctx);
    const res = (await tool.execute("c1", { job: "billing" })) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("All up.");
  });

  test("empty result mentions GMP gateway caveat", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = makePromTargetsTool(ctx);
    const res = (await tool.execute("c1", { job: "nope" })) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("GMP gateways do not expose");
  });
});
