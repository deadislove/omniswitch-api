import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MerchantService } from '../../../merchant/merchant.service';
import { DisputePort } from '../../ports/outbound/dispute.port';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';

// Any status where a real charge actually happened at the PSP — a later
// refund or dispute changes the payment's *current* status but doesn't
// change whether it was ever a settled charge in the first place. Same
// list PaymentTypeOrmRepository.findByProviderAndDateRange() already
// uses for the identical reason (reconciliation's "did this transaction
// really happen" question). Counting only SUCCEEDED would systematically
// *undercount* volume for exactly the merchants this service cares most
// about — a lost dispute moves the payment to REFUNDED, so a merchant's
// riskiest charges would silently fall out of their own denominator.
const SETTLED_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
  PaymentStatus.DISPUTED,
];

const WINDOW_DAYS = 90;
// Below this many settled charges in the window, a merchant's chargeback
// rate is statistical noise (one dispute out of 3 charges is a 33% "rate"
// that means nothing) — leave the reserve policy untouched rather than
// react to a sample too small to mean anything.
const MIN_SAMPLE_SIZE = 10;

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

interface TierPolicy {
  reserveBps: number;
  reserveHoldDays: number;
}

// Deliberately simple, round thresholds — an illustration of the
// mechanism ("chargeback rate drives reserve rate"), not a calibrated
// underwriting model. A real risk model would weigh MCC code, account
// tenure, dispute *reason* codes (fraud vs. "product not as described"
// carry very different signal), and probably a continuous function
// rather than 3 buckets. See docs/business-domain/future-directions.md's
// Merchant Risk Tiering section.
const TIER_POLICIES: Record<RiskTier, TierPolicy> = {
  LOW: { reserveBps: 0, reserveHoldDays: 0 },
  MEDIUM: { reserveBps: 500, reserveHoldDays: 30 },
  HIGH: { reserveBps: 1500, reserveHoldDays: 90 },
};

// Trailing lost-dispute rate (LOST disputes / SUCCEEDED charges) over
// WINDOW_DAYS. WON/still-open disputes don't count — a merchant that
// successfully contests every dispute against it isn't actually
// bleeding chargebacks, whatever the raw dispute-creation rate looks
// like. Defaults match the illustrative thresholds this file always
// used — overridable per-deployment (RISK_TIER_HIGH_THRESHOLD/
// RISK_TIER_MEDIUM_THRESHOLD, read in the constructor below) without a
// code change, not "calibrated" on their own; see this file's own
// docblock on TIER_POLICIES for why these are still illustrative.
const DEFAULT_HIGH_RISK_THRESHOLD = 0.01; // >1% lost-dispute rate
const DEFAULT_MEDIUM_RISK_THRESHOLD = 0.005; // >0.5% lost-dispute rate

function tierFor(lostDisputeRate: number, highThreshold: number, mediumThreshold: number): RiskTier {
  if (lostDisputeRate > highThreshold) return 'HIGH';
  if (lostDisputeRate > mediumThreshold) return 'MEDIUM';
  return 'LOW';
}

/**
 * Risk Tiering Service
 * Closes the gap the Merchant Risk Tiering & Reserves pass left open:
 * MerchantEntity.reserveBps/reserveHoldDays existed, but nothing decided
 * what they should *be* for a given merchant — an operator set them by
 * hand, and they never changed again on their own. This service
 * recomputes a trailing lost-dispute rate per merchant and adjusts the
 * reserve policy automatically — in both directions: a merchant whose
 * chargeback rate climbs gets a higher reserve/longer hold, and one that
 * cleans up its dispute history tapers back down, not just escalates.
 *
 * Only touches merchants with riskTierAutoManaged = true — an operator's
 * manual PATCH .../reserve-policy call disables it for that merchant (see
 * MerchantEntity's docblock), so a hand-tuned reserve doesn't get
 * silently overwritten by the next sweep tick. Re-enable via
 * PATCH .../risk-tier-auto.
 *
 * Only ever changes reserveBps/reserveHoldDays going forward — like
 * updateReservePolicy(), never retroactively touches already-booked
 * ReserveHold records.
 */
