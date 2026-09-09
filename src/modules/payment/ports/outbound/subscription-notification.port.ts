/**
 * `SubscriptionNotificationDispatcherService`/adapters' payload shape —
 * mirrors `subscription.past_due`/`subscription.canceled` event fields
 * verbatim (`SubscriptionService.emitPastDueEvent()`/`emitCanceledEvent()`),
 * not a re-derivation. Same "real event already existed, nothing
 * subscribed to it yet" gap `DisputeNotificationPort` closed for
 * dispute.created/dispute.resolved — see that port's docblock.
 */
export interface SubscriptionNotificationPayload {
  event: 'subscription.past_due' | 'subscription.canceled';
  subscriptionId: string;
  merchantId: string;
  customerId: string;
  /** Present on 'subscription.past_due'. */
  failedAttempts?: number;
  /** Present on 'subscription.past_due' when a dunning retry is scheduled. */
  nextRetryAt?: string;
  /** Present on either event when the most recent failed charge returned a PSP decline code. */
  declineCode?: string;
  /** Present on 'subscription.canceled'. */
  reason?: 'dunning_exhausted' | 'hard_decline' | 'period_end_reached' | 'merchant_requested';
}

export abstract class SubscriptionNotificationPort {
  abstract send(target: string, payload: SubscriptionNotificationPayload): Promise<void>;
}
