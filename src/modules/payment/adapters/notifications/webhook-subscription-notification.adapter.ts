import { Injectable, Logger } from '@nestjs/common';
import {
  SubscriptionNotificationPort,
  SubscriptionNotificationPayload,
} from '../../ports/outbound/subscription-notification.port';
import { MerchantService } from '../../../merchant/merchant.service';
import { VaultTransitService } from '../../../../shared/vault/vault-transit.service';
import {
  postJsonNotification,
  signOmniSwitchPayload,
  NotificationDeliveryError,
} from '../../../../shared/utils/notification-delivery.util';
import { WebhookDeliveryLogService } from '../../../../shared/webhook-delivery-log/webhook-delivery-log.service';

/**
 * Webhook Subscription Notification Adapter (default channel) — same
 * shape as `WebhookDisputeNotificationAdapter` (POSTs to
 * `MerchantEntity.subscriptionNotificationTarget`, signed with the
 * merchant's own `hmacSecretCiphertext` under `X-OmniSwitch-Signature`),
 * a deliberately separate class/field pair from the dispute one — a
 * merchant might want Slack for disputes and email for billing, so the
 * two event families' channel choices are independent.
 */
@Injectable()
export class WebhookSubscriptionNotificationAdapter extends SubscriptionNotificationPort {
  private readonly logger = new Logger(WebhookSubscriptionNotificationAdapter.name);

  constructor(
    private readonly merchantService: MerchantService,
    private readonly vaultTransit: VaultTransitService,
    private readonly deliveryLog: WebhookDeliveryLogService,
  ) {
    super();
  }

  async send(target: string, payload: SubscriptionNotificationPayload): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(payload.merchantId);
    if (!merchant?.hmacSecretCiphertext) {
      this.logger.warn(
        `No HMAC secret on file for merchant ${payload.merchantId} — cannot sign subscription webhook, skipping`,
      );
      return;
    }
    const secret = await this.vaultTransit.decrypt(merchant.hmacSecretCiphertext);
    const signatureHeader = signOmniSwitchPayload(secret, JSON.stringify(payload));

    const startedAt = Date.now();
    try {
      const { status } = await postJsonNotification(target, payload, { 'X-OmniSwitch-Signature': signatureHeader });
      await this.deliveryLog.record({
        merchantId: payload.merchantId,
        eventType: payload.event,
        targetUrl: target,
        payload: payload as unknown as Record<string, unknown>,
        success: true,
        statusCode: status,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err: unknown) {
      await this.deliveryLog.record({
        merchantId: payload.merchantId,
        eventType: payload.event,
        targetUrl: target,
        payload: payload as unknown as Record<string, unknown>,
        success: false,
        statusCode: (err as NotificationDeliveryError)?.statusCode,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }
}
