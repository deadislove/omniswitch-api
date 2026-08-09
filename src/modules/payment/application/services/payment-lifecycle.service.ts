import { Injectable, Logger, NotFoundException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { PaymentProcessorFactory } from '../../adapters/psp/payment-processor.factory';
import { PaymentAggregate } from '../../domain/aggregates/payment.aggregate';
import { PaymentStatus, isValidTransition } from '../../domain/value-objects/payment-status.vo';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';
import { Money } from '../../domain/value-objects/money.vo';
import { PaymentMapper } from '../../adapters/persistence/mappers/payment.mapper';
import { ChargeLedgerParamsResolverService } from './charge-ledger-params-resolver.service';
import { ReserveService } from './reserve.service';

/**
 * Payment Lifecycle Service
 * Orchestrates refund/capture/cancel — the post-charge operations the
 * checkout saga doesn't cover. Follows the same pattern as the saga: PSP
 * call first, then an atomic DB transaction for the aggregate + ledger
 * outbox entry, then publish domain events.
 */
@Injectable()
export class PaymentLifecycleService {
  private readonly logger = new Logger(PaymentLifecycleService.name);

  constructor(
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly processorFactory: PaymentProcessorFactory,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly chargeLedgerParams: ChargeLedgerParamsResolverService,
    private readonly reserveService: ReserveService,
  ) {}

  async getOwnedPayment(paymentId: string): Promise<PaymentAggregate> {
    // Forced onto master (findByIdOnMaster(), not findById()) — this backs
    // refund/capture/cancel, which a caller can (and this project's own
    // e2e suite does) call immediately after the charge that created this
    // payment. See PaymentRepositoryPort.findByIdOnMaster()'s docblock.
    const payment = await this.paymentRepository.findByIdOnMaster(paymentId);
    if (!payment) {
      throw new NotFoundException({ statusCode: 404, error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
    }
    return payment;
  }

  async refund(params: {
    payment: PaymentAggregate;
    amount?: number;
    reason?: string;
    idempotencyKey: string;
  }): Promise<PaymentAggregate> {
    const { payment } = params;

    if (!payment.pspProvider || !payment.pspTransactionId) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Payment was never charged at a PSP, nothing to refund',
        code: 'NOT_REFUNDABLE',
      });
    }

    const refundAmount = params.amount
      ? Money.of(params.amount, payment.amount.currency.code)
      : payment.remainingRefundable;

    // Validate the refund is legal *before* calling the PSP so we don't send
    // a refund request that PaymentAggregate.refund() would reject anyway.
    const totalAfterRefund = payment.totalRefunded.add(refundAmount);
    if (totalAfterRefund.isGreaterThan(payment.amount)) {
      throw new ConflictException({
        statusCode: 409,
        error: `Refund amount exceeds remaining refundable balance (${payment.remainingRefundable.toString()})`,
        code: 'REFUND_EXCEEDS_BALANCE',
      });
    }

    const refundId = uuidv4();
    const adapter = this.processorFactory.getAdapter(payment.pspProvider);
    const pspResult = await adapter.refund({
      paymentId: payment.id,
      pspTransactionId: payment.pspTransactionId,
      refundId,
      amount: refundAmount,
      reason: params.reason ?? 'requested_by_customer',
      idempotencyKey: params.idempotencyKey,
    });

    if (!pspResult.success && pspResult.status !== 'PENDING') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: pspResult.errorMessage ?? 'PSP declined the refund',
        code: pspResult.errorCode ?? 'REFUND_DECLINED',
      });
    }

    payment.refund({
      refundId,
      amount: refundAmount,
      reason: params.reason ?? 'requested_by_customer',
      pspRefundId: pspResult.pspRefundId,
    });

    // Reuses the *original* charge-time rate, not a fresh one — see
    // LedgerOutboxEvent.createRefundEntries()'s settlementConversion
    // param and PaymentAggregate.recordSettlementConversion()'s docblock
    // for why. Only set at all if this payment's charge/capture was
    // actually settlement-converted; most payments have none.
    const settlementConversion = payment.settlementConversion;
    // Same "replay the original, don't recompute" posture for splits —
    // see PaymentAggregate.recordSplits()'s docblock and
    // createRefundEntries()'s splits param for the proportional-reversal
    // math. Only set if this payment's charge actually had splits.
    const splits = payment.splits;
    const outboxEvent = LedgerOutboxEvent.createRefundEntries({
      id: uuidv4(),
      paymentId: payment.id,
      merchantId: payment.metadata.merchantId,
      refundAmount,
      settlementConversion: settlementConversion
        ? {
            convertedRefundAmount: refundAmount.convertTo(settlementConversion.currency, settlementConversion.rate, settlementConversion.provider),
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

    this.publish(payment);
    this.logger.log(`Payment ${payment.id} refunded ${refundAmount.toString()} (refundId=${refundId})`);
    return payment;
  }

  async capture(params: {
    payment: PaymentAggregate;
    amount?: number;
    idempotencyKey: string;
  }): Promise<PaymentAggregate> {
    const { payment } = params;

    if (payment.status !== PaymentStatus.REQUIRES_CAPTURE && payment.status !== PaymentStatus.PARTIALLY_CAPTURED) {
      throw new ConflictException({
        statusCode: 409,
        error: `Payment is in status ${payment.status}, not REQUIRES_CAPTURE or PARTIALLY_CAPTURED`,
        code: 'NOT_CAPTURABLE',
      });
    }
    if (!payment.pspProvider || !payment.pspTransactionId) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Payment has no PSP authorization to capture',
        code: 'NOT_CAPTURABLE',
      });
    }

    // Omitting `amount` captures whatever's left — not the original
    // authorized amount, which would double-count anything already
    // captured by an earlier partial-capture call.
    const captureAmount = params.amount
      ? Money.of(params.amount, payment.amount.currency.code)
      : payment.remainingCapturable;

    if (captureAmount.isGreaterThan(payment.remainingCapturable)) {
      throw new ConflictException({
        statusCode: 409,
        error: `Capture amount ${captureAmount.toString()} exceeds remaining capturable amount ${payment.remainingCapturable.toString()}`,
        code: 'CAPTURE_EXCEEDS_AUTHORIZATION',
      });
    }

    const adapter = this.processorFactory.getAdapter(payment.pspProvider);
    const pspResult = await adapter.capture({
      paymentId: payment.id,
      pspTransactionId: payment.pspTransactionId,
      amount: captureAmount,
      idempotencyKey: params.idempotencyKey,
    });

    if (!pspResult.success) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: pspResult.errorMessage ?? 'PSP declined the capture',
        code: pspResult.errorCode ?? 'CAPTURE_DECLINED',
      });
    }

    payment.recordCapture({
      captureId: uuidv4(),
      amount: captureAmount,
      pspTransactionId: payment.pspTransactionId,
      pspRawResponse: pspResult.rawResponse,
    });

    // The charge is only *confirmed* now — book settlement entries at
    // capture time, not at authorization time (see PaymentCheckoutSaga for
    // the equivalent fix on the immediate-capture path). Each capture call
    // books only its own increment, whether or not it's the one that
    // completes the authorization — a partial capture is real money moving,
    // not a placeholder to be corrected later.
    const { platformFee, settlementConversion, reserveHold } = await this.chargeLedgerParams.resolve(payment.metadata.merchantId, captureAmount);
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
      amount: captureAmount,
      platformFee,
      settlementConversion,
      reserveHold,
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

    this.publish(payment);
    this.logger.log(`Payment ${payment.id} captured ${captureAmount.toString()} (status=${payment.status})`);
    return payment;
  }

  async cancel(params: { payment: PaymentAggregate; idempotencyKey: string }): Promise<PaymentAggregate> {
    const { payment } = params;

    if (payment.status === PaymentStatus.CANCELLED) {
      // Idempotent: cancelling an already-cancelled payment is a no-op success.
      return payment;
    }
    if (!isValidTransition(payment.status, PaymentStatus.CANCELLED)) {
      throw new ConflictException({
        statusCode: 409,
        error: `Payment in status ${payment.status} cannot be cancelled`,
        code: 'NOT_CANCELLABLE',
      });
    }

    // Only call the PSP if it already knows about this payment; a PENDING
    // payment that never reached the routing/charge step has nothing to
    // cancel remotely.
    if (payment.pspProvider && payment.pspTransactionId) {
      const adapter = this.processorFactory.getAdapter(payment.pspProvider);
      const pspResult = await adapter.cancel({
        paymentId: payment.id,
        pspTransactionId: payment.pspTransactionId,
        idempotencyKey: params.idempotencyKey,
      });
      if (!pspResult.success) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: pspResult.errorMessage ?? 'PSP declined the cancellation',
          code: pspResult.errorCode ?? 'CANCEL_DECLINED',
        });
      }
    }

    payment.cancel();
    await this.paymentRepository.update(payment);
    this.publish(payment);
    this.logger.log(`Payment ${payment.id} cancelled`);
    return payment;
  }

  private publish(payment: PaymentAggregate): void {
    const events = payment.pullDomainEvents();
    for (const event of events) {
      this.eventEmitter.emit(event.eventName, event);
    }
  }
}
