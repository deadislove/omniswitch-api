import { Injectable, Logger } from '@nestjs/common';
import {
  AmlReviewNotificationPort,
  AmlReviewNotificationPayload,
} from '../../ports/outbound/aml-review-notification.port';
import { postJsonNotification } from './notification-delivery.util';

/**
 * Slack AML-Review Notification Adapter — same Incoming-Webhook-URL,
 * no-signing posture as `SlackDisputeNotificationAdapter`/
 * `SlackSubscriptionNotificationAdapter` (see those adapters' docblocks).
 */
@Injectable()
export class SlackAmlReviewNotificationAdapter extends AmlReviewNotificationPort {
  private readonly logger = new Logger(SlackAmlReviewNotificationAdapter.name);

  async send(target: string, payload: AmlReviewNotificationPayload): Promise<void> {
    const text = `:rotating_light: Merchant ${payload.merchantId} flagged for AML review — ${payload.reason} (${payload.hardDeclineCount} hard-declines / ${payload.windowDays}d). Passive observation only, no automated block.`;

    await postJsonNotification(target, { text });
    this.logger.log(`Slack AML-review notification sent for merchant ${payload.merchantId}`);
  }
}
