import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { InvestigationContext } from "@opsremedy/core/types";
import { makeGcpLogsTool } from "./gcp-logs.ts";
import { makeJaegerDepsTool, makeJaegerTracesTool } from "./jaeger.ts";
import { makeK8sDescribeTool, makeK8sEventsTool, makeK8sListPodsTool, makeK8sPodLogsTool } from "./k8s.ts";
import { makePromAlertRulesTool, makePromInstantTool, makePromRangeTool } from "./prometheus.ts";
import { makeProposeRemediationTool } from "./remediation.ts";

export function makeAllTools(ctx: InvestigationContext): AgentTool[] {
  return [
    makeGcpLogsTool(ctx),
    makePromInstantTool(ctx),
    makePromRangeTool(ctx),
    makePromAlertRulesTool(ctx),
    makeJaegerTracesTool(ctx),
    makeJaegerDepsTool(ctx),
    makeK8sListPodsTool(ctx),
    makeK8sDescribeTool(ctx),
    makeK8sEventsTool(ctx),
    makeK8sPodLogsTool(ctx),
    makeProposeRemediationTool(ctx),
  ];
}

export {
  makeGcpLogsTool,
  makeJaegerDepsTool,
  makeJaegerTracesTool,
  makeK8sDescribeTool,
  makeK8sEventsTool,
  makeK8sListPodsTool,
  makeK8sPodLogsTool,
  makePromAlertRulesTool,
  makePromInstantTool,
  makePromRangeTool,
  makeProposeRemediationTool,
};
