import { describe, expect, test } from "bun:test";
import { parseGcpAlertUrl } from "./gcp-alert.ts";

describe("parseGcpAlertUrl", () => {
  test("parses /alerts/<id> as incident", () => {
    const out = parseGcpAlertUrl(
      "https://console.cloud.google.com/monitoring/alerting/alerts/abc123?project=my-proj",
    );
    expect(out.kind).toBe("incident");
    expect(out.id).toBe("abc123");
    expect(out.projectId).toBe("my-proj");
  });

  test("parses /incidents/<id> as incident", () => {
    const out = parseGcpAlertUrl(
      "https://console.cloud.google.com/monitoring/alerting/incidents/xyz?project=p1",
    );
    expect(out.kind).toBe("incident");
    expect(out.id).toBe("xyz");
  });

  test("parses /policies/<id> as policy", () => {
    const out = parseGcpAlertUrl(
      "https://console.cloud.google.com/monitoring/alerting/policies/pol-1?project=p2",
    );
    expect(out.kind).toBe("policy");
    expect(out.id).toBe("pol-1");
  });

  test("preserves raw URL", () => {
    const url = "https://console.cloud.google.com/monitoring/alerting/alerts/x?project=p&extra=1";
    expect(parseGcpAlertUrl(url).raw).toBe(url);
  });

  test("throws when project param missing", () => {
    expect(() => parseGcpAlertUrl("https://console.cloud.google.com/monitoring/alerting/alerts/abc")).toThrow(
      /project/,
    );
  });

  test("throws on unknown subtype", () => {
    expect(() =>
      parseGcpAlertUrl("https://console.cloud.google.com/monitoring/alerting/foobar/abc?project=p"),
    ).toThrow(/foobar/);
  });

  test("throws when path is too short", () => {
    expect(() =>
      parseGcpAlertUrl("https://console.cloud.google.com/monitoring/alerting?project=p"),
    ).toThrow();
  });
});
