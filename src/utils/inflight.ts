const inflight = new Set<Promise<unknown>>();

export const DRAIN_TIMEOUT_MS = 110_000;

export function track<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
}

export function inflightCount(): number {
  return inflight.size;
}

export async function drain(timeoutMs: number): Promise<{ done: boolean; remaining: number }> {
  if (inflight.size === 0) return { done: true, remaining: 0 };
  await Promise.race([Promise.allSettled([...inflight]), new Promise((res) => setTimeout(res, timeoutMs))]);
  return { done: inflight.size === 0, remaining: inflight.size };
}
