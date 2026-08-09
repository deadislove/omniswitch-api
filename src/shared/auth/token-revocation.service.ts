import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const JTI_PREFIX = 'revoked:jti:';
const MERCHANT_PREFIX = 'revoked-before:';
// Safety margin for the merchant-wide revocation marker's own TTL — it just
// needs to outlive any token that could still be presented, not live forever.
const MERCHANT_REVOCATION_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Token Revocation Service
 * JWTs are stateless by design (no DB hit needed to verify one), which means
 * there was previously no way to invalidate a token before it naturally
 * expired — deactivating a merchant didn't stop their already-issued tokens
 * from working for up to another hour. This adds two revocation lists in
 * Redis, checked by JwtStrategy.validate() on every request:
 *
 * 1. Per-token (jti) — for self-service logout (POST /auth/revoke).
 * 2. Per-merchant (issued-before cutoff) — for admin-triggered "log out
 *    everywhere" and automatically on merchant deactivation.
 *
 * Uses its own ioredis connection rather than the payment module's
 * CachePort/RedisCacheAdapter to avoid a circular import (AuthModule is
 * imported by PaymentModule, which owns CachePort) — this is a small,
 * distinct concern from payment idempotency caching anyway.
 */
@Injectable()
export class TokenRevocationService implements OnModuleDestroy {
  private readonly logger = new Logger(TokenRevocationService.name);
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
  }

  /** Revoke a single token. TTL matches its remaining lifetime — no point outliving the token itself. */
  async revokeToken(jti: string, remainingLifetimeSeconds: number): Promise<void> {
    if (remainingLifetimeSeconds <= 0) return;
    await this.client.set(`${JTI_PREFIX}${jti}`, '1', 'EX', remainingLifetimeSeconds);
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    return (await this.client.exists(`${JTI_PREFIX}${jti}`)) === 1;
  }

  /** Revoke every token issued for a merchant up to now (deactivation, credential compromise, "log out everywhere"). */
  async revokeAllForMerchant(merchantId: string): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    await this.client.set(
      `${MERCHANT_PREFIX}${merchantId}`,
      String(nowSeconds),
      'EX',
      MERCHANT_REVOCATION_TTL_SECONDS,
    );
  }

  /** True if a token with this issued-at time predates the merchant's last "revoke all" action. */
  async isMerchantTokenRevoked(merchantId: string, tokenIssuedAt: number): Promise<boolean> {
    const revokedBefore = await this.client.get(`${MERCHANT_PREFIX}${merchantId}`);
    if (!revokedBefore) return false;
    return tokenIssuedAt <= Number(revokedBefore);
  }

  async onModuleDestroy(): Promise<void> {
    // Tolerate an already-closed connection — see RedisThrottlerStorage for
    // why this is a "goal already met" case, not a real failure.
    try {
      await this.client.quit();
    } catch (err: unknown) {
      this.logger.debug(`Redis client already closed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
