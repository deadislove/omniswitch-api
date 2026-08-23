import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { resetCircuitBreakerState } from './utils/circuit-breaker';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * End-to-end coverage of the transient-PSP-error retry path
 * (PaymentProcessorFactory.isTransientPspError()) — a PSP's own 5xx
 * response gets one same-provider retry before falling back, the same
 * idempotency-key-replay safety margin the ambiguous-outcome path uses,
 * but for a genuinely different failure class (a response WAS received).
 * See docs/spec/future/distributed-resilience-and-cde-isolation.md
 * (§1, Gap 1.1) for the full design rationale.
 *
 * Uses mock-psp's forceservererroronce/forceservererroralways markers
 * (scripts/mock-psp/server.js) — a synchronous 500 response, no real
 * delay involved, unlike the timeout/slow-call markers elsewhere in
 * this suite.
 */
describe('PSP transient server error retry (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  afterAll(async () => {
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
    await app.close();
  });

  function signedCharge(body: object) {
    const path = '/api/v1/payments/charge';
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(merchant.hmacSecret, 'post', path, bodyStr);
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', merchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  it('STRIPE returns one transient 5xx, the automatic same-provider retry succeeds, and the charge still completes on STRIPE', async () => {
    const res = await signedCharge({
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_forceservererroronce',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.pspProvider).toBe('STRIPE');
  });

  it('STRIPE returns a transient 5xx on both the primary attempt and the retry, so it falls back to ADYEN and still succeeds', async () => {
    // mock-psp's marker is keyed by idempotency key regardless of which
    // adapter is calling (see shouldForceServerError's docblock) — the
    // same-provider retry and the fallback-to-ADYEN attempt all reuse
    // this charge's one idempotency key, so "twice" means "STRIPE's
    // primary attempt and its retry," leaving the ADYEN fallback
    // attempt (the 3rd call) to succeed normally.
    const res = await signedCharge({
      amount: 25,
      currency: 'USD',
      paymentMethodId: 'pm_forceservererrortwice',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);

    // Confirmed non-ambiguous failure after the retry (a real 5xx both
    // times, not a lost response) — safe to fall back, unlike the
    // ambiguous-outcome path, which must never fall back.
    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.pspProvider).toBe('ADYEN');
  });
});
