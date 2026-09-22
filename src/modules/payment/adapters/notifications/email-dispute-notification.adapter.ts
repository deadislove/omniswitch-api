import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DisputeNotificationPort, DisputeNotificationPayload } from '../../ports/outbound/dispute-notification.port';
import { postJsonNotification } from '../../../../shared/utils/notification-delivery.util';

/**
 * Email Dispute Notification Adapter
 * `target` is the merchant's own notification email address. Calls
 * `EMAIL_PROVIDER_URL` (default: `scripts/mock-psp/server.js`'s
 * `/v1/email/send`, mimicking a real transactional-email API's
 * `{to, subject, body}` shape — SendGrid's `/v3/mail/send` and similar
 * providers all take some variant of this) — same "point at a local
 * mock in tests/dev, swap the URL for the real thing in production"
 * idiom as `FXRateProviderAdapter`/`MockKYCProviderAdapter`/
 * `MockBankTransferAdapter`. Unlike Slack/webhook (a plain HTTP POST
 * that already *is* a real, working notification mechanism), sending a
 * real email genuinely requires a real provider integration — this
 * adapter's shape is what that integration slots into, not a
 * placeholder for something structurally different later.
 */
@Injectable()
export class EmailDisputeNotificationAdapter extends DisputeNotificationPort {
  private readonly logger = new Logger(EmailDisputeNotificationAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('EMAIL_PROVIDER_URL', 'http://localhost:4000/v1/email');
  }

  async send(target: string, payload: DisputeNotificationPayload): Promise<void> {
    const subject =
      payload.event === 'dispute.created'
        ? `New dispute ${payload.disputeId} on payment ${payload.paymentId}`
        : `Dispute ${payload.disputeId} resolved: ${payload.outcome}`;
    const body =
      payload.event === 'dispute.created'
        ? `A new dispute was opened for ${payload.amount} ${payload.currency} (reason: ${payload.reason ?? 'unknown'}, auto-decision: ${payload.autoDecision ?? 'n/a'})${payload.respondBy ? `. Respond by ${payload.respondBy}.` : '.'}`
        : `Dispute ${payload.disputeId} for ${payload.amount} ${payload.currency} was resolved: ${payload.outcome}.`;

    await postJsonNotification(`${this.baseUrl}/send`, { to: target, subject, body });
    this.logger.log(
      `Email dispute notification sent for merchant ${payload.merchantId}: ${payload.event} (${payload.disputeId})`,
    );
  }
}
