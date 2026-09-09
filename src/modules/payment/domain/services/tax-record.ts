import { Money } from '../value-objects/money.vo';
import { BinInfo } from '../value-objects/bin-info.vo';
import { TaxRecord } from '../aggregates/payment.aggregate';

/**
 * Builds a cross-border **audit** record, not a tax calculation — this
 * platform doesn't compute owed tax amounts, file returns, or determine
 * real nexus. `jurisdictionBasis` is pinned to `'card-issuing-country'`
 * (the cardholder's `BinInfo.country`) because that's the only
 * jurisdiction-relevant signal already captured at charge time — a real
 * tax engine would also weigh the merchant's own nexus, the customer's
 * billing address, and product-category-specific rules, none of which
 * this platform tracks. `collectedAmountMinorUnits`/`currencyCode`
 * record what was actually collected from the customer (the charge
 * amount in its original, presentment currency), not the merchant's
 * post-conversion settlement amount — cross-border tax exposure is a
 * function of what the customer paid, not what the merchant received
 * after FX.
 *
 * Returns `undefined` when there's no `BinInfo` to build a jurisdiction
 * from at all (e.g. a subscription renewal, which never carries one —
 * see `SubscriptionService`'s docblock) — same "best-effort, not a hard
 * requirement" posture as `ChargeLedgerParamsResolverService`'s own FX
 * lookup.
 */
export function buildCrossBorderTaxRecord(
  amount: Money,
  binInfo: BinInfo | undefined,
  now: Date = new Date(),
): TaxRecord | undefined {
  if (!binInfo) return undefined;
  return {
    jurisdiction: binInfo.country,
    jurisdictionBasis: 'card-issuing-country',
    collectedAmountMinorUnits: amount.amountMinorUnits.toString(),
    currencyCode: amount.currency.code,
    capturedAt: now.toISOString(),
  };
}
