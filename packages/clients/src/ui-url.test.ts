import { describe, expect, test } from "bun:test";
import { RealGcpLoggingClient } from "./gcp/real.ts";
import { RealJaegerClient } from "./jaeger/real.ts";
import { RealPromClient } from "./prom/real.ts";

describe("RealGcpLoggingClient.uiUrl", () => {
  const c = new RealGcpLoggingClient("p-1");

  test("includes project param", () => {
    expect(c.uiUrl("")).toBe("https://console.cloud.google.com/logs/query?project=p-1");
  });

  test("encodes filter into matrix param BEFORE the project query string", () => {
    const url = c.uiUrl('resource.labels.namespace_name="payments"');
    // Console parses ;query as part of the path; the ?project= must follow it,
    // not precede it. Otherwise project becomes "p-1;query=..." and 404s.
    expect(url).toMatch(/\/logs\/query;query=[^?]+\?project=p-1$/);
    expect(decodeURIComponent(url)).toContain('namespace_name="payments"');
  });

  test("appends severity floor for errorsOnly when filter doesn't already constrain it", () => {
    const url = c.uiUrl('resource.type="k8s_container"', true);
    expect(decodeURIComponent(url)).toContain("severity>=ERROR");
    expect(url).toContain("?project=p-1");
  });

  test("does not duplicate severity floor when filter already has one", () => {
    const url = c.uiUrl('severity>=WARNING AND resource.type="k8s_container"', true);
    expect(url.match(/severity/g)?.length ?? 0).toBe(1);
  });

  test("encodes time window as cursorTimestamp + duration matrix params before project", () => {
    const from = new Date("2026-04-29T05:37:07.000Z");
    const to = new Date("2026-04-29T06:34:28.407Z");
    const url = c.uiUrl('resource.type="k8s_container"', false, { from, to });
    // matrix params live BEFORE ?project= and use the form GCP Console emits itself.
    expect(url).toMatch(/;cursorTimestamp=[^?]+;duration=PT\d+M\?project=p-1$/);
    expect(decodeURIComponent(url)).toContain("cursorTimestamp=2026-04-29T06:34:28.407Z");
    // 06:34 - 05:37 ≈ 57.36 min → ceil = 58
    expect(url).toContain("duration=PT58M");
    // no stray query-string time params
    expect(url).not.toContain("startTime=");
    expect(url).not.toContain("endTime=");
  });

  test("emits only time matrix when filter is empty but window is set", () => {
    const from = new Date("2026-04-29T05:37:07.000Z");
    const to = new Date("2026-04-29T06:34:28.407Z");
    const url = c.uiUrl("", false, { from, to });
    expect(url).toMatch(
      /^https:\/\/console\.cloud\.google\.com\/logs\/query;cursorTimestamp=[^?]+;duration=PT\d+M\?project=p-1$/,
    );
    expect(url).not.toContain(";query=");
  });

  test("clamps duration to at least 1 minute for sub-minute windows", () => {
    const from = new Date("2026-04-29T06:00:00.000Z");
    const to = new Date("2026-04-29T06:00:30.000Z");
    const url = c.uiUrl("", false, { from, to });
    expect(url).toContain("duration=PT1M");
  });
});

describe("RealPromClient.uiUrl", () => {
  const c = new RealPromClient({ baseUrl: "https://prom.example.com/" });

  test("trims trailing slash on base", () => {
    expect(c.uiUrl("graph")).toBe("https://prom.example.com/graph");
  });

  test("graph with query encodes expr", () => {
    expect(c.uiUrl("graph", "up")).toBe("https://prom.example.com/graph?g0.expr=up&g0.tab=0");
  });

  test("alerts page", () => {
    expect(c.uiUrl("alerts")).toBe("https://prom.example.com/alerts");
  });
});

describe("RealJaegerClient.uiUrl", () => {
  const c = new RealJaegerClient({ baseUrl: "https://jaeger.example.com" });

  test("search without service", () => {
    expect(c.uiUrl("search")).toBe("https://jaeger.example.com/search");
  });

  test("search with service encodes name", () => {
    expect(c.uiUrl("search", "payments-api")).toBe("https://jaeger.example.com/search?service=payments-api");
  });

  test("dependencies page", () => {
    expect(c.uiUrl("dependencies")).toBe("https://jaeger.example.com/dependencies");
  });
});
