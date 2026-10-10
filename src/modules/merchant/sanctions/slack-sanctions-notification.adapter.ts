import { Injectable, Logger } from '@nestjs/common';
import { SanctionsNotificationPort, SanctionsNotificationPayload } from './sanctions-notification.port';
import { postJsonNotification } from '../../../shared/utils/notification-delivery.util';

/** Slack Sanctions Notification Adapter — same Incoming-Webhook-URL, no-signing posture as `SlackAmlReviewNotificationAdapter`. */
@Injectable()
export class SlackSanctionsNotificationAdapter extends SanctionsNotificationPort {
  private readonly logger = new Logger(SlackSanctionsNotificationAdapter.name);

  async send(target: string, payload: SanctionsNotificationPayload): Promise<void> {
    const emoji = payload.status === 'HIT' ? ':rotating_light:' : ':warning:';
    const text = `${emoji} Merchant ${payload.merchantId} sanctions screening: ${payload.status} against "${payload.matchedListEntry}" (score=${payload.score}, ${payload.confidence} confidence).`;

    await postJsonNotification(target, { text });
    this.logger.log(`Slack sanctions-screening notification sent for merchant ${payload.merchantId}`);
  }
}
