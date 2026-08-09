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
const AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS = 15;

// Reason codes with a reasonably templatable, evidence-based response.
// Deliberately conservative — 'fraudulent' is excluded even though it's
// probably the single most common reason code in practice, since a
// card-not-present fraud claim usually can't be meaningfully contested
// with a generic template; it turns on real evidence (AVS/CVV match,
// 3DS proof, account history) and often on liability-shift rules this
// system doesn't model. Automating a templated response to a fraud claim
// would be more likely to waste the response window than win it.
const AUTO_CONTESTABLE_REASONS = new Set(['product_not_received', 'duplicate']);

const EVIDENCE_TEMPLATES: Record<string, string> = {
  product_not_received:
    'Automated response (dispute policy): shipment/delivery confirmation is on file for this order. ' +
    'Operator: verify tracking before this dispute\'s response deadline in case a fuller submission is warranted.',
  duplicate:
    'Automated response (dispute policy): transaction records on file show this as a single, non-duplicate charge. ' +
    'Operator: confirm no duplicate settlement occurred before this dispute\'s response deadline.',
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
 */
export function decideAutoDisposition(amount: Money, reason?: string): DisputeAutoDecision {
  if (amount.amount < AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS) return 'ACCEPT';
  if (reason && AUTO_CONTESTABLE_REASONS.has(reason)) return 'CONTEST';
  return 'MANUAL_REVIEW';
}

/** Only meaningful when decideAutoDisposition() returned 'CONTEST' — every reason in AUTO_CONTESTABLE_REASONS has a template. */
export function autoContestEvidenceFor(reason?: string): string {
  return (reason && EVIDENCE_TEMPLATES[reason]) || 'Automated response (dispute policy): evidence submitted per default dispute policy.';
}

export function evidenceGuidanceFor(reason?: string): string {
  return (reason && EVIDENCE_GUIDANCE[reason]) || DEFAULT_EVIDENCE_GUIDANCE;
}
