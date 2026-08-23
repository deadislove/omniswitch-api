import { Injectable } from '@nestjs/common';
import { CachePort } from '../../ports/outbound/cache.port';
import { RedisCircuitBreakerService } from './redis-circuit-breaker.service';

// Sliding window (TTL-refresh-on-write, same pattern as
// RedisCircuitBreakerService's own counters) for tracking which PSP a
// merchant's recent charges actually resolved to. 60s matches
// CHARGE_RATE_LIMIT_TTL's default so the two windows align.
const ROUTING_HISTORY_WINDOW_SECONDS = 60;
// Below this many recent charges, "concentration" isn't a reliable signal
// — one charge landing on a degraded PSP is 100% concentrated but tells us
// nothing about this merchant's actual traffic pattern.
const ROUTING_HISTORY_MIN_SAMPLES = 3;
// Matches RedisCircuitBreakerService's own SLOW_CALL_RATE_THRESHOLD: more
// than half of recent charges landing on a currently degraded PSP is
// treated as real exposure, not noise.
const DEGRADED_CONCENTRATION_THRESHOLD = 0.5;

/**
 * Tracks, per merchant, which PSP their recent successful charges actually
 * resolved to — used by DegradedPspAwareThrottlerGuard to decide whether a
 * merchant's *next* charge attempt should get a stricter rate limit because
 * their traffic has been concentrated on a currently-degraded PSP.
 *
 * Deliberately about protecting the merchant's own throughput, not the
 * platform's overall load: a merchant whose recent charges are landing on
 * a healthy PSP (including via automatic fallback) is never throttled by
 * this, even if some *other* PSP is degraded — only a merchant whose own
 * traffic is actually concentrated on the degraded one is. See
 * docs/spec/future/distributed-resilience-and-cde-isolation.md.
 */
@Injectable()
export class MerchantPspExposureService {
  constructor(
    private readonly cache: CachePort,
    private readonly circuitBreaker: RedisCircuitBreakerService,
  ) {}

  private key(merchantId: string, provider: string): string {
    return `merchant-psp-routing:${merchantId}:${provider}`;
  }

  /** Call once a charge's actual PSP has been resolved, on success. */
  async recordRouting(merchantId: string, provider: string): Promise<void> {
    const key = this.key(merchantId, provider);
    await Promise.all([
      this.cache.incr(key),
      this.cache.expire(key, ROUTING_HISTORY_WINDOW_SECONDS),
    ]);
  }

  /**
   * True when this merchant's recent routing history is concentrated on a
   * PSP that is currently OPEN or HALF_OPEN.
   */
  async isExposedToDegradedPsp(merchantId: string, providers: string[]): Promise<boolean> {
    const counts = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        count: (await this.cache.get<number>(this.key(merchantId, provider))) ?? 0,
      })),
    );

    const total = counts.reduce((sum, c) => sum + c.count, 0);
    if (total < ROUTING_HISTORY_MIN_SAMPLES) return false;

    let degradedCount = 0;
    for (const { provider, count } of counts) {
      if (count === 0) continue;
      const metrics = await this.circuitBreaker.getMetrics(provider);
      if (metrics.state === 'OPEN' || metrics.state === 'HALF_OPEN') {
        degradedCount += count;
      }
    }

    return degradedCount / total >= DEGRADED_CONCENTRATION_THRESHOLD;
  }
}
