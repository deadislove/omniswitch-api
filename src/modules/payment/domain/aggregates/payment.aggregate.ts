import { Money } from '../value-objects/money.vo';
import { PaymentStatus, assertValidTransition } from '../value-objects/payment-status.vo';
import { BinInfo } from '../value-objects/bin-info.vo';
import { DomainEvent } from '../events/domain-event.base';
import {
  PaymentIntentCreatedEvent,
  PaymentChargedEvent,
  PaymentFailedEvent,
  PaymentRequiresActionEvent,
  PaymentRefundedEvent,
  PaymentDisputedEvent,
  PaymentStatusChangedEvent,
} from '../events/payment.events';

export type PSPProvider = 'STRIPE' | 'ADYEN' | 'PAYPAL' | 'CHASE';

export interface PaymentMetadata {
  merchantId: string;
  customerId?: string;
  orderId?: string;
  description?: string;
  statementDescriptor?: string;
  metadata?: Record<string, string>;
}

export interface ThreeDSResult {
  authenticated: boolean;
  eci?: string;
  cavv?: string;
  xid?: string;
  version?: string;
  challengeCompleted?: boolean;
}

export interface RefundRecord {
  refundId: string;
  amount: Money;
  reason: string;
  createdAt: Date;
  pspRefundId?: string;
}

export interface CaptureRecord {
  captureId: string;
  amount: Money;
  createdAt: Date;
  pspCaptureId?: string;
}

export interface SettlementConversion {
  currency: string;
  rate: number;
  provider: string;
}

export interface PaymentSplit {
  merchantId: string;
  amount: Money;
}

/**
 * Payment Aggregate Root
 * Central domain entity encapsulating all payment lifecycle logic.
 * Enforces invariants and emits domain events.
 */
export class PaymentAggregate {
  private _domainEvents: DomainEvent[] = [];

  private constructor(
    private readonly _id: string,
    private _amount: Money,
    private _status: PaymentStatus,
    private readonly _idempotencyKey: string,
    private readonly _metadata: PaymentMetadata,
    private readonly _binInfo?: BinInfo,
    private _pspProvider?: PSPProvider,
    private _pspTransactionId?: string,
    private _pspRawResponse?: Record<string, unknown>,
    private _riskScore?: number,
    private _threeDSResult?: ThreeDSResult,
    private _refunds: RefundRecord[] = [],
    private _captures: CaptureRecord[] = [],
    private _failureReason?: string,
    private _failureCode?: string,
    private readonly _createdAt: Date = new Date(),
    private _updatedAt: Date = new Date(),
    private _settlementConversion?: SettlementConversion,
    private _splits?: PaymentSplit[],
  ) {}

  // ─── Factory Methods ────────────────────────────────────────────────────────

  static create(params: {
    id: string;
    amount: Money;
    idempotencyKey: string;
    metadata: PaymentMetadata;
    binInfo?: BinInfo;
  }): PaymentAggregate {
    const payment = new PaymentAggregate(
      params.id,
      params.amount,
      PaymentStatus.PENDING,
      params.idempotencyKey,
      params.metadata,
      params.binInfo,
    );

    payment.addDomainEvent(
      new PaymentIntentCreatedEvent(
        params.id,
        params.metadata.merchantId,
        params.amount.amountMinorUnits.toString(),
        params.amount.currency.code,
        params.idempotencyKey,
      ),
    );

    return payment;
  }

  static reconstitute(params: {
    id: string;
    amount: Money;
    status: PaymentStatus;
    idempotencyKey: string;
    metadata: PaymentMetadata;
    binInfo?: BinInfo;
    pspProvider?: PSPProvider;
    pspTransactionId?: string;
    pspRawResponse?: Record<string, unknown>;
    riskScore?: number;
    threeDSResult?: ThreeDSResult;
    refunds?: RefundRecord[];
    captures?: CaptureRecord[];
    failureReason?: string;
    failureCode?: string;
    createdAt?: Date;
    updatedAt?: Date;
    settlementConversion?: SettlementConversion;
    splits?: PaymentSplit[];
  }): PaymentAggregate {
    return new PaymentAggregate(
      params.id,
      params.amount,
      params.status,
      params.idempotencyKey,
      params.metadata,
      params.binInfo,
      params.pspProvider,
      params.pspTransactionId,
      params.pspRawResponse,
      params.riskScore,
      params.threeDSResult,
      params.refunds ?? [],
      params.captures ?? [],
      params.failureReason,
      params.failureCode,
      params.createdAt ?? new Date(),
      params.updatedAt ?? new Date(),
      params.settlementConversion,
      params.splits,
    );
  }

