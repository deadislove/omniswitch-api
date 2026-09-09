import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SubscriptionNotificationPort,
  SubscriptionNotificationPayload,
} from '../../ports/outbound/subscription-notification.port';
import { postJsonNotification } from './notification-delivery.util';

/**
 * Email Subscription Notification Adapter — same `EMAIL_PROVIDER_URL`
 * idiom as `EmailDisputeNotificationAdapter` (see its docblock for why).
 */
@Injectable()
export class EmailSubscriptionNotificationAdapter extends SubscriptionNotificationPort {
  private readonly logger = new Logger(EmailSubscriptionNotificationAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('EMAIL_PROVIDER_URL', 'http://localhost:4000/v1/email');
  }

  async send(target: string, payload: SubscriptionNotificationPayload): Promise<void> {
    const subject =
      payload.event === 'subscription.past_due'
        ? `Subscription ${payload.subscriptionId} payment failed (attempt ${payload.failedAttempts ?? '?'})`
        : `Subscription ${payload.subscriptionId} canceled`;
    const body =
      payload.event === 'subscription.past_due'
        ? `A charge attempt for subscription ${payload.subscriptionId} failed${payload.declineCode ? ` (decline code: ${payload.declineCode})` : ''}.${payload.nextRetryAt ? ` Next retry: ${payload.nextRetryAt}.` : ''}`
        : `Subscription ${payload.subscriptionId} was canceled (reason: ${payload.reason ?? 'unknown'}).`;

    await postJsonNotification(`${this.baseUrl}/send`, { to: target, subject, body });
    this.logger.log(
      `Email subscription notification sent for merchant ${payload.merchantId}: ${payload.event} (${payload.subscriptionId})`,
    );
  }
}
