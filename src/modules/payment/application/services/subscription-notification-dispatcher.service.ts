import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionNotificationPayload } from '../../ports/outbound/subscription-notification.port';
import { EmailSubscriptionNotificationAdapter } from '../../adapters/notifications/email-subscription-notification.adapter';
import { SlackSubscriptionNotificationAdapter } from '../../adapters/notifications/slack-subscription-notification.adapter';
import { WebhookSubscriptionNotificationAdapter } from '../../adapters/notifications/webhook-subscription-notification.adapter';
import { MerchantService } from '../../../merchant/merchant.service';

/**
 * Subscription Notification Dispatcher — same per-merchant runtime
 * registry shape as `DisputeNotificationDispatcherService` (see its
 * docblock), routed by `MerchantEntity.subscriptionNotificationChannel`/
 * `subscriptionNotificationTarget` instead — a merchant's dispute and
 * subscription channel choices are independent of each other.
 */
@Injectable()
export class SubscriptionNotificationDispatcherService {
  private readonly logger = new Logger(SubscriptionNotificationDispatcherService.name);
  private readonly adapters: Record<
    'EMAIL' | 'SLACK' | 'WEBHOOK',
    { send(target: string, payload: SubscriptionNotificationPayload): Promise<void> }
  >;

  constructor(
    private readonly merchantService: MerchantService,
    email: EmailSubscriptionNotificationAdapter,
    slack: SlackSubscriptionNotificationAdapter,
    webhook: WebhookSubscriptionNotificationAdapter,
  ) {
    this.adapters = { EMAIL: email, SLACK: slack, WEBHOOK: webhook };
  }

  /**
   * Never throws — same reasoning as
   * `DisputeNotificationDispatcherService.notify()`: always called from
   * an `@OnEvent` listener that can't propagate an exception back to
   * `SubscriptionService`'s original caller anyway.
   */
  async notify(payload: SubscriptionNotificationPayload): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(payload.merchantId);
    if (!merchant) {
      this.logger.warn(`Subscription notification: merchant ${payload.merchantId} not found, skipping`);
      return;
    }
    if (!merchant.subscriptionNotificationTarget) {
      this.logger.debug(
        `Subscription notification: merchant ${payload.merchantId} has no notification target configured, skipping`,
      );
      return;
    }

    const adapter = this.adapters[merchant.subscriptionNotificationChannel];
    try {
      await adapter.send(merchant.subscriptionNotificationTarget, payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Subscription notification via ${merchant.subscriptionNotificationChannel} failed for merchant ${payload.merchantId} (subscription ${payload.subscriptionId}): ${msg}`,
      );
    }
  }
}
