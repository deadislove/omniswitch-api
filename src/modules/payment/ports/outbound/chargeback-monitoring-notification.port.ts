/**
 * `ChargebackMonitoringNotificationDispatcherService`/adapters' payload
 * shape — fired by `ChargebackMonitoringService` whenever a merchant's
 * `chargebackMonitoringTier` actually changes (escalates or
 * de-escalates), skipped on every sweep tick that leaves it unchanged.
 * Same "real signal, nothing subscribed to it yet" gap
 * `AmlReviewNotificationPort` closed for its own event family.
 */
export interface ChargebackMonitoringNotificationPayload {
  event: 'chargeback_monitoring.tier_changed';
  merchantId: string;
  previousTier: 'NONE' | 'MONITORING' | 'EXCESSIVE';
  tier: 'NONE' | 'MONITORING' | 'EXCESSIVE';
  reason: string;
  disputeCount: number;
  settledCharges: number;
  windowDays: number;
}

export abstract class ChargebackMonitoringNotificationPort {
  abstract send(target: string, payload: ChargebackMonitoringNotificationPayload): Promise<void>;
}
