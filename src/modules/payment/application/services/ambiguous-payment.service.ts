import { Injectable, Logger, NotFoundException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { randomUUID as uuidv4 } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';
import { PaymentAggregate } from '../../domain/aggregates/payment.aggregate';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { PaymentMapper } from '../../adapters/persistence/mappers/payment.mapper';
import { ChargeLedgerParamsResolverService } from './charge-ledger-params-resolver.service';
import { ReserveService } from './reserve.service';

// Same cadence as LedgerOutboxRelayService.detectStaleEvents() — this is
// the same category of "alert, don't act" sweep, just for AMBIGUOUS
// payments instead of stuck outbox events.
const ALERT_THRESHOLD_MINUTES = 15;

/**
 * Ambiguous Payment Service (Phase 1 of the AMBIGUOUS-resolution gap —
 * see docs/business-domain/payment-lifecycle.md's note on AMBIGUOUS).
 *
 * `PaymentCheckoutSaga.compensate_markAmbiguous()` marks a payment
 * AMBIGUOUS when a PSP call gets no response at all and a same-provider
 * retry also gets no response — deliberately not FAILED, since this
 * system genuinely doesn't know whether the PSP actually processed the
 * charge. Nothing in this codebase automatically resolves that status:
 * `WebhookProcessingService` matches incoming webhooks by
 * `pspTransactionId`, which an ambiguous outcome never received: that's
 * the definition of ambiguous. This service is the manual escape
 * hatch — an operator who has checked the PSP's own dashboard/API
 * directly can record what actually happened, going through the same
 * ledger-booking path a webhook-confirmed success would (see resolve()'s
 * SUCCEEDED branch, deliberately mirroring
 * WebhookProcessingService.markSucceeded() rather than reusing its
 * private method, which is keyed by pspTransactionId lookup — the one
 * thing an AMBIGUOUS payment doesn't have until this call supplies it).
 *
 * What this doesn't do: actively query the PSP to resolve the ambiguity
 * automatically (e.g. a scheduled retry against the same idempotency
 * key) — that's the larger, not-yet-built Phase 2. This is the
 * "at least someone *can* fix it, and someone finds out it needs
 * fixing" phase.
 */
@Injectable()
export class AmbiguousPaymentService {
  private readonly logger = new Logger(AmbiguousPaymentService.name);

  constructor(
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly chargeLedgerParams: ChargeLedgerParamsResolverService,
    private readonly reserveService: ReserveService,
  ) {}

  async listStale(olderThanMinutes: number): Promise<PaymentAggregate[]> {
    return this.paymentRepository.findAmbiguousOlderThan(olderThanMinutes);
  }

  private async getOwnedAmbiguous(paymentId: string): Promise<PaymentAggregate> {
    // Master, not the ambient replica-routed connection — same reasoning
    // as PaymentLifecycleService.getOwnedPayment(): an operator resolving
    // this could plausibly be reacting to a payment that was only just
    // marked AMBIGUOUS moments earlier, and the ~1s replica lag is a real
    // window to lose.
    const payment = await this.paymentRepository.findByIdOnMaster(paymentId);
    if (!payment) {
      throw new NotFoundException({ statusCode: 404, error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
    }
    if (payment.status !== PaymentStatus.AMBIGUOUS) {
      throw new ConflictException({
        statusCode: 409,
        error: `Payment ${paymentId} is ${payment.status}, not AMBIGUOUS — nothing to resolve`,
        code: 'PAYMENT_NOT_AMBIGUOUS',
      });
    }
    return payment;
  }

  /**
   * Records an operator's determination of what actually happened at the
   * PSP for a payment stuck AMBIGUOUS. SUCCEEDED books the same ledger
   * entries a webhook confirmation would (fee/reserve/split resolution,
   * transactional payment+outbox write) — this is real money being
   * recorded as collected, not just a status flip. FAILED is the
   * simpler branch: no charge happened, nothing to book.
   */
  async resolve(params: {
    paymentId: string;
    outcome: 'SUCCEEDED' | 'FAILED';
    pspTransactionId?: string;
    reason: string;
    resolvedBy: string;
  }): Promise<PaymentAggregate> {
    const payment = await this.getOwnedAmbiguous(params.paymentId);

    if (params.outcome === 'SUCCEEDED') {
      if (!params.pspTransactionId) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'pspTransactionId is required when outcome is SUCCEEDED — an ambiguous payment never received one automatically',
          code: 'PSP_TRANSACTION_ID_REQUIRED',
        });
      }

      payment.markSucceeded(params.pspTransactionId);
      payment.recordManualAmbiguousResolution(params.resolvedBy, params.reason);

      // Same sequence as WebhookProcessingService.markSucceeded()'s
      // ledger-booking — see that method's comments for why each piece
      // is here (splits surviving a REQUIRES_ACTION-style detour,
      // settlement conversion, the reserve hold write sharing this same
      // transaction). Not called directly: that method is private and
      // keyed by pspTransactionId lookup (the payment is already in hand
      // here, already validated AMBIGUOUS), so duplicating this short
      // sequence is more direct than reshaping a webhook-specific method
      // to serve a second caller — the same judgment call
      // ChargeLedgerParamsResolverService's own docblock describes for
      // why each of ITS three callers keeps its own transaction wrapper.
      const { platformFee, settlementConversion, reserveHold, splits } = await this.chargeLedgerParams.resolve(
        payment.metadata.merchantId,
        payment.amount,
        payment.splits,
      );
      if (settlementConversion) {
        payment.recordSettlementConversion({
          currency: settlementConversion.convertedNetAmount.currency.code,
          rate: settlementConversion.rate,
          provider: settlementConversion.provider,
        });
      }
      const outboxEvent = LedgerOutboxEvent.createChargeEntries({
        id: uuidv4(),
        paymentId: payment.id,
        merchantId: payment.metadata.merchantId,
        amount: payment.amount,
        platformFee,
        settlementConversion,
        reserveHold,
        splits,
      });

      await this.dataSource.transaction(async (manager) => {
        await manager.save(PaymentMapper.toPersistence(payment));
        await this.ledgerOutbox.saveWithPayment(payment.id, outboxEvent, manager);
        if (reserveHold) {
          await this.reserveService.recordHold(
            { paymentId: payment.id, merchantId: payment.metadata.merchantId, amount: reserveHold.amount, holdDays: reserveHold.holdDays },
            manager,
          );
        }
      });

      this.logger.warn(`Payment ${payment.id} manually resolved AMBIGUOUS -> SUCCEEDED by ${params.resolvedBy} (pspTransactionId=${params.pspTransactionId}): ${params.reason}`);
    } else {
      payment.markFailed(params.reason, 'MANUALLY_RESOLVED_AMBIGUOUS');
      payment.recordManualAmbiguousResolution(params.resolvedBy, params.reason);
      await this.paymentRepository.update(payment);
      this.logger.warn(`Payment ${payment.id} manually resolved AMBIGUOUS -> FAILED by ${params.resolvedBy}: ${params.reason}`);
    }

    this.publish(payment);
    return payment;
  }

  /**
   * Alert-only, same posture as LedgerOutboxRelayService.detectStaleEvents()
   * — no state mutation, just makes sure a human finds out an AMBIGUOUS
   * payment is sitting unresolved rather than it being silently invisible
   * (nothing else in this codebase surfaces one). Not itself a fix for
   * the "no automated resolution" gap — see this class's docblock.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'ambiguous-payment-alert' })
  async alertOnStale(): Promise<void> {
    const stale = await this.paymentRepository.findAmbiguousOlderThan(ALERT_THRESHOLD_MINUTES);
    if (stale.length === 0) return;

    for (const payment of stale) {
      this.logger.error(
        `Payment ${payment.id} (merchant ${payment.metadata.merchantId}, ${payment.pspProvider ?? 'unknown PSP'}) has been AMBIGUOUS for ` +
        `>${ALERT_THRESHOLD_MINUTES}min with no automated resolution — check the PSP directly and resolve via ` +
        `POST /admin/payments/${payment.id}/resolve-ambiguous`,
      );
    }
  }

  private publish(payment: PaymentAggregate): void {
    const events = payment.pullDomainEvents();
    for (const event of events) {
      this.eventEmitter.emit(event.eventName, event);
    }
  }
}
