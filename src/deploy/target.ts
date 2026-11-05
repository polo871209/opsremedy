export type AppType = "api" | "worker";

/** One Deployment that CI rolled out, with the facts CI read from its manifest, deploy configuration and build output. */
export type DeployTarget = {
  service: string;
  deployment: string;
  namespace: string;
  container: string;
  k8sService: string | null;
  appType: AppType;
  critical: boolean;
  rolloutResult: string;
  appliedAtMs: number;
  finishedAtMs: number;
  consumerGroups: string[] | null;
  unresolvedGroups: string[];
};

export const WINDOW_MS = 5 * 60 * 1000;

export function windowOf(t: DeployTarget): { baselineEndMs: number; startMs: number; endMs: number } {
  return { baselineEndMs: t.appliedAtMs, startMs: t.finishedAtMs, endMs: t.finishedAtMs + WINDOW_MS };
}
