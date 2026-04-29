import { describe, expect, it } from "bun:test";
import type { Evidence } from "../types.ts";
import { deriveFindings } from "./findings.ts";

describe("deriveFindings", () => {
  it("returns empty when evidence is clean", () => {
    expect(deriveFindings({})).toEqual([]);
  });

  it("flags a CrashLoopBackOff pod with restarts and parent", () => {
    const ev: Evidence = {
      k8s_pods: [
        {
          namespace: "payments",
          name: "payments-api-abc",
          phase: "Running",
          ready: false,
          restarts: 14,
          lastTerminationReason: "CrashLoopBackOff",
          owner: "Deployment/payments-api",
        },
      ],
    };
    const f = deriveFindings(ev);
    expect(f).toHaveLength(1);
    const first = f[0]!;
    expect(first.kind).toBe("Pod");
    expect(first.parent).toBe("Deployment/payments-api");
    expect(first.text).toContain("CrashLoopBackOff");
    expect(first.text).toContain("restarts=14");
    expect(first.severity).toBe("critical");
    expect(first.source).toBe("deterministic");
  });

  it("flags OOMKilled termination", () => {
    const ev: Evidence = {
      k8s_pods: [
        {
          namespace: "x",
          name: "p",
          phase: "Running",
          ready: false,
          restarts: 1,
          lastTerminationReason: "OOMKilled",
        },
      ],
    };
    const f = deriveFindings(ev);
    expect(f).toHaveLength(1);
    expect(f[0]!.text).toContain("OOMKilled");
  });

  it("ignores Succeeded jobs and healthy running pods", () => {
    const ev: Evidence = {
      k8s_pods: [
        { namespace: "x", name: "j", phase: "Succeeded", ready: false, restarts: 0 },
        { namespace: "x", name: "h", phase: "Running", ready: true, restarts: 0 },
      ],
    };
    expect(deriveFindings(ev)).toEqual([]);
  });

  it("flags Pending without termination reason", () => {
    const ev: Evidence = {
      k8s_pods: [{ namespace: "x", name: "p", phase: "Pending", ready: false, restarts: 0 }],
    };
    const f = deriveFindings(ev);
    expect(f).toHaveLength(1);
    expect(f[0]!.text).toContain("Pending");
  });

  it("surfaces Warning events with failure reasons", () => {
    const ev: Evidence = {
      k8s_events: [
        {
          namespace: "x",
          involvedKind: "Pod",
          involvedName: "p1",
          type: "Warning",
          reason: "FailedScheduling",
          message: "0/3 nodes are available",
          count: 1,
          lastSeen: "2026-04-25T10:00:00Z",
        },
        {
          namespace: "x",
          involvedKind: "Pod",
          involvedName: "p1",
          type: "Normal",
          reason: "Pulled",
          message: "ok",
          count: 1,
          lastSeen: "2026-04-25T10:00:00Z",
        },
      ],
    };
    const f = deriveFindings(ev);
    expect(f).toHaveLength(1);
    expect(f[0]!.text).toContain("FailedScheduling");
  });

  it("ignores Warning events with non-failure reasons", () => {
    const ev: Evidence = {
      k8s_events: [
        {
          namespace: "x",
          involvedKind: "Node",
          involvedName: "n1",
          type: "Warning",
          reason: "Rebooted",
          message: "node was rebooted",
          count: 1,
          lastSeen: "2026-04-25T10:00:00Z",
        },
      ],
    };
    expect(deriveFindings(ev)).toEqual([]);
  });

  it("dedupes identical (kind, name, ns, text) entries", () => {
    const ev: Evidence = {
      k8s_events: [
        {
          namespace: "x",
          involvedKind: "Pod",
          involvedName: "p",
          type: "Warning",
          reason: "BackOff",
          message: "back-off",
          count: 1,
          lastSeen: "t1",
        },
        {
          namespace: "x",
          involvedKind: "Pod",
          involvedName: "p",
          type: "Warning",
          reason: "BackOff",
          message: "back-off",
          count: 5,
          lastSeen: "t2",
        },
      ],
    };
    expect(deriveFindings(ev)).toHaveLength(1);
  });
});
