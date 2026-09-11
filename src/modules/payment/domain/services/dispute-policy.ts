import { Money } from '../value-objects/money.vo';

export type DisputeAutoDecision = 'ACCEPT' | 'CONTEST' | 'MANUAL_REVIEW';

/**
 * Dispute Auto-Decision Policy
 * Classifies a new dispute as ACCEPT/CONTEST/MANUAL_REVIEW by amount and
 * reason code, so routine disputes don't all sit at NEEDS_RESPONSE
 * waiting on an operator. A pure domain function — no I/O — computing a
 * recommendation at dispute-creation time (see DisputeService.recordDispute()
 * for where the recommendation is actually acted on).
 *
 * Deliberately simple, illustrative thresholds/tables — not calibrated
 * against real chargeback win-rate data, same posture as
 * RiskTieringService's tiers. A real policy would also weigh the
 * merchant's own dispute history, the card network involved, and
 * jurisdiction-specific evidence requirements.
 */

// Same reasoning as RiskTieringService's reserve tiers: not FX-normalized
// across currencies — a 15-unit threshold means very different things for
// USD vs. JPY vs. KWD. A flat major-unit cutoff, not a calibrated one.
// Overridable at the call site (DisputeService reads
// DISPUTE_AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS) rather than read from
// ConfigService here directly — this file is a pure domain module (no
// I/O, no DI), and stays that way on purpose; see this file's own
// docblock and RiskTieringService's matching comment on its thresholds.
export const DEFAULT_AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS = 15;

// Multipliers applied to the base auto-accept threshold by the charging
// merchant's current risk tier (see decideAutoDisposition()'s
// merchantRiskTier param) — same "illustrative, overridable, not
// calibrated" posture as the base threshold above. LOW *lowers* the
// threshold (fewer disputes auto-accepted, more reach the CONTEST check —
// worth contesting more aggressively for a merchant with a strong track
// record); HIGH *raises* it (more small disputes auto-accepted outright,
// not spending contest effort on a merchant already flagged higher-risk).
export const DEFAULT_LOW_RISK_THRESHOLD_MULTIPLIER = 0.5;
export const DEFAULT_HIGH_RISK_THRESHOLD_MULTIPLIER = 2;

// Reason codes with a reasonably templatable, evidence-based response.
// Deliberately conservative — 'fraudulent' is excluded even though it's
// probably the single most common reason code in practice, since a
// card-not-present fraud claim usually can't be meaningfully contested
// with a generic template; it turns on real evidence (AVS/CVV match,
// 3DS proof, account history) and often on liability-shift rules this
// system doesn't model. Automating a templated response to a fraud claim
// would be more likely to waste the response window than win it — this
// applies regardless of merchant risk tier, so 'fraudulent' never enters
// any tier's contestable set below.
const AUTO_CONTESTABLE_REASONS = new Set(['product_not_received', 'duplicate']);

// Only added to the contestable set for a LOW-risk merchant (see
// decideAutoDisposition()) — a strong track record buys a merchant a
// templated auto-contest on one more reason code than the default set,
// not a change to which reasons are ever templatable in principle.
const LOW_RISK_EXTRA_CONTESTABLE_REASONS = new Set(['subscription_canceled']);

const EVIDENCE_TEMPLATES: Record<string, string> = {
  product_not_received:
    'Automated response (dispute policy): shipment/delivery confirmation is on file for this order. ' +
    "Operator: verify tracking before this dispute's response deadline in case a fuller submission is warranted.",
  duplicate:
    'Automated response (dispute policy): transaction records on file show this as a single, non-duplicate charge. ' +
    "Operator: confirm no duplicate settlement occurred before this dispute's response deadline.",
  subscription_canceled:
    'Automated response (dispute policy): billing records on file show this subscription was active and not ' +
    "canceled as of the charge date. Operator: confirm the cancellation policy/timestamp before this dispute's " +
    'response deadline.',
};

