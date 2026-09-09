import { Injectable, Logger } from '@nestjs/common';
import { AmlReviewNotificationPort, AmlReviewNotificationPayload } from '../../ports/outbound/aml-review-notification.port';
import { MerchantService } from '../../../merchant/merchant.service';
import { VaultTransitService } from '../../../../shared/vault/vault-transit.service';
import { postJsonNotification, signOmniSwitchPayload } from './notification-delivery.util';

/**
 * Webhook AML-Review Notification Adapter (default channel) — same
 * shape as `WebhookSubscriptionNotificationAdapter` (POSTs to
 * `MerchantEntity.amlReviewNotificationTarget`, signed with the
 * merchant's own `hmacSecretCiphertext` under `X-OmniSwitch-Signature`).
 */
@Injectable()
export class WebhookAmlReviewNotificationAdapter extends AmlReviewNotificationPort {
  private readonly logger = new Logger(WebhookAmlReviewNotificationAdapter.name);

  constructor(
    private readonly merchantService: MerchantService,
    private readonly vaultTransit: VaultTransitService,
  ) {
    super();
  }

  async send(target: string, payload: AmlReviewNotificationPayload): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(payload.merchantId);
    if (!merchant?.hmacSecretCiphertext) {
      this.logger.warn(
        `No HMAC secret on file for merchant ${payload.merchantId} — cannot sign AML-review webhook, skipping`,
      );
      return;
    }
    const secret = await this.vaultTransit.decrypt(merchant.hmacSecretCiphertext);
    const signatureHeader = signOmniSwitchPayload(secret, JSON.stringify(payload));

    await postJsonNotification(target, payload, { 'X-OmniSwitch-Signature': signatureHeader });
  }
}
