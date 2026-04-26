import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AuditEntry, Evidence, InvestigationContext } from "@opsremedy/core/types";
import type { Static, TSchema } from "typebox";
import { recordToolCall } from "./shared.ts";

/** Snapshot of evidence-key cardinality for diffing before/after a tool run. */
function evidenceShape(ev: Evidence): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(ev)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) out.set(k, v.length);
    } else if (typeof v === "object") {
      const size = Object.keys(v as object).length;
      if (size > 0) out.set(k, size);
    } else {
      out.set(k, 1);
    }
  }
  return out;
}

/** Keys that grew (or appeared) between two evidence snapshots. */
function diffEvidence(before: Map<string, number>, after: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of after) {
    if ((before.get(k) ?? 0) < n) out.push(k);
  }
  return out;
}

/**
 * Result returned by a tool's `run` body. The wrapper converts this into the
 * `AgentToolResult` shape pi-mono expects. `summary` is the short text the
 * gathering agent sees; `details` is structured metadata for traces.
 */
export interface ToolRunResult<TDetails = unknown> {
  summary: string;
  details?: TDetails;
}

/**
 * Define an `AgentTool` with shared boilerplate (timing, audit, error capture)
 * lifted into the wrapper. Tool body just does the work and returns a summary;
 * recordToolCall + try/catch + AgentToolResult shaping happen here.
 *
 * The wrapper:
 *  - times the call
 *  - records ok=true on success / ok=false with `error` on throw (then re-throws)
 *  - converts {summary, details} into the AgentToolResult content array
 */
export function defineTool<TParams extends TSchema, TDetails = unknown>(def: {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  ctx: InvestigationContext;
  run: (params: Static<TParams>, signal?: AbortSignal) => Promise<ToolRunResult<TDetails>>;
}): AgentTool<TParams, TDetails> {
  const execute = async (
    _toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<TDetails>> => {
    const t0 = Date.now();
    const before = evidenceShape(def.ctx.evidence);
    let summary = "";
    let ok = false;
    let errorMessage: string | undefined;
    try {
      const result = await def.run(params, signal);
      summary = result.summary;
      ok = true;
      recordToolCall(def.ctx, { name: def.name, args: params, ok: true, ms: Date.now() - t0 });
      return {
        content: [{ type: "text", text: summary }],
        details: result.details as TDetails,
      };
    } catch (err) {
      errorMessage = (err as Error).message;
      summary = `error: ${errorMessage}`;
      recordToolCall(def.ctx, {
        name: def.name,
        args: params,
        ok: false,
        ms: Date.now() - t0,
        error: errorMessage,
      });
      throw err;
    } finally {
      // Pair with the bump in gather.ts:beforeToolCall. Decrement even on
      // throw so a failing tool doesn't leak budget against the inflight cap.
      if (def.ctx.inflight > 0) def.ctx.inflight--;

      // Audit entry: parallel to tools_called but carries loop, summary, and
      // which evidence keys grew. Lets reroute + bench reason about trajectory
      // without re-derivation.
      const after = evidenceShape(def.ctx.evidence);
      const entry: AuditEntry = {
        loop: def.ctx.loop,
        tool: def.name,
        args: params,
        startedAt: t0,
        durationMs: Date.now() - t0,
        ok,
        summary,
        evidenceKeys: diffEvidence(before, after),
        ...(errorMessage !== undefined && { errorMessage }),
      };
      def.ctx.audit.push(entry);
    }
  };

  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute,
  };
}
