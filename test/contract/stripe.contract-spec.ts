import { randomUUID } from 'crypto';
import { StripePSPAdapter } from '../../src/modules/payment/adapters/psp/stripe/stripe-psp.adapter';
import { RedisCircuitBreakerService } from '../../src/modules/payment/adapters/circuit-breaker/redis-circuit-breaker.service';
import { RedisCacheAdapter } from '../../src/modules/payment/adapters/cache/redis-cache.adapter';
import { Money } from '../../src/modules/payment/domain/value-objects/money.vo';
import { EnvConfigService } from './utils/env-config-service';

/**
 * Contract test: StripePSPAdapter against the REAL Stripe test-mode API
 * (`https://api.stripe.com/v1`), not `scripts/mock-psp/server.js`.
 *
 * What this catches that the e2e suite (mock-psp) structurally can't:
 * Stripe changing a response field name, adding a newly-required
 * parameter, deprecating an endpoint this adapter calls, or otherwise
 * drifting from what `StripePSPAdapter`'s parsing code assumes —
 * mock-psp is a hand-maintained approximation of Stripe's API shape, not
 * Stripe itself, so it can only ever be as accurate as whoever last
 * updated it. This suite is what actually verifies the assumption.
 *
 * Skipped entirely unless `STRIPE_CONTRACT_TEST_SECRET_KEY` is set — see
 * docs/technical/contract-testing.md for how to get one (a real Stripe
 * **test-mode** secret key, `sk_test_...` — never a live key) and run
 * this suite. Not part of `npm test`/`npm run test:e2e`/CI: real network
 * calls to a real third party, meaningfully slower and flakier than
 * anything else in this project's test suite, and gated on a credential
 * this repo doesn't have.
 */
const STRIPE_SECRET_KEY = process.env.STRIPE_CONTRACT_TEST_SECRET_KEY;
const describeIfConfigured = STRIPE_SECRET_KEY ? describe : describe.skip;

