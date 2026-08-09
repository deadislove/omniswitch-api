import { Injectable } from '@nestjs/common';
import { CachePort } from '../../ports/outbound/cache.port';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitMetrics {
  state: CircuitState;
  successCount: number;
  totalRequests: number;
  avgLatencyMs: number;
}

const FAILURE_THRESHOLD = 5;
const RECOVERY_TIME_MS = 30000;

// Reported health metrics (successCount/totalRequests/avgLatencyMs) are a
// sliding window made of fixed 1-minute buckets — same fixed-window-counter
// trade-off already used for rate limiting (see
// docs/technical/distributed-state.md): a true sliding log (one Redis
// member per request, e.g. a sorted set) would be more precise but costs a
// write per request instead of one INCR into whichever minute is current.
// For "is this PSP healthy right now," minute-granularity is more than
// enough. failureCount (the OPEN-trip trigger, below) is intentionally NOT
// part of this window — it already resets on HALF_OPEN -> CLOSED recovery,
// which is a different, already-correct mechanism.
const METRICS_BUCKET_SECONDS = 60;
const METRICS_WINDOW_MINUTES = 15;
const METRICS_BUCKET_TTL_SECONDS = (METRICS_WINDOW_MINUTES + 5) * 60;

/**
 * Redis-Backed Circuit Breaker
 *
 * StripePSPAdapter/AdyenPSPAdapter used to keep circuit breaker state
 * (failure count, OPEN/HALF_OPEN/CLOSED, success/latency metrics) in plain
 * instance fields. That's per-process — with multiple replicas, each pod
 * independently decides whether a PSP is healthy, so one pod can keep
 * hammering a PSP its siblings have already tripped the breaker on, and the
 * "success rate" shown by GET /payments/routing/health only reflects
 * whichever pod answered that specific request. This moves the state into
 * Redis (via the existing CachePort, no new connection) so every replica
 * shares one view per PSP provider.
 *
 * Reported metrics (successCount/totalRequests/avgLatencyMs, via
 * getMetrics()) cover a rolling METRICS_WINDOW_MINUTES-minute window, not
 * all-time — they used to be plain cumulative counters that never reset for
 * as long as the Redis keys lived, meaning a bad incident from months ago
 * stayed baked into the reported success rate forever. Fixed by bucketing
 * writes into per-minute keys (each with its own short TTL) and summing the
 * last METRICS_WINDOW_MINUTES of them at read time.
 */
@Injectable()
export class RedisCircuitBreakerService {
  constructor(private readonly cache: CachePort) {}

  private key(provider: string, field: string): string {
    return `circuit:${provider}:${field}`;
  }

  private currentEpochMinute(): number {
    return Math.floor(Date.now() / (METRICS_BUCKET_SECONDS * 1000));
  }

  private bucketKey(provider: string, field: 'success' | 'total' | 'latencyMs', epochMinute: number): string {
    return `circuit:${provider}:bucket:${epochMinute}:${field}`;
  }

  private async incrBucket(bucketKey: string, by = 1): Promise<void> {
    // TTL is refreshed on every write to that bucket, which is harmless
    // here (unlike the rate limiter, over-extending this TTL doesn't change
    // the window's meaning — each bucket's *key name* is what pins it to a
    // specific minute, not its expiry).
    await this.cache.pipeline([
      ['incrby', bucketKey, by],
      ['expire', bucketKey, METRICS_BUCKET_TTL_SECONDS],
    ]);
  }

  /** Throws if the circuit is OPEN and the recovery window hasn't elapsed yet. */
  async assertAvailable(provider: string): Promise<void> {
    const state = (await this.cache.get<CircuitState>(this.key(provider, 'state'))) ?? 'CLOSED';
    if (state !== 'OPEN') return;

    const lastFailureTime = await this.cache.get<number>(this.key(provider, 'lastFailureTime'));
    if (lastFailureTime && Date.now() - lastFailureTime > RECOVERY_TIME_MS) {
      // Benign race if two replicas both flip this at once — same target value.
      await this.cache.set(this.key(provider, 'state'), 'HALF_OPEN');
      return;
    }

    throw new Error(`${provider} circuit breaker is OPEN. Service unavailable.`);
  }

  async recordSuccess(provider: string, latencyMs: number): Promise<void> {
    const epoch = this.currentEpochMinute();
    await Promise.all([
      this.incrBucket(this.bucketKey(provider, 'success', epoch)),
      this.incrBucket(this.bucketKey(provider, 'total', epoch)),
      this.incrBucket(this.bucketKey(provider, 'latencyMs', epoch), latencyMs),
    ]);

    const state = await this.cache.get<CircuitState>(this.key(provider, 'state'));
    if (state === 'HALF_OPEN') {
      await this.cache.set(this.key(provider, 'state'), 'CLOSED');
      await this.cache.set(this.key(provider, 'failureCount'), 0);
    }
  }

  async recordFailure(provider: string): Promise<void> {
    const epoch = this.currentEpochMinute();
    const [failureCount] = await Promise.all([
      this.cache.incr(this.key(provider, 'failureCount')),
      this.incrBucket(this.bucketKey(provider, 'total', epoch)),
      this.cache.set(this.key(provider, 'lastFailureTime'), Date.now()),
    ]);

    if (failureCount >= FAILURE_THRESHOLD) {
      await this.cache.set(this.key(provider, 'state'), 'OPEN');
    }
  }

  async getMetrics(provider: string): Promise<CircuitMetrics> {
    const state = (await this.cache.get<CircuitState>(this.key(provider, 'state'))) ?? 'CLOSED';

    const currentEpoch = this.currentEpochMinute();
    const commands: Array<[string, ...unknown[]]> = [];
    for (let i = 0; i < METRICS_WINDOW_MINUTES; i++) {
      const epoch = currentEpoch - i;
      commands.push(['get', this.bucketKey(provider, 'success', epoch)]);
      commands.push(['get', this.bucketKey(provider, 'total', epoch)]);
      commands.push(['get', this.bucketKey(provider, 'latencyMs', epoch)]);
    }
    const results = await this.cache.pipeline(commands);

    let successCount = 0;
    let totalRequests = 0;
    let totalLatencyMs = 0;
    for (let i = 0; i < METRICS_WINDOW_MINUTES; i++) {
      successCount += Number(results[i * 3]) || 0;
      totalRequests += Number(results[i * 3 + 1]) || 0;
      totalLatencyMs += Number(results[i * 3 + 2]) || 0;
    }

    return {
      state,
      successCount,
      totalRequests,
      avgLatencyMs: totalRequests > 0 ? totalLatencyMs / totalRequests : 0,
    };
  }

  async isAvailable(provider: string): Promise<boolean> {
    const state = (await this.cache.get<CircuitState>(this.key(provider, 'state'))) ?? 'CLOSED';
    return state !== 'OPEN';
  }
}