  // ─── Domain Behaviors ───────────────────────────────────────────────────────

  startProcessing(pspProvider: PSPProvider): void {
    assertValidTransition(this._status, PaymentStatus.PROCESSING);
    this._pspProvider = pspProvider;
    this.transitionTo(PaymentStatus.PROCESSING);
  }

  requiresAction(actionUrl: string, riskScore: number, pspTransactionId?: string): void {
    assertValidTransition(this._status, PaymentStatus.REQUIRES_ACTION);
    this._riskScore = riskScore;
    // Only set when the PSP actually returned one (i.e. charge() was called
    // and it responded 'requires_action'). The pre-emptive, risk-score-based
    // 3DS branch in the saga returns REQUIRES_ACTION *before* ever calling
    // the PSP, so there's no id yet in that case — a later webhook can't
    // resolve that payment by pspTransactionId until the client completes
    // the challenge and a real charge is attempted.
    if (pspTransactionId) {
      this._pspTransactionId = pspTransactionId;
    }
    this.transitionTo(PaymentStatus.REQUIRES_ACTION);
    this.addDomainEvent(
      new PaymentRequiresActionEvent(this._id, actionUrl, riskScore),
    );
  }

  completeThreeDS(result: ThreeDSResult): void {
    assertValidTransition(this._status, PaymentStatus.PROCESSING);
    this._threeDSResult = result;
    this.transitionTo(PaymentStatus.PROCESSING);
  }

  /**
   * Authorization succeeded but funds haven't been captured yet
   * (`captureMethod: 'manual'`). The PSP transaction id is recorded now so
   * the capture/cancel API can reference it.
   */
  requiresCapture(pspTransactionId: string, pspRawResponse?: Record<string, unknown>): void {
    assertValidTransition(this._status, PaymentStatus.REQUIRES_CAPTURE);
    this._pspTransactionId = pspTransactionId;
    this._pspRawResponse = pspRawResponse;
    this.transitionTo(PaymentStatus.REQUIRES_CAPTURE);
  }

  /**
   * Records one capture against a REQUIRES_CAPTURE/PARTIALLY_CAPTURED
   * authorization. `amount` is the increment being captured *now*, not a
   * running total — multiple calls are expected for split
   * shipment/partial-fulfillment billing. Only transitions to SUCCEEDED
   * once the sum of all captures reaches the full authorized amount;
   * otherwise stays PARTIALLY_CAPTURED so a later call can capture the
   * rest. Returns whether this call completed the authorization.
   */
  recordCapture(params: {
    captureId: string;
    amount: Money;
    pspTransactionId: string;
    pspRawResponse?: Record<string, unknown>;
  }): boolean {
    if (this._status !== PaymentStatus.REQUIRES_CAPTURE && this._status !== PaymentStatus.PARTIALLY_CAPTURED) {
      throw new Error(`Cannot capture payment in status: ${this._status}`);
    }

    const newTotal = this.totalCaptured.add(params.amount);
    if (newTotal.isGreaterThan(this._amount)) {
      throw new Error(
        `Capture amount ${params.amount.toString()} exceeds remaining capturable amount ${this.remainingCapturable.toString()}`,
      );
    }

    this._captures.push({
      captureId: params.captureId,
      amount: params.amount,
      createdAt: new Date(),
      pspCaptureId: params.pspTransactionId,
    });
    this._pspTransactionId = params.pspTransactionId;
    this._pspRawResponse = params.pspRawResponse;

    const isFullyCaptured = newTotal.equals(this._amount);
    this.transitionTo(isFullyCaptured ? PaymentStatus.SUCCEEDED : PaymentStatus.PARTIALLY_CAPTURED);

    if (isFullyCaptured) {
      this.addDomainEvent(
        new PaymentChargedEvent(
          this._id,
          params.pspTransactionId,
          this._pspProvider!,
          this._amount.amountMinorUnits.toString(),
          this._amount.currency.code,
        ),
      );
    }

    return isFullyCaptured;
  }

