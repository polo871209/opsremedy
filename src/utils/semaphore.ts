export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  active(): number;
  queued(): number;
}

export function makeSemaphore(max: number): Semaphore {
  let n = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire: () =>
      new Promise<void>((res) => {
        if (n < max) {
          n++;
          res();
        } else {
          waiters.push(res);
        }
      }),
    release: () => {
      const next = waiters.shift();
      if (next) next();
      else n--;
    },
    active: () => n,
    queued: () => waiters.length,
  };
}
