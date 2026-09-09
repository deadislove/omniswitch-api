import { Money } from '../value-objects/money.vo';

export type ReserveHoldStatus = 'HELD' | 'RELEASED';

/**
 * Reserve Hold Aggregate
 * A single amount withheld from one charge's payout, released back to the
 * merchant after `releaseEligibleAt` — the mechanism behind
 * `MerchantEntity.reserveBps`/`reserveHoldDays` (see that entity's
 * docblock). Tracked as its own record with a real lifecycle (`HELD` ->
 * `RELEASED`), not folded into `LedgerOutboxEvent`, because a hold has to be
 * queryable and individually releasable long after the ledger event that
 * created it has already been published — the ledger entries are a
 * point-in-time journal, this is the thing an operator (or the release
 * sweep) needs to find and act on later.
 *
 * The withheld amount is always in the *charge* currency, not whatever
 * currency the merchant might be settled in — see
 * ChargeLedgerParamsResolverService's docblock for why reserve and FX
 * settlement conversion compose the way they do.
 */
export class ReserveHold {
  private constructor(
    private readonly _id: string,
    private readonly _paymentId: string,
    private readonly _merchantId: string,
    private _amount: Money,
    private readonly _netAmount: Money,
    private _status: ReserveHoldStatus,
    private readonly _releaseEligibleAt: Date,
    private readonly _createdAt: Date,
    private _releasedAt: Date | undefined,
  ) {}

  static create(params: {
    id: string;
    paymentId: string;
    merchantId: string;
    amount: Money;
    netAmount: Money;
    holdDays: number;
  }): ReserveHold {
    const now = new Date();
    const releaseEligibleAt = new Date(now.getTime() + params.holdDays * 24 * 60 * 60 * 1000);
    return new ReserveHold(
      params.id,
      params.paymentId,
      params.merchantId,
      params.amount,
      params.netAmount,
      'HELD',
      releaseEligibleAt,
      now,
      undefined,
    );
  }

  static reconstitute(params: {
    id: string;
    paymentId: string;
    merchantId: string;
    amount: Money;
    netAmount: Money;
    status: ReserveHoldStatus;
    releaseEligibleAt: Date;
    createdAt: Date;
    releasedAt?: Date;
  }): ReserveHold {
    return new ReserveHold(
      params.id,
      params.paymentId,
      params.merchantId,
      params.amount,
      params.netAmount,
      params.status,
      params.releaseEligibleAt,
      params.createdAt,
      params.releasedAt,
    );
  }

  /**
   * `force` bypasses the `releaseEligibleAt` check for an operator's manual
   * override (`POST /admin/reserves/:id/release`) — the scheduled sweep
   * (ReserveService.releaseEligible()) never passes it. Either way this is
   * an in-memory precondition check; the actual persistence layer still
   * does a conditional `UPDATE ... WHERE status = 'HELD'` (same pattern as
   * OutboxRecoveryService.retry()) so two concurrent release attempts on
   * the same hold can't both succeed.
   */
  release(now: Date, force = false): void {
    if (this._status !== 'HELD') {
      throw new Error(`Cannot release reserve hold in status: ${this._status}`);
    }
    if (!force && now < this._releaseEligibleAt) {
      throw new Error(
        `Reserve hold ${this._id} is not yet eligible for release (eligible at ${this._releaseEligibleAt.toISOString()})`,
      );
    }
    this._status = 'RELEASED';
    this._releasedAt = now;
  }

  /**
   * Increases the withheld amount — the one deliberate exception to this
   * aggregate otherwise treating `amount` as fixed at creation time. Only
   * ever called by RiskTieringService's tier-escalation path
   * (ReserveService.topUpHeldReservesForMerchant()), and only while still
   * `HELD` — a `RELEASED` hold's funds have already left the reserve
   * account, so there's nothing left here to top up; a merchant that
   * escalates after this hold already released only gets a bigger reserve
   * on its *next* charge, same as any other reserveBps change. Never
   * called for a tier de-escalation — see RiskTieringService's own
   * docblock for why that never claws back anything already held.
   */
  topUp(additionalAmount: Money): void {
    if (this._status !== 'HELD') {
      throw new Error(`Cannot top up reserve hold in status: ${this._status}`);
    }
    if (additionalAmount.isZero()) {
      throw new Error(`topUp amount must be positive, got zero`);
    }
    this._amount = this._amount.add(additionalAmount);
  }

  get id(): string {
    return this._id;
  }
  get paymentId(): string {
    return this._paymentId;
  }
  get merchantId(): string {
    return this._merchantId;
  }
  get amount(): Money {
    return this._amount;
  }
  get netAmount(): Money {
    return this._netAmount;
  }
  get status(): ReserveHoldStatus {
    return this._status;
  }
  get releaseEligibleAt(): Date {
    return this._releaseEligibleAt;
  }
  get createdAt(): Date {
    return this._createdAt;
  }
  get releasedAt(): Date | undefined {
    return this._releasedAt;
  }
}
