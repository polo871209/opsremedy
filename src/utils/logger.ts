// GCP Cloud Logging structured-logging format.
// https://docs.cloud.google.com/logging/docs/structured-logging
// stdout JSON lines are auto-parsed by the GKE logging agent.

type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

function emit(severity: Severity, message: string, fields?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    severity,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (severity === "ERROR") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function errFields(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { error: e.message, stack: e.stack };
  return { error: String(e) };
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("DEBUG", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("INFO", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("WARNING", message, fields),
  error: (message: string, e?: unknown, fields?: Record<string, unknown>) =>
    emit("ERROR", message, { ...(e !== undefined ? errFields(e) : {}), ...fields }),
};

function fromArgs(args: unknown[]): { message: string; fields?: Record<string, unknown> } {
  const flat = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  const words: string[] = [];
  const rest: unknown[] = [];
  for (const a of flat) {
    if (typeof a === "string") words.push(a);
    else rest.push(a);
  }
  const message = words.join(" ").trim() || JSON.stringify(flat);
  return rest.length ? { message, fields: { args: rest } } : { message };
}

export function makeSdkLogger(component: string) {
  const wrap =
    (level: "debug" | "info" | "warn" | "error") =>
    (...args: unknown[]) => {
      const { message, fields } = fromArgs(args);
      if (level === "error") log.error(message, undefined, { component, ...fields });
      else log[level](message, { component, ...fields });
    };
  return {
    error: wrap("error"),
    warn: wrap("warn"),
    info: wrap("info"),
    debug: wrap("debug"),
    trace: wrap("debug"),
  };
}
