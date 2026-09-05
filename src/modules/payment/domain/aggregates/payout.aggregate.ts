import { Money } from '../value-objects/money.vo';

/**
 * Payout
 * One CONNECTED merchant's share of a payout sweep (see
 * PayoutService.runSweep()) — the money a marketplace split already
 * credited to their `MERCHANT` ledger balance, batched into a scheduled
 * disbursement instead of being available the instant it's credited.
 *
 * Unlike the charge-time reserve (`ReserveHold`/`MerchantEntity.reserveBps`),
 * the reserveAmount/netAmount split itself does **not** move any ledger
 * money — the split's `MERCHANT` credit already correctly represents what
 * the connected merchant is owed (see
 * `docs/business-domain/ledger-and-settlement.md#marketplace-splits`).
 * `netAmount`/`reserveAmount` are a scheduling overlay on top of that
 * ledger balance: how much was confirmed disbursable in this sweep versus
 * held back as a rolling reserve — the same distinction a bank's "ledger
 * balance" vs. "available balance" draws. Actually *sending* `netAmount`
 * somewhere real is a separate action — see `recordTransferInitiated()`.
 */
export type PayoutReserveStatus = 'NONE' | 'HELD' | 'RELEASED';
/**
 * `PENDING_CONFIRMATION` sits between `NOT_INITIATED` and `INITIATED` for
 * a real, async-settling rail (`AchBankTransferAdapter`/
 * `WireBankTransferAdapter`) — the rail accepted the transfer but hasn't
 * settled it yet, so `INITIATED` isn't true yet either.
 * `MockBankTransferAdapter` skips this state entirely (`NOT_INITIATED` ->
 * `INITIATED` in one call, same as before this state existed) since it
 * settles synchronously. See `recordTransferPending()`/
 * `recordTransferInitiated()`.
 */
export type PayoutTransferStatus = 'NOT_INITIATED' | 'PENDING_CONFIRMATION' | 'INITIATED' | 'FAILED';

export class Payout {
  private constructor(
    private readonly _id: string,
    private readonly _merchantId: string,
    private readonly _sweepRunId: string,
    private readonly _grossAmount: Money,
    private readonly _reserveAmount: Money,
    private readonly _netAmount: Money,
    private readonly _releaseEligibleAt: Date | undefined,
    private _reserveReleased: boolean,
    private _reserveReleasedAt: Date | undefined,
    private readonly _createdAt: Date,
    private _kycBlocked: boolean,
    private _kycClearedAt: Date | undefined,
    private _transferStatus: PayoutTransferStatus,
    private _transferId: string | undefined,
    private _transferInitiatedAt: Date | undefined,
    private _transferError: string | undefined,
    private _reserveTransferStatus: PayoutTransferStatus,
    private _reserveTransferId: string | undefined,
    private _reserveTransferInitiatedAt: Date | undefined,
    private _reserveTransferError: string | undefined,
  ) {}

  static create(params: {
    id: string;
    merchantId: string;
    sweepRunId: string;
    grossAmount: Money;
    reserveBps: number;
    reserveHoldDays: number;
    /**
     * The recipient's `MerchantEntity.kycStatus === 'VERIFIED'` at sweep
     * time — mirrors real Stripe Connect's `payouts_enabled` capability:
     * a connected account can accumulate ledger credit before KYC clears
     * (see the split-charge validation, which doesn't check this at
     * all), but this `Payout`'s `netAmount` isn't actually disbursable
     * until it does. Unlike the reserve hold (a *duration*), KYC is a
     * *status* — there's no `releaseEligibleAt` for it; a blocked
     * Payout stays blocked until an explicit recheck finds the merchant
     * VERIFIED (see `clearKycBlock()` and
     * `PayoutService.recheckKycBlocks()`), however long that takes.
     */
    kycVerified: boolean;
  }): Payout {
    const reserveAmount =
      params.reserveBps > 0
        ? params.grossAmount.multiply(params.reserveBps / 10_000)
        : Money.zero(params.grossAmount.currency.code);
    const netAmount = params.grossAmount.subtract(reserveAmount);
    const now = new Date();
    const releaseEligibleAt = reserveAmount.isZero()
      ? undefined
      : new Date(now.getTime() + params.reserveHoldDays * 24 * 60 * 60 * 1000);
    return new Payout(
      params.id,
      params.merchantId,
      params.sweepRunId,
      params.grossAmount,
      reserveAmount,
      netAmount,
      releaseEligibleAt,
      false,
      undefined,
      now,
      !params.kycVerified,
      undefined,
      'NOT_INITIATED',
      undefined,
      undefined,
      undefined,
      'NOT_INITIATED',
      undefined,
      undefined,
      undefined,
    );
  }

