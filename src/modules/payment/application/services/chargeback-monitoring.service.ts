import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MerchantService } from '../../../merchant/merchant.service';
import { MerchantEntity } from '../../../merchant/merchant.entity';
import { DisputePort } from '../../ports/outbound/dispute.port';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { ChargebackMonitoringNotificationDispatcherService } from './chargeback-monitoring-notification-dispatcher.service';
import { ChargebackMonitoringTier } from '../../domain/services/chargeback-monitoring-tier';

// Same settled-status list RiskTieringService uses for its own
// denominator — a later refund/dispute changes a payment's *current*
// status but not whether it was ever a settled charge a network counts
// against this merchant's transaction volume.
const SETTLED_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
  PaymentStatus.DISPUTED,
];

// Real Visa VDMP / Mastercard ECP programs assess on a calendar-month
// basis, with a minimum absolute dispute count alongside the ratio
// (e.g. "100+ disputes AND 0.65%+ in a month") — simplified here to a
// rolling window with no minimum-count gate, matching this codebase's
// other monitoring windows (AmlReviewMonitoringService's
// AML_REVIEW_WINDOW_DAYS, RiskTieringService's 90-day window) rather
// than introducing calendar-month-boundary logic for one feature.
// MIN_SETTLED_CHARGES below plays the same "not enough signal yet" role
// the real minimum dispute count does, just expressed against the
// denominator instead of the numerator.
const WINDOW_DAYS = 30;
const MIN_SETTLED_CHARGES = 10;

// Deliberately illustrative, same posture as RiskTieringService's own
// thresholds (see that file's own docblock) — round numbers in the real
// neighborhood of Visa VDMP's published tiers (~0.65% "Early Warning",
// ~1.8% "Excessive"), left uncalibrated against this project's own
// synthetic data. Overridable per-deployment without a code change.
const DEFAULT_MONITORING_THRESHOLD = 0.0065; // >0.65% dispute rate
const DEFAULT_EXCESSIVE_THRESHOLD = 0.018; // >1.8% dispute rate

const SWEEP_BATCH_SIZE = 50;

function tierFor(
  disputeRate: number,
  excessiveThreshold: number,
  monitoringThreshold: number,
): ChargebackMonitoringTier {
  if (disputeRate > excessiveThreshold) return 'EXCESSIVE';
  if (disputeRate > monitoringThreshold) return 'MONITORING';
  return 'NONE';
}

/**
 * Chargeback Monitoring Service — models the mechanism real card
 * networks implement as Visa's Dispute Monitoring Program (VDMP) and
 * Mastercard's Excessive Chargeback Program (ECP): a merchant whose
 * dispute-to-settled-charge ratio crosses a published threshold gets
 * flagged, and a worse-crossing merchant gets flagged harder — purely a
 * network-compliance-exposure signal, independent of
 * `RiskTieringService`'s reserve-rate response to the same underlying
 * dispute history (see `MerchantEntity.chargebackMonitoringTier`'s own
 * docblock for the full contrast).
 *
 * Deliberately more than RiskTieringService under a different name,
 * despite the structural similarity: the numerator differs (every
 * dispute received in the window, counting all of them rather than
 * `LOST`-only — a network penalizes a chargeback landing at all,
 * before any outcome is known), the window differs (30d, closer to a
 * network's monthly cadence than RiskTieringService's 90d), and the
 * consequence differs — this service only ever flags and notifies; it
 * has no `ReserveService` dependency at all, so a reserve-rate change
 * is structurally impossible from here.
 *
 * Only ever touches `chargebackMonitoringAutoManaged` merchants — same
 * "manual input pauses automation" posture as every other auto-managed
 * flag in this codebase. A manual `PATCH .../chargeback-monitoring`
 * sets it to `false`; `PATCH .../chargeback-monitoring-auto` re-enables
 * it.
 *
 * Notifies on tier *change* in either direction — unlike
 * `AmlReviewMonitoringService` (notifies once on first trip, silent on
 * every subsequent incident while already flagged), both directions
 * are actionable here: an operator watching for a network compliance
 * fine obviously cares about escalation, but also wants to know the
 * moment a merchant works its way back out of the program.
 */
@Injectable()
export class ChargebackMonitoringService {
  private readonly logger = new Logger(ChargebackMonitoringService.name);
  private readonly monitoringThreshold: number;
  private readonly excessiveThreshold: number;
  private readonly windowDays: number;
  private readonly minSettledCharges: number;

  constructor(
    private readonly merchantService: MerchantService,
    private readonly disputePort: DisputePort,
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly notificationDispatcher: ChargebackMonitoringNotificationDispatcherService,
    configService: ConfigService,
  ) {
    this.monitoringThreshold = Number(
      configService.get('CHARGEBACK_MONITORING_THRESHOLD', DEFAULT_MONITORING_THRESHOLD),
    );
    this.excessiveThreshold = Number(configService.get('CHARGEBACK_EXCESSIVE_THRESHOLD', DEFAULT_EXCESSIVE_THRESHOLD));
    this.windowDays = Number(configService.get('CHARGEBACK_MONITORING_WINDOW_DAYS', WINDOW_DAYS));
    this.minSettledCharges = Number(
      configService.get('CHARGEBACK_MONITORING_MIN_SETTLED_CHARGES', MIN_SETTLED_CHARGES),
    );
  }

