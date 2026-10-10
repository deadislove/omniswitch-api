/**
 * `AmlReviewNotificationDispatcherService`/adapters' payload shape —
 * fired once by `AmlReviewMonitoringService` when a merchant's AML-review
 * flag first trips (not re-sent on every subsequent hard-decline while
 * already flagged — see that service's docblock). Same "real signal,
 * nothing subscribed to it yet" gap `SubscriptionNotificationPort`/
 * `DisputeNotificationPort` each closed for their own event families.
 */
export interface AmlReviewNotificationPayload {
  event: 'aml_review.flagged';
  merchantId: string;
  reason: string;
  hardDeclineCount: number;
  windowDays: number;
}

export abstract class AmlReviewNotificationPort {
  abstract send(target: string, payload: AmlReviewNotificationPayload): Promise<void>;
}
