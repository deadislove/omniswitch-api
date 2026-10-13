import { Money } from '../value-objects/money.vo';

/**
 * Real PSD2/EMVCo exemption categories a card-not-present EU transaction
 * can claim to skip an SCA challenge — see `evaluateScaExemption()`'s own
 * docblock for the real published thresholds each one models. `MIT`
 * (merchant-initiated transaction) is categorically different from the
 * other two: it's not a risk/amount judgment at all, just "was the
 * cardholder actually present for this specific charge."
 */
export type ScaExemptionType = 'LOW_VALUE' | 'TRANSACTION_RISK_ANALYSIS' | 'MIT';

export interface ScaExemptionEligibility {
  /** Undefined means no exemption applies — a real SCA challenge is expected for this EU card. */
  exemption?: ScaExemptionType;
  reason: string;
}

/**
 * PSD2's real low-value exemption threshold (EEA: €30, UK: £30) —
 * illustrative here as a flat major-units number applied regardless of
 * the charge's own currency, rather than converting through a real EUR
 * rate the way a production system would need to (this platform already
 * has `FXRateProviderPort` for that, deliberately left unwired here) —
 * same illustrative-rather-than-calibrated posture as this project's
 * other round-number thresholds, e.g. chargeback-monitoring's own
 * thresholds.
 */
const LOW_VALUE_THRESHOLD_MAJOR_UNITS = 30;

/**
 * The real PSD2 rule this models: a card can ride on consecutive
 * low-value exemptions without a fresh challenge, but only up to 5
 * consecutive exemptions (or a cumulative €100 since the last real
 * authentication, whichever comes first — this only models the
 * consecutive-count half of that rule, not the cumulative-amount half).
 * `ScaExemptionTrackerService` is what actually tracks this count per
 * payment method.
 */
export const LOW_VALUE_EXEMPTION_STREAK_CAP = 5;

/** Real EEA TRA cap (€250) — same illustrative-flat-number posture as LOW_VALUE_THRESHOLD_MAJOR_UNITS above. UK's real cap (£220) isn't modeled as a separate figure. */
const TRA_AMOUNT_CAP_MAJOR_UNITS = 250;

/**
 * A real TRA exemption's maximum eligible amount actually scales with
 * the *acquirer's* trailing fraud-rate percentage (banded: higher caps
 * for a demonstrably lower fraud rate) — not modeled here. This is a
 * single flat risk-score gate standing in for that whole mechanism,
 * reusing `PaymentAggregate.calculateRiskScore()`'s existing 0-100
 * output rather than introducing a second risk model. Illustrative,
 * same posture as every other round-number threshold in this file.
 */
const TRA_RISK_SCORE_MAX = 30;

/**
 * Computes whether a European card-not-present charge can claim an SCA
 * exemption instead of expecting a real challenge — the actual mechanics
 * behind PSD2's friction-reduction rules, which this codebase's existing
 * `BinInfo.requiresSCA()` only ever *feeds into the risk score*, never
 * acts on directly (see that method's own callers). This function is the
 * missing piece: a real exemption claim this platform can compute and
 * forward to the PSP as a request (`PSPChargeRequest.scaExemptionRequested`)
 * — the PSP's own SCA engine still makes the final call, honoring or
 * rejecting the claim, the same hint-rather-than-pre-emptive-decision
 * posture `binCountry` already has in `PaymentCheckoutSaga`.
 *
 * Checked in a fixed precedence, matching how a real integration would
 * reason about it: MIT first (categorical — the cardholder genuinely
 * wasn't present, no amount/risk judgment involved, and unlike the
 * other two doesn't require a European card at all — see `isEuropean`'s
 * own param doc), then low-value (cheapest to qualify for), then TRA
 * (the broadest but most risk-dependent).
 */
export function evaluateScaExemption(params: {
  amount: Money;
  riskScore: number;
  isMitRenewal: boolean;
  /**
   * LOW_VALUE/TRA are specifically PSD2/EEA concepts — meaningless (and
   * not evaluated) for a non-European card. MIT is checked first and
   * doesn't depend on this at all: "the cardholder wasn't present for
   * this charge" is a real signal worth forwarding to any PSP regardless
   * of card origin (real Stripe's `off_session`/real Adyen's
   * `shopperInteraction: 'ContAuth'` both exist independently of SCA).
   */
  isEuropean: boolean;
  lowValueStreakCount: number;
}): ScaExemptionEligibility {
  if (params.isMitRenewal) {
    return {
      exemption: 'MIT',
      reason: 'Merchant-initiated recurring charge — cardholder not present for this specific charge',
    };
  }

  if (!params.isEuropean) {
    return { reason: 'Not a European card — the PSD2 SCA exemption question does not apply' };
  }

  const amountMajorUnits = params.amount.amount;

  if (amountMajorUnits < LOW_VALUE_THRESHOLD_MAJOR_UNITS) {
    if (params.lowValueStreakCount < LOW_VALUE_EXEMPTION_STREAK_CAP) {
      return {
        exemption: 'LOW_VALUE',
        reason: `Amount under the low-value threshold, consecutive exemption count (${params.lowValueStreakCount}) under the cap (${LOW_VALUE_EXEMPTION_STREAK_CAP})`,
      };
    }
    return {
      reason: `Amount under the low-value threshold, but the consecutive exemption count (${params.lowValueStreakCount}) already reached the cap (${LOW_VALUE_EXEMPTION_STREAK_CAP}) — a fresh challenge is due`,
    };
  }

  if (amountMajorUnits < TRA_AMOUNT_CAP_MAJOR_UNITS && params.riskScore <= TRA_RISK_SCORE_MAX) {
    return {
      exemption: 'TRANSACTION_RISK_ANALYSIS',
      reason: `Amount under the TRA cap and risk score (${params.riskScore}) at or under the TRA threshold (${TRA_RISK_SCORE_MAX})`,
    };
  }

  return { reason: 'No exemption criteria met — a real SCA challenge is expected' };
}
