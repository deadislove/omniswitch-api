/**
 * How heavily a LOST dispute's reason code counts toward
 * RiskTieringService's chargeback-rate signal — a `fraudulent` loss and a
 * `duplicate` loss carry very different risk signal about the merchant
 * itself (see dispute-policy.ts's own docblock on why `fraudulent` is
 * deliberately excluded from auto-contest, for the same underlying
 * reason). Deliberately illustrative weights, same posture as
 * RiskTieringService's tier thresholds and dispute-policy.ts's
 * auto-accept threshold — not calibrated against real chargeback data.
 * Reuses the exact reason-code vocabulary dispute-policy.ts already
 * uses in production (EVIDENCE_GUIDANCE's keys), not a new taxonomy.
 *
 * An unlisted reason code defaults to full weight (1) — the conservative
 * choice: treating an unrecognized reason as low-risk by default could
 * silently under-count real risk as new reason codes appear at the PSP
 * level before this table is updated to know about them.
 */
const DISPUTE_RISK_WEIGHTS: Record<string, number> = {
  fraudulent: 1,
  product_not_received: 0.5,
  subscription_canceled: 0.5,
  duplicate: 0.25,
};
const DEFAULT_DISPUTE_RISK_WEIGHT = 1;

export function getDisputeRiskWeight(reason: string | null | undefined): number {
  if (!reason) return DEFAULT_DISPUTE_RISK_WEIGHT;
  return DISPUTE_RISK_WEIGHTS[reason] ?? DEFAULT_DISPUTE_RISK_WEIGHT;
}
