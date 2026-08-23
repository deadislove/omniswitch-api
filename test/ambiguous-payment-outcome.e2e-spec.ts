import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * End-to-end coverage of the ambiguous-outcome recovery path, using
 * mock-psp's forcetimeoutonce/forcetimeoutalways markers
 * (scripts/mock-psp/server.js) to simulate a PSP call getting no response
 * at all, without waiting out the real 30s adapter timeout. See
 * docs/spec/future/distributed-resilience-and-cde-isolation.md for the
 * full design rationale.
 */
describe('Ambiguous payment outcome recovery (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
  });

  afterAll(async () => {
    await app.close();
  });

  function signedRequest(body: object, idempotencyKey: string) {
    const path = '/api/v1/payments/charge';
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(merchant.hmacSecret, 'post', path, bodyStr);
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', merchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  it('resolves via same-provider idempotency replay: the PSP call is ambiguous once, the automatic retry succeeds, and the charge still completes', async () => {
    const res = await signedRequest(
      {
        amount: 20,
        currency: 'USD',
        paymentMethodId: 'pm_forcetimeoutonce',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      },
      randomUUID(),
    ).expect(201);

    // The first PSP attempt got no response at all — but
    // PaymentProcessorFactory.executeWithFallback's same-provider retry
    // (via the PSP's own idempotency-key replay) resolved it, so this
    // charge is a normal SUCCEEDED, not left ambiguous.
    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.pspTransactionId).toEqual(expect.any(String));
  });

  it('marks the payment AMBIGUOUS (not FAILED) when the retry also gets no response, and preserves the idempotency lock so a client retry replays the SAME payment', async () => {
    const idempotencyKey = randomUUID();
    const chargeBody = {
      amount: 30,
      currency: 'USD',
      paymentMethodId: 'pm_forcetimeoutalways',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    };

    const firstRes = await signedRequest(chargeBody, idempotencyKey).expect(201);

    expect(firstRes.body.status).toBe('AMBIGUOUS');
    expect(firstRes.body.pspTransactionId).toBeUndefined();

    const firstPaymentId = firstRes.body.paymentId;

    // A client retry reusing the same Idempotency-Key must NOT trigger a
    // second saga execution (a second PaymentAggregate row under a new
    // paymentId) — IdempotencyInterceptor should have cached this
    // AMBIGUOUS response the same way it caches a success, precisely
    // because PaymentCheckoutSaga returned normally instead of throwing.
    // Before this fix, throwing here would have wiped the idempotency
    // lock/cache, and this retry would have generated a brand-new
    // paymentId and run the whole saga again.
    const secondRes = await signedRequest(chargeBody, idempotencyKey).expect(201);

    expect(secondRes.body.paymentId).toBe(firstPaymentId);
    expect(secondRes.body.status).toBe('AMBIGUOUS');

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/payments/${firstPaymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(getRes.body.status).toBe('AMBIGUOUS');
  });

  it('never falls back to a different PSP after an ambiguous primary failure, even when a healthy fallback exists', async () => {
    // preferredProvider: 'STRIPE' pins the primary so the fallback (ADYEN)
    // is known and healthy — if executeWithFallback fell back to it after
    // STRIPE's ambiguous failure (the bug this fix closes), ADYEN would
    // process a brand-new charge under an idempotency key it's never seen,
    // succeeding outright. Asserting AMBIGUOUS here (not SUCCEEDED via a
    // fallback) is the actual regression test for that double-charge risk.
    const res = await signedRequest(
      {
        amount: 15,
        currency: 'USD',
        paymentMethodId: 'pm_forcetimeoutalways',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
        preferredProvider: 'STRIPE',
      },
      randomUUID(),
    ).expect(201);

    expect(res.body.status).toBe('AMBIGUOUS');
  });
});
