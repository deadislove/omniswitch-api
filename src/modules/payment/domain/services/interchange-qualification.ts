import { CardBrand, CardProduct } from '../value-objects/bin-info.vo';
import { DOWNGRADE_SURCHARGE_BPS, lookupInterchangeRate } from './interchange-rate-table';

/** Normalized AVS result — see `PSPChargeResponse.avsResult`'s own docblock for how each PSP's native vocabulary maps onto this. */
export type AvsResult = 'MATCH' | 'PARTIAL' | 'NO_MATCH' | 'UNAVAILABLE';
/** Normalized CVV result — see `PSPChargeResponse.cvvResult`'s own docblock. */
export type CvvResult = 'MATCH' | 'NO_MATCH' | 'UNAVAILABLE';

export type InterchangeDowngradeReason =
  /** AVS came back anything other than a full MATCH (PARTIAL or NO_MATCH). */
  | 'AVS_NOT_MATCHED'
  /** CVV came back NO_MATCH. */
  | 'CVV_NOT_MATCHED'
  /** Neither check could even be attempted — the PSP never populated either result. Distinct from UNAVAILABLE on one specific check: this is "no data at all," not "the issuer didn't support the check." */
  | 'NO_AVS_CVV_DATA'
  /** Captured later than the network's required settlement window after authorization — see `SETTLEMENT_WINDOW_HOURS`. */
  | 'LATE_SETTLEMENT';

export interface InterchangeQualificationResult {
  cardBrand: CardBrand;
  cardProduct: CardProduct;
  /** The best-qualified rate for this brand/product — what this transaction would have cost if nothing had gone wrong. */
  qualifiedBps: number;
  qualifiedFixedMinorUnits: number;
  downgraded: boolean;
  downgradeReasons: InterchangeDowngradeReason[];
  /** qualifiedBps + DOWNGRADE_SURCHARGE_BPS when downgraded, else equal to qualifiedBps. The fixed per-transaction fee never changes on a downgrade — only the bps rate does, matching how real interchange downgrades work. */
  appliedBps: number;
  appliedFixedMinorUnits: number;
}

/**
 * Real Visa/Mastercard card-not-present transactions must settle
 * (capture) within a network-required window of authorization to keep
 * their best-qualified rate — typically a small number of calendar
 * days, varying by brand/region. This models one representative
 * illustrative window rather than a specific brand's exact published
 * value, same posture as `interchange-rate-table.ts`'s own rates.
 */
export const SETTLEMENT_WINDOW_HOURS = 48;

/**
 * The actual mechanics behind an acquirer's margin: a transaction's
 * interchange rate isn't fixed at its brand/product's best-qualified
 * row — it downgrades (a flat surcharge on top, see
 * `DOWNGRADE_SURCHARGE_BPS`) when the data a network requires for the
 * best rate wasn't there. Models the three qualification checks this
 * codebase can actually observe: AVS match, CVV match, and settlement
 * timing (capture within `SETTLEMENT_WINDOW_HOURS` of authorization).
 * Real networks also downgrade for missing 3DS on card-not-present —
 * not modeled here since this codebase's own SCA/3DS handling already
 * has the PSP decide that pre-emptively (see `PaymentCheckoutSaga`'s
 * docblock), with no "was 3DS attempted" signal of its own to check
 * against after the fact.
 *
 * Pure and synchronous — no PSP/DB calls, same posture as
 * `chargeback-monitoring-tier.ts`'s domain functions. Called once a
 * charge is actually confirmed captured (`PaymentCheckoutSaga`'s
 * immediate-capture path, or `PaymentLifecycleService.capture()`'s
 * manual-capture completion) — never before, since `settlementDelayHours`
 * and the final AVS/CVV result both only exist once there's a real PSP
 * response to read them from.
 */
export function evaluateInterchangeQualification(params: {
  cardBrand: CardBrand;
  cardProduct: CardProduct;
  avsResult?: AvsResult;
  cvvResult?: CvvResult;
  settlementDelayHours: number;
}): InterchangeQualificationResult {
  const rate = lookupInterchangeRate(params.cardBrand, params.cardProduct);
  const reasons: InterchangeDowngradeReason[] = [];

  if (params.avsResult === undefined && params.cvvResult === undefined) {
    reasons.push('NO_AVS_CVV_DATA');
  } else {
    if (params.avsResult && params.avsResult !== 'MATCH') reasons.push('AVS_NOT_MATCHED');
    if (params.cvvResult && params.cvvResult !== 'MATCH') reasons.push('CVV_NOT_MATCHED');
  }
  if (params.settlementDelayHours > SETTLEMENT_WINDOW_HOURS) {
    reasons.push('LATE_SETTLEMENT');
  }

  const downgraded = reasons.length > 0;
  return {
    cardBrand: params.cardBrand,
    cardProduct: params.cardProduct,
    qualifiedBps: rate.bps,
    qualifiedFixedMinorUnits: rate.fixedMinorUnits,
    downgraded,
    downgradeReasons: reasons,
    appliedBps: downgraded ? rate.bps + DOWNGRADE_SURCHARGE_BPS : rate.bps,
    appliedFixedMinorUnits: rate.fixedMinorUnits,
  };
}
