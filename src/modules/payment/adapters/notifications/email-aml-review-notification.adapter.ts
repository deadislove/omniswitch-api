import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AmlReviewNotificationPort, AmlReviewNotificationPayload } from '../../ports/outbound/aml-review-notification.port';
import { postJsonNotification } from './notification-delivery.util';

/**
 * Email AML-Review Notification Adapter — same `EMAIL_PROVIDER_URL`
 * idiom as `EmailDisputeNotificationAdapter`/`EmailSubscriptionNotificationAdapter`
 * (see those adapters' docblocks for why).
 */
@Injectable()
export class EmailAmlReviewNotificationAdapter extends AmlReviewNotificationPort {
  private readonly logger = new Logger(EmailAmlReviewNotificationAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('EMAIL_PROVIDER_URL', 'http://localhost:4000/v1/email');
  }

  async send(target: string, payload: AmlReviewNotificationPayload): Promise<void> {
    const subject = `Merchant ${payload.merchantId} flagged for AML review`;
    const body = `${payload.reason} (${payload.hardDeclineCount} hard-declines in the trailing ${payload.windowDays} days). This is a passive observation flag — it does not change how this merchant's charges are processed.`;

    await postJsonNotification(`${this.baseUrl}/send`, { to: target, subject, body });
    this.logger.log(`Email AML-review notification sent for merchant ${payload.merchantId}`);
  }
}
