export interface Alert {
  name: string;
  source: string;
  severity: string;
  service?: string;
  message?: string;
  startedAt?: string;
  endedAt?: string;
  labels?: Record<string, string>;
}
