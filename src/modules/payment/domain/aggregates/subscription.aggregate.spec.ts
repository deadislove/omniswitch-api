import { classifyDeclineCode } from './subscription.aggregate';

/**
 * Phase 1: `errorCode` reaching `classifyDeclineCode()` is each PSP
 * adapter's *raw*, unnormalized decline code — Stripe's own
 * `decline_code` strings (e.g. `stolen_card`) vs Adyen's own numeric
 * `refusalReasonCode` strings (e.g. `'5'`) — see the aggregate's own
 * docblock on `HARD_DECLINE_CODES`. This proves the two PSPs' tables
 * are genuinely separate: a code real for one PSP must not be treated
 * as hard for the other just because the string happens to collide (or,
 * for Adyen's purely-numeric codes, never could collide with Stripe's
 * semantic ones in practice — but the classifier must still key strictly
 * off the *given* provider, not fall back to checking every table).
 */
describe('classifyDeclineCode() — per-PSP decline-code vocabulary', () => {
  it('classifies a real Stripe hard-decline code as HARD_DECLINE under STRIPE', () => {
    expect(classifyDeclineCode('stolen_card', 'STRIPE')).toBe('HARD_DECLINE');
    expect(classifyDeclineCode('expired_card', 'STRIPE')).toBe('HARD_DECLINE');
  });

  it('classifies a real Adyen hard-decline refusalReasonCode as HARD_DECLINE under ADYEN', () => {
    expect(classifyDeclineCode('20', 'ADYEN')).toBe('HARD_DECLINE'); // FRAUD
    expect(classifyDeclineCode('25', 'ADYEN')).toBe('HARD_DECLINE'); // Restricted Card
  });

  // Added via a 2026 documentation-accuracy audit (docs.adyen.com/
  // development-resources/refusal-reasons) — both are as unambiguous as
  // the original 7: the cardholder explicitly revoked authorization (26),
  // or the merchant's own recurring-charge token no longer exists on
  // Adyen's side at all (50) — neither is something a retry could ever
  // recover from.
  it('classifies the two codes added by the 2026 Adyen documentation audit as HARD_DECLINE', () => {
    expect(classifyDeclineCode('26', 'ADYEN')).toBe('HARD_DECLINE'); // Revocation Of Auth
    expect(classifyDeclineCode('50', 'ADYEN')).toBe('HARD_DECLINE'); // Token Revoked
  });

  it("a Stripe-vocabulary string is NOT treated as hard under Adyen's table — the two PSPs' tables don't cross-contaminate", () => {
    expect(classifyDeclineCode('stolen_card', 'ADYEN')).toBe('RETRYABLE');
    expect(classifyDeclineCode('fraudulent', 'ADYEN')).toBe('RETRYABLE');
  });

  it("an Adyen-vocabulary code is NOT treated as hard under Stripe's table", () => {
    expect(classifyDeclineCode('20', 'STRIPE')).toBe('RETRYABLE');
    expect(classifyDeclineCode('25', 'STRIPE')).toBe('RETRYABLE');
  });

  it('a retryable code stays RETRYABLE regardless of provider', () => {
    expect(classifyDeclineCode('insufficient_funds', 'STRIPE')).toBe('RETRYABLE');
    expect(classifyDeclineCode('12', 'ADYEN')).toBe('RETRYABLE'); // Not enough balance
  });

  it('an absent code, or a code with no known provider, defaults to RETRYABLE — same as before this PSP-vocabulary distinction existed', () => {
    expect(classifyDeclineCode(undefined, 'STRIPE')).toBe('RETRYABLE');
    expect(classifyDeclineCode('stolen_card', undefined)).toBe('RETRYABLE');
    expect(classifyDeclineCode(undefined, undefined)).toBe('RETRYABLE');
  });

  it('PSPs this codebase does not actually integrate (PAYPAL/CHASE) have no calibrated vocabulary — everything is RETRYABLE rather than guessed', () => {
    expect(classifyDeclineCode('stolen_card', 'PAYPAL')).toBe('RETRYABLE');
    expect(classifyDeclineCode('20', 'CHASE')).toBe('RETRYABLE');
  });
});
