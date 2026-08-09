import { Injectable, Logger, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DisputePort, FindDisputesFilter } from '../../ports/outbound/dispute.port';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { PaymentProcessorFactory } from '../../adapters/psp/payment-processor.factory';
import { Dispute } from '../../domain/aggregates/dispute.aggregate';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';
import { PaymentMapper } from '../../adapters/persistence/mappers/payment.mapper';
import { decideAutoDisposition, autoContestEvidenceFor } from '../../domain/services/dispute-policy';

/**
 * Dispute Service
 * Owns the Dispute record's lifecycle (see Dispute aggregate's docblock for
 * why this exists as its own thing, not just a PaymentAggregate status
 * flip) and the payment-status/ledger side effects of a dispute resolving.
 *
 * Dispute *creation* is driven by WebhookProcessingService (a PSP telling us
 * a chargeback happened); *resolution* also arrives by webhook (the PSP/card
 * network's decision, not something this system or the merchant decides).
 * The only thing genuinely operator-initiated here is submitEvidence —
 * everything else is this service reacting to what a PSP reported.
 */
@Injectable()
export class DisputeService {
  private readonly logger = new Logger(DisputeService.name);

  constructor(
    private readonly disputePort: DisputePort,
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly processorFactory: PaymentProcessorFactory,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async recordDispute(params: {
    paymentId: string;
    merchantId: string;
    pspProvider: PSPProvider;
    pspDisputeId: string;
    amount: Money;
    reason?: string;
  }): Promise<Dispute> {
    const existing = await this.disputePort.findByPspDisputeId(params.pspDisputeId);
    if (existing) {
      // PSPs redeliver webhooks at least once — same idempotency posture as
      // WebhookProcessingService's other handlers.
      this.logger.debug(`Duplicate dispute webhook for pspDisputeId=${params.pspDisputeId}, ignoring`);
      return existing;
    }

    // See dispute-policy.ts's docblock for the (deliberately simple,
    // illustrative) thresholds. 'CONTEST' actually calls the PSP with a
    // template response right here, immediately, before this dispute is
    // ever visible to an operator; 'ACCEPT'/'MANUAL_REVIEW' are
    // recommendations only — this system has no PSP "accept/close" action
    // to call, so 'ACCEPT' just tells the operator not to bother, it
    // doesn't take an action a human wouldn't otherwise need to.
    const autoDecision = decideAutoDisposition(params.amount, params.reason);
    const dispute = Dispute.create({ id: uuidv4(), ...params, autoDecision });

    if (autoDecision === 'CONTEST') {
      const evidence = autoContestEvidenceFor(params.reason);
      try {
        const adapter = this.processorFactory.getAdapter(dispute.pspProvider);
        const result = await adapter.submitDisputeEvidence(dispute.pspDisputeId, evidence);
        if (result.success) {
          // Mutates the in-memory aggregate directly — status ->
          // UNDER_REVIEW — rather than calling this.submitEvidence(id, ...)
          // (which would re-fetch by id, and this dispute hasn't been
          // saved yet at all). Same "act on the object you already have,
          // don't re-fetch" posture ReserveService.release() had to adopt
          // after finding a replica-lag bug doing the opposite.
          dispute.submitEvidence(evidence);
        } else {
          this.logger.warn(
            `Auto-contest evidence submission declined by PSP for dispute ${dispute.id} (${result.errorMessage ?? 'no reason given'}) — leaving for manual review`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Auto-contest evidence submission threw for dispute ${dispute.id}: ${msg} — leaving for manual review`);
      }
    }

    await this.disputePort.save(dispute);

    // Structured event, not just a log line — a real notification
    // integration (email/Slack/paging) has something to subscribe to now,
    // even though nothing does yet. Same stand-in posture as
    // ReconciliationService/LedgerOutboxRelayService's alerting elsewhere
    // in this codebase.
    this.eventEmitter.emit('dispute.created', {
      disputeId: dispute.id,
      paymentId: dispute.paymentId,
      merchantId: dispute.merchantId,
      pspProvider: dispute.pspProvider,
      amount: dispute.amount.amount,
      currency: dispute.amount.currency.code,
      reason: dispute.reason,
      autoDecision,
      status: dispute.status,
      respondBy: dispute.respondBy.toISOString(),
    });

    this.logger.warn(
      `New dispute ${dispute.id} for payment ${params.paymentId} (${params.amount.toString()}) — ` +
      `auto-decision=${autoDecision}, status=${dispute.status} — needs a response by ${dispute.respondBy.toISOString()}`,
    );
    return dispute;
  }

  async submitEvidence(disputeId: string, evidence: string): Promise<Dispute> {
    const dispute = await this.disputePort.findById(disputeId);
    if (!dispute) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Dispute ${disputeId} not found`,
        code: 'DISPUTE_NOT_FOUND',
      });
    }
    if (dispute.status !== 'NEEDS_RESPONSE') {
      throw new ConflictException({
        statusCode: 409,
        error: `Dispute is in status ${dispute.status}, not NEEDS_RESPONSE`,
        code: 'DISPUTE_NOT_RESPONDABLE',
      });
    }

    const adapter = this.processorFactory.getAdapter(dispute.pspProvider);
    const result = await adapter.submitDisputeEvidence(dispute.pspDisputeId, evidence);
    if (!result.success) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: result.errorMessage ?? 'PSP declined the evidence submission',
        code: 'EVIDENCE_SUBMISSION_FAILED',
      });
    }

