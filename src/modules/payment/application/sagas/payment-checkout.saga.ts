import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID as uuidv4 } from 'crypto';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { AcquirerRoutingService } from '../services/acquirer-routing.service';
import { PaymentAggregate, PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';
import { Money } from '../../domain/value-objects/money.vo';
import { BinInfo } from '../../domain/value-objects/bin-info.vo';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentMapper } from '../../adapters/persistence/mappers/payment.mapper';
import { PaymentEntity } from '../../adapters/persistence/entities/payment.entity';
import { ChargeLedgerParamsResolverService, ChargeLedgerParams } from '../services/charge-ledger-params-resolver.service';
import { ReserveService } from '../services/reserve.service';
import { isAmbiguousOutcomeError } from '../../adapters/psp/payment-processor.factory';

export interface CheckoutSagaInput {
  paymentId: string;
  idempotencyKey: string;
  amount: Money;
  merchantId: string;
  customerId?: string;
  orderId?: string;
  description?: string;
  binInfo?: BinInfo;
  paymentMethodId?: string;
  cardToken?: string;
  preferredProvider?: PSPProvider;
  captureMethod?: 'automatic' | 'manual';
  /** Marketplace split targets — see ChargeLedgerParamsResolverService.resolve()'s docblock. */
  splits?: { merchantId: string; amount: Money }[];
  /** Free-form attribution bag stored verbatim on PaymentAggregate.metadata.metadata — currently only populated by PaymentController.charge() for an agent-initiated charge (delegationId, initiatedBy), so a payment's audit trail can answer "who/what actually initiated this" without a schema change. See DelegationService/delegation.aggregate.ts. */
  initiatorMetadata?: Record<string, string>;
}

export interface CheckoutSagaResult {
  paymentId: string;
  status: PaymentStatus;
  pspTransactionId?: string;
  pspProvider?: PSPProvider;
  actionUrl?: string;
  riskScore?: number;
  requiresAction: boolean;
  usedFallback: boolean;
  estimatedFee?: Money;
  /** Only set when status is FAILED — the PSP's own decline code, if it returned one (a routing failure that never reached a PSP has none). See SubscriptionService's decline-code-aware dunning for the one caller that reads this. */
  errorCode?: string;
}

/**
 * Payment Checkout Saga
 * Orchestrates the multi-step checkout flow with compensating transactions.
 *
 * Steps:
 * 1. Create Payment Intent (PENDING, no ledger entry yet)
 * 2. Risk Assessment (scored and stored for audit; does not gate anything)
 * 3. Smart PSP Routing
 * 4. PSP Charge — the PSP's own response is the only thing that can produce
 *    a REQUIRES_ACTION result
 * 5. Update Payment Status + Publish Domain Events; write the ledger outbox
 *    entry only once the charge is actually confirmed (SUCCEEDED)
 *
 * 3DS: Step 4 used to be skipped entirely whenever Step 2's risk score
 * crossed a threshold — instead of calling the PSP, the saga fabricated a
 * `https://3ds.omniswitch.io/challenge/...` URL and put the payment straight
 * into REQUIRES_ACTION. That URL resolved to nothing, and — worse — the PSP
 * was never actually called, so there was no `pspTransactionId`. A payment
 * that entered REQUIRES_ACTION this way could never be resolved by any
 * webhook; it was stuck permanently. The PSP is now always called, and its
 * own response decides REQUIRES_ACTION vs. SUCCEEDED — matching how Stripe
 * and Adyen actually work (the PSP's real-time SCA/3DS2 engine makes this
 * call, not the merchant, pre-emptively, before ever attempting the charge).
 * `binCountry` is still forwarded as a hint (PSD2 requires a challenge for
 * European cards), but it informs the PSP's decision, it doesn't replace it.
 *
 * Ledger timing: entries used to be written in Step 1, atomically with the
 * payment intent, *before* the PSP was ever called. That double-booked
 * settlement funds that were never actually charged (a routing/PSP failure
 * still left a PAYMENT_CHARGED entry on the books), and — once manual
 * capture was added — produced two PAYMENT_CHARGED entries for a single
 * payment (one at authorization, one at capture). Confirmed live: capturing
 * a REQUIRES_CAPTURE payment produced duplicate ledger rows for the same
 * paymentId. Entries are now written only at the moment funds are actually
 * confirmed captured: the SUCCEEDED branch here (immediate capture), or
 * PaymentLifecycleService.capture() (manual capture), or
 * WebhookProcessingService (PSP-confirmed via webhook).
 *
 * Compensating Transactions on failure:
 * - If PSP times out: mark payment FAILED with errorCode
 *   PSP_TIMEOUT_AMBIGUOUS (see isAmbiguousOutcomeError) — distinct from an
 *   explicit PSP decline's own errorCode/PSP_ALL_FAILED, since a timeout
 *   means whether the PSP actually processed the charge is genuinely
 *   unknown, not confirmed failed. No ledger entry was ever written either
 *   way; this only changes what's recorded about *why*.
 * - If DB write fails: no charge attempted (safe)
 * - If charge succeeds but DB update fails: idempotency key prevents double charge
 */
