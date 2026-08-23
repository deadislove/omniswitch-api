import { RedisCircuitBreakerService } from './redis-circuit-breaker.service';
import { CachePort } from '../../ports/outbound/cache.port';

/**
 * In-memory CachePort with real TTL semantics (keyed off Date.now(), which
 * jest's fake timers override) — needed to prove the sliding-window fix
 * actually behaves correctly over time, not just that expire() was called
 * with the right argument.
 */
class FakeCachePort extends CachePort {
  private store = new Map<string, { value: unknown; expiresAt: number | null }>();

  private isExpired(entry: { expiresAt: number | null }): boolean {
    return entry.expiresAt !== null && Date.now() >= entry.expiresAt;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry || this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async incr(key: string): Promise<number> {
    const current = (await this.get<number>(key)) ?? 0;
    const next = current + 1;
    const entry = this.store.get(key);
    const expiresAt = entry && !this.isExpired(entry) ? entry.expiresAt : null;
    this.store.set(key, { value: next, expiresAt });
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = this.store.get(key);
    if (entry && !this.isExpired(entry)) {
      entry.expiresAt = Date.now() + ttlSeconds * 1000;
    }
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || this.isExpired(entry) || entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }

  async pipeline(commands: Array<[string, ...unknown[]]>): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const [cmd, ...args] of commands) {
      if (cmd === 'incrby') {
        const [key, by] = args as [string, number];
        const current = (await this.get<number>(key)) ?? 0;
        const next = current + by;
        const entry = this.store.get(key);
        const expiresAt = entry && !this.isExpired(entry) ? entry.expiresAt : null;
        this.store.set(key, { value: next, expiresAt });
        results.push(next);
      } else if (cmd === 'expire') {
        const [key, ttlSeconds] = args as [string, number];
        await this.expire(key, ttlSeconds);
        results.push(1);
      } else if (cmd === 'get') {
        const [key] = args as [string];
        results.push(await this.get(key));
      } else {
        throw new Error(`FakeCachePort.pipeline: unsupported command "${cmd}"`);
      }
    }
    return results;
  }
}

describe('RedisCircuitBreakerService', () => {
  let cache: FakeCachePort;
  let breaker: RedisCircuitBreakerService;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new FakeCachePort();
    breaker = new RedisCircuitBreakerService(cache);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens the circuit after 5 failures within the sliding window', async () => {
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('STRIPE');
    }
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('STRIPE circuit breaker is OPEN');
  });

  it('does not trip when failures are scattered across gaps longer than the failure window', async () => {
    // 3 failures now.
    await breaker.recordFailure('STRIPE');
    await breaker.recordFailure('STRIPE');
    await breaker.recordFailure('STRIPE');

    // Advance past the 60s sliding window — those 3 no longer count.
    jest.advanceTimersByTime(61_000);

    // 2 more failures. Naive cumulative counting (the pre-fix behavior)
    // would see 5 "ever" and trip; the sliding window must not.
    await breaker.recordFailure('STRIPE');
    await breaker.recordFailure('STRIPE');

    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined();
  });

  it('still trips on a fresh burst that reaches the threshold after the window has reset', async () => {
    await breaker.recordFailure('STRIPE');
    await breaker.recordFailure('STRIPE');
    jest.advanceTimersByTime(61_000);

    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('STRIPE');
    }

    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');
  });

  it('does not reset the window on every failure past what is needed — a burst within 60s still trips', async () => {
    // Failures spaced 20s apart, all within the 60s window, should still
    // accumulate toward the threshold rather than each one individually
    // needing to be within 60s of every other one.
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('STRIPE');
      jest.advanceTimersByTime(20_000);
    }
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');
  });

  it('transitions OPEN -> HALF_OPEN after the recovery window, and back to CLOSED on a subsequent success', async () => {
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('STRIPE');
    }
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');

    jest.advanceTimersByTime(31_000); // past RECOVERY_TIME_MS (30s)
    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined(); // flips to HALF_OPEN

    await breaker.recordSuccess('STRIPE', 50);
    const metrics = await breaker.getMetrics('STRIPE');
    expect(metrics.state).toBe('CLOSED');
  });

  it('does not open the circuit on a slow-but-successful call', async () => {
    // recordSuccess with high latency must not be treated as a failure —
    // the circuit breaker only opens on a thrown exception (recordFailure),
    // never on latency alone, by current design.
    await breaker.recordSuccess('STRIPE', 25_000);
    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined();
    const metrics = await breaker.getMetrics('STRIPE');
    expect(metrics.state).toBe('CLOSED');
  });
});
