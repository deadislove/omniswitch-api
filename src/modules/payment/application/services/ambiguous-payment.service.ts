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
import { PaymentProcessorFactory } from '../../adapters/psp/payment-processor.factory';

// Same cadence as LedgerOutboxRelayService.detectStaleEvents() — this is
// the same category of "alert, don't act" sweep, just for AMBIGUOUS
// payments instead of stuck outbox events.
const ALERT_THRESHOLD_MINUTES = 15;

/**
 * Ambiguous Payment Service — see docs/business-domain/payment-lifecycle.md's
 * note on AMBIGUOUS.
 *
 * `PaymentCheckoutSaga.compensate_markAmbiguous()` marks a payment
 * AMBIGUOUS when a PSP call gets no response at all and a same-provider
 * retry also gets no response — deliberately not FAILED, since this
 * system genuinely doesn't know whether the PSP actually processed the
 * charge. `WebhookProcessingService` matches incoming webhooks by
 * `pspTransactionId`, which an ambiguous outcome never received: that's
 * the definition of ambiguous, so a webhook alone never resolves one.
 *
 * Two resolution paths live here:
 *  - resolve() — the manual escape hatch. An operator who has checked the
 *    PSP's own dashboard/API directly records what actually happened,
 *    going through the same ledger-booking path a webhook-confirmed
 *    success would (see bookSucceeded(), deliberately mirroring
 *    WebhookProcessingService.markSucceeded() rather than reusing its
 *    private method, which is keyed by pspTransactionId lookup — the one
 *    thing an AMBIGUOUS payment doesn't have until this call supplies
 *    it).
 *  - runAutoResolutionSweep() — the automated path. Asks the PSP itself
 *    via PSPAdapterPort.queryOutcome(), keyed by idempotency key (not a
 *    new charge attempt — this system never persists the card reference
 *    past the original request, so a sweep running minutes later has
 *    nothing to charge with even if it wanted to retry). Bounded by
 *    AMBIGUOUS_AUTO_RESOLUTION_MAX_ATTEMPTS; once a payment hits the cap
 *    without a definitive answer, the sweep stops touching it and
 *    alertOnStale() below keeps escalating it to a human.
 */
@Injectable()
export class AmbiguousPaymentService {
  private readonly logger = new Logger(AmbiguousPaymentService.name);
  private readonly maxAutoResolutionAttempts: number;
  private readonly minAutoResolutionAgeMinutes: number;

