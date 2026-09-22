import { Injectable, Logger } from '@nestjs/common';
import { SanctionsNotificationPort, SanctionsNotificationPayload } from './sanctions-notification.port';
import { MerchantService } from '../merchant.service';
import { VaultTransitService } from '../../../shared/vault/vault-transit.service';
import {
  postJsonNotification,
  signOmniSwitchPayload,
  NotificationDeliveryError,
} from '../../../shared/utils/notification-delivery.util';
import { WebhookDeliveryLogService } from '../../../shared/webhook-delivery-log/webhook-delivery-log.service';

/**
 * Webhook Sanctions Notification Adapter (default channel) — same shape
 * as `WebhookAmlReviewNotificationAdapter` (POSTs to
 * `MerchantEntity.sanctionsNotificationTarget`, signed with the
 * merchant's own `hmacSecretCiphertext` under `X-OmniSwitch-Signature`).
 */
@Injectable()
export class WebhookSanctionsNotificationAdapter extends SanctionsNotificationPort {
  private readonly logger = new Logger(WebhookSanctionsNotificationAdapter.name);

  constructor(
    private readonly merchantService: MerchantService,
    private readonly vaultTransit: VaultTransitService,
    private readonly deliveryLog: WebhookDeliveryLogService,
  ) {
    super();
  }

  async send(target: string, payload: SanctionsNotificationPayload): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(payload.merchantId);
    if (!merchant?.hmacSecretCiphertext) {
      this.logger.warn(
        `No HMAC secret on file for merchant ${payload.merchantId} — cannot sign sanctions-screening webhook, skipping`,
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
