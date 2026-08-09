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

  abstract findMany(filter?: FindPayoutsFilter): Promise<Payout[]>;

  /** All Payouts with a HELD (unreleased, non-zero) reserve whose releaseEligibleAt has passed — what the release sweep iterates over. */
  abstract findReserveReleaseEligible(now: Date): Promise<Payout[]>;

  /** Atomic, conditional on the reserve currently being unreleased — same reasoning as ReserveHoldPort.markReleased(). */
  abstract markReserveReleased(id: string, releasedAt: Date): Promise<boolean>;

  /** Every currently KYC-blocked Payout — what PayoutService.recheckKycBlocks() iterates over. */
  abstract findKycBlocked(): Promise<Payout[]>;

  /** Atomic, conditional on kycBlocked currently being true — same reasoning as markReserveReleased(). */
  abstract markKycCleared(id: string, clearedAt: Date): Promise<boolean>;

  /** Every Payout eligible for transfer initiation: not KYC-blocked, net amount > 0, transfer not already INITIATED. */
  abstract findTransferEligible(): Promise<Payout[]>;

  /**
   * Atomic, conditional on transferStatus currently *not* being
   * INITIATED — a real bank transfer is money genuinely leaving the
   * platform, so two concurrent initiation attempts (an operator's
   * manual call racing the scheduled sweep) succeeding would mean
   * sending the same payout twice. Returns false if the condition
   * didn't hold, same pattern as markReserveReleased().
   */
  abstract markTransferInitiated(id: string, transferId: string, initiatedAt: Date): Promise<boolean>;

  abstract markTransferFailed(id: string, error: string): Promise<void>;

  abstract saveSweepRun(run: PayoutSweepRun): Promise<void>;

  /** The most recent sweep run, or null if PayoutService.runSweep() has never been called — the cursor for the next sweep's window start. */
  abstract findLatestSweepRun(): Promise<PayoutSweepRun | null>;
}
