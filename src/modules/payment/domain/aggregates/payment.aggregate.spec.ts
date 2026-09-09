import { PaymentAggregate } from './payment.aggregate';
import { PaymentStatus } from '../value-objects/payment-status.vo';
import { Money } from '../value-objects/money.vo';

/**
 * PaymentAggregate.declineCategory generalizes
 * Subscription's per-PSP hard-decline classification (see
 * decline-code-classifier.ts) to one-off charges. Covers the specific
 * bug class markFailed()'s pspProvider param was added to prevent: a
 * charge that falls back to a second PSP must be classified against
 * *that* PSP's decline vocabulary, not whichever provider first
 * attempted it (see PaymentCheckoutSaga's own comment at its
 * compensate_markFailed() call site for the fallback scenario this
 * covers).
 */
describe('PaymentAggregate.declineCategory', () => {
  const buildPending = () =>
    PaymentAggregate.reconstitute({
      id: 'pay_decline_test',
      amount: Money.of(20, 'USD'),
      status: PaymentStatus.PENDING,
      idempotencyKey: 'idem_decline_test',
      metadata: { merchantId: 'merchant_test' },
    });

  it('is RETRYABLE before any failure is recorded', () => {
    const payment = buildPending();
    expect(payment.declineCategory).toBe('RETRYABLE');
  });

  it('classifies a hard-decline code against the pspProvider passed to markFailed()', () => {
    const payment = buildPending();
    payment.markFailed('card stolen', 'stolen_card', 'STRIPE');
    expect(payment.declineCategory).toBe('HARD_DECLINE');
    expect(payment.pspProvider).toBe('STRIPE');
  });

  it('a retryable code under the same provider stays RETRYABLE', () => {
    const payment = buildPending();
    payment.markFailed('insufficient funds', 'insufficient_funds', 'STRIPE');
    expect(payment.declineCategory).toBe('RETRYABLE');
  });

  it("classifies against the provider that actually produced the failure, not whichever provider first attempted the charge", () => {
    const payment = PaymentAggregate.reconstitute({
      id: 'pay_decline_fallback',
      amount: Money.of(20, 'USD'),
      status: PaymentStatus.PROCESSING,
      idempotencyKey: 'idem_decline_fallback',
      metadata: { merchantId: 'merchant_test' },
      pspProvider: 'STRIPE', // set by startProcessing() at the first attempt
    });
    // Fallback attempt actually declined on ADYEN with an ADYEN-vocabulary
    // code ('25' = Restricted Card) — markFailed() must override
    // _pspProvider to ADYEN, not classify '25' against Stripe's table
    // (where it would wrongly come back RETRYABLE).
    payment.markFailed('PSP declined', '25', 'ADYEN');
    expect(payment.pspProvider).toBe('ADYEN');
    expect(payment.declineCategory).toBe('HARD_DECLINE');
  });

  it('omitting pspProvider on markFailed() leaves the existing pspProvider untouched', () => {
    const payment = PaymentAggregate.reconstitute({
      id: 'pay_decline_no_override',
      amount: Money.of(20, 'USD'),
      status: PaymentStatus.PROCESSING,
      idempotencyKey: 'idem_decline_no_override',
      metadata: { merchantId: 'merchant_test' },
      pspProvider: 'STRIPE',
    });
    payment.markFailed('card stolen', 'stolen_card');
    expect(payment.pspProvider).toBe('STRIPE');
    expect(payment.declineCategory).toBe('HARD_DECLINE');
  });
});
