import { PSPProvider } from '../aggregates/payment.aggregate';

/**
 * Decline codes a real card network/PSP can return where retrying is
 * actively harmful, not just unlikely to succeed — a stolen/lost/
 * fraudulent card retried again is a real signal to whoever's monitoring
 * for card testing, and an expired card will never succeed on a retry
 * with the *same* stored credential regardless of backoff.
 *
 * **Per-PSP (Phase 1), not one shared vocabulary.** `errorCode` reaching
 * this function is the *raw* value each PSP adapter returns verbatim —
 * `StripePSPAdapter` passes through `response.last_payment_error?.code`
 * (Stripe's own `decline_code` strings, e.g. `stolen_card`) and
 * `AdyenPSPAdapter` passes through `response.refusalReasonCode` (Adyen's
 * own *numeric* refusalReasonCode strings, e.g. `'5'` for Blocked Card) —
 * neither adapter normalizes to a shared vocabulary before this point.
 * A single shared `Set<string>` would only ever match Stripe's strings;
 * every real Adyen hard decline would silently fall through to
 * `RETRYABLE` (the exact bug this Phase 1 item fixes). See
 * `docs/business-domain/subscriptions.md`'s Dunning section for the
 * fuller reasoning. Each PSP's set is a documentation-accuracy claim
 * ("this code is really what that PSP's own docs say it is"), not a
 * statistical one — verified against each PSP's own, currently-published
 * documentation (via WebFetch, 2026), not trained-data recall:
 *
 * - **Stripe** (docs.stripe.com/declines/codes) — all 6 confirmed as
 *   real, current `decline_code` values with the exact meanings this
 *   list already assumed: `stolen_card`, `lost_card`, `fraudulent`,
 *   `pickup_card`, `restricted_card`, `expired_card`.
 * - **Adyen** (docs.adyen.com/development-resources/refusal-reasons) —
 *   all 7 pre-existing codes confirmed real and correctly labeled:
 *   `'5'` Blocked Card, `'6'` Expired Card, `'14'` Acquirer Fraud,
 *   `'20'` FRAUD, `'22'` FRAUD-CANCELLED, `'25'` Restricted Card, `'31'`
 *   Issuer Suspected Fraud. Two more, equally unambiguous codes were
 *   added as a direct result of this verification pass: `'26'`
 *   Revocation Of Auth (the cardholder explicitly asked their issuer to
 *   stop future charges — retrying isn't just futile, it's the exact
 *   thing the cardholder said not to do) and `'50'` Token Revoked (the
 *   merchant's own recurring-charge token was disabled — the credential
 *   this codebase would be retrying against no longer exists on Adyen's
 *   side at all). Both are as clear-cut as the original 7; Adyen's own
 *   docs describe neither as anything a retry could plausibly recover
 *   from.
 *
 * Originally lived only in `subscription.aggregate.ts` (Phase 1 item 8,
 * dunning-only). Moved here so `PaymentAggregate`'s one-off charges can
 * classify their own declines too without a
 * one-off-charge module reaching into a subscription-domain file for a
 * concept that has nothing to do with dunning — `Subscription` imports
 * `classifyDeclineCode` from here the same as anything else now does.
 */
const HARD_DECLINE_CODES: Record<PSPProvider, Set<string>> = {
  STRIPE: new Set(['stolen_card', 'lost_card', 'fraudulent', 'pickup_card', 'restricted_card', 'expired_card']),
  ADYEN: new Set(['5', '6', '14', '20', '22', '25', '26', '31', '50']),
  // Neither PSP this codebase actually integrates — no real decline-code
  // vocabulary to verify against, so every code is RETRYABLE by default
  // (classifyDeclineCode()'s own fallback) rather than guessing.
  PAYPAL: new Set(),
  CHASE: new Set(),
};

export type DeclineCategory = 'RETRYABLE' | 'HARD_DECLINE';

export function classifyDeclineCode(errorCode: string | undefined, pspProvider?: PSPProvider): DeclineCategory {
  if (!errorCode || !pspProvider) return 'RETRYABLE';
  return HARD_DECLINE_CODES[pspProvider].has(errorCode) ? 'HARD_DECLINE' : 'RETRYABLE';
}
