import { Payout } from '../../domain/aggregates/payout.aggregate';
import { PayoutSweepRun } from '../../domain/aggregates/payout-sweep-run.aggregate';

export interface FindPayoutsFilter {
  merchantId?: string;
  limit?: number;
}

/**
 * Payout Port (Outbound)
 * Persistence contract for both `Payout` and `PayoutSweepRun` — kept on
 * one port since both are owned exclusively by `PayoutService` and always
 * change together (a sweep run either produces some `Payout` rows or
 * none, but the run record itself is always written).
 */
export abstract class PayoutPort {
  abstract save(payout: Payout): Promise<void>;

  abstract findById(id: string): Promise<Payout | null>;

  /**
   * Same as findById(), but forced onto master — same reasoning as
   * findManyOnMaster() below. Confirmed as a real, reproducible flake
   * under sustained e2e load: a caller that just wrote this exact Payout
   * (an admin action, a bank-transfer webhook confirmation) and reads it
   * straight back can observe the replica's ~1s streaming lag as a
   * stale, pre-write copy.
   */
  abstract findByIdOnMaster(id: string): Promise<Payout | null>;

  abstract findMany(filter?: FindPayoutsFilter): Promise<Payout[]>;

  /**
   * Same as findMany(), but forced onto master instead of the ambient
   * replica-routed connection — for internal call sites that look up a
   * merchant's payouts immediately after a write (a sweep run, a
   * transfer confirmation) in the same business flow, where the read
   * genuinely can't tolerate the replica's ~1s streaming lag. Confirmed
   * as a real, reproducible flake under sustained e2e load (not just
   * theorized) — see PaymentRepositoryPort.findByIdOnMaster()'s docblock
   * for the same reasoning applied to a different repository.
   */
  abstract findManyOnMaster(filter?: FindPayoutsFilter): Promise<Payout[]>;

  /** All Payouts with a HELD (unreleased, non-zero) reserve whose releaseEligibleAt has passed — what the release sweep iterates over. */
  abstract findReserveReleaseEligible(now: Date): Promise<Payout[]>;

  /** Atomic, conditional on the reserve currently being unreleased — same reasoning as ReserveHoldPort.markReleased(). */
  abstract markReserveReleased(id: string, releasedAt: Date): Promise<boolean>;

  /** Every currently KYC-blocked Payout — what PayoutService.recheckKycBlocks() iterates over. */
  abstract findKycBlocked(): Promise<Payout[]>;

  /** Atomic, conditional on kycBlocked currently being true — same reasoning as markReserveReleased(). */
  abstract markKycCleared(id: string, clearedAt: Date): Promise<boolean>;

  /** Every Payout eligible for transfer initiation: not KYC-blocked, net amount > 0, transfer not already INITIATED or PENDING_CONFIRMATION. */
  abstract findTransferEligible(): Promise<Payout[]>;

  /**
   * Atomic, conditional on transferStatus currently being neither
   * INITIATED nor PENDING_CONFIRMATION — a real ACH/wire transfer is
   * money genuinely in flight once submitted, so two concurrent
   * submission attempts (an operator's manual call racing the scheduled
   * sweep) succeeding would mean sending the same payout twice. Returns
   * false if the condition didn't hold, same pattern as
   * markReserveReleased(). See `Payout.recordTransferPending()`.
   */
  abstract markTransferPending(id: string, transferId: string, submittedAt: Date): Promise<boolean>;

  /**
   * Atomic, conditional on transferStatus currently *not* being
   * INITIATED — a real bank transfer is money genuinely leaving the
   * platform, so two concurrent initiation attempts (an operator's
   * manual call racing the scheduled sweep, or a duplicate webhook
   * delivery) succeeding would mean sending the same payout twice.
   * Returns false if the condition didn't hold, same pattern as
   * markReserveReleased(). Called either straight from NOT_INITIATED
   * (mock's synchronous SENT) or from PENDING_CONFIRMATION (a real
   * rail's async webhook confirming settlement).
   */
  abstract markTransferInitiated(id: string, transferId: string, initiatedAt: Date): Promise<boolean>;

  abstract markTransferFailed(id: string, error: string): Promise<void>;

  /** Looks up the Payout a real rail's async webhook confirmation refers to — see PayoutService.confirmTransfer(). Checks the netAmount transferId only; see findByReserveTransferId() for the reserve leg. */
  abstract findByTransferId(transferId: string): Promise<Payout | null>;

  /**
   * Same as findByTransferId(), but forced onto master. The
   * `transferId` a webhook confirmation refers to was itself written
   * (via markTransferPending()) moments earlier in the same real-world
   * flow — often by the very same admin action that triggered the
   * external rail to call this webhook back — so this lookup can't
   * tolerate reading a pre-write replica snapshot that doesn't have this
   * transferId on it yet, which would surface as "no Payout found for
   * transferId=..., ignoring" and silently drop a real confirmation.
   */
  abstract findByTransferIdOnMaster(transferId: string): Promise<Payout | null>;

  /**
   * Every Payout eligible for a *reserve* transfer: reserve released,
   * reserve amount > 0, not KYC-blocked, reserve transfer not already
   * INITIATED or PENDING_CONFIRMATION. Independent of the netAmount
   * transfer's own status — a reserve released before, during, or long
   * after the netAmount transfer is equally eligible the moment
   * `reserveReleased` is true, since this is always a separate transfer
   * action, not a merge into whatever already happened to netAmount.
   */
  abstract findReserveTransferEligible(): Promise<Payout[]>;

  /** Same shape as markTransferPending(), for the reserve leg. See Payout.recordReserveTransferPending(). */
  abstract markReserveTransferPending(id: string, transferId: string, submittedAt: Date): Promise<boolean>;

  /** Same shape as markTransferInitiated(), for the reserve leg. */
  abstract markReserveTransferInitiated(id: string, transferId: string, initiatedAt: Date): Promise<boolean>;

  abstract markReserveTransferFailed(id: string, error: string): Promise<void>;

  /** Looks up the Payout a real rail's async webhook confirmation refers to, by its *reserve* transferId — see PayoutService.confirmTransfer(). */
  abstract findByReserveTransferId(transferId: string): Promise<Payout | null>;

  /** Same as findByReserveTransferId(), but forced onto master — same reasoning as findByTransferIdOnMaster() above, for the reserve leg. */
  abstract findByReserveTransferIdOnMaster(transferId: string): Promise<Payout | null>;

  abstract saveSweepRun(run: PayoutSweepRun): Promise<void>;

  /** The most recent sweep run, or null if PayoutService.runSweep() has never been called — the cursor for the next sweep's window start. */
  abstract findLatestSweepRun(): Promise<PayoutSweepRun | null>;
}
