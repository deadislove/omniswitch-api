export interface FXRate {
  rate: number;
  provider: string;
}

/**
 * FX Rate Provider Port (Outbound)
 * The real exchange-rate source `Money.convertTo()` needed but never had —
 * see DEV_README.md's FX conversion entry. Only used for the
 * charge-currency -> merchant-settlement-currency leg (see
 * LedgerOutboxEvent.createChargeEntries()'s settlementConversion param),
 * not for presentment currency or any other conversion.
 */
export abstract class FXRateProviderPort {
  abstract getRate(fromCurrency: string, toCurrency: string): Promise<FXRate>;
}
