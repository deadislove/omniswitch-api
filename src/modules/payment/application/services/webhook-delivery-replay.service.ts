import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WebhookDeliveryLogService } from '../../../../shared/webhook-delivery-log/webhook-delivery-log.service';
import { WebhookDeliveryLogEntity } from '../../../../shared/webhook-delivery-log/webhook-delivery-log.entity';
import { MerchantService } from '../../../merchant/merchant.service';
import { VaultTransitService } from '../../../../shared/vault/vault-transit.service';
import {
  postJsonNotification,
  signOmniSwitchPayload,
  NotificationDeliveryError,
} from '../../../../shared/utils/notification-delivery.util';

/**
 * Webhook Delivery Replay Service
 * The manual-replay half of the webhook delivery log — re-sends a
 * previously recorded delivery's exact `payload` to its exact
 * `targetUrl`, re-signed fresh (a new timestamp; the payload bytes
 * themselves are replayed verbatim, not reconstructed). Deliberately
 * generic across all four notification families (dispute, subscription,
 * AML review, sanctions screening): replay only ever needs the stored
 * payload/target plus the merchant's *current* HMAC secret, none of
 * which is family-specific — the same reason
 * `WebhookDeliveryLogService` itself lives in `shared/` rather than
 * being duplicated per family.
 *
 * Lives in `PaymentModule`, not `shared/`, specifically because it
 * needs `MerchantService` — `PaymentModule` already depends on
 * `MerchantModule` (the reverse never holds), so this is the one
 * module that can safely host a controller needing both the
 * cross-cutting delivery log and a live merchant lookup.
 *
 * Re-signs with the merchant's *current* HMAC secret, not whatever
 * secret was in effect at the original delivery time — if the merchant
 * rotated their key since, replaying with the old key would only ever
 * fail their own verification, which defeats the point of a replay
 * button ("did my endpoint actually receive this, correctly signed,
 * just now").
 */
@Injectable()
export class WebhookDeliveryReplayService {
  constructor(
    private readonly deliveryLog: WebhookDeliveryLogService,
    private readonly merchantService: MerchantService,
    private readonly vaultTransit: VaultTransitService,
  ) {}

  async replay(deliveryId: string): Promise<WebhookDeliveryLogEntity> {
    const original = await this.deliveryLog.findById(deliveryId);
    if (!original) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Webhook delivery ${deliveryId} not found`,
        code: 'WEBHOOK_DELIVERY_NOT_FOUND',
      });
    }

    const merchant = await this.merchantService.findByMerchantId(original.merchantId);
    if (!merchant?.hmacSecretCiphertext) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Merchant ${original.merchantId} has no HMAC secret on file — cannot sign a replay`,
        code: 'HMAC_SECRET_MISSING',
      });
    }

    const secret = await this.vaultTransit.decrypt(merchant.hmacSecretCiphertext);
    const signatureHeader = signOmniSwitchPayload(secret, JSON.stringify(original.payload));
    // Always point at the true original, not the row that was itself a
    // replay — replaying a replay should still read as "one more attempt
    // at delivering this same logical event," not a chain a caller has
    // to walk backward to find where it started.
    const replayOfDeliveryId = original.replayOfDeliveryId ?? original.id;

    const startedAt = Date.now();
    let recorded: WebhookDeliveryLogEntity | null;
    try {
      const { status } = await postJsonNotification(original.targetUrl, original.payload, {
        'X-OmniSwitch-Signature': signatureHeader,
      });
      recorded = await this.deliveryLog.record({
        merchantId: original.merchantId,
        eventType: original.eventType,
        targetUrl: original.targetUrl,
        payload: original.payload,
        success: true,
        statusCode: status,
        latencyMs: Date.now() - startedAt,
        replayOfDeliveryId,
      });
    } catch (err: unknown) {
      recorded = await this.deliveryLog.record({
        merchantId: original.merchantId,
        eventType: original.eventType,
        targetUrl: original.targetUrl,
        payload: original.payload,
        success: false,
        statusCode: (err as NotificationDeliveryError)?.statusCode,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
        replayOfDeliveryId,
      });
    }

    // recorded is only null if WebhookDeliveryLogService.record() itself
    // failed to write (its own logging failure, swallowed there) — the
    // replay attempt above still genuinely happened either way, so this
    // reconstructs a response from what's known rather than losing the
    // outcome entirely.
    return (
      recorded ?? {
        id: replayOfDeliveryId,
        merchantId: original.merchantId,
        eventType: original.eventType,
        targetUrl: original.targetUrl,
        payload: original.payload,
        success: false,
        statusCode: null,
        errorMessage: 'Replay attempted but the result could not be persisted',
        latencyMs: Date.now() - startedAt,
        replayOfDeliveryId,
        createdAt: new Date(),
      }
    );
  }
}
