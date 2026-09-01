/**
 * A per-process counting semaphore — bounds how many callers of run() can
 * be mid-flight at once; anything beyond that queues (FIFO) until a permit
 * frees up, rather than being rejected outright. In-memory and per-pod on
 * purpose (not Redis-backed like RedisCircuitBreakerService): this exists
 * to protect *this pod's own* connection pool/event loop capacity from one
 * degrading dependency, not to coordinate a limit across replicas.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    this.available = maxConcurrent;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}
