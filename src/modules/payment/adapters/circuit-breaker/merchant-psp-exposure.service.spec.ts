import { MerchantPspExposureService } from './merchant-psp-exposure.service';
import { RedisCircuitBreakerService } from './redis-circuit-breaker.service';
import { CachePort } from '../../ports/outbound/cache.port';

/**
 * Minimal in-memory CachePort — only the operations
 * MerchantPspExposureService/RedisCircuitBreakerService actually use here
 * (get/set/incr/expire). Real TTL semantics keyed off Date.now(), which
 * jest's fake timers override.
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

describe('MerchantPspExposureService', () => {
  let cache: FakeCachePort;
  let circuitBreaker: RedisCircuitBreakerService;
  let exposure: MerchantPspExposureService;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new FakeCachePort();
    circuitBreaker = new RedisCircuitBreakerService(cache);
    exposure = new MerchantPspExposureService(cache, circuitBreaker);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is not exposed with too few recent samples, even if 100% landed on a degraded PSP', async () => {
    for (let i = 0; i < 5; i++) await circuitBreaker.recordFailure('STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');

    expect(await exposure.isExposedToDegradedPsp('merchant_1', ['STRIPE', 'ADYEN'])).toBe(false);
  });

  it('is not exposed when recent charges landed on a healthy PSP, even while another PSP is degraded', async () => {
    for (let i = 0; i < 5; i++) await circuitBreaker.recordFailure('STRIPE');
    await exposure.recordRouting('merchant_1', 'ADYEN');
    await exposure.recordRouting('merchant_1', 'ADYEN');
    await exposure.recordRouting('merchant_1', 'ADYEN');

    expect(await exposure.isExposedToDegradedPsp('merchant_1', ['STRIPE', 'ADYEN'])).toBe(false);
  });

  it('is exposed once enough recent charges are concentrated on a currently OPEN PSP', async () => {
    for (let i = 0; i < 5; i++) await circuitBreaker.recordFailure('STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');
    await exposure.recordRouting('merchant_1', 'ADYEN');

    expect(await exposure.isExposedToDegradedPsp('merchant_1', ['STRIPE', 'ADYEN'])).toBe(true);
  });

  it('is exposed while the degraded PSP is HALF_OPEN too, not just OPEN', async () => {
    for (let i = 0; i < 5; i++) await circuitBreaker.recordFailure('STRIPE');
    jest.advanceTimersByTime(31_000); // past RECOVERY_TIME_MS — flips to HALF_OPEN on next check
    await circuitBreaker.assertAvailable('STRIPE');

    await exposure.recordRouting('merchant_1', 'STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');

    expect(await exposure.isExposedToDegradedPsp('merchant_1', ['STRIPE', 'ADYEN'])).toBe(true);
  });

  it('is not exposed once concentration drops back under the 50% threshold', async () => {
    for (let i = 0; i < 5; i++) await circuitBreaker.recordFailure('STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');
    await exposure.recordRouting('merchant_1', 'ADYEN');
    await exposure.recordRouting('merchant_1', 'ADYEN');

    expect(await exposure.isExposedToDegradedPsp('merchant_1', ['STRIPE', 'ADYEN'])).toBe(false);
  });

  it('tracks merchants independently — one merchant is exposed, another is not', async () => {
    for (let i = 0; i < 5; i++) await circuitBreaker.recordFailure('STRIPE');
    await exposure.recordRouting('merchant_exposed', 'STRIPE');
    await exposure.recordRouting('merchant_exposed', 'STRIPE');
    await exposure.recordRouting('merchant_exposed', 'STRIPE');
    await exposure.recordRouting('merchant_healthy', 'ADYEN');
    await exposure.recordRouting('merchant_healthy', 'ADYEN');
    await exposure.recordRouting('merchant_healthy', 'ADYEN');

    expect(await exposure.isExposedToDegradedPsp('merchant_exposed', ['STRIPE', 'ADYEN'])).toBe(true);
    expect(await exposure.isExposedToDegradedPsp('merchant_healthy', ['STRIPE', 'ADYEN'])).toBe(false);
  });

  it('the routing-history window naturally expires — old concentration does not persist forever', async () => {
    for (let i = 0; i < 5; i++) await circuitBreaker.recordFailure('STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');
    await exposure.recordRouting('merchant_1', 'STRIPE');
    expect(await exposure.isExposedToDegradedPsp('merchant_1', ['STRIPE', 'ADYEN'])).toBe(true);

    jest.advanceTimersByTime(61_000); // past the 60s routing-history window

    expect(await exposure.isExposedToDegradedPsp('merchant_1', ['STRIPE', 'ADYEN'])).toBe(false);
  });
});
