export type ChargebackMonitoringTier = 'NONE' | 'MONITORING' | 'EXCESSIVE';

const TIER_ORDER: ChargebackMonitoringTier[] = ['NONE', 'MONITORING', 'EXCESSIVE'];

/** Ordinal rank for comparing two tiers — higher is worse. */
export function chargebackTierRank(tier: ChargebackMonitoringTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** Whether a tier change from `previous` to `next` is an escalation (worse) rather than a de-escalation (better) or no change. */
export function isChargebackTierEscalation(
  previous: ChargebackMonitoringTier,
  next: ChargebackMonitoringTier,
): boolean {
  return chargebackTierRank(next) > chargebackTierRank(previous);
}
