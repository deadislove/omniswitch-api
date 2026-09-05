import { Money } from '../value-objects/money.vo';

export type ChargeApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED';

/**
 * Charge Approval
 * The `PENDING_APPROVAL` hold state `SpendPolicy.requireApprovalAboveAmount`
 * needs — a charge within `perTransactionLimit` but above this threshold
 * doesn't auto-execute the way every other in-policy agent charge does;
 * it waits here for a human operator's decision (see
 * `ChargeApprovalService`). See
 * docs/business-domain/future-directions.md#agentic-payments for why
 * this is the durable business mechanism the original "ask me first for
 * anything above $200" framing needed and didn't have.
 *
 * `chargeRequest` is the original `ChargePaymentDto`, stored verbatim
 * (JSON) — not re-derived piecemeal — so `ChargeApprovalService.approve()`
 * can replay the *exact* request that was deferred, through the same
 * `buildCheckoutSagaInput()` helper `PaymentController.charge()` uses for
 * the immediate-execution path. `amount` is stored separately (not just
 * inside `chargeRequest`) because `DelegationService.reserveSpendOrThrow()`
 * already reserved this exact `Money` against the delegation's spend
 * policy at creation time — `deny()` needs it back, in a typed form,
 * without re-parsing the raw request.
 */
export class ChargeApproval {
  private constructor(
    private readonly _id: string,
    private readonly _paymentId: string,
    private readonly _delegationId: string,
    private readonly _merchantId: string,
    private readonly _amount: Money,
    private readonly _idempotencyKey: string,
    private readonly _chargeRequest: Record<string, unknown>,
    private _status: ChargeApprovalStatus,
    private readonly _createdAt: Date,
    private _decidedAt: Date | undefined,
    private _decidedBy: string | undefined,
    private _denialReason: string | undefined,
  ) {}

  static create(params: {
    id: string;
    paymentId: string;
    delegationId: string;
    merchantId: string;
    amount: Money;
    idempotencyKey: string;
    chargeRequest: Record<string, unknown>;
  }): ChargeApproval {
    return new ChargeApproval(
      params.id,
      params.paymentId,
      params.delegationId,
      params.merchantId,
      params.amount,
      params.idempotencyKey,
      params.chargeRequest,
      'PENDING',
      new Date(),
      undefined,
      undefined,
      undefined,
    );
  }

  static reconstitute(params: {
    id: string;
    paymentId: string;
    delegationId: string;
    merchantId: string;
    amount: Money;
    idempotencyKey: string;
    chargeRequest: Record<string, unknown>;
    status: ChargeApprovalStatus;
    createdAt: Date;
    decidedAt?: Date;
    decidedBy?: string;
    denialReason?: string;
  }): ChargeApproval {
    return new ChargeApproval(
      params.id,
      params.paymentId,
      params.delegationId,
      params.merchantId,
      params.amount,
      params.idempotencyKey,
      params.chargeRequest,
      params.status,
      params.createdAt,
      params.decidedAt,
      params.decidedBy,
      params.denialReason,
    );
  }

  approve(now: Date, decidedBy: string): void {
    if (this._status !== 'PENDING') {
      throw new Error(`Charge approval ${this._id} is already ${this._status}`);
    }
    this._status = 'APPROVED';
    this._decidedAt = now;
    this._decidedBy = decidedBy;
  }

  deny(now: Date, decidedBy: string, reason?: string): void {
    if (this._status !== 'PENDING') {
      throw new Error(`Charge approval ${this._id} is already ${this._status}`);
    }
    this._status = 'DENIED';
    this._decidedAt = now;
    this._decidedBy = decidedBy;
    this._denialReason = reason;
  }

  get id(): string {
    return this._id;
  }
  get paymentId(): string {
    return this._paymentId;
  }
  get delegationId(): string {
    return this._delegationId;
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
  get chargeRequest(): Record<string, unknown> {
    return this._chargeRequest;
  }
  get status(): ChargeApprovalStatus {
    return this._status;
  }
  get createdAt(): Date {
    return this._createdAt;
  }
  get decidedAt(): Date | undefined {
    return this._decidedAt;
  }
  get decidedBy(): string | undefined {
    return this._decidedBy;
  }
  get denialReason(): string | undefined {
    return this._denialReason;
  }
}
