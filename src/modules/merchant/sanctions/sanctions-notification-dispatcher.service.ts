import { Injectable, Logger } from '@nestjs/common';
import { SanctionsNotificationPayload } from './sanctions-notification.port';
import { EmailSanctionsNotificationAdapter } from './email-sanctions-notification.adapter';
import { SlackSanctionsNotificationAdapter } from './slack-sanctions-notification.adapter';
import { WebhookSanctionsNotificationAdapter } from './webhook-sanctions-notification.adapter';
import { MerchantService } from '../merchant.service';

/**
 * Sanctions Notification Dispatcher — same per-merchant runtime registry
 * shape as `AmlReviewNotificationDispatcherService`, routed by
 * `MerchantEntity.sanctionsNotificationChannel`/`sanctionsNotificationTarget`
 * instead. Called directly by whatever detects a `POTENTIAL_MATCH`/`HIT`
 * (`MerchantService.createMerchant()`/`submitKyc()` at onboarding time,
 * `SanctionsScreeningSweepService` on the weekly sweep) — no domain event
 * indirection, same reasoning `AmlReviewNotificationDispatcherService`'s
 * own docblock gives: nothing else in the codebase would ever react to
 * this.
 */
@Injectable()
export class SanctionsNotificationDispatcherService {
  private readonly logger = new Logger(SanctionsNotificationDispatcherService.name);
  private readonly adapters: Record<
    'EMAIL' | 'SLACK' | 'WEBHOOK',
    { send(target: string, payload: SanctionsNotificationPayload): Promise<void> }
  >;

  constructor(
    private readonly merchantService: MerchantService,
    email: EmailSanctionsNotificationAdapter,
    slack: SlackSanctionsNotificationAdapter,
    webhook: WebhookSanctionsNotificationAdapter,
  ) {
    this.adapters = { EMAIL: email, SLACK: slack, WEBHOOK: webhook };
  }

  /** Never throws — same reasoning as `AmlReviewNotificationDispatcherService.notify()`: a notification-delivery failure must never mask the flag having been set correctly. */
  async notify(payload: SanctionsNotificationPayload): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(payload.merchantId);
    if (!merchant) {
      this.logger.warn(`Sanctions notification: merchant ${payload.merchantId} not found, skipping`);
      return;
    }
    if (!merchant.sanctionsNotificationTarget) {
      this.logger.debug(
        `Sanctions notification: merchant ${payload.merchantId} has no notification target configured, skipping`,
      );
      return;
    }

    const adapter = this.adapters[merchant.sanctionsNotificationChannel];
    try {
      await adapter.send(merchant.sanctionsNotificationTarget, payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Sanctions notification via ${merchant.sanctionsNotificationChannel} failed for merchant ${payload.merchantId}: ${msg}`,
      );
    }
  }
}
