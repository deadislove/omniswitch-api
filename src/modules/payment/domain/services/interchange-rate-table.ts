import { CardBrand, CardProduct } from '../value-objects/bin-info.vo';

export interface InterchangeRate {
  /** Basis points of the transaction amount. */
  bps: number;
  /** Flat per-transaction fee, in the transaction's own minor units — real interchange is always "bps + a fixed amount," never bps alone. */
  fixedMinorUnits: number;
}

/**
 * A deliberately simplified, illustrative card-not-present interchange
 * rate table — the actual mechanics behind an acquirer's margin, which
 * `PspFeeScheduleService`'s flat "platform fee bps" sits entirely on top
 * of without modeling. Real Visa/Mastercard interchange is a much larger
 * published matrix (dozens of named categories per brand, keyed on MCC,
 * card product, and channel, revised twice a year) — this models the
 * same three dimensions this codebase can actually observe (`CardBrand`,
 * `CardProduct`, card-not-present-only since every charge here is
 * online) at illustrative, round numbers in the real neighborhood of
 * published card-not-present rates, same "calibrated vs. illustrative"
 * honesty posture as `chargeback-monitoring.service.ts`'s thresholds —
 * not a live network rate sheet.
 *
 * Amex and Discover don't get their own brand/product cross product:
 * Amex's OptBlue program and Discover's acquiring model both price
 * closer to a single blended rate per brand rather than publishing a
 * Visa/Mastercard-style product-tiered table, so both use one flat rate
 * regardless of `CardProduct`. JCB/UnionPay/Diners/UNKNOWN fall back to
 * `DEFAULT_RATE` — no published table modeled, a conservative (higher)
 * estimate rather than guessing at these networks' real tables.
 */
const RATE_TABLE: Partial<Record<CardBrand, Partial<Record<CardProduct, InterchangeRate>>>> = {
  [CardBrand.VISA]: {
    [CardProduct.CONSUMER]: { bps: 180, fixedMinorUnits: 10 },
    [CardProduct.CONSUMER_REWARDS]: { bps: 210, fixedMinorUnits: 10 },
    [CardProduct.COMMERCIAL]: { bps: 250, fixedMinorUnits: 10 },
  },
  [CardBrand.MASTERCARD]: {
    [CardProduct.CONSUMER]: { bps: 175, fixedMinorUnits: 10 },
    [CardProduct.CONSUMER_REWARDS]: { bps: 205, fixedMinorUnits: 10 },
    [CardProduct.COMMERCIAL]: { bps: 245, fixedMinorUnits: 10 },
  },
};

const FLAT_BRAND_RATE: Partial<Record<CardBrand, InterchangeRate>> = {
  [CardBrand.AMEX]: { bps: 250, fixedMinorUnits: 10 },
  [CardBrand.DISCOVER]: { bps: 175, fixedMinorUnits: 10 },
};

const DEFAULT_RATE: InterchangeRate = { bps: 300, fixedMinorUnits: 10 };

/**
 * A downgraded transaction doesn't get re-looked-up in a worse row of
 * the same table — real networks add a flat surcharge on top of
 * whatever the best-qualified rate was. Illustrative, same posture as
 * `RATE_TABLE` above: real downgrade surcharges vary by brand/category,
 * typically landing somewhere in the tens to low hundreds of basis
 * points; this picks one representative value rather than modeling
 * each brand's own published downgrade tier.
 */
export const DOWNGRADE_SURCHARGE_BPS = 80;

export function lookupInterchangeRate(cardBrand: CardBrand, cardProduct: CardProduct): InterchangeRate {
  return RATE_TABLE[cardBrand]?.[cardProduct] ?? FLAT_BRAND_RATE[cardBrand] ?? DEFAULT_RATE;
}