  constructor(
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly chargeLedgerParams: ChargeLedgerParamsResolverService,
    private readonly reserveService: ReserveService,
    private readonly processorFactory: PaymentProcessorFactory,
  ) {
    // Read directly from process.env in the constructor, not module-level
    // consts — so an e2e test can override before createTestApp() reads
    // this service's providers. Same reasoning/pattern as
    // AmbiguousRiskMonitoringService's thresholds, established after
    // PSP_BULKHEAD_MAX_CONCURRENT's hoisting bug (a module-level const
    // captures process.env at import time, before a test's beforeAll has
    // a chance to set it).
    this.maxAutoResolutionAttempts = Number(process.env.AMBIGUOUS_AUTO_RESOLUTION_MAX_ATTEMPTS) || 5;
    this.minAutoResolutionAgeMinutes = Number(process.env.AMBIGUOUS_AUTO_RESOLUTION_MIN_AGE_MINUTES) || 5;
  }

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
      await this.bookSucceeded(payment);

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
   * Shared ledger-booking sequence for an AMBIGUOUS payment that just
   * turned out to have actually succeeded at the PSP — same sequence as
   * WebhookProcessingService.markSucceeded()'s ledger-booking (see that
   * method's comments for why each piece is here: splits surviving a
   * REQUIRES_ACTION-style detour, settlement conversion, the reserve
   * hold write sharing this same transaction). Not called directly:
   * that method is private and keyed by pspTransactionId lookup, so
   * duplicating this short sequence here (shared between resolve()'s
   * manual path and runAutoResolutionSweep()'s automated one, rather
   * than a third copy) is more direct than reshaping a webhook-specific
   * method to serve two more callers — the same judgment call
   * ChargeLedgerParamsResolverService's own docblock describes for why
   * each of ITS callers keeps its own transaction wrapper. Caller must
   * already have called payment.markSucceeded() first.
   */
  private async bookSucceeded(payment: PaymentAggregate): Promise<void> {
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
  }

  /**
   * The automated resolution sweep — asks the PSP what actually happened
   * to each eligible AMBIGUOUS payment via PSPAdapterPort.queryOutcome(),
   * and books/fails/keeps-waiting accordingly. `@Cron` + on-demand
   * (AmbiguousPaymentAdminController's run-now endpoint), same dual
   * pattern as AmbiguousRiskMonitoringService.runAutoClearSweep(). Every
   * item gets its own try/catch — one payment's PSP call failing (e.g. a
   * transient network error, not a real STILL_UNKNOWN answer) must not
   * abort the whole batch, same posture as PayoutService's sweep.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'ambiguous-payment-auto-resolution' })
  async runAutoResolutionSweep(): Promise<{ succeeded: number; failed: number; stillUnknown: number; skipped: number }> {
    const eligible = await this.paymentRepository.findAmbiguousEligibleForAutoResolution(
      this.maxAutoResolutionAttempts,
      this.minAutoResolutionAgeMinutes,
    );
    const result = { succeeded: 0, failed: 0, stillUnknown: 0, skipped: 0 };

    for (const payment of eligible) {
      try {
        await this.autoResolveOne(payment, result);
      } catch (error) {
        this.logger.error(`Auto-resolution sweep failed for payment ${payment.id}: ${error.message}`);
      }
    }

    return result;
  }

  private async autoResolveOne(
    payment: PaymentAggregate,
    result: { succeeded: number; failed: number; stillUnknown: number; skipped: number },
  ): Promise<void> {
    // Re-read on master right before acting, not the (possibly
    // now-stale) copy the sweep's list query returned — an operator may
    // have resolved this exact payment manually via
    // POST /admin/payments/:id/resolve-ambiguous between the sweep's
    // list query and this iteration reaching it. Silently skip rather
    // than error: this is an expected race, not a fault, and
    // markSucceeded()/markFailed() would throw on a payment that's no
    // longer AMBIGUOUS anyway (assertValidTransition).
    const fresh = await this.paymentRepository.findByIdOnMaster(payment.id);
    if (!fresh || fresh.status !== PaymentStatus.AMBIGUOUS) {
      result.skipped++;
      return;
    }
    if (!fresh.pspProvider) {
      // Can't happen in practice — a payment only ever reaches AMBIGUOUS
      // after startProcessing() records which PSP it was attempted
      // against — but queryOutcome() has nothing to ask without it.
      result.skipped++;
      return;
    }

    const adapter = this.processorFactory.getAdapter(fresh.pspProvider);
    const outcome = await adapter.queryOutcome(fresh.idempotencyKey);

    if (outcome.outcome === 'SUCCEEDED' && outcome.pspTransactionId) {
      fresh.markSucceeded(outcome.pspTransactionId);
      await this.bookSucceeded(fresh);
      this.publish(fresh);
      result.succeeded++;
      this.logger.warn(`Payment ${fresh.id} auto-resolved AMBIGUOUS -> SUCCEEDED via PSP query (pspTransactionId=${outcome.pspTransactionId})`);
    } else if (outcome.outcome === 'FAILED') {
      fresh.markFailed('Auto-resolved via PSP query: the PSP has no record of this charge succeeding', outcome.errorCode ?? 'AUTO_RESOLVED_AMBIGUOUS');
      await this.paymentRepository.update(fresh);
      this.publish(fresh);
      result.failed++;
      this.logger.warn(`Payment ${fresh.id} auto-resolved AMBIGUOUS -> FAILED via PSP query (errorCode=${outcome.errorCode ?? 'unknown'})`);
    } else {
      fresh.incrementAmbiguousAutoRetryCount();
      await this.paymentRepository.update(fresh);
      result.stillUnknown++;
    }
  }

  /**
   * Alert-only, same posture as LedgerOutboxRelayService.detectStaleEvents()
   * — no state mutation, just makes sure a human finds out an AMBIGUOUS
   * payment is sitting unresolved rather than it being silently invisible
   * (nothing else in this codebase surfaces one). Deliberately fires well
   * before runAutoResolutionSweep() exhausts its own retry budget
   * (ALERT_THRESHOLD_MINUTES is well under
   * maxAutoResolutionAttempts * the sweep's cron interval): a human
   * finding out early that something is stuck is more useful than a
   * human only finding out once automation has already given up.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'ambiguous-payment-alert' })
  async alertOnStale(): Promise<void> {
    const stale = await this.paymentRepository.findAmbiguousOlderThan(ALERT_THRESHOLD_MINUTES);
    if (stale.length === 0) return;

    for (const payment of stale) {
      this.logger.error(
        `Payment ${payment.id} (merchant ${payment.metadata.merchantId}, ${payment.pspProvider ?? 'unknown PSP'}) has been AMBIGUOUS for ` +
        `>${ALERT_THRESHOLD_MINUTES}min (auto-resolution attempts so far: ${payment.ambiguousAutoRetryCount}/${this.maxAutoResolutionAttempts}) — ` +
        `check the PSP directly if this persists, or resolve via POST /admin/payments/${payment.id}/resolve-ambiguous`,
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
