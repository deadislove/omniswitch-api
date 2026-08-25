import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { MerchantService } from '../../../merchant/merchant.service';

/**
 * Ambiguous Risk Monitoring Service — Phase 2.a of the AMBIGUOUS-resolution
 * gap (see docs/spec/future/ambiguous-payment-resolution.md). Purely
 * observational: flags a merchant whose AMBIGUOUS incidents cross either
 * of two thresholds, so an operator can see it — does **not** change how
 * that merchant's charges are processed (no throttling, no forced
 * review). Whether to add an active-enforcement phase (2.b) is a
 * deliberately separate, not-yet-made decision — see that doc.
 *
 * Two independent triggers, evaluated per merchant right after one of
 * their payments transitions to AMBIGUOUS (see evaluate(), called from
 * PaymentCheckoutSaga.compensate_markAmbiguous()) — the same "evaluate
 * synchronously on the triggering event, no separate detection sweep"
 * shape MerchantPspExposureService already uses for a different signal:
 *
 * 1. Volume: more than AMBIGUOUS_RISK_DAILY_THRESHOLD "ever AMBIGUOUS"
 *    incidents (see PaymentRepositoryPort.countAmbiguousIncidentsSince()'s
 *    docblock for why "ever", not "currently") in a rolling 24h window.
 * 2. Streak: the merchant's last AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD
 *    payments were *all* ambiguous — a stronger, more specific signal
 *    than raw volume (a high-volume merchant could rack up several
 *    incidents during a PSP's bad stretch without every charge being
 *    affected; an unbroken streak is harder to explain that way).
 *
 * A merchant flagged manually (PATCH .../ambiguous-risk) has
 * ambiguousRiskAutoManaged flipped to false and is skipped entirely by
 * both this evaluation and the auto-clear sweep below, until an operator
 * explicitly re-enables it (PATCH .../ambiguous-risk-auto) — same
 * "manual input pauses automation" behavior RiskTieringService's
 * riskTierAutoManaged already uses.
 */
@Injectable()
export class AmbiguousRiskMonitoringService {
  private readonly logger = new Logger(AmbiguousRiskMonitoringService.name);
  // Read in the constructor, not as module-level constants — a
  // module-level `Number(process.env.X) || default` is evaluated once at
  // first import, before a test's beforeAll ever gets to set
  // process.env, so a test wanting a low threshold to trigger quickly
  // would silently get the real default instead (the exact bug this
  // project hit once already with PSP_BULKHEAD_MAX_CONCURRENT).
  private readonly dailyThreshold: number;
  private readonly consecutiveThreshold: number;
  private readonly autoClearDays: number;

  constructor(
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly merchantService: MerchantService,
  ) {
    this.dailyThreshold = Number(process.env.AMBIGUOUS_RISK_DAILY_THRESHOLD) || 100;
    this.consecutiveThreshold = Number(process.env.AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD) || 5;
    this.autoClearDays = Number(process.env.AMBIGUOUS_RISK_AUTO_CLEAR_DAYS) || 60;
  }

  async evaluate(merchantId: string): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(merchantId);
    if (!merchant || !merchant.ambiguousRiskAutoManaged) return;

    if (merchant.ambiguousRiskFlagged) {
      // Already flagged — re-touch ambiguousRiskFlaggedAt so the
      // auto-clear countdown restarts from this new incident, rather
      // than potentially clearing mid-trickle. Thresholds already
      // tripped once; no need to recompute them.
      await this.merchantService.applyAutoAmbiguousRiskFlag(
        merchantId,
        true,
        merchant.ambiguousRiskFlagReason ?? 'Repeated AMBIGUOUS incident while already flagged',
      );
      return;
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dailyCount = await this.paymentRepository.countAmbiguousIncidentsSince(merchantId, since);
    if (dailyCount > this.dailyThreshold) {
      await this.flag(merchantId, `${dailyCount} AMBIGUOUS incidents in the trailing 24 hours (threshold: ${this.dailyThreshold})`);
      return;
    }

    const recent = await this.paymentRepository.findRecentAmbiguousFlags(merchantId, this.consecutiveThreshold);
    if (recent.length === this.consecutiveThreshold && recent.every(Boolean)) {
      await this.flag(merchantId, `last ${this.consecutiveThreshold} consecutive payments were all AMBIGUOUS`);
    }
  }

  private async flag(merchantId: string, reason: string): Promise<void> {
    await this.merchantService.applyAutoAmbiguousRiskFlag(merchantId, true, reason);
    this.logger.warn(`Merchant ${merchantId} auto-flagged for ambiguous-risk: ${reason}`);
  }

  /**
   * Daily sweep — same dual on-demand + scheduled shape as
   * ReconciliationService/ReserveService (see those classes' docblocks):
   * this is also directly callable via
   * POST /admin/merchants/ambiguous-risk/run-auto-clear for on-demand
   * use (a test not waiting for the schedule, or an operator wanting an
   * immediate re-check right after adjusting AMBIGUOUS_RISK_AUTO_CLEAR_DAYS).
   * Only touches ambiguousRiskAutoManaged: true merchants — a manually
   * flagged/cleared merchant never auto-clears.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'ambiguous-risk-auto-clear-sweep' })
  async runAutoClearSweep(now: Date = new Date()): Promise<{ cleared: number }> {
    const cutoff = new Date(now.getTime() - this.autoClearDays * 24 * 60 * 60 * 1000);
    const merchants = await this.merchantService.list();
    const candidates = merchants.filter(
      (m) => m.ambiguousRiskFlagged && m.ambiguousRiskAutoManaged && m.ambiguousRiskFlaggedAt && m.ambiguousRiskFlaggedAt <= cutoff,
    );

    let cleared = 0;
    for (const merchant of candidates) {
      try {
        await this.merchantService.applyAutoAmbiguousRiskFlag(merchant.merchantId, false, '');
        cleared++;
        this.logger.log(`Merchant ${merchant.merchantId} auto-cleared from ambiguous-risk watch (no incident in ${this.autoClearDays} days)`);
      } catch (err: unknown) {
        // One merchant's failure shouldn't abort the whole sweep — same
        // per-item try/catch posture RiskTieringService/PayoutService use
        // in their own sweeps.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to auto-clear ambiguous-risk flag for merchant ${merchant.merchantId}: ${msg}`);
      }
    }
    return { cleared };
  }
}
