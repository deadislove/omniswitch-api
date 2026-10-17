import { Dispute, DisputeStatus } from '../../domain/aggregates/dispute.aggregate';

export interface FindDisputesFilter {
  merchantId?: string;
  status?: DisputeStatus;
  limit?: number;
}

export abstract class DisputePort {
  abstract save(dispute: Dispute): Promise<void>;
  abstract findById(id: string): Promise<Dispute | null>;
  abstract findByPspDisputeId(pspDisputeId: string): Promise<Dispute | null>;
  abstract findMany(filter?: FindDisputesFilter): Promise<Dispute[]>;

  /**
   * Total count (not capped by findMany()'s `limit`) of a merchant's
   * disputes in a given status created on or after `since` — used by
   * RiskTieringService to compute a trailing chargeback rate. Deliberately
   * a separate method rather than adding a date filter to findMany(),
   * which returns full domain objects capped at 50 for admin listing; a
   * risk calculation needs the true count, instead of a page of it.
   */
  abstract countByMerchantSince(merchantId: string, status: DisputeStatus, since: Date): Promise<number>;

  /**
   * Same shape as countByMerchantSince() above, but unfiltered by
   * status — `ChargebackMonitoringService` needs *every* dispute
   * received in the window regardless of outcome, where
   * countByMerchantSince()'s callers specifically want one status at a
   * time (e.g. `LOST` only). A network chargeback-monitoring program
   * counts a dispute against a merchant's ratio the moment it lands,
   * whether or not the merchant goes on to win it.
   */
  abstract countAllByMerchantSince(merchantId: string, since: Date): Promise<number>;

  /**
   * Just the `reason` column (not full Dispute objects — RiskTieringService
   * only needs to weight-and-sum these, same "true count rather than a
   * page of it" reasoning as countByMerchantSince()) for a merchant's disputes in
   * a given status created on or after `since`. Weighting itself happens
   * in the caller via dispute-risk-weight.ts — kept out of the repository
   * so the weight table has exactly one place to change.
   */
  abstract findReasonsByMerchantStatusSince(
    merchantId: string,
    status: DisputeStatus,
    since: Date,
  ): Promise<(string | null)[]>;

  /**
   * Full `Dispute` objects (not just a count, unlike
   * `countByMerchantSince()`) for a merchant in a given status, bounded
   * on *both* ends — `MerchantStatementService` needs the real amount of
   * each chargeback to report alongside the count, and a closed
   * statement period needs an upper bound every other query here (all
   * open-ended "since") doesn't. `createdAt`-bounded, same convention
   * `countByMerchantSince()` already uses: a dispute's chargeback is
   * attributed to the period it was *received* in, not the period it
   * was eventually resolved in, so a later-arriving resolution can't
   * retroactively change an already-generated statement.
   */
  abstract findByMerchantStatusInRange(
    merchantId: string,
    status: DisputeStatus,
    since: Date,
    until: Date,
  ): Promise<Dispute[]>;
}
