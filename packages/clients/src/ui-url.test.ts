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
