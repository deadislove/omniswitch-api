import { Injectable } from '@nestjs/common';
import { CachePort } from '../../ports/outbound/cache.port';

// A streak with no activity for this long is stale enough to let expire
// naturally rather than track forever — a payment method that stops
// transacting shouldn't hold Redis memory indefinitely. Comfortably
// longer than any real gap between legitimate recurring charges.
const STREAK_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Tracks the real PSD2 rule `evaluateScaExemption()`'s own docblock
 * describes: a payment method can ride on consecutive LOW_VALUE
 * exemptions only up to a cap before a fresh challenge is due. Keyed on
 * `paymentMethodId` — the one stable per-card reference this codebase
 * ever has (this platform never persists a raw PAN or a BIN-level
 * identifier precise enough to track an individual card); a one-off
 * `cardToken` charge has no reasonable key to track against at all, so
 * `PaymentCheckoutSaga` simply never calls this for one.
 */
@Injectable()
export class ScaExemptionTrackerService {
  constructor(private readonly cache: CachePort) {}

  private key(paymentMethodId: string): string {
    return `sca-exemption-streak:${paymentMethodId}`;
  }

  async getStreak(paymentMethodId: string): Promise<number> {
    return (await this.cache.get<number>(this.key(paymentMethodId))) ?? 0;
  }

  /** Called when a LOW_VALUE exemption was actually requested on a charge that went through without a challenge — advances the streak toward the cap. */
  async recordLowValueExemptionUsed(paymentMethodId: string): Promise<void> {
    await this.cache.incr(this.key(paymentMethodId));
    await this.cache.expire(this.key(paymentMethodId), STREAK_TTL_SECONDS);
  }

  /** Called whenever a real challenge happens (no exemption requested, or the PSP's own engine still issued one) — a fresh authentication resets how many consecutive exemptions this payment method has ridden on. */
  async resetStreak(paymentMethodId: string): Promise<void> {
    await this.cache.del(this.key(paymentMethodId));
  }
}