// Shown to an operator regardless of what the auto-policy decided —
// 'fraudulent' and 'product_not_received' need completely different proof,
// so a MANUAL_REVIEW dispute shouldn't leave the operator guessing.
const EVIDENCE_GUIDANCE: Record<string, string> = {
  fraudulent:
    'Cardholder disputes authorizing this charge. Strongest evidence: AVS/CVV match results, 3DS ' +
    'authentication proof, prior undisputed transaction history with this cardholder, IP/device ' +
    'fingerprint matching account history.',
  product_not_received:
    'Provide shipment tracking with delivery confirmation, or proof of digital delivery ' +
    '(download/access logs) if this was a digital good.',
  duplicate:
    'Provide the two transaction IDs the cardholder believes are duplicates and show they correspond ' +
    'to distinct orders/charges, or that only one was ever actually settled.',
  subscription_canceled:
    'Provide the cancellation policy the cardholder agreed to and the actual cancellation timestamp ' +
    'versus the charge date.',
};
const DEFAULT_EVIDENCE_GUIDANCE =
  'No specific guidance for this reason code — review the raw dispute details and respond with ' +
  'general evidence (receipts, communication logs, delivery/usage records).';

/**
 * Amount is checked before reason — an economically-cheap dispute isn't
 * worth contesting regardless of why it was filed, the same reasoning a
 * human operator would apply first.
 *
 * `merchantRiskTier` — the charging merchant's current risk tier (see
 * RiskTieringService), passed in by the caller rather than looked up here:
 * this module is deliberately I/O-free/no-DI (see this file's own
 * docblock), so a plain string literal type is used instead of importing
 * RiskTieringService's own `RiskTier` type — that lives in the
 * application layer, and importing it here would point a domain-layer
 * dependency at an application-layer one. `undefined` (merchant not
 * found, or tier lookup skipped) behaves identically to `'MEDIUM'`: the
 * base threshold and default contestable set, unchanged from before this
 * parameter existed.
 */
export function decideAutoDisposition(
  amount: Money,
  reason?: string,
  autoAcceptThresholdMajorUnits: number = DEFAULT_AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS,
  merchantRiskTier?: 'LOW' | 'MEDIUM' | 'HIGH',
  lowRiskThresholdMultiplier: number = DEFAULT_LOW_RISK_THRESHOLD_MULTIPLIER,
  highRiskThresholdMultiplier: number = DEFAULT_HIGH_RISK_THRESHOLD_MULTIPLIER,
): DisputeAutoDecision {
  const effectiveThreshold =
    merchantRiskTier === 'LOW'
      ? autoAcceptThresholdMajorUnits * lowRiskThresholdMultiplier
      : merchantRiskTier === 'HIGH'
        ? autoAcceptThresholdMajorUnits * highRiskThresholdMultiplier
        : autoAcceptThresholdMajorUnits;
  if (amount.amount < effectiveThreshold) return 'ACCEPT';

  const contestableReasons =
    merchantRiskTier === 'LOW'
      ? new Set([...AUTO_CONTESTABLE_REASONS, ...LOW_RISK_EXTRA_CONTESTABLE_REASONS])
      : AUTO_CONTESTABLE_REASONS;
  if (reason && contestableReasons.has(reason)) return 'CONTEST';
  return 'MANUAL_REVIEW';
}

/** Only meaningful when decideAutoDisposition() returned 'CONTEST' — every reason in AUTO_CONTESTABLE_REASONS has a template. */
export function autoContestEvidenceFor(reason?: string): string {
  return (
    (reason && EVIDENCE_TEMPLATES[reason]) ||
    'Automated response (dispute policy): evidence submitted per default dispute policy.'
  );
}

export function evidenceGuidanceFor(reason?: string): string {
  return (reason && EVIDENCE_GUIDANCE[reason]) || DEFAULT_EVIDENCE_GUIDANCE;
}
