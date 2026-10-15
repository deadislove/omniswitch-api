import { Money } from '../value-objects/money.vo';

/**
 * Basis points Klarna charges a merchant on a captured BNPL order —
 * real published Klarna merchant fees run roughly 3-6% plus a fixed
 * fee depending on market/plan, well above typical card interchange
 * (see `interchange-rate-table.ts`'s own rates for the comparison) —
 * this is the real tradeoff a merchant accepts for Klarna taking on
 * the customer's credit risk and paying upfront regardless of whether
 * the customer ever finishes their installments. 399 (3.99%) is a
 * deliberately simplified, illustrative stand-in in that real
 * neighborhood, same "round number in the real range" posture
 * `INSTANT_PAYOUT_FEE_BPS` already uses — a real integration would read
 * this off Klarna's own merchant agreement, not a constant.
 */
export const KLARNA_MERCHANT_FEE_BPS = 399;

/** The fee Klarna deducts from a captured order before crediting this platform's merchant — deducted alongside (never instead of) this platform's own platformFee at capture time, see `LedgerOutboxEvent.createBnplCaptureEntries()`. */
export function calculateBnplProviderFee(amount: Money): Money {
  return amount.multiply(KLARNA_MERCHANT_FEE_BPS / 10_000);
}