describeIfConfigured('StripePSPAdapter contract (real Stripe test-mode API)', () => {
  let adapter: StripePSPAdapter;
  let cache: RedisCacheAdapter;

  beforeAll(() => {
    if (STRIPE_SECRET_KEY && !STRIPE_SECRET_KEY.startsWith('sk_test_')) {
      // The one guardrail worth hardcoding: this suite creates and
      // captures real charges. Refusing anything that isn't obviously a
      // test-mode key is cheap insurance against ever running this
      // against a live account by mistake (e.g. a copy-pasted key, or
      // STRIPE_SECRET_KEY vs. STRIPE_CONTRACT_TEST_SECRET_KEY confusion).
      throw new Error(
        'STRIPE_CONTRACT_TEST_SECRET_KEY must be a Stripe TEST-mode key (starts with "sk_test_"). Refusing to run contract tests against what looks like a live key.',
      );
    }
    // StripePSPAdapter reads `STRIPE_SECRET_KEY`/`STRIPE_BASE_URL`, not
    // the *_CONTRACT_TEST_* names — those are namespaced separately so
    // running this suite can never accidentally pick up whatever
    // STRIPE_SECRET_KEY happens to be set to for e2e/local dev (a
    // mock-psp placeholder — see test/setup-env.ts). Bridge explicitly,
    // only inside this suite's own process.
    process.env.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY;
    if (process.env.STRIPE_CONTRACT_TEST_BASE_URL) {
      process.env.STRIPE_BASE_URL = process.env.STRIPE_CONTRACT_TEST_BASE_URL;
    }
    const configService = new EnvConfigService();
    cache = new RedisCacheAdapter(configService as any);
    const circuitBreaker = new RedisCircuitBreakerService(cache);
    adapter = new StripePSPAdapter(configService as any, circuitBreaker);
  });

  afterAll(async () => {
    await (cache as any).onModuleDestroy?.();
  });

  // Stripe's own well-known test PaymentMethod tokens — real, stable
  // constants Stripe documents for exactly this purpose (API testing
  // without Stripe.js/Elements), not this repo's own invention. Same
  // token mock-psp's server.js happens to also treat as "the visa test
  // card", by design — this suite doesn't depend on that coincidence.
  const TEST_PAYMENT_METHOD = 'pm_card_visa';
  const TEST_DECLINED_PAYMENT_METHOD = 'pm_card_chargeDeclined';

  it('charge() with captureMethod "automatic" succeeds and returns a real Stripe PaymentIntent id', async () => {
    const response = await adapter.charge({
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: Money.of(1, 'USD'),
      currency: 'USD',
      merchantId: 'contract-test-merchant',
      paymentMethodId: TEST_PAYMENT_METHOD,
    });

    expect(response.status).toBe('SUCCEEDED');
    expect(response.transactionId).toMatch(/^pi_/);
    expect(response.rawResponse.status).toBe('succeeded');
  });

  it('charge() with captureMethod "manual" authorizes without capturing, then capture() completes it', async () => {
    const chargeResponse = await adapter.charge({
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: Money.of(1, 'USD'),
      currency: 'USD',
      merchantId: 'contract-test-merchant',
      paymentMethodId: TEST_PAYMENT_METHOD,
      captureMethod: 'manual',
    });
    expect(chargeResponse.status).toBe('REQUIRES_CAPTURE');

    const captureResponse = await adapter.capture({
      paymentId: randomUUID(),
      pspTransactionId: chargeResponse.transactionId,
      amount: Money.of(1, 'USD'),
      idempotencyKey: randomUUID(),
    });
    expect(captureResponse.success).toBe(true);
  });

  it('a declined test card resolves as a real Stripe decline, not a thrown/ambiguous error', async () => {
    const response = await adapter.charge({
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: Money.of(1, 'USD'),
      currency: 'USD',
      merchantId: 'contract-test-merchant',
      paymentMethodId: TEST_DECLINED_PAYMENT_METHOD,
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBeTruthy();
  });

  it('refund() against a real captured charge succeeds', async () => {
    const chargeResponse = await adapter.charge({
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: Money.of(2, 'USD'),
      currency: 'USD',
      merchantId: 'contract-test-merchant',
      paymentMethodId: TEST_PAYMENT_METHOD,
    });
    expect(chargeResponse.status).toBe('SUCCEEDED');

    const refundResponse = await adapter.refund({
      paymentId: randomUUID(),
      pspTransactionId: chargeResponse.transactionId,
      refundId: randomUUID(),
      amount: Money.of(2, 'USD'),
      reason: 'requested_by_customer',
      idempotencyKey: randomUUID(),
    });
    expect(refundResponse.success).toBe(true);
    expect(refundResponse.pspRefundId).toMatch(/^re_/);
  });

  it('cancel() against a manually-authorized (not yet captured) charge succeeds', async () => {
    const chargeResponse = await adapter.charge({
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: Money.of(1, 'USD'),
      currency: 'USD',
      merchantId: 'contract-test-merchant',
      paymentMethodId: TEST_PAYMENT_METHOD,
      captureMethod: 'manual',
    });
    expect(chargeResponse.status).toBe('REQUIRES_CAPTURE');

    const cancelResponse = await adapter.cancel({
      paymentId: randomUUID(),
      pspTransactionId: chargeResponse.transactionId,
      idempotencyKey: randomUUID(),
    });
    expect(cancelResponse.success).toBe(true);
  });

  it('verifyPaymentMethod() confirms a real stored payment method off-session, without charging it', async () => {
    const response = await adapter.verifyPaymentMethod({
      paymentMethodId: TEST_PAYMENT_METHOD,
      merchantId: 'contract-test-merchant',
      currency: 'USD',
      idempotencyKey: randomUUID(),
    });

    expect(response.success).toBe(true);
    expect(response.pspVerificationId).toMatch(/^seti_/);
  });

  it('fetchSettlementTransactions() returns real balance-transaction rows for a recent window', async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const until = new Date();

    const transactions = await adapter.fetchSettlementTransactions(since, until);

    // Not asserting a specific count — this Stripe test account's
    // recent history is whatever it is. The contract being verified is
    // "this call succeeds and returns well-formed rows", not a specific
    // number of them.
    expect(Array.isArray(transactions)).toBe(true);
    for (const tx of transactions) {
      expect(typeof tx.pspTransactionId).toBe('string');
      expect(tx.settledAt).toBeInstanceOf(Date);
    }
  });
});