@Injectable()
export class PaymentCheckoutSaga {
  private readonly logger = new Logger(PaymentCheckoutSaga.name);

  constructor(
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly acquirerRouting: AcquirerRoutingService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly chargeLedgerParams: ChargeLedgerParamsResolverService,
    private readonly reserveService: ReserveService,
  ) {}

  async execute(input: CheckoutSagaInput): Promise<CheckoutSagaResult> {
    this.logger.log(`[Saga] Starting checkout for payment ${input.paymentId}`);

    // ─── Step 1: Create Payment Intent ───────────────────────────────────────
    // No ledger entry yet — see class docblock. Funds haven't moved.
    const payment = PaymentAggregate.create({
      id: input.paymentId,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      metadata: {
        merchantId: input.merchantId,
        customerId: input.customerId,
        orderId: input.orderId,
        description: input.description,
        metadata: input.initiatorMetadata,
      },
      binInfo: input.binInfo,
    });

    await this.paymentRepository.save(payment);

    this.logger.log(`[Saga] Step 1 complete: Payment intent created ${input.paymentId}`);

    // Resolve fee/reserve/settlement/split parameters now, before the PSP is
    // ever called — not in Step 5 where this used to happen. Every other
    // failure mode this method resolves for (bad FX lookup) already
    // tolerated being discovered late by falling back silently; an invalid
    // `splits` request (unknown/non-connected recipient, total exceeding
    // the net payout) is the first case that can *throw* here, and doing
    // that after a real PSP charge already succeeded would leave a
    // customer actually charged with no way to recover — the saga has no
    // compensating "undo the charge" step for that. Resolving up front
    // means an invalid split fails the request before money moves, same as
    // a routing failure below.
    let chargeLedgerParams: ChargeLedgerParams;
    try {
      chargeLedgerParams = await this.chargeLedgerParams.resolve(input.merchantId, input.amount, input.splits);
    } catch (paramsError: unknown) {
      const msg = paramsError instanceof Error ? paramsError.message : String(paramsError);
      this.logger.error(`[Saga] Charge ledger params invalid: ${msg}`);
      await this.compensate_markFailed(payment, msg, 'INVALID_CHARGE_PARAMS');
      throw paramsError;
    }

    // Recorded on the payment intent now, regardless of how this charge
    // resolves — not only in the SUCCEEDED branch below. A charge that
    // comes back REQUIRES_ACTION (3DS) doesn't book ledger entries here at
    // all; WebhookProcessingService.markSucceeded() does, once the
    // customer completes the challenge, and by then the only thing it has
    // to work with is the persisted Payment row — it has no access to this
    // request's original `splits`. Recording them on the payment now (they
    // survive the `paymentRepository.update()` call in the REQUIRES_ACTION
    // branch below) means that webhook-driven confirmation can still find
    // and honor them; leaving this for only the SUCCEEDED branch would
    // silently drop a split for any charge that happens to need a 3DS
    // challenge. (REQUIRES_CAPTURE can't occur here — see this method's
    // `splits` are guarded to `captureMethod: "automatic"` at the
    // controller, and REQUIRES_CAPTURE is only ever returned for
    // "manual".)
    if (chargeLedgerParams.splits && chargeLedgerParams.splits.length > 0) {
      payment.recordSplits(chargeLedgerParams.splits);
    }

    // ─── Step 2: Risk Assessment ─────────────────────────────────────────────
    // Scored and stored for audit/telemetry, but deliberately does not
    // decide anything here — see the class docblock's 3DS note below. The
    // PSP's own charge response (Step 4) is the only thing that can put a
    // payment into REQUIRES_ACTION.
    const riskScore = payment.calculateRiskScore();

    this.logger.log(`[Saga] Step 2: Risk score=${riskScore}`);

    // ─── Step 3: Smart PSP Routing ───────────────────────────────────────────
    let routingDecision: any;
    try {
      const routing = await this.acquirerRouting.selectOptimalAdapter({
        amount: input.amount,
        binInfo: input.binInfo,
        merchantId: input.merchantId,
        preferredProvider: input.preferredProvider,
      });
      routingDecision = routing.decision;
    } catch (routingError: unknown) {
      const msg = routingError instanceof Error ? routingError.message : String(routingError);
      this.logger.error(`[Saga] Routing failed: ${msg}`);
      await this.compensate_markFailed(payment, `No available PSP: ${msg}`);
      throw routingError;
    }

    // ─── Step 4: PSP Charge ──────────────────────────────────────────────────
    payment.startProcessing(routingDecision.selectedProvider);
    await this.paymentRepository.update(payment);

    // Execute charge with fallback
    let chargeResult: any;
    let usedFallback = false;
    let finalProvider = routingDecision.selectedProvider;

    try {
      const { result, provider, usedFallback: fb } = await this.acquirerRouting.executeWithSmartRouting(
        {
          amount: input.amount,
          binInfo: input.binInfo,
          merchantId: input.merchantId,
          preferredProvider: input.preferredProvider,
        },
        (adapter) => adapter.charge({
          paymentId: input.paymentId,
          idempotencyKey: input.idempotencyKey,
          amount: input.amount,
          currency: input.amount.currency.code,
          merchantId: input.merchantId,
          customerId: input.customerId,
          description: input.description,
          paymentMethodId: input.paymentMethodId,
          cardToken: input.cardToken,
          captureMethod: input.captureMethod,
          binCountry: input.binInfo?.country,
        }),
      );

      chargeResult = result;
      usedFallback = fb;
      finalProvider = provider;
    } catch (chargeError: unknown) {
      const msg = chargeError instanceof Error ? chargeError.message : String(chargeError);
      // Distinct errorCode when the last PSP attempt got no response at
      // all (see isAmbiguousOutcomeError) rather than an explicit decline —
      // an operator or support agent looking at a failed payment's
      // errorCode should be able to tell "every PSP said no" apart from
      // "we don't actually know what happened at the PSP," since only the
      // latter carries a real risk of the charge having gone through
      // despite this payment being marked FAILED.
      const errorCode = isAmbiguousOutcomeError(chargeError) ? 'PSP_TIMEOUT_AMBIGUOUS' : 'PSP_ALL_FAILED';
      this.logger.error(`[Saga] All PSP providers failed: ${msg}`);
      await this.compensate_markFailed(payment, msg, errorCode);
      throw chargeError;
    }

    // ─── Step 5: Update Payment Status ──────────────────────────────────────
    if (chargeResult.status === 'SUCCEEDED') {
      payment.markSucceeded(chargeResult.transactionId, chargeResult.rawResponse);

      // Funds are confirmed captured *now* — this is the only place in the
      // immediate-capture path where a ledger entry should be written.
      // (chargeLedgerParams was already resolved before the PSP was called
      // above — reused here rather than re-resolved, so this can't diverge
      // from what was validated pre-charge.)
      const { platformFee, settlementConversion, reserveHold, splits } = chargeLedgerParams;
      if (settlementConversion) {
        // So a later refund/lost-dispute can replay this exact rate — see
        // PaymentAggregate.recordSettlementConversion()'s docblock.
        payment.recordSettlementConversion({
          currency: settlementConversion.convertedNetAmount.currency.code,
          rate: settlementConversion.rate,
          provider: settlementConversion.provider,
        });
      }
      // (splits were already recorded on `payment` right after
      // chargeLedgerParams resolved, above — recordSplits() is a no-op on
      // a second call, so nothing to do here.)
      const outboxEvent = LedgerOutboxEvent.createChargeEntries({
        id: uuidv4(),
        paymentId: input.paymentId,
        merchantId: input.merchantId,
        amount: input.amount,
        platformFee,
        settlementConversion,
        reserveHold,
        splits,
      });

      await this.dataSource.transaction(async (manager) => {
        await manager.save(this.toPaymentEntity(payment));
        await this.ledgerOutbox.saveWithPayment(input.paymentId, outboxEvent, manager);
        if (reserveHold) {
          await this.reserveService.recordHold(
            { paymentId: input.paymentId, merchantId: input.merchantId, amount: reserveHold.amount, holdDays: reserveHold.holdDays },
            manager,
          );
        }
      });

      this.publishDomainEvents(payment);

      this.logger.log(`[Saga] Payment ${input.paymentId} succeeded via ${finalProvider}`);

      return {
        paymentId: input.paymentId,
        status: PaymentStatus.SUCCEEDED,
        pspTransactionId: chargeResult.transactionId,
        pspProvider: finalProvider,
        riskScore,
        requiresAction: false,
        usedFallback,
        estimatedFee: routingDecision.estimatedFee,
      };
    }

    if (chargeResult.status === 'REQUIRES_CAPTURE') {
      payment.requiresCapture(chargeResult.transactionId, chargeResult.rawResponse);
      await this.paymentRepository.update(payment);
      this.publishDomainEvents(payment);

      this.logger.log(`[Saga] Payment ${input.paymentId} authorized via ${finalProvider}, awaiting capture`);

      return {
        paymentId: input.paymentId,
        status: PaymentStatus.REQUIRES_CAPTURE,
        pspTransactionId: chargeResult.transactionId,
        pspProvider: finalProvider,
        riskScore,
        requiresAction: false,
        usedFallback,
        estimatedFee: routingDecision.estimatedFee,
      };
    }

    if (chargeResult.status === 'REQUIRES_ACTION') {
      payment.requiresAction(chargeResult.actionUrl!, riskScore, chargeResult.transactionId);
      await this.paymentRepository.update(payment);
      this.publishDomainEvents(payment);

      return {
        paymentId: input.paymentId,
        status: PaymentStatus.REQUIRES_ACTION,
        pspTransactionId: chargeResult.transactionId,
        pspProvider: finalProvider,
        actionUrl: chargeResult.actionUrl,
        riskScore,
        requiresAction: true,
        usedFallback,
        estimatedFee: routingDecision.estimatedFee,
      };
    }

    // PSP returned FAILED
    await this.compensate_markFailed(
      payment,
      chargeResult.errorMessage || 'PSP declined',
      chargeResult.errorCode,
    );

    return {
      paymentId: input.paymentId,
      status: PaymentStatus.FAILED,
      pspProvider: finalProvider,
      riskScore,
      requiresAction: false,
      usedFallback,
      errorCode: chargeResult.errorCode,
    };
  }

  // ─── Compensating Transaction ─────────────────────────────────────────────

  /**
   * Compensating transaction: Mark payment as failed and persist.
   * Called when any step in the saga fails.
   */
  private async compensate_markFailed(
    payment: PaymentAggregate,
    reason: string,
    errorCode?: string,
  ): Promise<void> {
    try {
      payment.markFailed(reason, errorCode);
      await this.paymentRepository.update(payment);
      this.publishDomainEvents(payment);
      this.logger.warn(`[Saga] Compensating transaction: Payment ${payment.id} marked FAILED: ${reason}`);
    } catch (compensationError: unknown) {
      const msg = compensationError instanceof Error ? compensationError.message : String(compensationError);
      this.logger.error(`[Saga] CRITICAL: Compensation failed for payment ${payment.id}: ${msg}`);
      // In production: alert on-call, write to dead-letter queue
    }
  }

  private publishDomainEvents(payment: PaymentAggregate): void {
    const events = payment.pullDomainEvents();
    for (const event of events) {
      this.eventEmitter.emit(event.eventName, event);
    }
  }

  private toPaymentEntity(payment: PaymentAggregate): PaymentEntity {
    return PaymentMapper.toPersistence(payment);
  }
}