  markSucceeded(pspTransactionId: string, pspRawResponse?: Record<string, unknown>): void {
    assertValidTransition(this._status, PaymentStatus.SUCCEEDED);
    this._pspTransactionId = pspTransactionId;
    this._pspRawResponse = pspRawResponse;
    this.transitionTo(PaymentStatus.SUCCEEDED);
    this.addDomainEvent(
      new PaymentChargedEvent(
        this._id,
        pspTransactionId,
        this._pspProvider!,
        this._amount.amountMinorUnits.toString(),
        this._amount.currency.code,
      ),
    );
  }

  markFailed(reason: string, errorCode?: string): void {
    assertValidTransition(this._status, PaymentStatus.FAILED);
    this._failureReason = reason;
    this._failureCode = errorCode;
    this.transitionTo(PaymentStatus.FAILED);
    this.addDomainEvent(
      new PaymentFailedEvent(this._id, reason, errorCode),
    );
  }

  cancel(): void {
    assertValidTransition(this._status, PaymentStatus.CANCELLED);
    this.transitionTo(PaymentStatus.CANCELLED);
  }

  refund(params: {
    refundId: string;
    amount: Money;
    reason: string;
    pspRefundId?: string;
  }): void {
    if (this._status !== PaymentStatus.SUCCEEDED && this._status !== PaymentStatus.PARTIALLY_REFUNDED) {
      throw new Error(`Cannot refund payment in status: ${this._status}`);
    }

    const totalRefunded = this._refunds.reduce(
      (sum, r) => sum.add(r.amount),
      Money.zero(this._amount.currency.code),
    );

    const newTotal = totalRefunded.add(params.amount);
    if (newTotal.isGreaterThan(this._amount)) {
      throw new Error(
        `Refund amount ${params.amount.toString()} exceeds remaining refundable amount`,
      );
    }

    this._refunds.push({
      refundId: params.refundId,
      amount: params.amount,
      reason: params.reason,
      createdAt: new Date(),
      pspRefundId: params.pspRefundId,
    });

    const isFullRefund = newTotal.equals(this._amount);
    const newStatus = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
    this.transitionTo(newStatus);

    this.addDomainEvent(
      new PaymentRefundedEvent(
        this._id,
        params.refundId,
        params.amount.amountMinorUnits.toString(),
        params.amount.currency.code,
        params.reason,
      ),
    );
  }

  /**
   * Records a chargeback/dispute reported by the PSP via webhook.
   * Only valid from SUCCEEDED (a payment can't be disputed before it charged).
   */
  markDisputed(reason?: string): void {
    assertValidTransition(this._status, PaymentStatus.DISPUTED);
    this.transitionTo(PaymentStatus.DISPUTED);
    this.addDomainEvent(new PaymentDisputedEvent(this._id, reason));
  }

  /**
   * The PSP/card network's final decision on a dispute (see the Dispute
   * aggregate — this only updates payment status/ledger-relevant state, the
   * dispute's own record lives separately).
   */
  resolveDispute(outcome: 'WON' | 'LOST'): void {
    if (outcome === 'WON') {
      assertValidTransition(this._status, PaymentStatus.SUCCEEDED);
      this.transitionTo(PaymentStatus.SUCCEEDED);
      return;
    }
    // LOST: economically identical to a full, merchant-uninitiated refund —
    // the card network claws the funds back regardless of what the merchant
    // wants. Recorded via the same RefundRecord/refunds[] mechanism a normal
    // refund uses (not a separate code path) so totalRefunded/
    // remainingRefundable stay accurate no matter why the money left.
    assertValidTransition(this._status, PaymentStatus.REFUNDED);
    this._refunds.push({
      refundId: `dispute-lost-${this._id}`,
      amount: this._amount,
      reason: 'dispute_lost',
      createdAt: new Date(),
    });
    this.transitionTo(PaymentStatus.REFUNDED);
  }