  /**
   * Looks the merchant up itself — for any caller that only has a
   * `merchantId`. `runMonitoringSweep()` below already has the full
   * `MerchantEntity` from its own batch fetch, so it calls
   * `evaluateMerchantEntity()` directly instead.
   */
  async evaluateMerchant(
    merchantId: string,
    now: Date,
  ): Promise<{ tier: ChargebackMonitoringTier; changed: boolean } | null> {
    const merchant = await this.merchantService.findByMerchantId(merchantId);
    if (!merchant) return null;
    return this.evaluateMerchantEntity(merchant, now);
  }

  private async evaluateMerchantEntity(
    merchant: MerchantEntity,
    now: Date,
  ): Promise<{ tier: ChargebackMonitoringTier; changed: boolean } | null> {
    if (!merchant.chargebackMonitoringAutoManaged) return null;

    const merchantId = merchant.merchantId;
    const since = new Date(now.getTime() - this.windowDays * 24 * 60 * 60 * 1000);

    const [settledCounts, disputeCount] = await Promise.all([
      Promise.all(
        SETTLED_STATUSES.map((status) =>
          this.paymentRepository.count({ merchantId, status, fromDate: since, toDate: now }),
        ),
      ),
      this.disputePort.countAllByMerchantSince(merchantId, since),
    ]);
    const settledCharges = settledCounts.reduce((sum, n) => sum + n, 0);

    if (settledCharges < this.minSettledCharges) return null;

    const disputeRate = disputeCount / settledCharges;
    const tier = tierFor(disputeRate, this.excessiveThreshold, this.monitoringThreshold);
    const previousTier = merchant.chargebackMonitoringTier;

    if (tier === previousTier) {
      return { tier, changed: false };
    }

    const reason = `${(disputeRate * 100).toFixed(2)}% dispute rate over ${settledCharges} settled charges/${this.windowDays}d (${disputeCount} disputes)`;
    await this.merchantService.applyAutoChargebackMonitoringTier(merchantId, tier, reason);
    this.logger.warn(`Merchant ${merchantId} chargeback-monitoring tier changed ${previousTier} -> ${tier}: ${reason}`);

    try {
      await this.notificationDispatcher.notify({
        event: 'chargeback_monitoring.tier_changed',
        merchantId,
        previousTier,
        tier,
        reason,
        disputeCount,
        settledCharges,
        windowDays: this.windowDays,
      });
    } catch (err: unknown) {
      // Same "notification failure must never mask the tier change
      // having been recorded correctly" posture as
      // AmlReviewMonitoringService.evaluate()'s own try/catch.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Chargeback-monitoring notification failed for merchant ${merchantId} (tier still correctly set): ${msg}`,
      );
    }

    return { tier, changed: true };
  }

  /**
   * Daily, at 3AM — a different slot from RiskTieringService's 2AM, so
   * both sweeps' batched DB reads never land in the same minute. Same
   * keyset-pagination/`Promise.allSettled()` shape as
   * `RiskTieringService.runTieringSweep()` (see that method's own
   * docblock for why: one failing merchant's evaluation must never
   * abort the whole sweep, and a batch never contains a row this sweep
   * was going to skip anyway).
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'chargeback-monitoring-sweep' })
  async runMonitoringSweep(now: Date = new Date()): Promise<{ evaluated: number; changed: number; skipped: number }> {
    let evaluated = 0;
    let changed = 0;
    let skipped = 0;
    let totalCandidates = 0;
    let afterId: string | undefined;

    for (;;) {
      const batch = await this.merchantService.findActiveChargebackMonitoringAutoManagedBatch(
        afterId,
        SWEEP_BATCH_SIZE,
      );
      if (batch.length === 0) break;
      totalCandidates += batch.length;

      const results = await Promise.allSettled(batch.map((merchant) => this.evaluateMerchantEntity(merchant, now)));
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          skipped++;
          const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.logger.error(`Chargeback monitoring sweep: failed to evaluate merchant ${batch[i].merchantId}: ${msg}`);
          return;
        }
        if (result.value === null) {
          skipped++;
        } else {
          evaluated++;
          if (result.value.changed) changed++;
        }
      });

      afterId = batch[batch.length - 1].id;
      if (batch.length < SWEEP_BATCH_SIZE) break;
    }

    if (totalCandidates > 0) {
      this.logger.log(
        `Chargeback monitoring sweep: ${evaluated} evaluated (${changed} changed), ${skipped} skipped, ${totalCandidates} auto-managed merchants`,
      );
    }
    return { evaluated, changed, skipped };
  }
}
