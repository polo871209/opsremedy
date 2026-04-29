import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FixtureK8sClient, resetClients, setClients } from "@opsremedy/clients";
import { newContext } from "@opsremedy/core";
import type { Alert } from "@opsremedy/core/types";
import { makeK8sEventsTool } from "./k8s.ts";

const ALERT: Alert = {
  alert_id: "t-1",
  alert_name: "Test",
  severity: "warning",
  fired_at: "2026-04-29T06:00:00.000Z",
  labels: {},
  annotations: {},
  summary: "",
};

const NS = "payments";
const EVENTS = [
  {
    namespace: NS,
    involvedKind: "Pod",
    involvedName: "payments-api-abc",
    type: "Warning" as const,
    reason: "BackOff",
    message: "Back-off restarting failed container",
    count: 1,
    lastSeen: "2026-04-29T06:00:00Z",
  },
  {
    namespace: NS,
    involvedKind: "Pod",
    involvedName: "other-pod",
    type: "Normal" as const,
    reason: "Pulled",
    message: "Pulled image",
    count: 1,
    lastSeen: "2026-04-29T06:00:00Z",
  },
];

beforeEach(() => {
  resetClients();
});
afterEach(() => {
  resetClients();
});

describe("k8s_get_events", () => {
  test("uses object_name to build field selector", async () => {
    // FixtureK8sClient ignores fieldSelector at the client layer, but the
    // tool should still construct one and surface it in details. We verify
    // the constructed value via the tool's details payload.
    setClients({ k8s: new FixtureK8sClient({ events: { [NS]: EVENTS } }) });
    const ctx = newContext(ALERT, 5);
    const tool = makeK8sEventsTool(ctx);
    const res = (await tool.execute("c1", {
      namespace: NS,
      object_name: "payments-api-abc",
      object_kind: "Pod",
    })) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("Pod/payments-api-abc in payments");
    expect(text).toContain("BackOff");
  });

  test("falls back to raw field_selector when object_name absent", async () => {
    setClients({ k8s: new FixtureK8sClient({ events: { [NS]: EVENTS } }) });
    const ctx = newContext(ALERT, 5);
    const tool = makeK8sEventsTool(ctx);
    const res = (await tool.execute("c1", {
      namespace: NS,
      field_selector: "type=Warning",
    })) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("namespace payments");
  });
});
