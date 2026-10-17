import { MerchantStatement } from '../../domain/aggregates/merchant-statement.aggregate';

export interface FindStatementsFilter {
  limit?: number;
  offset?: number;
}

/**
 * Merchant Statement Port (Outbound)
 * Persistence contract for `MerchantStatement` — same single-aggregate-
 * per-port shape as `ReconciliationPort`/`PayoutPort`.
 */
export abstract class MerchantStatementPort {
  abstract save(statement: MerchantStatement): Promise<void>;
  abstract findById(id: string): Promise<MerchantStatement | null>;

  /**
   * The idempotency check `MerchantStatementService.generateForMerchant()`
   * runs before computing anything — a statement already generated for
   * this exact `(merchantId, periodStart, periodEnd)` is returned as-is
   * rather than recomputed, same "a closed period's history doesn't
   * change" posture as that service's own docblock.
   */
  abstract findByMerchantAndPeriod(merchantId: string, periodStart: Date, periodEnd: Date): Promise<MerchantStatement | null>;

  abstract findByMerchantId(merchantId: string, filter?: FindStatementsFilter): Promise<MerchantStatement[]>;
}
