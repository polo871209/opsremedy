import { describe, expect, it } from "bun:test";
import { controllerRef, refLabel, resolvePodOwner } from "./parent.ts";

describe("controllerRef", () => {
  it("returns the controller=true ref when present", () => {
    const ref = controllerRef({
      metadata: {
        ownerReferences: [
          { kind: "ReplicaSet", name: "foo", controller: false },
          { kind: "Job", name: "bar", controller: true },
        ],
      },
    });
    expect(ref?.name).toBe("bar");
  });

  it("falls back to the first ref when none is controller", () => {
    const ref = controllerRef({
      metadata: { ownerReferences: [{ kind: "ReplicaSet", name: "foo" }] },
    });
    expect(ref?.name).toBe("foo");
  });

  it("returns undefined for empty/missing refs", () => {
    expect(controllerRef(undefined)).toBeUndefined();
    expect(controllerRef({})).toBeUndefined();
    expect(controllerRef({ metadata: { ownerReferences: [] } })).toBeUndefined();
  });
});

describe("refLabel", () => {
  it("formats kind/name", () => {
    expect(refLabel({ kind: "Deployment", name: "x" })).toBe("Deployment/x");
  });
  it("returns undefined when fields missing", () => {
    expect(refLabel({})).toBeUndefined();
    expect(refLabel({ kind: "Deployment" })).toBeUndefined();
  });
});

describe("resolvePodOwner", () => {
  it("walks ReplicaSet → Deployment", async () => {
    const apis = {
      apps: {
        readNamespacedReplicaSet: async () => ({
          metadata: { ownerReferences: [{ kind: "Deployment", name: "payments-api", controller: true }] },
        }),
      },
      batch: {
        readNamespacedJob: async () => ({}),
      },
    } as Parameters<typeof resolvePodOwner>[1];

    const owner = await resolvePodOwner(
      {
        metadata: {
          namespace: "payments",
          ownerReferences: [{ kind: "ReplicaSet", name: "payments-api-abc", controller: true }],
        },
      },
      apis,
    );
    expect(owner).toBe("Deployment/payments-api");
  });

  it("walks Job → CronJob", async () => {
    const apis = {
      apps: { readNamespacedReplicaSet: async () => ({}) },
      batch: {
        readNamespacedJob: async () => ({
          metadata: { ownerReferences: [{ kind: "CronJob", name: "nightly", controller: true }] },
        }),
      },
    } as Parameters<typeof resolvePodOwner>[1];

    const owner = await resolvePodOwner(
      {
        metadata: {
          namespace: "batch",
          ownerReferences: [{ kind: "Job", name: "nightly-202604", controller: true }],
        },
      },
      apis,
    );
    expect(owner).toBe("CronJob/nightly");
  });

  it("falls back to first ref when second hop fails", async () => {
    const apis = {
      apps: {
        readNamespacedReplicaSet: async () => {
          throw new Error("api down");
        },
      },
      batch: { readNamespacedJob: async () => ({}) },
    } as Parameters<typeof resolvePodOwner>[1];

    const owner = await resolvePodOwner(
      {
        metadata: {
          namespace: "x",
          ownerReferences: [{ kind: "ReplicaSet", name: "rs-1", controller: true }],
        },
      },
      apis,
    );
    expect(owner).toBe("ReplicaSet/rs-1");
  });

  it("stops at leaf workloads (StatefulSet/DaemonSet) without extra reads", async () => {
    let reads = 0;
    const apis = {
      apps: {
        readNamespacedReplicaSet: async () => {
          reads++;
          return {};
        },
      },
      batch: {
        readNamespacedJob: async () => {
          reads++;
          return {};
        },
      },
    } as Parameters<typeof resolvePodOwner>[1];

    const owner = await resolvePodOwner(
      {
        metadata: {
          namespace: "db",
          ownerReferences: [{ kind: "StatefulSet", name: "postgres", controller: true }],
        },
      },
      apis,
    );
    expect(owner).toBe("StatefulSet/postgres");
    expect(reads).toBe(0);
  });

  it("returns undefined when no ownerReferences", async () => {
    const apis = {
      apps: { readNamespacedReplicaSet: async () => ({}) },
      batch: { readNamespacedJob: async () => ({}) },
    } as Parameters<typeof resolvePodOwner>[1];
    const owner = await resolvePodOwner({ metadata: { namespace: "x" } }, apis);
    expect(owner).toBeUndefined();
  });
});
