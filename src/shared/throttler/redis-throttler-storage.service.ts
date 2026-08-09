import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ThrottlerStorage } from '@nestjs/throttler';

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

  async increment(key: string, ttl: number): Promise<{ totalHits: number; timeToExpire: number }> {
    const prefixedKey = `throttle:${key}`;
    const [totalHits, pttl] = (await (this.client as any).throttlerIncrement(
      prefixedKey,
      ttl,
    )) as [number, number];

    return {
      totalHits,
      timeToExpire: Math.max(0, Math.ceil(pttl / 1000)),
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
