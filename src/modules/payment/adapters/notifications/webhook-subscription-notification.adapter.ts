import { Injectable, Logger } from '@nestjs/common';
import {
  SubscriptionNotificationPort,
  SubscriptionNotificationPayload,
} from '../../ports/outbound/subscription-notification.port';
import { MerchantService } from '../../../merchant/merchant.service';
import { VaultTransitService } from '../../../../shared/vault/vault-transit.service';
import { postJsonNotification, signOmniSwitchPayload } from './notification-delivery.util';

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

    await postJsonNotification(target, payload, { 'X-OmniSwitch-Signature': signatureHeader });
  }
}