  /**
   * Records the FX rate actually applied to this payment's merchant payout
   * leg, the first time (charge or capture) it was settlement-converted —
   * called by whichever ledger-booking call site's
   * ChargeLedgerParamsResolverService.resolve() returned a
   * settlementConversion. Deliberately recorded once and never overwritten
   * on a later capture of the same payment: a partial-capture payment's
   * settlement currency doesn't change between captures, and even if it
   * did, refunds/dispute losses need one consistent rate to replay, not
   * whatever the merchant's settlement currency happens to be *right now*.
   *
   * This is what lets refund()/a lost dispute convert their clawback
   * amount using the *original* charge-time rate rather than a fresh one
   * — refunding the same money back at a different rate than it was paid
   * out at would either shortchange the merchant or claw back more than
   * they actually received. See LedgerOutboxEvent.createRefundEntries()'s
   * settlementConversion param.
   */
  recordSettlementConversion(conversion: SettlementConversion): void {
    if (this._settlementConversion) return;
    this._settlementConversion = conversion;
  }

  /**
   * Records the marketplace `splits` this payment was charged with, the
   * first time (charge or capture) it had any — same "record once, never
   * overwritten" posture as recordSettlementConversion() above, and for
   * the same reason: a refund or lost dispute needs to replay the
   * *original* split ratios, not whatever this payment's splits happen to
   * be reasoned about later (there's no way to change them after the
   * charge anyway, but future-proofing the invariant costs nothing). See
   * LedgerOutboxEvent.createRefundEntries()'s splits param for how a
   * refund/dispute-loss clawback proportions itself against these.
   */
  recordSplits(splits: PaymentSplit[]): void {
    if (this._splits) return;
    if (splits.length === 0) return;
    this._splits = splits;
  }

  // ─── Risk Assessment ────────────────────────────────────────────────────────

  calculateRiskScore(): number {
    let score = 0;

    // High-value transactions increase risk
    if (this._amount.amount > 10000) score += 30;
    else if (this._amount.amount > 1000) score += 15;

    // European cards require SCA
    if (this._binInfo?.requiresSCA()) score += 20;

    // New merchant increases risk
    // (In real implementation, check merchant history)
    score += 10;

    this._riskScore = Math.min(score, 100);
    return this._riskScore;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private transitionTo(newStatus: PaymentStatus): void {
    const previousStatus = this._status;
    this._status = newStatus;
    this._updatedAt = new Date();
    this.addDomainEvent(
      new PaymentStatusChangedEvent(this._id, previousStatus, newStatus),
    );
  }

  private addDomainEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }

  // ─── Getters ────────────────────────────────────────────────────────────────

  get id(): string { return this._id; }
  get amount(): Money { return this._amount; }
  get status(): PaymentStatus { return this._status; }
  get idempotencyKey(): string { return this._idempotencyKey; }
  get metadata(): PaymentMetadata { return this._metadata; }
  get binInfo(): BinInfo | undefined { return this._binInfo; }
  get pspProvider(): PSPProvider | undefined { return this._pspProvider; }
  get pspTransactionId(): string | undefined { return this._pspTransactionId; }
  get pspRawResponse(): Record<string, unknown> | undefined { return this._pspRawResponse; }
  get riskScore(): number | undefined { return this._riskScore; }
  get threeDSResult(): ThreeDSResult | undefined { return this._threeDSResult; }
  get refunds(): RefundRecord[] { return [...this._refunds]; }
  get captures(): CaptureRecord[] { return [...this._captures]; }
  get failureReason(): string | undefined { return this._failureReason; }
  get failureCode(): string | undefined { return this._failureCode; }
  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }
  get settlementConversion(): SettlementConversion | undefined { return this._settlementConversion; }
  get splits(): PaymentSplit[] | undefined { return this._splits; }

  get totalRefunded(): Money {
    return this._refunds.reduce(
      (sum, r) => sum.add(r.amount),
      Money.zero(this._amount.currency.code),
    );
  }

  get remainingRefundable(): Money {
    return this._amount.subtract(this.totalRefunded);
  }

  get totalCaptured(): Money {
    return this._captures.reduce(
      (sum, c) => sum.add(c.amount),
      Money.zero(this._amount.currency.code),
    );
  }

  get remainingCapturable(): Money {
    return this._amount.subtract(this.totalCaptured);
  }

  pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents = [];
    return events;
  }
}