@Injectable()
export class RiskTieringService {
  private readonly logger = new Logger(RiskTieringService.name);
  // `ConfigService.get<number>()` doesn't actually cast (see
  // health.controller.ts's own comment on the same gap) — wrap explicitly.
  private readonly highRiskThreshold: number;
  private readonly mediumRiskThreshold: number;

  constructor(
    private readonly merchantService: MerchantService,
    private readonly disputePort: DisputePort,
    private readonly paymentRepository: PaymentRepositoryPort,
    configService: ConfigService,
  ) {
    this.highRiskThreshold = Number(configService.get('RISK_TIER_HIGH_THRESHOLD', DEFAULT_HIGH_RISK_THRESHOLD));
    this.mediumRiskThreshold = Number(configService.get('RISK_TIER_MEDIUM_THRESHOLD', DEFAULT_MEDIUM_RISK_THRESHOLD));
  }

  /**
   * Returns the computed tier and whether it caused a change — `null` if
   * there wasn't enough sample size to evaluate at all.
   */
  async evaluateMerchant(merchantId: string, now: Date): Promise<{ tier: RiskTier; changed: boolean } | null> {
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [settledCounts, lostDisputes] = await Promise.all([
      Promise.all(
        SETTLED_STATUSES.map((status) =>
          this.paymentRepository.count({ merchantId, status, fromDate: since, toDate: now }),
        ),
      ),
      this.disputePort.countByMerchantSince(merchantId, 'LOST', since),
    ]);
    const settledCharges = settledCounts.reduce((sum, n) => sum + n, 0);

    if (settledCharges < MIN_SAMPLE_SIZE) {
      return null;
    }

    const lostDisputeRate = lostDisputes / settledCharges;
    const tier = tierFor(lostDisputeRate, this.highRiskThreshold, this.mediumRiskThreshold);
    const policy = TIER_POLICIES[tier];

    const merchant = await this.merchantService.findByMerchantId(merchantId);
    const changed =
      !merchant || merchant.reserveBps !== policy.reserveBps || merchant.reserveHoldDays !== policy.reserveHoldDays;

    if (changed) {
      await this.merchantService.applyAutoRiskTier(merchantId, policy.reserveBps, policy.reserveHoldDays);
      this.logger.log(
        `Risk tier for merchant ${merchantId} -> ${tier} (${(lostDisputeRate * 100).toFixed(2)}% lost-dispute rate over ` +
          `${settledCharges} charges/${WINDOW_DAYS}d) — reserve now ${policy.reserveBps}bps/${policy.reserveHoldDays}d`,
      );
    }

    return { tier, changed };
  }

  /**
   * Daily sweep — every auto-managed, active merchant gets re-evaluated.
   * Also exposed on demand via POST /admin/risk-tiering/run (same dual
   * on-demand + scheduled shape as ReconciliationService/ReserveService/
   * SubscriptionService's billing sweep).
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'risk-tiering-sweep' })
  async runTieringSweep(now: Date = new Date()): Promise<{ evaluated: number; changed: number; skipped: number }> {
    const merchants = await this.merchantService.list();
    const candidates = merchants.filter((m) => m.isActive && m.riskTierAutoManaged);

    let evaluated = 0;
    let changed = 0;
    let skipped = 0;

    for (const merchant of candidates) {
      try {
        const result = await this.evaluateMerchant(merchant.merchantId, now);
        if (result === null) {
          skipped++;
        } else {
          evaluated++;
          if (result.changed) changed++;
        }
      } catch (err: unknown) {
        skipped++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Risk tiering sweep: failed to evaluate merchant ${merchant.merchantId}: ${msg}`);
      }
    }

    if (candidates.length > 0) {
      this.logger.log(
        `Risk tiering sweep: ${evaluated} evaluated (${changed} changed), ${skipped} skipped, ${candidates.length} auto-managed merchants`,
      );
    }
    return { evaluated, changed, skipped };
  }
}
