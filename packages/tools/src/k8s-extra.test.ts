import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FixtureK8sClient, resetClients, setClients } from "@opsremedy/clients";
import { newContext } from "@opsremedy/core";
import type { Alert } from "@opsremedy/core/types";
import { makeK8sClusterInfoTool, makeK8sTriagePodTool } from "./k8s-extra.ts";

const ALERT: Alert = {
  alert_id: "t-1",
  alert_name: "Test",
  severity: "critical",
  fired_at: "2026-04-29T06:00:00.000Z",
  labels: {},
  annotations: {},
  summary: "",
};

beforeEach(() => {
  resetClients();
});

afterEach(() => {
  resetClients();
});

describe("k8s_cluster_info", () => {
  test("renders nodes and namespaces", async () => {
    setClients({
      k8s: new FixtureK8sClient({
        cluster: {
          nodes: { total: 5, ready: 4 },
          namespaces: ["default", "kube-system", "payments", "monitoring"],
        },
      }),
    });
    const ctx = newContext(ALERT, 5);
    const tool = makeK8sClusterInfoTool(ctx);
    const res = (await tool.execute("c1", {})) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("Nodes: 4/5 ready");
    expect(text).toContain("default");
    expect(text).toContain("payments");
  });

  test("falls back to namespace keys when cluster info missing", async () => {
    setClients({ k8s: new FixtureK8sClient({ pods: { ns1: [], ns2: [] } }) });
    const ctx = newContext(ALERT, 5);
    const tool = makeK8sClusterInfoTool(ctx);
    const res = (await tool.execute("c1", {})) as { content: Array<{ text: string }> };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("ns1");
    expect(text).toContain("ns2");
  });
});

describe("k8s_triage_pod", () => {
  test("populates pods, describe, events, logs in one call", async () => {
    setClients({
      k8s: new FixtureK8sClient({
        pods: {
          payments: [
            {
              namespace: "payments",
              name: "payments-api-abc",
              phase: "Running",
              ready: false,
              restarts: 7,
              lastTerminationReason: "CrashLoopBackOff",
              owner: "Deployment/payments-api",
            },
          ],
        },
        describe: {
          "pod/payments-api-abc@payments": "Pod describe text",
        },
        events: {
          payments: [
            {
              namespace: "payments",
              involvedKind: "Pod",
              involvedName: "payments-api-abc",
              type: "Warning",
              reason: "BackOff",
              message: "Back-off restarting failed container",
              count: 12,
              lastSeen: "2026-04-29T06:00:00Z",
            },
          ],
        },
        logs: { "payments/payments-api-abc": ["[INFO] starting", "[FATAL] migration mismatch"] },
      }),
    });

    const ctx = newContext(ALERT, 5);
    const tool = makeK8sTriagePodTool(ctx);
    const res = (await tool.execute("c1", { namespace: "payments", pod: "payments-api-abc" })) as {
      content: Array<{ text: string }>;
    };
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("phase=Running");
    expect(text).toContain("CrashLoopBackOff");
    expect(text).toContain("BackOff: Back-off restarting");
    expect(text).toContain("FATAL");

    expect(ctx.evidence.k8s_pods?.[0]?.name).toBe("payments-api-abc");
    expect(ctx.evidence.k8s_describe?.["pod/payments-api-abc@payments"]).toContain("Pod describe text");
    expect(ctx.evidence.k8s_events?.[0]?.reason).toBe("BackOff");
    expect(ctx.evidence.k8s_pod_logs?.["payments/payments-api-abc"]).toHaveLength(2);
  });
});
