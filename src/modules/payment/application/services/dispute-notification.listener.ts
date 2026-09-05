import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DisputeNotificationDispatcherService } from './dispute-notification-dispatcher.service';

/**
 * The actual subscriber `dispute.created`/`dispute.resolved` never had
 * (`DisputeService.recordDispute()`'s own comment used to note "even
 * though nothing does yet" — this is that "yet"). `@OnEvent` handlers
 * run on the same `EventEmitter2` instance `app.module.ts` registers
 * globally (`EventEmitterModule.forRoot()`) — see `payment.module.ts`'s
 * docblock for why this module deliberately never calls `forRoot()`
 * again itself.
 */
@Injectable()
export class DisputeNotificationListener {
  constructor(private readonly dispatcher: DisputeNotificationDispatcherService) {}

  @OnEvent('dispute.created')
  async onDisputeCreated(event: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: number;
    currency: string;
    reason: string;
    autoDecision: string;
    status: string;
    respondBy: string;
  }): Promise<void> {
    await this.dispatcher.notify({
      event: 'dispute.created',
      disputeId: event.disputeId,
      paymentId: event.paymentId,
      merchantId: event.merchantId,
      amount: event.amount,
      currency: event.currency,
      reason: event.reason,
      autoDecision: event.autoDecision,
      status: event.status,
      respondBy: event.respondBy,
    });
  }

  @OnEvent('dispute.resolved')
  async onDisputeResolved(event: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    outcome: string;
    amount: number;
    currency: string;
    autoDecision: string;
  }): Promise<void> {
    await this.dispatcher.notify({
      event: 'dispute.resolved',
      disputeId: event.disputeId,
      paymentId: event.paymentId,
      merchantId: event.merchantId,
      amount: event.amount,
      currency: event.currency,
      autoDecision: event.autoDecision,
      outcome: event.outcome,
    });
  }
}
