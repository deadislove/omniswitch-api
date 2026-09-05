import { Injectable, Logger } from '@nestjs/common';
import { DisputeNotificationPayload } from '../../ports/outbound/dispute-notification.port';
import { EmailDisputeNotificationAdapter } from '../../adapters/notifications/email-dispute-notification.adapter';
import { SlackDisputeNotificationAdapter } from '../../adapters/notifications/slack-dispute-notification.adapter';
import { WebhookDisputeNotificationAdapter } from '../../adapters/notifications/webhook-dispute-notification.adapter';
import { MerchantService } from '../../../merchant/merchant.service';

/**
 * Dispute Notification Dispatcher
 * Unlike `BankTransferPort` (one adapter per deployment, picked by an
 * env var), which channel handles a given merchant's dispute
 * notifications varies *per merchant* — so this is a small runtime
 * registry (same shape as `PaymentProcessorFactory`'s `Map<PSPProvider,
 * PSPAdapterPort>`), not a DI-level `useFactory` binding. Called from
 * `DisputeNotificationListener`, itself the actual `@OnEvent` subscriber
 * — kept separate so this class's per-merchant routing logic is testable
 * without needing a real `EventEmitter2` emission to exercise it.
 */
@Injectable()
export class DisputeNotificationDispatcherService {
  private readonly logger = new Logger(DisputeNotificationDispatcherService.name);
  private readonly adapters: Record<
    'EMAIL' | 'SLACK' | 'WEBHOOK',
    { send(target: string, payload: DisputeNotificationPayload): Promise<void> }
  >;

  constructor(
    private readonly merchantService: MerchantService,
    email: EmailDisputeNotificationAdapter,
    slack: SlackDisputeNotificationAdapter,
    webhook: WebhookDisputeNotificationAdapter,
  ) {
    this.adapters = { EMAIL: email, SLACK: slack, WEBHOOK: webhook };
  }

  /**
   * Never throws — a notification failure is a real problem worth
   * logging loudly, but it must not take down the dispute-processing
   * path it's a side effect of (this is always called from an
   * `@OnEvent` listener, which already can't propagate an exception back
   * to `DisputeService`'s original caller anyway — see
   * `DisputeNotificationListener`).
   */
  async notify(payload: DisputeNotificationPayload): Promise<void> {
    const merchant = await this.merchantService.findByMerchantId(payload.merchantId);
    if (!merchant) {
      this.logger.warn(`Dispute notification: merchant ${payload.merchantId} not found, skipping`);
      return;
    }
    if (!merchant.disputeNotificationTarget) {
      this.logger.debug(
        `Dispute notification: merchant ${payload.merchantId} has no notification target configured, skipping`,
      );
      return;
    }

    const adapter = this.adapters[merchant.disputeNotificationChannel];
    try {
      await adapter.send(merchant.disputeNotificationTarget, payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Dispute notification via ${merchant.disputeNotificationChannel} failed for merchant ${payload.merchantId} (dispute ${payload.disputeId}): ${msg}`,
      );
    }
  }
}
