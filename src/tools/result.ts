export function textResult(obj: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    details: null,
    isError,
  };
}

function errText(e: unknown): string {
  if (e && typeof e === "object" && "body" in e) {
    const b = (e as { body?: { message?: string } }).body;
    if (b?.message) return b.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function errResult(e: unknown) {
  return textResult(`Error: ${errText(e)}`, true);
}

export function guarded<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R | ReturnType<typeof errResult>> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return errResult(e);
    }
  };
}
