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

  it('does not open the circuit on a single slow-but-successful call — one sample is not a reliable rate', async () => {
    // A single slow success can't tell "consistently degrading" apart from
    // "one call happened to be slow" — SLOW_CALL_MIN_CALLS exists precisely
    // to require more than one data point before treating latency as a
    // trip signal.
    await breaker.recordSuccess('STRIPE', 25_000);
    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined();
    const metrics = await breaker.getMetrics('STRIPE');
    expect(metrics.state).toBe('CLOSED');
  });

  it('opens the circuit on a slow-call-rate trip even though every call succeeded (no thrown exception at all)', async () => {
    // A PSP that hangs but never errors would otherwise be invisible to
    // the breaker no matter how slow it got, since recordFailure() (the
    // only other trip path) is never reached by a call that resolves
    // successfully.
    for (let i = 0; i < 5; i++) {
      await breaker.recordSuccess('STRIPE', 6_000); // over SLOW_CALL_THRESHOLD_MS (5s)
    }
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');
  });

  it('does not trip on the slow-call-rate path when most recent calls are fast', async () => {
    // 1 slow out of 5 is 20% — under SLOW_CALL_RATE_THRESHOLD (50%).
    await breaker.recordSuccess('STRIPE', 6_000);
    for (let i = 0; i < 4; i++) {
      await breaker.recordSuccess('STRIPE', 50);
    }
    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined();
  });

  it('trips on the slow-call-rate path once slow calls cross the 50% threshold', async () => {
    // 3 slow, 2 fast = 60% slow, over SLOW_CALL_RATE_THRESHOLD, and
    // SLOW_CALL_MIN_CALLS (5) has been reached.
    await breaker.recordSuccess('STRIPE', 6_000);
    await breaker.recordSuccess('STRIPE', 50);
    await breaker.recordSuccess('STRIPE', 6_000);
    await breaker.recordSuccess('STRIPE', 50);
    await breaker.recordSuccess('STRIPE', 6_000);
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');
  });

  it('trips even when the call that crosses SLOW_CALL_MIN_CALLS is itself fast', async () => {
    // 4 slow calls first (still under the 5-sample minimum, so no trip
    // yet), then one fast call that happens to be the 5th sample. The rate
    // (4/5 = 80%) is well past threshold and must still open the circuit —
    // the trip decision has to be evaluated on every call once the sample
    // size is met, not only on calls that were themselves slow.
    for (let i = 0; i < 4; i++) {
      await breaker.recordSuccess('STRIPE', 6_000);
    }
    await breaker.recordSuccess('STRIPE', 50);
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');
  });

  it('during HALF_OPEN, only a single trial call is let through — the rest are rejected like OPEN', async () => {
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('STRIPE');
    }
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');

    jest.advanceTimersByTime(31_000); // past RECOVERY_TIME_MS

    // First call transitions OPEN -> HALF_OPEN and is admitted as the
    // trial call.
    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined();

    // Every other call arriving while that trial is still outstanding
    // must be rejected — this is the actual thundering-herd bug: without
    // a trial budget, every call passes unconditionally the instant state
    // flips to HALF_OPEN, regardless of how many are in flight.
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');
  });

  it('a failed HALF_OPEN trial call re-opens the circuit immediately, not after FAILURE_THRESHOLD failures again', async () => {
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('STRIPE');
    }
    jest.advanceTimersByTime(31_000);
    await breaker.assertAvailable('STRIPE'); // admits the trial call, state -> HALF_OPEN

    // The trial call itself fails — a single failure, not FAILURE_THRESHOLD
    // (5) of them, must be enough to snap back to OPEN: the PSP is still
    // down, and letting more real traffic through while re-accumulating
    // the failure count is exactly the thundering-herd problem restated.
    await breaker.recordFailure('STRIPE');
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');
  });

  it('a new OPEN -> HALF_OPEN cycle after a failed trial gets its own fresh trial budget', async () => {
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('STRIPE');
    }
    jest.advanceTimersByTime(31_000);
    await breaker.assertAvailable('STRIPE'); // trial 1, state -> HALF_OPEN
    await breaker.recordFailure('STRIPE'); // trial fails, state -> OPEN again

    jest.advanceTimersByTime(31_000); // past RECOVERY_TIME_MS again

    // A stale trial-counter left over from the previous HALF_OPEN episode
    // must not carry over and immediately reject this new recovery
    // attempt's own trial call.
    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined();
  });

  it('recovers the slow-call window on TTL expiry once the PSP stops being slow', async () => {
    for (let i = 0; i < 4; i++) {
      await breaker.recordSuccess('STRIPE', 6_000);
    }
    // Still under SLOW_CALL_MIN_CALLS (5), circuit not yet open.
    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined();

    // The slow-call window (60s) fully lapses with no further calls.
    jest.advanceTimersByTime(61_000);

    // A fresh burst of fast calls afterward should not inherit the earlier
    // slow calls — this is a fresh window, not a naive all-time count.
    for (let i = 0; i < 5; i++) {
      await breaker.recordSuccess('STRIPE', 50);
    }
    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined();
  });

  it('the HALF_OPEN -> CLOSED recovery transition resets the slow-call window too', async () => {
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('STRIPE');
    }
    await expect(breaker.assertAvailable('STRIPE')).rejects.toThrow('OPEN');

    jest.advanceTimersByTime(31_000); // past RECOVERY_TIME_MS
    await breaker.assertAvailable('STRIPE'); // flips to HALF_OPEN

    await breaker.recordSuccess('STRIPE', 50); // closes the circuit
    const metrics = await breaker.getMetrics('STRIPE');
    expect(metrics.state).toBe('CLOSED');

    // A handful of fast calls right after recovery shouldn't be able to
    // combine with anything left over from before the outage.
    for (let i = 0; i < 4; i++) {
      await breaker.recordSuccess('STRIPE', 50);
    }
    await expect(breaker.assertAvailable('STRIPE')).resolves.toBeUndefined();
  });
});
