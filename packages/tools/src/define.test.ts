import { describe, expect, test } from "bun:test";
import { newContext } from "@opsremedy/core";
import type { Alert } from "@opsremedy/core/types";
import { Type } from "typebox";
import { defineTool } from "./define.ts";

const ALERT: Alert = {
  alert_id: "t-1",
  alert_name: "Test",
  severity: "critical",
  fired_at: new Date().toISOString(),
  labels: {},
  annotations: {},
  summary: "",
};

describe("defineTool audit", () => {
  test("records audit entry with summary, loop, evidenceKeys on success", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = defineTool({
      name: "fake_tool",
      label: "Fake",
      description: "test",
      parameters: Type.Object({ x: Type.Number() }),
      ctx,
      run: async (params) => {
        ctx.evidence.gcp_logs = [{ timestamp: "now", severity: "INFO", textPreview: `n=${params.x}` }];
        return { summary: `wrote ${params.x}` };
      },
    });

    await tool.execute("call-1", { x: 7 });

    expect(ctx.audit).toHaveLength(1);
    const entry = ctx.audit[0];
    expect(entry).toBeDefined();
    expect(entry?.tool).toBe("fake_tool");
    expect(entry?.ok).toBe(true);
    expect(entry?.summary).toBe("wrote 7");
    expect(entry?.loop).toBe(0);
    expect(entry?.evidenceKeys).toContain("gcp_logs");
    expect(entry?.errorMessage).toBeUndefined();
  });

  test("records audit entry with errorMessage on throw, decrements inflight", async () => {
    const ctx = newContext(ALERT, 5);
    ctx.inflight = 1; // simulate the bump from beforeToolCall
    const tool = defineTool({
      name: "boom_tool",
      label: "Boom",
      description: "test",
      parameters: Type.Object({}),
      ctx,
      run: async () => {
        throw new Error("kaboom");
      },
    });

    await expect(tool.execute("call-1", {})).rejects.toThrow("kaboom");
    expect(ctx.audit).toHaveLength(1);
    const entry = ctx.audit[0];
    expect(entry?.ok).toBe(false);
    expect(entry?.errorMessage).toBe("kaboom");
    expect(entry?.evidenceKeys).toEqual([]);
    expect(ctx.inflight).toBe(0);
  });

  test("loop value tracks ctx.loop at call time", async () => {
    const ctx = newContext(ALERT, 5);
    const tool = defineTool({
      name: "noop_tool",
      label: "Noop",
      description: "test",
      parameters: Type.Object({}),
      ctx,
      run: async () => ({ summary: "ok" }),
    });

    await tool.execute("c1", {});
    ctx.loop = 1;
    await tool.execute("c2", {});

    expect(ctx.audit.map((e) => e.loop)).toEqual([0, 1]);
  });
});
