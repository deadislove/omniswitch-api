import { Money } from '../value-objects/money.vo';

/**
 * BNPL Order
 * A Klarna (buy-now-pay-later) order — deliberately its own aggregate
 * rather than another `PaymentAggregate` status, since BNPL's real
 * settlement shape is fundamentally different from a card charge: the
 * provider (Klarna) pays the merchant in full at capture, takes on the
 * customer's credit risk itself, and collects installments from the
 * customer separately — this platform has no visibility into, and no
 * involvement in, that installment collection. A BNPL refund likewise
 * flows back through Klarna rather than a card-network reversal. See
 * `docs/business-domain/bnpl.md` for the full real-vs-modeled scope
 * boundary (no customer-facing checkout session/redirect is modeled —
 * this reference project has no frontend to redirect a customer
 * through, same simplification already accepted for 3DS's `actionUrl`).
 *
 * `PENDING_AUTHORIZATION` -> `AUTHORIZED` (Klarna granted credit; not
 * yet paid to the merchant) -> `CAPTURED` (Klarna has now paid the
 * merchant; ledger entries exist) -> `REFUNDED`/`PARTIALLY_REFUNDED`.
 * `REJECTED` is the only exit from `PENDING_AUTHORIZATION` — Klarna's
 * own real-time credit decision, modeled the same "the provider
 * decides, this platform never does" posture as a card's SCA
 * challenge outcome.
 */
export type BnplOrderStatus =
  'PENDING_AUTHORIZATION' | 'AUTHORIZED' | 'REJECTED' | 'CAPTURED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';

export interface BnplRefundRecord {
  refundId: string;
  amount: Money;
  reason: string;
  createdAt: Date;
  providerRefundId?: string;
}

export class BnplOrder {
  private constructor(
    private readonly _id: string,
    private readonly _merchantId: string,
    private readonly _amount: Money,
    private readonly _idempotencyKey: string,
    private _status: BnplOrderStatus,
    private readonly _customerId: string | undefined,
    private readonly _description: string | undefined,
    private _providerOrderId: string | undefined,
    private _providerCaptureId: string | undefined,
    private _failureReason: string | undefined,
    private _refunds: BnplRefundRecord[],
    private readonly _createdAt: Date,
    private _capturedAt: Date | undefined,
  ) {}

  static create(params: {
    id: string;
    merchantId: string;
    amount: Money;
    idempotencyKey: string;
    customerId?: string;
    description?: string;
  }): BnplOrder {
    return new BnplOrder(
      params.id,
      params.merchantId,
      params.amount,
      params.idempotencyKey,
      'PENDING_AUTHORIZATION',
      params.customerId,
      params.description,
      undefined,
      undefined,
      undefined,
      [],
      new Date(),
      undefined,
    );
  }

  static reconstitute(params: {
    id: string;
    merchantId: string;
    amount: Money;
    idempotencyKey: string;
    status: BnplOrderStatus;
    customerId?: string;
    description?: string;
    providerOrderId?: string;
    providerCaptureId?: string;
    failureReason?: string;
    refunds?: BnplRefundRecord[];
    createdAt: Date;
    capturedAt?: Date;
  }): BnplOrder {
    return new BnplOrder(
      params.id,
      params.merchantId,
      params.amount,
      params.idempotencyKey,
      params.status,
      params.customerId,
      params.description,
      params.providerOrderId,
      params.providerCaptureId,
      params.failureReason,
      params.refunds ?? [],
      params.createdAt,
      params.capturedAt,
    );
  }

  /** Klarna granted credit for this order — not yet paid to the merchant; see `capture()`. */
  authorize(providerOrderId: string): void {
    if (this._status !== 'PENDING_AUTHORIZATION') {
      throw new Error(`BNPL order ${this._id} is ${this._status}, cannot authorize`);
    }
    this._status = 'AUTHORIZED';
    this._providerOrderId = providerOrderId;
  }

  /** Klarna declined this purchase — its own real-time credit decision, same "the provider decides" posture as a card decline. */
  reject(reason: string): void {
    if (this._status !== 'PENDING_AUTHORIZATION') {
      throw new Error(`BNPL order ${this._id} is ${this._status}, cannot reject`);
    }
    this._status = 'REJECTED';
    this._failureReason = reason;
  }

  /** The point real Klarna actually pays the merchant — see `LedgerOutboxEvent.createBnplCaptureEntries()`, written in the same transaction as this status change by `BnplService.createOrder()`. */
  capture(providerCaptureId: string, now: Date): void {
    if (this._status !== 'AUTHORIZED') {
      throw new Error(`BNPL order ${this._id} is ${this._status}, cannot capture`);
    }
    this._status = 'CAPTURED';
    this._providerCaptureId = providerCaptureId;
    this._capturedAt = now;
  }

  /**
   * Records a refund against a captured order — can only be called on
   * `CAPTURED`/`PARTIALLY_REFUNDED` (never on an order that was never
   * actually paid out). Transitions to `REFUNDED` once the cumulative
   * refunded amount reaches the original `amount`, `PARTIALLY_REFUNDED`
   * otherwise — same shape as a card payment's own partial-refund
   * tracking, minus the splits/FX this pass deliberately doesn't model
   * (see this aggregate's file-level docblock).
   */
  refund(refundId: string, amount: Money, reason: string, providerRefundId: string, now: Date): void {
    if (this._status !== 'CAPTURED' && this._status !== 'PARTIALLY_REFUNDED') {
      throw new Error(`BNPL order ${this._id} is ${this._status}, cannot refund`);
    }
    const alreadyRefunded = this._refunds.reduce((sum, r) => sum.add(r.amount), Money.zero(this._amount.currency.code));
    if (alreadyRefunded.add(amount).isGreaterThan(this._amount)) {
      throw new Error(`BNPL order ${this._id}: refund would exceed the original order amount`);
    }
    this._refunds.push({ refundId, amount, reason, createdAt: now, providerRefundId });
    const totalRefunded = alreadyRefunded.add(amount);
    this._status = totalRefunded.equals(this._amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }

  get id(): string {
    return this._id;
  }
  get merchantId(): string {
    return this._merchantId;
  }
  get amount(): Money {
    return this._amount;
  }
  get idempotencyKey(): string {
    return this._idempotencyKey;
  }
  get status(): BnplOrderStatus {
    return this._status;
  }
  get customerId(): string | undefined {
    return this._customerId;
  }
  get description(): string | undefined {
    return this._description;
  }
  get providerOrderId(): string | undefined {
    return this._providerOrderId;
  }
  get providerCaptureId(): string | undefined {
    return this._providerCaptureId;
  }
  get failureReason(): string | undefined {
    return this._failureReason;
  }
  get refunds(): BnplRefundRecord[] {
    return [...this._refunds];
  }
  get createdAt(): Date {
    return this._createdAt;
  }
  get capturedAt(): Date | undefined {
    return this._capturedAt;
  }
}
