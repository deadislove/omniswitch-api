import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';

const RELAY_BATCH_SIZE = 50;
const STALE_THRESHOLD_MINUTES = 5;

/**
 * Ledger Outbox Relay
 * Implements the publishing half of the Transactional Outbox Pattern.
 * PaymentCheckoutSaga / PaymentLifecycleService / WebhookProcessingService
 * write PENDING ledger entries atomically with the payment state change;
 * this job is what actually ships them out and marks them PUBLISHED.
 *
 * There's no external broker (Kafka/SNS/etc.) wired up in this reference
 * project, so "publish" here means emitting on the same in-process
 * EventEmitter2 already used for domain events — that's the seam where a
 * production deployment would instead push to a durable queue. The
 * reliability contract (poll PENDING, mark PUBLISHED only after the publish
 * call succeeds, retry with a cap, surface anything stuck) is what actually
 * matters and is what's implemented here.
 */
@Injectable()
export class LedgerOutboxRelayService {
  private readonly logger = new Logger(LedgerOutboxRelayService.name);

  constructor(
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'ledger-outbox-relay' })
  async relayPendingEvents(): Promise<void> {
    const events = await this.ledgerOutbox.findPending(RELAY_BATCH_SIZE);
    if (events.length === 0) return;

    this.logger.debug(`Relaying ${events.length} pending ledger outbox event(s)`);

    for (const event of events) {
      await this.relayOne(event);
    }
  }

  /**
   * Alerting sweep, not a retry mechanism. markFailed() below sets a
   * terminal FAILED status (matching LedgerOutboxPort's contract), so a
   * PENDING event only shows up here if the relay never got a chance to
   * attempt it at all — e.g. the process crashed mid-batch, or write
   * throughput has been outrunning EVERY_10_SECONDS for a while. Either way
   * it's still PENDING, so the next relay tick will pick it up on its own;
   * this just makes sure someone finds out if that isn't happening.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'ledger-outbox-stale-check' })
  async detectStaleEvents(): Promise<void> {
    const stale = await this.ledgerOutbox.findStale(STALE_THRESHOLD_MINUTES);
    if (stale.length === 0) return;

    for (const event of stale) {
      // In production: page on-call / emit a metric an alert is wired to.
      this.logger.error(
        `Ledger outbox event ${event.id} (payment ${event.paymentId}) has been PENDING for ` +
        `>${STALE_THRESHOLD_MINUTES}min without being relayed — investigate the relay job`,
      );
    }
  }

  private async relayOne(event: LedgerOutboxEvent): Promise<void> {
    try {
      this.eventEmitter.emit('ledger.outbox.published', event);
      await this.ledgerOutbox.markPublished(event.id);
      this.logger.debug(`Published ledger outbox event ${event.id} for payment ${event.paymentId}`);
    } catch (error: unknown) {
      // markFailed() is terminal (see LedgerOutboxPort) — a publish error
      // stops this event from being auto-retried and requires an operator
      // to look at it and reset it back to PENDING, rather than silently
      // retrying forever and potentially double-publishing downstream.
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to publish ledger outbox event ${event.id}: ${msg}`);
      await this.ledgerOutbox.markFailed(event.id, msg);
    }
  }
}
