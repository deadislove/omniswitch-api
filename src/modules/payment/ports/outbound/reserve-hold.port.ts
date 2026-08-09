import { ReserveHold, ReserveHoldStatus } from '../../domain/aggregates/reserve-hold.aggregate';

export interface FindReserveHoldsFilter {
  merchantId?: string;
  status?: ReserveHoldStatus;
  limit?: number;
}

export abstract class ReserveHoldPort {
  /** `transactionManager` lets the caller write this atomically with the ledger outbox event that funded it — same pattern as LedgerOutboxPort.saveWithPayment(). */
  abstract save(hold: ReserveHold, transactionManager?: unknown): Promise<void>;

  abstract findById(id: string): Promise<ReserveHold | null>;

  abstract findMany(filter?: FindReserveHoldsFilter): Promise<ReserveHold[]>;

  /**
   * All HELD holds whose releaseEligibleAt has passed — what the release
   * sweep iterates over. Deliberately separate from findMany() (which is
   * capped/paginated for admin listing) since the sweep needs the true set,
   * not a page of it.
   */
  abstract findReleaseEligible(now: Date): Promise<ReserveHold[]>;

  /**
   * Atomic, conditional on the hold currently being HELD — same reasoning
   * as LedgerOutboxPort.resetToPending(): a plain read-then-write here
   * would let two concurrent release attempts (an operator's manual
   * override racing the scheduled sweep) both succeed. Returns false if
   * the hold didn't exist or wasn't HELD. Takes an optional
   * `transactionManager` (same pattern as save()) so ReserveService can
   * wrap the status flip and the offsetting ledger entry in one DB
   * transaction — a lone status flip with no matching ledger entry (or
   * vice versa) would be exactly the kind of "response says it worked but
   * the books don't agree" bug this project's reconciliation pass exists
   * to catch, so it shouldn't be possible to leave that half-done here.
   */
  abstract markReleased(id: string, releasedAt: Date, transactionManager?: unknown): Promise<boolean>;
}
