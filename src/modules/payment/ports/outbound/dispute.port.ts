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
   * risk calculation needs the true count, not a page of it.
   */
  abstract countByMerchantSince(merchantId: string, status: DisputeStatus, since: Date): Promise<number>;
}
