import { Injectable, Logger } from '@nestjs/common';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { MerchantService } from '../../../merchant/merchant.service';
import { classifyDeclineCode } from '../../domain/services/decline-code-classifier';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { AmlReviewNotificationDispatcherService } from './aml-review-notification-dispatcher.service';

/**
 * AML Review Monitoring Service — purely observational, same posture as
 * `AmbiguousRiskMonitoringService`: flags a merchant so a human can look
 * at it — does **not** throttle or block that merchant's charges. The
 * premise: every industry classification carries some potential
 * money-laundering exposure, and a `HIGH`-industry merchant racking up
 * hard-declines (stolen/lost/fraudulent-card-class outcomes — see
 * decline-code-classifier.ts) in a short window is exactly the kind of
 * cross-referenceable signal that's too hard to fully automate a
 * judgment from, but easy to surface for a human reviewer — a warning
 * flag, not an auto-block.
 *
 * Evaluated inline, right after a charge is marked FAILED (see
 * `evaluate()`, called from
 * `PaymentCheckoutSaga.compensate_markFailed()`) — same "evaluate
 * synchronously on the triggering event, no separate detection sweep"
 * shape `AmbiguousRiskMonitoringService` already uses. Because
 * `SubscriptionService.runBillingSweep()` charges a subscription's
 * renewal through the very same `PaymentCheckoutSaga`, a subscription's
 * hard-declines flow through this exact same path with no separate
 * wiring needed — one integration point covers every kind of charge,
 * one-off or recurring.
 *
 * Only ever evaluates `industryRiskCategory === 'HIGH'` merchants — a
 * deliberate scope limit (not "every merchant"), the same MCC-risk
 * premise `mcc-risk-lookup.ts` already encodes: a LOW-risk industry's
 * occasional hard-decline is just card-testing/fraud noise, not an
 * AML-adjacent signal worth a human's time.
 *
 * A merchant flagged manually (PATCH .../aml-review) has
 * amlReviewAutoManaged flipped to false and is skipped entirely by this
 * evaluation, until an operator explicitly re-enables it
 * (PATCH .../aml-review-auto) — same "manual input pauses automation"
 * behavior `ambiguousRiskAutoManaged`/`riskTierAutoManaged` already use.
 *
 * Unlike `AmbiguousRiskMonitoringService`, this fires a real
 * notification (email/Slack/webhook, per merchant config) the moment the
 * flag trips — a HIGH-industry merchant crossing this threshold is
 * compliance-relevant enough to page someone in real time, not just show
 * up on a dashboard whenever an operator next looks. Only sent once per
 * trip, not re-sent on every subsequent hard-decline while already
 * flagged (see the already-flagged branch below).
 */
@Injectable()
export class AmlReviewMonitoringService {
  private readonly logger = new Logger(AmlReviewMonitoringService.name);
  // Read in the constructor, not as module-level constants — see
  // AmbiguousRiskMonitoringService's own docblock for why (a test
  // wanting a low threshold set via process.env in beforeAll would
  // otherwise silently get the real default instead).
  private readonly threshold: number;
  private readonly windowDays: number;

  constructor(
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly merchantService: MerchantService,
    private readonly notificationDispatcher: AmlReviewNotificationDispatcherService,
  ) {
    this.threshold = Number(process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD) || 5;
    this.windowDays = Number(process.env.AML_REVIEW_WINDOW_DAYS) || 30;
  }

  async evaluate(merchantId: string, errorCode?: string, pspProvider?: PSPProvider): Promise<void> {
    if (classifyDeclineCode(errorCode, pspProvider) !== 'HARD_DECLINE') return;

    const merchant = await this.merchantService.findByMerchantId(merchantId);
    if (!merchant || merchant.industryRiskCategory !== 'HIGH' || !merchant.amlReviewAutoManaged) return;

    if (merchant.amlReviewFlagged) {
      // Already flagged — re-touch amlReviewFlaggedAt so a future
      // auto-clear countdown (if one is ever added) restarts from this
      // new incident, same reasoning as
      // AmbiguousRiskMonitoringService's own already-flagged branch.
      // Deliberately does not re-notify — the notification already sent
      // when this first tripped is the actionable signal; re-paging on
      // every subsequent hard-decline while already under review would
      // just be noise.
      await this.merchantService.applyAutoAmlReviewFlag(
        merchantId,
        true,
        merchant.amlReviewFlagReason ?? 'Repeated hard-decline while already flagged for AML review',
      );
      return;
    }

    const since = new Date(Date.now() - this.windowDays * 24 * 60 * 60 * 1000);
    const hardDeclineCount = await this.paymentRepository.countHardDeclinesSince(merchantId, since);
    if (hardDeclineCount < this.threshold) return;

    const reason = `${hardDeclineCount} hard-declines in the trailing ${this.windowDays} days (threshold: ${this.threshold})`;
    await this.merchantService.applyAutoAmlReviewFlag(merchantId, true, reason);
    this.logger.warn(`Merchant ${merchantId} auto-flagged for AML review: ${reason}`);

    try {
      await this.notificationDispatcher.notify({
        event: 'aml_review.flagged',
        merchantId,
        reason,
        hardDeclineCount,
        windowDays: this.windowDays,
      });
    } catch (err: unknown) {
      // Same "notification failure must never mask the flag having been
      // set correctly" posture as PaymentCheckoutSaga.compensate_markAmbiguous()'s
      // own separate try/catch around ambiguousRiskMonitoring.evaluate().
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`AML-review notification failed for merchant ${merchantId} (flag still correctly set): ${msg}`);
    }
  }
}
