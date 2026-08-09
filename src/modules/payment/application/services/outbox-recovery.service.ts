import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';

/**
 * Outbox Recovery Service
 * Operator-facing recovery for dead-lettered ledger outbox events.
 *
 * LedgerOutboxRelayService.markFailed() is deliberately terminal — a
 * publish error stops auto-retry rather than risk silently retrying
 * forever and double-publishing downstream. Before this existed, the only
 * way to recover a FAILED event was a manual SQL update
 * (`UPDATE ledger_outbox SET status = 'PENDING' WHERE id = ...`), the same
 * category of gap `npm run seed:admin` closed for merchant bootstrap.
 */
@Injectable()
export class OutboxRecoveryService {
  private readonly logger = new Logger(OutboxRecoveryService.name);

  constructor(private readonly ledgerOutbox: LedgerOutboxPort) {}

  async listFailed(limit?: number): Promise<LedgerOutboxEvent[]> {
    return this.ledgerOutbox.findFailed(limit);
  }

  /**
   * Resets a FAILED event back to PENDING so the relay's next
   * EVERY_10_SECONDS tick picks it up. Does not touch the event's
   * `entries` — this is purely a delivery-status reset, not a correction of
   * the underlying ledger entries (those were already validated for
   * double-entry balance at creation and must not be edited here).
   */
  async retry(eventId: string): Promise<void> {
    const event = await this.ledgerOutbox.findById(eventId);
    if (!event) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Ledger outbox event ${eventId} not found`,
        code: 'OUTBOX_EVENT_NOT_FOUND',
      });
    }

    const reset = await this.ledgerOutbox.resetToPending(eventId);
    if (!reset) {
      // Lost a race with another retry, or the event moved on (e.g. got
      // published) between the findById above and the conditional update.
      throw new ConflictException({
        statusCode: 409,
        error: `Ledger outbox event ${eventId} is not in FAILED status (currently ${event.status})`,
        code: 'OUTBOX_EVENT_NOT_FAILED',
      });
    }

    this.logger.warn(`Ledger outbox event ${eventId} (payment ${event.paymentId}) reset FAILED -> PENDING for retry`);
  }
}