    dispute.submitEvidence(evidence);
    await this.disputePort.save(dispute);
    this.logger.log(`Evidence submitted for dispute ${dispute.id}, now UNDER_REVIEW`);
    return dispute;
  }

  async findMany(filter?: FindDisputesFilter): Promise<Dispute[]> {
    return this.disputePort.findMany(filter);
  }

  async findById(id: string): Promise<Dispute | null> {
    return this.disputePort.findById(id);
  }

  /**
   * Applies the PSP's final decision — called from
   * WebhookProcessingService when a resolution webhook arrives (Stripe
   * `charge.dispute.closed`, Adyen `CHARGEBACK`/`CHARGEBACK_REVERSED`).
   */
  async resolveByPspDisputeId(pspDisputeId: string, outcome: 'WON' | 'LOST'): Promise<void> {
    const dispute = await this.disputePort.findByPspDisputeId(pspDisputeId);
    if (!dispute) {
      this.logger.warn(`Dispute resolution webhook for unknown pspDisputeId=${pspDisputeId}`);
      return;
    }
    if (dispute.status === 'WON' || dispute.status === 'LOST') {
      this.logger.debug(`Duplicate resolution webhook for dispute ${dispute.id}, already ${dispute.status}`);
      return;
    }

    // Forced onto master (findByIdOnMaster(), not findById()) — this gates
    // whether the payment/ledger side of a dispute resolution actually
    // runs. A stale (pre-DISPUTED) read here doesn't just show wrong data,
    // it makes this method silently skip the update below — confirmed
    // live: a lost dispute's charge.dispute.closed webhook, processed
    // shortly after the charge.dispute.created webhook that set DISPUTED,
    // raced this exact read. See PaymentRepositoryPort.findByIdOnMaster().
    const payment = await this.paymentRepository.findByIdOnMaster(dispute.paymentId);
    if (!payment || payment.status !== PaymentStatus.DISPUTED) {
      this.logger.warn(
        `Dispute ${dispute.id} resolved ${outcome} but payment ${dispute.paymentId} is not DISPUTED (status=${payment?.status ?? 'not found'}) — skipping payment/ledger update`,
      );
      dispute.resolve(outcome);
      await this.disputePort.save(dispute);
      this.emitResolvedEvent(dispute, outcome);
      return;
    }

    dispute.resolve(outcome);
    payment.resolveDispute(outcome);

    if (outcome === 'LOST') {
      // Same ledger shape as a normal refund (PaymentLifecycleService.refund())
      // — a lost chargeback moves money out of the merchant's account via
      // the PSP settlement account exactly like a refund does, it's just
      // not merchant-initiated. See PaymentAggregate.resolveDispute()'s
      // comment for why this reuses the refunds[] bookkeeping too. Same
      // settlement-currency replay as a normal refund, and for the same
      // reason — see PaymentLifecycleService.refund()'s comment.
      const settlementConversion = payment.settlementConversion;
      // Same proportional-reversal treatment a normal refund gets — see
      // PaymentLifecycleService.refund()'s comment and
      // createRefundEntries()'s splits param.
      const splits = payment.splits;
      const outboxEvent = LedgerOutboxEvent.createRefundEntries({
        id: uuidv4(),
        paymentId: payment.id,
        merchantId: payment.metadata.merchantId,
        refundAmount: dispute.amount,
        settlementConversion: settlementConversion
          ? {
              convertedRefundAmount: dispute.amount.convertTo(settlementConversion.currency, settlementConversion.rate, settlementConversion.provider),
              rate: settlementConversion.rate,
              provider: settlementConversion.provider,
            }
          : undefined,
        splits,
        originalChargeAmount: splits ? payment.amount : undefined,
      });
      await this.dataSource.transaction(async (manager) => {
        await manager.save(PaymentMapper.toPersistence(payment));
        await this.ledgerOutbox.saveWithPayment(payment.id, outboxEvent, manager);
      });
    } else {
      await this.paymentRepository.update(payment);
    }

    await this.disputePort.save(dispute);

    const events = payment.pullDomainEvents();
    for (const event of events) {
      this.eventEmitter.emit(event.eventName, event);
    }
    this.emitResolvedEvent(dispute, outcome);

    this.logger.log(`Dispute ${dispute.id} resolved ${outcome} — payment ${payment.id} now ${payment.status}`);
  }

  private emitResolvedEvent(dispute: Dispute, outcome: 'WON' | 'LOST'): void {
    this.eventEmitter.emit('dispute.resolved', {
      disputeId: dispute.id,
      paymentId: dispute.paymentId,
      merchantId: dispute.merchantId,
      outcome,
      amount: dispute.amount.amount,
      currency: dispute.amount.currency.code,
      autoDecision: dispute.autoDecision,
    });
  }
}
