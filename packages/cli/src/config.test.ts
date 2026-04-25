import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_JAEGER_URL, DEFAULT_MAX_TOOL_CALLS, DEFAULT_PROM_URL, resolveSettings } from "./config.ts";

const ENV_KEYS = [
  "OPSREMEDY_LLM_PROVIDER",
  "OPSREMEDY_LLM_MODEL",
  "PROM_URL",
  "PROM_BEARER_TOKEN",
  "PROM_USER",
  "PROM_PASSWORD",
  "JAEGER_URL",
  "JAEGER_TOKEN",
  "KUBECONFIG",
  "OPSREMEDY_K8S_CONTEXT",
  "GCP_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPSREMEDY_MAX_TOOL_CALLS",
];

describe("resolveSettings", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("returns defaults on empty config + creds", () => {
    const s = resolveSettings({}, {});
    expect(s.llm.provider).toBe("anthropic");
    expect(s.llm.model).toBe("claude-sonnet-4-5-20250929");
    expect(s.prom.url).toBe(DEFAULT_PROM_URL);
    expect(s.jaeger.url).toBe(DEFAULT_JAEGER_URL);
    expect(s.agent.maxToolCalls).toBe(DEFAULT_MAX_TOOL_CALLS);
    expect(s.gcp.projectId).toBeUndefined();
  });

  test("file values override defaults", () => {
    const s = resolveSettings(
      {
        llm: { provider: "openai", model: "gpt-5" },
        prom: { url: "http://prom.svc:9090" },
        jaeger: { url: "http://jaeger:16686" },
        gcp: { project_id: "p-from-file" },
      },
      {},
    );
    expect(s.llm.provider).toBe("openai");
    expect(s.llm.model).toBe("gpt-5");
    expect(s.prom.url).toBe("http://prom.svc:9090");
    expect(s.gcp.projectId).toBe("p-from-file");
  });

  test("env overrides file", () => {
    process.env.OPSREMEDY_LLM_PROVIDER = "anthropic-from-env";
    process.env.PROM_URL = "http://env.prom:9090";
    process.env.GCP_PROJECT_ID = "p-from-env";
    const s = resolveSettings(
      {
        llm: { provider: "openai", model: "gpt-5" },
        prom: { url: "http://prom.svc:9090" },
        gcp: { project_id: "p-from-file" },
      },
      {},
    );
    expect(s.llm.provider).toBe("anthropic-from-env");
    expect(s.prom.url).toBe("http://env.prom:9090");
    expect(s.gcp.projectId).toBe("p-from-env");
  });

  test("basicAuth requires both user and password", () => {
    const userOnly = resolveSettings({ prom: { url: "http://x", user: "u" } }, {});
    expect(userOnly.prom.basicAuth).toBeUndefined();

    const both = resolveSettings({ prom: { url: "http://x", user: "u" } }, { prom_password: "secret" });
    expect(both.prom.basicAuth).toEqual({ user: "u", password: "secret" });
  });

  test("falls back to default when env value is non-numeric", () => {
    process.env.OPSREMEDY_MAX_TOOL_CALLS = "not-a-number";
    const s = resolveSettings({}, {});
    expect(s.agent.maxToolCalls).toBe(DEFAULT_MAX_TOOL_CALLS);
  });

  test("creds bearer token populates prom auth", () => {
    const s = resolveSettings({ prom: { url: "http://x" } }, { prom_bearer_token: "tk" });
    expect(s.prom.bearerToken).toBe("tk");
  });
});
