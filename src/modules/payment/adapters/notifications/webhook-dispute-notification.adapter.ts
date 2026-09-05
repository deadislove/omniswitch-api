import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { DisputeNotificationPort, DisputeNotificationPayload } from '../../ports/outbound/dispute-notification.port';
import { MerchantService } from '../../../merchant/merchant.service';
import { VaultTransitService } from '../../../../shared/vault/vault-transit.service';

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

    const bodyStr = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${bodyStr}`).digest('hex');

    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OmniSwitch-Signature': `t=${timestamp},v1=${signature}`,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`Dispute webhook to ${target} for merchant ${payload.merchantId} got HTTP ${response.status}`);
    }
  }
}
