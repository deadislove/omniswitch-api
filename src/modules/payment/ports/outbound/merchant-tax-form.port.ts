import { MerchantTaxForm1099K } from '../../domain/aggregates/merchant-tax-form-1099k.aggregate';

export interface FindTaxFormsFilter {
  limit?: number;
  offset?: number;
}

/**
 * Merchant Tax Form Port (Outbound)
 * Persistence contract for `MerchantTaxForm1099K` — same
 * single-aggregate-per-port shape as `MerchantStatementPort`.
 */
export abstract class MerchantTaxFormPort {
  abstract save(form: MerchantTaxForm1099K): Promise<void>;
  abstract findById(id: string): Promise<MerchantTaxForm1099K | null>;

  /**
   * The idempotency check `TaxForm1099KService.generateForMerchant()`
   * runs first — a form already generated for this exact
   * `(merchantId, taxYear)` is returned as-is rather than recomputed,
   * same "a closed year's history doesn't change" posture as
   * `MerchantStatementPort.findByMerchantAndPeriod()`.
   */
  abstract findByMerchantAndYear(merchantId: string, taxYear: number): Promise<MerchantTaxForm1099K | null>;

  abstract findByMerchantId(merchantId: string, filter?: FindTaxFormsFilter): Promise<MerchantTaxForm1099K[]>;
}
