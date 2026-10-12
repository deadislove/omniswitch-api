import { Injectable, Logger } from '@nestjs/common';
import { ChargebackMonitoringNotificationPayload } from '../../ports/outbound/chargeback-monitoring-notification.port';
import { EmailChargebackMonitoringNotificationAdapter } from '../../adapters/notifications/email-chargeback-monitoring-notification.adapter';
import { SlackChargebackMonitoringNotificationAdapter } from '../../adapters/notifications/slack-chargeback-monitoring-notification.adapter';
import { WebhookChargebackMonitoringNotificationAdapter } from '../../adapters/notifications/webhook-chargeback-monitoring-notification.adapter';
import { MerchantService } from '../../../merchant/merchant.service';

/**
 * Chargeback-Monitoring Notification Dispatcher — same per-merchant
 * runtime registry shape as `AmlReviewNotificationDispatcherService`
 * (see its docblock). Called directly by `ChargebackMonitoringService`
 * rather than through an `@OnEvent` listener, for the same reason: a
 * tier change has exactly one caller that ever wants to react to it.
 */
@Injectable()
export class ChargebackMonitoringNotificationDispatcherService {
  private readonly logger = new Logger(ChargebackMonitoringNotificationDispatcherService.name);
  private readonly adapters: Record<
    'EMAIL' | 'SLACK' | 'WEBHOOK',
    { send(target: string, payload: ChargebackMonitoringNotificationPayload): Promise<void> }
  >;

  constructor(
    private readonly merchantService: MerchantService,
    email: EmailChargebackMonitoringNotificationAdapter,
    slack: SlackChargebackMonitoringNotificationAdapter,
    webhook: WebhookChargebackMonitoringNotificationAdapter,
  ) {
    this.adapters = { EMAIL: email, SLACK: slack, WEBHOOK: webhook };
  }

  /**
   * Never throws — same reasoning as
   * `AmlReviewNotificationDispatcherService.notify()`: always called
   * from `ChargebackMonitoringService`'s own best-effort block, which
   * must never let a notification-delivery failure mask the tier change
   * having been recorded correctly.
   */
  async notify(payload: ChargebackMonitoringNotificationPayload): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(payload.merchantId);
    if (!merchant) {
      this.logger.warn(`Chargeback-monitoring notification: merchant ${payload.merchantId} not found, skipping`);
      return;
    }
    if (!merchant.chargebackMonitoringNotificationTarget) {
      this.logger.debug(
        `Chargeback-monitoring notification: merchant ${payload.merchantId} has no notification target configured, skipping`,
      );
      return;
    }

    const adapter = this.adapters[merchant.chargebackMonitoringNotificationChannel];
    try {
      await adapter.send(merchant.chargebackMonitoringNotificationTarget, payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Chargeback-monitoring notification via ${merchant.chargebackMonitoringNotificationChannel} failed for merchant ${payload.merchantId}: ${msg}`,
      );
    }
  }
}
