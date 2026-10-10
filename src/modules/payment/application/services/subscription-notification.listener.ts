import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SubscriptionNotificationDispatcherService } from './subscription-notification-dispatcher.service';

/**
 * The actual subscriber `subscription.past_due`/`subscription.canceled`
 * never had — `SubscriptionService.emitPastDueEvent()`/
 * `emitCanceledEvent()`'s own comments used to note "nothing subscribes
 * to these yet". Same shape as `DisputeNotificationListener` (see its
 * docblock).
 */
@Injectable()
export class SubscriptionNotificationListener {
  constructor(private readonly dispatcher: SubscriptionNotificationDispatcherService) {}

  @OnEvent('subscription.past_due')
  async onSubscriptionPastDue(event: {
    subscriptionId: string;
    merchantId: string;
    customerId: string;
    failedAttempts: number;
    nextRetryAt?: string;
    declineCode?: string;
  }): Promise<void> {
    await this.dispatcher.notify({
      event: 'subscription.past_due',
      subscriptionId: event.subscriptionId,
      merchantId: event.merchantId,
      customerId: event.customerId,
      failedAttempts: event.failedAttempts,
      nextRetryAt: event.nextRetryAt,
      declineCode: event.declineCode,
    });
  }

  @OnEvent('subscription.canceled')
  async onSubscriptionCanceled(event: {
    subscriptionId: string;
    merchantId: string;
    customerId: string;
    reason: 'dunning_exhausted' | 'hard_decline' | 'period_end_reached' | 'merchant_requested';
    declineCode?: string;
  }): Promise<void> {
    await this.dispatcher.notify({
      event: 'subscription.canceled',
      subscriptionId: event.subscriptionId,
      merchantId: event.merchantId,
      customerId: event.customerId,
      reason: event.reason,
      declineCode: event.declineCode,
    });
  }
}
