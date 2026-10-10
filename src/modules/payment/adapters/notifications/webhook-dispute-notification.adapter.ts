import { Injectable, Logger } from '@nestjs/common';
import { DisputeNotificationPort, DisputeNotificationPayload } from '../../ports/outbound/dispute-notification.port';
import { MerchantService } from '../../../merchant/merchant.service';
import { VaultTransitService } from '../../../../shared/vault/vault-transit.service';
import {
  postJsonNotification,
  signOmniSwitchPayload,
  NotificationDeliveryError,
} from '../../../../shared/utils/notification-delivery.util';
import { WebhookDeliveryLogService } from '../../../../shared/webhook-delivery-log/webhook-delivery-log.service';

/**
 * Webhook Dispute Notification Adapter (default channel)
 * POSTs the payload to `MerchantEntity.disputeNotificationTarget` (a
 * merchant-provided URL), signed with that same merchant's own
 * `hmacSecretCiphertext` — the secret already exists and the merchant
 * already holds the plaintext (it's the same key they use to sign
 * *inbound* requests via `HmacSignatureGuard`), so reusing it here
 * means a merchant can verify this notification genuinely came from
 * this platform without provisioning a second credential. Same
 * `${timestamp}.${rawBody}` HMAC-SHA256 scheme `StripeWebhookGuard`
 * verifies incoming PSP webhooks with, just outbound:
 * `X-OmniSwitch-Signature: t=<unix seconds>,v1=<hex digest>`.
 */
@Injectable()
export class WebhookDisputeNotificationAdapter extends DisputeNotificationPort {
  private readonly logger = new Logger(WebhookDisputeNotificationAdapter.name);

  constructor(
    private readonly merchantService: MerchantService,
    private readonly vaultTransit: VaultTransitService,
    private readonly deliveryLog: WebhookDeliveryLogService,
  ) {
    super();
  }

  async send(target: string, payload: DisputeNotificationPayload): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(payload.merchantId);
    if (!merchant?.hmacSecretCiphertext) {
      this.logger.warn(
        `No HMAC secret on file for merchant ${payload.merchantId} — cannot sign dispute webhook, skipping`,
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
