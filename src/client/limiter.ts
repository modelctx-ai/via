/** Counting semaphore: at most `limit` tasks run at once, the rest wait in arrival order (daemon.md, "并发"). */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`concurrency must be a positive integer, got ${limit}`);
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Run `task` once a slot is free. With `wait`, a task still queued after `wait.ms` leaves the queue
   * without running and the call rejects with `wait.error()`.
   */
  async run<T>(task: () => Promise<T>, wait?: { ms: number; error: () => Error }): Promise<T> {
    if (this.active >= this.limit) await this.slot(wait);
    else this.active += 1;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot over without releasing it
      else this.active -= 1;
    }
  }

  private slot(wait?: { ms: number; error: () => Error }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const take = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiting.push(take);
      if (!wait) return;
      timer = setTimeout(() => {
        const index = this.waiting.indexOf(take);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        reject(wait.error());
      }, wait.ms);
    });
  }
}
