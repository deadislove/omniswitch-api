/**
 * What a merchant actually needs to know about a dispute event —
 * assembled once in `DisputeNotificationDispatcherService` from the
 * `dispute.created`/`dispute.resolved` event payloads `DisputeService`
 * already emits, then handed to whichever channel adapter the merchant
 * has configured. Deliberately flat/primitive (no `Dispute` aggregate,
 * no Money VO) — every adapter serializes this straight into an HTTP
 * body (JSON for webhook, a mock email API's `{to, subject, body}`, a
 * Slack `{text}`), so there's nothing for an adapter to gain from a
 * richer domain type it would just have to re-flatten anyway.
 */
export interface DisputeNotificationPayload {
  event: 'dispute.created' | 'dispute.resolved';
  disputeId: string;
  paymentId: string;
  merchantId: string;
  /** Major units — mirrors the `dispute.created`/`dispute.resolved` event fields verbatim (`dispute.amount.amount`), not a re-derivation. */
  amount: number;
  currency: string;
  /** Present on 'dispute.created' — the reason code the PSP reported. */
  reason?: string;
  /** What DisputePolicy decided (ACCEPT/CONTEST/MANUAL_REVIEW) — present on both events. */
  autoDecision?: string;
  /** Present on 'dispute.created' — the dispute's status right after the auto-decision ran. */
  status?: string;
  /** Present on 'dispute.created' when a response deadline applies. */
  respondBy?: string;
  /** Present on 'dispute.resolved' — WON/LOST. */
  outcome?: string;
}

/**
 * Dispute Notification Port (Outbound)
 * `DisputeService` has emitted `dispute.created`/`dispute.resolved` as
 * real, structured `EventEmitter2` events since before this port existed
 * — but until `DisputeNotificationListener` was added, nothing in this
 * codebase actually subscribed to them (`grep -rn "@OnEvent" src` used
 * to come back empty). This is the delivery side: three adapters
 * (`EmailDisputeNotificationAdapter`/`SlackDisputeNotificationAdapter`/
 * `WebhookDisputeNotificationAdapter`), one per `MerchantEntity.disputeNotificationChannel`
 * value, dispatched per-merchant by `DisputeNotificationDispatcherService`
 * — not a single-adapter port like `BankTransferPort`/`KYCProviderPort`,
 * since which concrete adapter answers this interface varies by
 * merchant, not by deployment.
 */
export abstract class DisputeNotificationPort {
  abstract send(target: string, payload: DisputeNotificationPayload): Promise<void>;
}
