import { Injectable, Logger } from '@nestjs/common';
import {
  ChargebackMonitoringNotificationPort,
  ChargebackMonitoringNotificationPayload,
} from '../../ports/outbound/chargeback-monitoring-notification.port';
import { postJsonNotification } from '../../../../shared/utils/notification-delivery.util';
import { isChargebackTierEscalation } from '../../domain/services/chargeback-monitoring-tier';

/**
 * Slack Chargeback-Monitoring Notification Adapter — same Incoming-
 * Webhook-URL, no-signing posture as `SlackAmlReviewNotificationAdapter`
 * (see that adapter's docblock).
 */
@Injectable()
export class SlackChargebackMonitoringNotificationAdapter extends ChargebackMonitoringNotificationPort {
  private readonly logger = new Logger(SlackChargebackMonitoringNotificationAdapter.name);

  async send(target: string, payload: ChargebackMonitoringNotificationPayload): Promise<void> {
    const escalating = isChargebackTierEscalation(payload.previousTier, payload.tier);
    const emoji = escalating ? ':rotating_light:' : ':white_check_mark:';
    const direction = escalating ? 'escalated to' : 'de-escalated to';
    const text = `${emoji} Merchant ${payload.merchantId} chargeback-monitoring tier ${direction} *${payload.tier}* (was ${payload.previousTier}) — ${payload.reason} (${payload.disputeCount} disputes / ${payload.settledCharges} settled charges / ${payload.windowDays}d).`;

    await postJsonNotification(target, { text });
    this.logger.log(`Slack chargeback-monitoring notification sent for merchant ${payload.merchantId}`);
  }
}
