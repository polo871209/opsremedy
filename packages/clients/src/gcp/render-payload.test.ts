import { describe, expect, test } from "bun:test";
import { renderJsonPayload } from "./real.ts";

describe("renderJsonPayload", () => {
  test("uses `message` field when present", () => {
    expect(renderJsonPayload({ message: "boom", other: 1 })).toBe("boom");
  });

  test("falls back to common message-like keys", () => {
    expect(renderJsonPayload({ msg: "x" })).toBe("x");
    expect(renderJsonPayload({ error: "kaboom" })).toBe("kaboom");
  });

  test("renders istio/envoy access-log shape with no message field", () => {
    const out = renderJsonPayload({
      response_code: 503,
      response_flags: "UH",
      method: "POST",
      path: "/api/checkout",
      upstream_cluster: "outbound|8080||payment-account.qashier.svc",
    });
    expect(out).toContain("status=503");
    expect(out).toContain("flags=UH");
    expect(out).toContain("method=POST");
    expect(out).toContain("path=/api/checkout");
    expect(out).toContain("upstream=outbound|8080||payment-account.qashier.svc");
  });

  test("compact-scalar fallback when neither message nor access-log shape", () => {
    const out = renderJsonPayload({ traceId: "abc", spanId: "def", level: "warn" });
    expect(out).toContain("traceId=abc");
    expect(out).toContain("spanId=def");
    expect(out).toContain("level=warn");
  });

  test("returns empty string for empty payload", () => {
    expect(renderJsonPayload({})).toBe("");
  });
});
