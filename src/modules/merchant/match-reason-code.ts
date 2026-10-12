/**
 * A subset of Mastercard's published MATCH ("Member Alert To Control
 * High-risk Merchants") reason codes — the taxonomy an acquirer must
 * pick from when filing a terminated-for-cause merchant to the shared
 * industry file (Mastercard Rules manual, MATCH System appendix).
 * Trimmed to the codes this codebase's own existing signals can
 * plausibly justify (laundering ties to AmlReviewMonitoringService,
 * excessive chargebacks to ChargebackMonitoringService reaching
 * `EXCESSIVE`, the rest are standard acquirer-termination grounds) —
 * same illustrative-subset posture as mcc-risk-lookup.ts's table,
 * instead of reproducing Mastercard's full published list wholesale.
 */
export const MATCH_REASON_CODE_LABELS = {
  '03': 'Laundering',
  '04': 'Excessive Chargebacks',
  '05': 'Fraud Conviction',
  '07': 'Bankrupt',
  '09': 'Merchant Collusion',
  '11': 'Illegal Transactions',
} as const;

export type MatchReasonCode = keyof typeof MATCH_REASON_CODE_LABELS;

export const MATCH_REASON_CODES = Object.keys(MATCH_REASON_CODE_LABELS) as MatchReasonCode[];
