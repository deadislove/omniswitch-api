import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Merchant-Scoped Throttler Guard
 * README/Swagger docs advertise "100 req/min per merchant", but the global
 * ThrottlerGuard (APP_GUARD in AppModule) keys on IP address — the default
 * NestJS behavior. That means multiple merchants sharing a NAT/corporate IP
 * share one quota, and a single merchant rotating source IPs can bypass
 * their own limit entirely.
 *
 * Applied at the controller level *after* JwtAuthGuard (see PaymentController
 * @UseGuards order), so req.user is already populated by the time this runs
 * — Nest guards execute in the order they're listed, and this needs to run
 * after authentication to know which merchant it's throttling.
 *
 * This layers on top of the global IP-based guard rather than replacing it:
 * the IP-based one still catches unauthenticated abuse; this one stops a
 * single compromised/misbehaving merchant credential from being amplified
 * by using multiple source IPs.
 */
@Injectable()
export class MerchantThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.merchantId ? `merchant:${req.user.merchantId}` : `ip:${req.ip}`;
  }
}