  static reconstitute(params: {
    id: string;
    merchantId: string;
    sweepRunId: string;
    grossAmount: Money;
    reserveAmount: Money;
    netAmount: Money;
    releaseEligibleAt?: Date;
    reserveReleased: boolean;
    reserveReleasedAt?: Date;
    createdAt: Date;
    kycBlocked: boolean;
    kycClearedAt?: Date;
    transferStatus: PayoutTransferStatus;
    transferId?: string;
    transferInitiatedAt?: Date;
    transferError?: string;
    reserveTransferStatus: PayoutTransferStatus;
    reserveTransferId?: string;
    reserveTransferInitiatedAt?: Date;
    reserveTransferError?: string;
  }): Payout {
    return new Payout(
      params.id,
      params.merchantId,
      params.sweepRunId,
      params.grossAmount,
      params.reserveAmount,
      params.netAmount,
      params.releaseEligibleAt,
      params.reserveReleased,
      params.reserveReleasedAt,
      params.createdAt,
      params.kycBlocked,
      params.kycClearedAt,
      params.transferStatus,
      params.transferId,
      params.transferInitiatedAt,
      params.transferError,
      params.reserveTransferStatus,
      params.reserveTransferId,
      params.reserveTransferInitiatedAt,
      params.reserveTransferError,
    );
  }

  /** `force` bypasses `releaseEligibleAt` — an operator's manual override, same posture as `ReserveHold.release()`. */
  releaseReserve(now: Date, force = false): void {
    if (this._reserveAmount.isZero()) {
      throw new Error(`Payout ${this._id} has no reserve to release`);
    }
    if (this._reserveReleased) {
      throw new Error(`Payout ${this._id}'s reserve is already released`);
    }
    if (!force && this._releaseEligibleAt && now < this._releaseEligibleAt) {
      throw new Error(
        `Payout ${this._id}'s reserve is not yet eligible for release (eligible at ${this._releaseEligibleAt.toISOString()})`,
      );
    }
    this._reserveReleased = true;
    this._reserveReleasedAt = now;
  }

  /** Called once a recheck finds the merchant's KYC status is now VERIFIED — see PayoutService.recheckKycBlocks(). */
  clearKycBlock(now: Date): void {
    if (!this._kycBlocked) {
      throw new Error(`Payout ${this._id} is not KYC-blocked`);
    }
    this._kycBlocked = false;
    this._kycClearedAt = now;
  }

  /**
   * Records that the rail *accepted* the transfer for processing but
   * hasn't settled it yet (`AchBankTransferAdapter`/
   * `WireBankTransferAdapter`) — final outcome arrives later via
   * `PayoutService.confirmTransfer()`, called from the
   * `POST /webhooks/bank-transfer` receiver. `MockBankTransferAdapter`
   * never calls this — it goes straight to `recordTransferInitiated()`.
   */
  recordTransferPending(transferId: string, now: Date): void {
    if (this._kycBlocked) {
      throw new Error(`Payout ${this._id} is KYC-blocked, cannot initiate a transfer`);
    }
    if (this._netAmount.isZero()) {
      throw new Error(`Payout ${this._id} has no net amount to transfer`);
    }
    if (this._transferStatus === 'INITIATED' || this._transferStatus === 'PENDING_CONFIRMATION') {
      throw new Error(`Payout ${this._id}'s transfer is already ${this._transferStatus.toLowerCase()}`);
    }
    this._transferStatus = 'PENDING_CONFIRMATION';
    this._transferId = transferId;
    this._transferInitiatedAt = now;
    this._transferError = undefined;
  }

  /**
   * Records that `netAmount` was actually sent to the merchant's bank —
   * see BankTransferPort. Called either immediately (`MockBankTransferAdapter`'s
   * synchronous `SENT`, straight from `NOT_INITIATED`) or later, from
   * `PENDING_CONFIRMATION`, once a real rail's async webhook confirms
   * settlement (`PayoutService.confirmTransfer()`) — both paths land in
   * the same terminal `INITIATED` state. Deliberately only ever covers
   * `netAmount`, not any *later*-released reserve — see this aggregate's
   * file-level docblock and
   * docs/business-domain/marketplace-and-payouts.md for why that's a
   * real, documented gap rather than something this method silently gets
   * wrong.
   */
  recordTransferInitiated(transferId: string, now: Date): void {
    if (this._kycBlocked) {
      throw new Error(`Payout ${this._id} is KYC-blocked, cannot initiate a transfer`);
    }
    if (this._netAmount.isZero()) {
      throw new Error(`Payout ${this._id} has no net amount to transfer`);
    }
    if (this._transferStatus === 'INITIATED') {
      throw new Error(`Payout ${this._id}'s transfer is already initiated`);
    }
    this._transferStatus = 'INITIATED';
    this._transferId = transferId;
    this._transferInitiatedAt = now;
    this._transferError = undefined;
  }

