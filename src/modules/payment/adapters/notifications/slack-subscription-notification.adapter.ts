import { Injectable, Logger } from '@nestjs/common';
import {
  SubscriptionNotificationPort,
  SubscriptionNotificationPayload,
} from '../../ports/outbound/subscription-notification.port';
import { postJsonNotification } from '../../../../shared/utils/notification-delivery.util';

/**
 * Slack Subscription Notification Adapter — same Incoming-Webhook-URL,
 * no-signing posture as `SlackDisputeNotificationAdapter` (see its
 * docblock for why).
 */
@Injectable()
export class SlackSubscriptionNotificationAdapter extends SubscriptionNotificationPort {
  private readonly logger = new Logger(SlackSubscriptionNotificationAdapter.name);

  async send(target: string, payload: SubscriptionNotificationPayload): Promise<void> {
    const text =
      payload.event === 'subscription.past_due'
        ? `:warning: Subscription ${payload.subscriptionId} is past due (attempt ${payload.failedAttempts ?? '?'})${payload.declineCode ? `, decline code: ${payload.declineCode}` : ''}${payload.nextRetryAt ? `, next retry ${payload.nextRetryAt}` : ''}`
        : `Subscription ${payload.subscriptionId} canceled: *${payload.reason ?? 'unknown'}*${payload.declineCode ? ` (decline code: ${payload.declineCode})` : ''}`;

    await postJsonNotification(target, { text });
    this.logger.log(
      `Slack subscription notification sent for merchant ${payload.merchantId}: ${payload.event} (${payload.subscriptionId})`,
    );
  }
}
