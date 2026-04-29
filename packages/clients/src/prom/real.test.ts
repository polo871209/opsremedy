import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RealPromClient } from "./real.ts";

const ORIGINAL_FETCH = globalThis.fetch;

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

function installMockFetch(responder: (req: CapturedRequest) => unknown): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const headers: Record<string, string> = {};
    const raw = init?.headers ?? {};
    if (raw instanceof Headers) {
      raw.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(raw)) {
      for (const [k, v] of raw as Array<[string, string]>) headers[k.toLowerCase()] = v;
    } else {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const captured: CapturedRequest = { url, headers };
    requests.push(captured);
    const data = responder(captured);
    return new Response(JSON.stringify({ status: "success", data }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

beforeEach(() => {
  // ensure clean state
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("RealPromClient.headers", () => {
  test("uses tokenProvider per request and overrides static bearerToken", async () => {
    let count = 0;
    const tokenProvider = async () => `t-${++count}`;
    const requests = installMockFetch(() => []);
    const client = new RealPromClient({
      baseUrl: "https://prom.example.com",
      bearerToken: "static-loses",
      tokenProvider,
    });
    await client.listMetrics({});
    await client.listMetrics({});
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.authorization).toBe("Bearer t-1");
    expect(requests[1]!.headers.authorization).toBe("Bearer t-2");
  });

  test("falls back to static bearerToken when no provider", async () => {
    const requests = installMockFetch(() => []);
    const client = new RealPromClient({
      baseUrl: "https://prom.example.com",
      bearerToken: "abc",
    });
    await client.listMetrics({});
    expect(requests[0]!.headers.authorization).toBe("Bearer abc");
  });

  test("falls back to basic auth when no token sources", async () => {
    const requests = installMockFetch(() => []);
    const client = new RealPromClient({
      baseUrl: "https://prom.example.com",
      basicAuth: { user: "u", password: "p" },
    });
    await client.listMetrics({});
    const expected = `Basic ${Buffer.from("u:p").toString("base64")}`;
    expect(requests[0]!.headers.authorization).toBe(expected);
  });

  test("omits Authorization when no auth configured", async () => {
    const requests = installMockFetch(() => []);
    const client = new RealPromClient({ baseUrl: "https://prom.example.com" });
    await client.listMetrics({});
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });
});

describe("RealPromClient parsers", () => {
  test("metricMetadata normalises Record<metric, items[]> shape", async () => {
    installMockFetch(() => ({
      http_requests_total: [{ type: "counter", help: "Total requests.", unit: "" }],
      kube_pod_status_phase: [{ type: "gauge", help: "Phase.", unit: "" }],
    }));
    const client = new RealPromClient({ baseUrl: "https://prom.example.com" });
    const md = await client.metricMetadata({});
    expect(md).toHaveLength(2);
    expect(md.find((m) => m.metric === "http_requests_total")?.type).toBe("counter");
  });

  test("targets returns down lastError and filters by job", async () => {
    installMockFetch(() => ({
      activeTargets: [
        {
          labels: { job: "payments", instance: "i1" },
          health: "down",
          lastError: "connection refused",
          scrapeUrl: "http://i1/metrics",
        },
        {
          labels: { job: "billing", instance: "i2" },
          health: "up",
          scrapeUrl: "http://i2/metrics",
        },
      ],
    }));
    const client = new RealPromClient({ baseUrl: "https://prom.example.com" });
    const all = await client.targets({});
    expect(all).toHaveLength(2);
    const payments = await client.targets({ job: "payments" });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.lastError).toBe("connection refused");
  });

  test("listMetrics filters by case-insensitive substring", async () => {
    installMockFetch(() => ["http_requests_total", "kube_pod_status_phase"]);
    const client = new RealPromClient({ baseUrl: "https://prom.example.com" });
    const m = await client.listMetrics({ contains: "HTTP" });
    expect(m).toEqual(["http_requests_total"]);
  });
});
