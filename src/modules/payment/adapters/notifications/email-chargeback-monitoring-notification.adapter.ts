import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChargebackMonitoringNotificationPort,
  ChargebackMonitoringNotificationPayload,
} from '../../ports/outbound/chargeback-monitoring-notification.port';
import { postJsonNotification } from '../../../../shared/utils/notification-delivery.util';
import { isChargebackTierEscalation } from '../../domain/services/chargeback-monitoring-tier';

/**
 * Email Chargeback-Monitoring Notification Adapter — same
 * `EMAIL_PROVIDER_URL` idiom as `EmailAmlReviewNotificationAdapter` (see
 * that adapter's docblock for why).
 */
@Injectable()
export class EmailChargebackMonitoringNotificationAdapter extends ChargebackMonitoringNotificationPort {
  private readonly logger = new Logger(EmailChargebackMonitoringNotificationAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('EMAIL_PROVIDER_URL', 'http://localhost:4000/v1/email');
  }

  async send(target: string, payload: ChargebackMonitoringNotificationPayload): Promise<void> {
    const direction = isChargebackTierEscalation(payload.previousTier, payload.tier)
      ? 'escalated to'
      : 'de-escalated to';
    const subject = `Merchant ${payload.merchantId} chargeback-monitoring tier ${direction} ${payload.tier}`;
    const body = `${payload.reason} (${payload.disputeCount} disputes / ${payload.settledCharges} settled charges over the trailing ${payload.windowDays} days). Previous tier: ${payload.previousTier}.`;

    await postJsonNotification(`${this.baseUrl}/send`, { to: target, subject, body });
    this.logger.log(`Email chargeback-monitoring notification sent for merchant ${payload.merchantId}`);
  }
}
