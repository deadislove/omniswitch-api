import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CachePort } from '../../ports/outbound/cache.port';

/**
 * Redis Cache Adapter
 * Implements CachePort using ioredis.
 * Supports distributed locking (SETNX), atomic operations, and TTL management.
 */
@Injectable()
export class RedisCacheAdapter extends CachePort implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheAdapter.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    super();
    this.client = new Redis({
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      password: configService.get<string>('REDIS_PASSWORD'),
      db: configService.get<number>('REDIS_DB', 0),
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        this.logger.warn(`Redis reconnecting... attempt ${times}, delay ${delay}ms`);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('error', (err) => this.logger.error('Redis error', err));
    this.client.on('ready', () => this.logger.log('Redis ready'));
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (value === null) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, serialized);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  /**
   * Atomic SETNX with TTL for distributed idempotency locking.
   * Uses SET key value NX EX ttl (atomic in Redis 2.6.12+)
   */
  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async pipeline(commands: Array<[string, ...unknown[]]>): Promise<unknown[]> {
    const pipe = this.client.pipeline();
    for (const [cmd, ...args] of commands) {
      (pipe as any)[cmd](...args);
    }
    const results = await pipe.exec();
    return (results || []).map(([err, result]) => {
      if (err) throw err;
      return result;
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    // Tolerate an already-closed connection — see RedisThrottlerStorage for
    // why this is a "goal already met" case, not a real failure.
    try {
      await this.client.quit();
      this.logger.log('Redis connection closed');
    } catch (err: unknown) {
      this.logger.debug(`Redis client already closed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
