import { Injectable, Logger } from '@nestjs/common';
import { AmlReviewNotificationPayload } from '../../ports/outbound/aml-review-notification.port';
import { EmailAmlReviewNotificationAdapter } from '../../adapters/notifications/email-aml-review-notification.adapter';
import { SlackAmlReviewNotificationAdapter } from '../../adapters/notifications/slack-aml-review-notification.adapter';
import { WebhookAmlReviewNotificationAdapter } from '../../adapters/notifications/webhook-aml-review-notification.adapter';
import { MerchantService } from '../../../merchant/merchant.service';

/**
 * AML-Review Notification Dispatcher — same per-merchant runtime
 * registry shape as `SubscriptionNotificationDispatcherService` (see its
 * docblock), routed by `MerchantEntity.amlReviewNotificationChannel`/
 * `amlReviewNotificationTarget` instead. Called directly by
 * `AmlReviewMonitoringService` (the only thing that ever detects this
 * condition) rather than through an `@OnEvent` listener — unlike
 * subscription/dispute notifications, which fan out from events other
 * callers already had reasons to emit, nothing else in the codebase
 * would ever want to react to a flag trip, so the extra indirection of
 * a domain event isn't buying anything here.
 */
@Injectable()
export class AmlReviewNotificationDispatcherService {
  private readonly logger = new Logger(AmlReviewNotificationDispatcherService.name);
  private readonly adapters: Record<
    'EMAIL' | 'SLACK' | 'WEBHOOK',
    { send(target: string, payload: AmlReviewNotificationPayload): Promise<void> }
  >;

  constructor(
    private readonly merchantService: MerchantService,
    email: EmailAmlReviewNotificationAdapter,
    slack: SlackAmlReviewNotificationAdapter,
    webhook: WebhookAmlReviewNotificationAdapter,
  ) {
    this.adapters = { EMAIL: email, SLACK: slack, WEBHOOK: webhook };
  }

  /**
   * Never throws — same reasoning as
   * `SubscriptionNotificationDispatcherService.notify()`: always called
   * from `AmlReviewMonitoringService`'s own best-effort block, which must
   * never let a notification-delivery failure mask the flag having been
   * set correctly.
   */
  async notify(payload: AmlReviewNotificationPayload): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(payload.merchantId);
    if (!merchant) {
      this.logger.warn(`AML-review notification: merchant ${payload.merchantId} not found, skipping`);
      return;
    }
    if (!merchant.amlReviewNotificationTarget) {
      this.logger.debug(
        `AML-review notification: merchant ${payload.merchantId} has no notification target configured, skipping`,
      );
      return;
    }

    const adapter = this.adapters[merchant.amlReviewNotificationChannel];
    try {
      await adapter.send(merchant.amlReviewNotificationTarget, payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `AML-review notification via ${merchant.amlReviewNotificationChannel} failed for merchant ${payload.merchantId}: ${msg}`,
      );
    }
  }
}
