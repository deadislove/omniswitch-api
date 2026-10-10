import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SanctionsNotificationPort, SanctionsNotificationPayload } from './sanctions-notification.port';
import { postJsonNotification } from '../../../shared/utils/notification-delivery.util';

/** Email Sanctions Notification Adapter — same `EMAIL_PROVIDER_URL` idiom as `EmailAmlReviewNotificationAdapter`. */
@Injectable()
export class EmailSanctionsNotificationAdapter extends SanctionsNotificationPort {
  private readonly logger = new Logger(EmailSanctionsNotificationAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('EMAIL_PROVIDER_URL', 'http://localhost:4000/v1/email');
  }

  async send(target: string, payload: SanctionsNotificationPayload): Promise<void> {
    const subject = `Merchant ${payload.merchantId} flagged by sanctions screening: ${payload.status}`;
    const body =
      payload.status === 'HIT'
        ? `Confirmed high-confidence match against "${payload.matchedListEntry}" (score=${payload.score}, ${payload.confidence} confidence). This merchant's onboarding/KYC action was already blocked — review via PATCH /admin/merchants/:id/sanctions-review.`
        : `Potential match against "${payload.matchedListEntry}" (score=${payload.score}, ${payload.confidence} confidence). This is a visibility flag only — review via PATCH /admin/merchants/:id/sanctions-review.`;

    await postJsonNotification(`${this.baseUrl}/send`, { to: target, subject, body });
    this.logger.log(`Email sanctions-screening notification sent for merchant ${payload.merchantId}`);
  }
}
