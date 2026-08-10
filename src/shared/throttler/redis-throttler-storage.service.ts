import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ThrottlerStorage } from '@nestjs/throttler';

// @nestjs/throttler's own ThrottlerStorageRecord type isn't re-exported
// from the package's public entry point (only ThrottlerStorage is) —
// declared locally instead of a fragile deep import into its dist/ layout.
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-Backed Throttler Storage
 *
 * @nestjs/throttler's default ThrottlerStorageService keeps counters in a
 * plain in-process object. That's invisible across replicas: this API's K8s
 * HPA scales to 20 pods (see k8s/hpa.yaml), and each one would enforce
 * "100 req/min per merchant" independently — meaning the *actual* aggregate
 * limit for a merchant hitting multiple pods could be up to 20x the
 * documented number, with no coordination between them at all. Same problem
 * for the global IP-scoped limiter. This makes every replica share one
 * Redis-backed counter per (throttler, tracker) key instead.
 *
 * Uses a fixed-window counter (INCR, then EXPIRE only on the first hit in a
 * window) rather than replicating the in-memory implementation's per-hit
 * sliding decay — a standard, well-understood trade-off for distributed
 * rate limiting (small burst allowance right at a window boundary, in
 * exchange for O(1) storage and a single atomic round-trip per check).
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD'),
      db: this.configService.get<number>('REDIS_DB', 0),
      lazyConnect: false,
    });
    this.client.on('error', (err) => this.logger.error('Redis error', err));

    // Atomic increment-and-conditionally-set-TTL — must be a single script
    // to avoid a race between INCR and EXPIRE (two concurrent requests could
    // otherwise both see themselves as "first hit" and both set a fresh TTL,
    // effectively extending the window forever under sustained traffic).
    this.client.defineCommand('throttlerIncrement', {
      numberOfKeys: 1,
      lua: `
        local current = redis.call("INCR", KEYS[1])
        if current == 1 then
          redis.call("PEXPIRE", KEYS[1], ARGV[1])
        end
        local pttl = redis.call("PTTL", KEYS[1])
        return {current, pttl}
      `,
    });
  }

  // @nestjs/throttler v6 widened this interface to support a separate
  // "block duration" beyond the counting window (isBlocked/
  // timeToBlockExpire) — and, more importantly, ThrottlerGuard now trusts
  // isBlocked entirely to decide whether to throw 429, instead of
  // comparing totalHits > limit itself. This implementation deliberately
  // doesn't add a real block-duration feature (still the same fixed-window
  // design this class's docblock describes) — it just computes isBlocked
  // from the same totalHits > limit check the guard used to do, so a
  // blocked key un-blocks exactly when the counting window itself expires,
  // preserving this app's actual behavior instead of silently defaulting
  // to "never blocked" (which would have made every rate limit a no-op).
  async increment(key: string, ttl: number, limit: number): Promise<ThrottlerStorageRecord> {
    const prefixedKey = `throttle:${key}`;
    const [totalHits, pttl] = (await (this.client as any).throttlerIncrement(
      prefixedKey,
      ttl,
    )) as [number, number];

    const timeToExpire = Math.max(0, Math.ceil(pttl / 1000));
    const isBlocked = totalHits > limit;

    return {
      totalHits,
      timeToExpire,
      isBlocked,
      timeToBlockExpire: isBlocked ? timeToExpire : 0,
    };
  }

  async onModuleDestroy(): Promise<void> {
    // Tolerate an already-closed/closing connection (e.g. Redis dropped the
    // connection first, or something else in the shutdown sequence already
    // closed it) — the goal of this hook is "make sure it's closed," and
    // quit() throwing "Connection is closed" on an already-closed client
    // means that goal is already met, not a real shutdown failure.
    try {
      await this.client.quit();
    } catch (err: unknown) {
      this.logger.debug(`Redis client already closed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
