export interface Alert {
  name: string;
  source: string;
  severity: string;
  service?: string;
  message?: string;
  startedAt?: string;
  endedAt?: string;
  labels?: Record<string, string>;
  /** Tool calls the source of the alert picked from facts it already holds, run before the first turn like seed-calls.yaml. */
  seedCalls?: { tool: string; args: Record<string, unknown> }[];
}
