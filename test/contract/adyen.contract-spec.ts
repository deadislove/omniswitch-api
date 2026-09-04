import { randomUUID } from 'crypto';
import { AdyenPSPAdapter } from '../../src/modules/payment/adapters/psp/adyen/adyen-psp.adapter';
import { RedisCircuitBreakerService } from '../../src/modules/payment/adapters/circuit-breaker/redis-circuit-breaker.service';
import { RedisCacheAdapter } from '../../src/modules/payment/adapters/cache/redis-cache.adapter';
import { Money } from '../../src/modules/payment/domain/value-objects/money.vo';
import { EnvConfigService } from './utils/env-config-service';

/**
 * Contract test: AdyenPSPAdapter against the REAL Adyen test-mode
 * Checkout API (`https://checkout-test.adyen.com/v71` by default), not
 * `scripts/mock-psp/server.js`. See stripe.contract-spec.ts's docblock
 * for why this class of test exists — same reasoning applies here.
 *
 * Unlike Stripe, Adyen has no well-known public test-mode token
 * equivalent to `pm_card_visa` — a `storedPaymentMethodId` has to come
 * from a real tokenization call against your own Adyen test merchant
 * account first (Adyen's `/paymentMethods` or a Drop-in/Components test
 * checkout). `ADYEN_CONTRACT_TEST_STORED_PAYMENT_METHOD_ID` is that
 * token; see docs/technical/contract-testing.md for how to obtain one.
 *
 * Skipped entirely unless `ADYEN_CONTRACT_TEST_API_KEY` is set. Not part
 * of `npm test`/`npm run test:e2e`/CI — same reasons as the Stripe
 * contract suite.
 */
const ADYEN_API_KEY = process.env.ADYEN_CONTRACT_TEST_API_KEY;
const ADYEN_MERCHANT_ACCOUNT = process.env.ADYEN_CONTRACT_TEST_MERCHANT_ACCOUNT;
const ADYEN_STORED_PAYMENT_METHOD_ID = process.env.ADYEN_CONTRACT_TEST_STORED_PAYMENT_METHOD_ID;
const describeIfConfigured = ADYEN_API_KEY ? describe : describe.skip;

describeIfConfigured('AdyenPSPAdapter contract (real Adyen test-mode Checkout API)', () => {
  let adapter: AdyenPSPAdapter;
  let cache: RedisCacheAdapter;

  beforeAll(() => {
    if (!ADYEN_MERCHANT_ACCOUNT || !ADYEN_STORED_PAYMENT_METHOD_ID) {
      throw new Error(
        'ADYEN_CONTRACT_TEST_API_KEY is set but ADYEN_CONTRACT_TEST_MERCHANT_ACCOUNT and/or ' +
          'ADYEN_CONTRACT_TEST_STORED_PAYMENT_METHOD_ID is missing — see docs/technical/contract-testing.md.',
      );
    }
    const baseUrl = process.env.ADYEN_CONTRACT_TEST_BASE_URL ?? 'https://checkout-test.adyen.com/v71';
    if (!baseUrl.includes('-test.adyen.com') && !baseUrl.includes('checkout-test')) {
      // Same guardrail as the Stripe suite's sk_test_ check, adapted to
      // Adyen's naming: refuse anything that doesn't look like Adyen's
      // test environment host, since this suite creates real payments.
      throw new Error(
        `ADYEN_CONTRACT_TEST_BASE_URL ("${baseUrl}") doesn't look like an Adyen TEST environment host. Refusing to run contract tests against what looks like a live endpoint.`,
      );
    }
    // AdyenPSPAdapter reads `ADYEN_API_KEY`/`ADYEN_MERCHANT_ACCOUNT`/
    // `ADYEN_BASE_URL`, not the *_CONTRACT_TEST_* names — see the
    // matching comment in stripe.contract-spec.ts for why the bridge is
    // explicit and scoped to this suite's own process.
    process.env.ADYEN_API_KEY = ADYEN_API_KEY;
    process.env.ADYEN_MERCHANT_ACCOUNT = ADYEN_MERCHANT_ACCOUNT;
    process.env.ADYEN_BASE_URL = baseUrl;
    const configService = new EnvConfigService();
    cache = new RedisCacheAdapter(configService as any);
    const circuitBreaker = new RedisCircuitBreakerService(cache);
    adapter = new AdyenPSPAdapter(configService as any, circuitBreaker);
  });

  afterAll(async () => {
    await (cache as any).onModuleDestroy?.();
  });

  const STORED_PAYMENT_METHOD = ADYEN_STORED_PAYMENT_METHOD_ID as string;

  it('charge() authorizes with a real stored payment method and returns a real Adyen pspReference', async () => {
    const response = await adapter.charge({
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: Money.of(1, 'USD'),
      currency: 'USD',
      merchantId: 'contract-test-merchant',
      paymentMethodId: STORED_PAYMENT_METHOD,
    });

    expect(response.status).toBe('SUCCEEDED');
    expect(typeof response.transactionId).toBe('string');
    expect(response.rawResponse.resultCode).toBe('Authorised');
  });

  it('capture() completes a manually-authorized charge', async () => {
    const chargeResponse = await adapter.charge({
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: Money.of(1, 'USD'),
      currency: 'USD',
      merchantId: 'contract-test-merchant',
      paymentMethodId: STORED_PAYMENT_METHOD,
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

  it('refund() against a real captured charge succeeds', async () => {
    const chargeResponse = await adapter.charge({
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: Money.of(2, 'USD'),
      currency: 'USD',
      merchantId: 'contract-test-merchant',
      paymentMethodId: STORED_PAYMENT_METHOD,
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
    // Adyen refunds are asynchronous — a successful call means the
    // refund request was accepted, not that funds have settled yet. See
    // AdyenPSPAdapter.refund()'s own `status: 'PENDING'` comment.
    expect(refundResponse.success).toBe(true);
    expect(refundResponse.status).toBe('PENDING');
    expect(typeof refundResponse.pspRefundId).toBe('string');
  });

  it('cancel() against a manually-authorized (not yet captured) charge succeeds', async () => {
    const chargeResponse = await adapter.charge({
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      amount: Money.of(1, 'USD'),
      currency: 'USD',
      merchantId: 'contract-test-merchant',
      paymentMethodId: STORED_PAYMENT_METHOD,
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

  it('verifyPaymentMethod() confirms a real stored payment method off-session via a zero-value authorization', async () => {
    const response = await adapter.verifyPaymentMethod({
      paymentMethodId: STORED_PAYMENT_METHOD,
      merchantId: 'contract-test-merchant',
      currency: 'USD',
      idempotencyKey: randomUUID(),
    });

    expect(response.success).toBe(true);
    expect(typeof response.pspVerificationId).toBe('string');
  });

  it('fetchSettlementTransactions() returns real settlement rows for a recent window', async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const until = new Date();

    const transactions = await adapter.fetchSettlementTransactions(since, until);

    expect(Array.isArray(transactions)).toBe(true);
    for (const tx of transactions) {
      expect(typeof tx.pspTransactionId).toBe('string');
      expect(tx.settledAt).toBeInstanceOf(Date);
    }
  });
});