  /** The bank/PSP declined the transfer — recorded, not thrown, so a sweep can move on to the next payout (see PayoutService.initiateEligibleTransfers()'s per-item try/catch). Also used from PENDING_CONFIRMATION when a real rail's async webhook reports settlement failure. */
  recordTransferFailed(error: string): void {
    this._transferStatus = 'FAILED';
    this._transferError = error;
  }

  /**
   * The follow-up transfer this aggregate's file-level docblock used to
   * name as a real, documented gap: once a reserve is released, its
   * amount needs its own transfer, independent of whatever already
   * happened to `netAmount` — same rail (`BankTransferPort`), same
   * `PENDING_CONFIRMATION`/`INITIATED`/`FAILED` shape, just a second,
   * separate transfer against a different amount. Requires the reserve
   * to actually be released first (`releaseReserve()`) — there is
   * nothing to transfer otherwise.
   */
  private assertReserveTransferable(): void {
    if (this._kycBlocked) {
      throw new Error(`Payout ${this._id} is KYC-blocked, cannot initiate a reserve transfer`);
    }
    if (this._reserveAmount.isZero()) {
      throw new Error(`Payout ${this._id} has no reserve to transfer`);
    }
    if (!this._reserveReleased) {
      throw new Error(`Payout ${this._id}'s reserve has not been released yet`);
    }
  }

  /** Same shape as recordTransferPending(), for the reserve leg. */
  recordReserveTransferPending(transferId: string, now: Date): void {
    this.assertReserveTransferable();
    if (this._reserveTransferStatus === 'INITIATED' || this._reserveTransferStatus === 'PENDING_CONFIRMATION') {
      throw new Error(`Payout ${this._id}'s reserve transfer is already ${this._reserveTransferStatus.toLowerCase()}`);
    }
    this._reserveTransferStatus = 'PENDING_CONFIRMATION';
    this._reserveTransferId = transferId;
    this._reserveTransferInitiatedAt = now;
    this._reserveTransferError = undefined;
  }

  /** Same shape as recordTransferInitiated(), for the reserve leg. */
  recordReserveTransferInitiated(transferId: string, now: Date): void {
    this.assertReserveTransferable();
    if (this._reserveTransferStatus === 'INITIATED') {
      throw new Error(`Payout ${this._id}'s reserve transfer is already initiated`);
    }
    this._reserveTransferStatus = 'INITIATED';
    this._reserveTransferId = transferId;
    this._reserveTransferInitiatedAt = now;
    this._reserveTransferError = undefined;
  }

  /** Same shape as recordTransferFailed(), for the reserve leg. */
  recordReserveTransferFailed(error: string): void {
    this._reserveTransferStatus = 'FAILED';
    this._reserveTransferError = error;
  }

  get id(): string {
    return this._id;
  }
  get merchantId(): string {
    return this._merchantId;
  }
  get sweepRunId(): string {
    return this._sweepRunId;
  }
  get grossAmount(): Money {
    return this._grossAmount;
  }
  get reserveAmount(): Money {
    return this._reserveAmount;
  }
  get netAmount(): Money {
    return this._netAmount;
  }
  get releaseEligibleAt(): Date | undefined {
    return this._releaseEligibleAt;
  }
  get reserveReleased(): boolean {
    return this._reserveReleased;
  }
  get reserveReleasedAt(): Date | undefined {
    return this._reserveReleasedAt;
  }
  get createdAt(): Date {
    return this._createdAt;
  }
  get kycBlocked(): boolean {
    return this._kycBlocked;
  }
  get kycClearedAt(): Date | undefined {
    return this._kycClearedAt;
  }
  get transferStatus(): PayoutTransferStatus {
    return this._transferStatus;
  }
  get transferId(): string | undefined {
    return this._transferId;
  }
  get transferInitiatedAt(): Date | undefined {
    return this._transferInitiatedAt;
  }
  get transferError(): string | undefined {
    return this._transferError;
  }

  get reserveTransferStatus(): PayoutTransferStatus {
    return this._reserveTransferStatus;
  }
  get reserveTransferId(): string | undefined {
    return this._reserveTransferId;
  }
  get reserveTransferInitiatedAt(): Date | undefined {
    return this._reserveTransferInitiatedAt;
  }
  get reserveTransferError(): string | undefined {
    return this._reserveTransferError;
  }

  get reserveStatus(): PayoutReserveStatus {
    if (this._reserveAmount.isZero()) return 'NONE';
    return this._reserveReleased ? 'RELEASED' : 'HELD';
  }
}
