import { LedgerOutboxEvent, OutboxStatus } from '../../domain/aggregates/ledger-outbox.aggregate';

/**
 * Ledger Outbox Port (Outbound)
 * Defines the contract for the Transactional Outbox Pattern.
 * Ensures atomic write of payment + ledger event in same DB transaction.
 */
export abstract class LedgerOutboxPort {
  /**
   * Atomically save a payment and its ledger outbox event in the same transaction.
   * This is the core of the Outbox Pattern - guarantees at-least-once delivery.
   */
  abstract saveWithPayment(
    paymentId: string,
    outboxEvent: LedgerOutboxEvent,
    transactionManager?: unknown,
  ): Promise<void>;

  /**
   * Fetch pending outbox events for the relay/publisher process
   */
  abstract findPending(limit?: number): Promise<LedgerOutboxEvent[]>;

  /**
   * Mark an outbox event as published
   */
  abstract markPublished(eventId: string): Promise<void>;

  /**
   * Mark an outbox event as failed with error details
   */
  abstract markFailed(eventId: string, error: string): Promise<void>;

  /**
   * Find events that have been pending too long (for dead-letter handling)
   */
  abstract findStale(olderThanMinutes: number): Promise<LedgerOutboxEvent[]>;

  /**
   * Fetch a single outbox event by id — used by the dead-letter recovery
   * endpoints to look up an event's current state (e.g. for a clear error
   * message when a retry is attempted on something that isn't FAILED).
   */
  abstract findById(eventId: string): Promise<LedgerOutboxEvent | null>;

  /**
   * List FAILED (dead-letter) events for operator review.
   */
  abstract findFailed(limit?: number): Promise<LedgerOutboxEvent[]>;

  /**
   * Reset a FAILED event back to PENDING so the relay picks it up on its
   * next tick. Atomic and conditional on the current status being FAILED
   * (a plain read-then-write here would race two operators retrying the
   * same event at once) — returns false if the event didn't exist or
   * wasn't in FAILED status, true if the reset actually happened.
   */
  abstract resetToPending(eventId: string): Promise<boolean>;

  /**
   * Total count of events in a given status — used for the /metrics
   * endpoint's outbox backlog gauges. Deliberately a separate method from
   * findPending()/findFailed(), which are capped by `limit` and so cannot
   * report a true total.
   */
  abstract countByStatus(status: OutboxStatus): Promise<number>;

  /**
   * Every outbox event created in `[since, until)`, regardless of status —
   * used by PayoutService.runSweep() to aggregate each CONNECTED
   * merchant's net MERCHANT-entry ledger balance for a payout window.
   * Deliberately not filtered to PUBLISHED-only: `status` only tracks
   * whether the outbox relay has told an external system about this
   * event, not whether the money it represents is real — the write inside
   * `saveWithPayment()`'s transaction is already the source of truth.
   */
  abstract findCreatedBetween(since: Date, until: Date): Promise<LedgerOutboxEvent[]>;
}
