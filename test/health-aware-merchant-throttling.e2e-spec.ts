import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { resetCircuitBreakerState } from './utils/circuit-breaker';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Proves DegradedPspAwareThrottlerGuard actually lowers a merchant's
 * charge-rate ceiling once their recent charges are concentrated on a PSP
 * that is currently OPEN — and that this is scoped to that merchant's own
 * exposure, not a platform-wide slowdown. See
 * docs/spec/future/distributed-resilience-and-cde-isolation.md for the
 * full design rationale (including why "protect the merchant" was chosen
 * over "protect the platform").
 */
describe('Health-aware merchant throttling (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;
  let admin: SeededMerchant;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);

    // The circuit-breaker window is shared Redis state across every e2e
    // file (maxWorkers: 1, no flush between files), so reset it here
    // rather than assume a clean window.
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  afterAll(async () => {
    // This test deliberately trips STRIPE's circuit OPEN — reset it so
    // that state doesn't leak into whichever e2e file runs next.
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

  it(
    'once this merchant is exposed to a degraded STRIPE, their subsequent charges hit a stricter limit than the base per-merchant ceiling',
    async () => {
      // Build STRIPE routing history for this merchant — 3 genuine
      // successes, meeting MerchantPspExposureService's minimum sample
      // size, all while STRIPE is still healthy.
      // 17 successful STRIPE charges — not just enough to meet
      // MerchantPspExposureService's minimum sample size, but enough that
      // the *shared* per-merchant throttle counter (every request counts
      // against it, success or not) is already close to
      // DEGRADED_MERCHANT_CHARGE_RATE_LIMIT_MAX's default (20) by the time
      // exposure kicks in below. This matters: each charge fired *after*
      // exposure starts also gets recorded (even the ones that succeed via
      // ADYEN's healthy fallback), which dilutes the STRIPE concentration
      // ratio back down — with only a couple of exposed-and-throttled
      // requests available before dilution turns exposure back off, the
      // counter needs to already be near the ceiling going in, not build
      // up to it gradually while exposed.
      for (let i = 0; i < 17; i++) {
        const res = await signedCharge({
          amount: 10,
          currency: 'USD',
          paymentMethodId: 'pm_card_visa',
          orderId: uniqueId('order'),
          binInfo: USD_BIN,
          preferredProvider: 'STRIPE',
        }).expect(201);
        expect(res.body.pspProvider).toBe('STRIPE');
      }

      // Trip STRIPE's circuit breaker via the ambiguous-outcome path
      // (real thrown failures, not the slow-call path — no need to wait
      // out a real 5s+ delay here). Each forcetimeoutalways attempt tries
      // STRIPE, retries STRIPE once more (both ambiguous), then gives up
      // without falling back — two recordFailure() calls per attempt, so
      // 3 attempts comfortably clears FAILURE_THRESHOLD (5). These also
      // count toward the shared throttle counter (20 total requests so
      // far, right at the degraded ceiling) without touching
      // MerchantPspExposureService (recordRouting() is only reached on
      // success, and these all end AMBIGUOUS).
      for (let i = 0; i < 3; i++) {
        await signedCharge({
          amount: 15,
          currency: 'USD',
          paymentMethodId: 'pm_forcetimeoutalways',
          orderId: uniqueId('order'),
          binInfo: USD_BIN,
          preferredProvider: 'STRIPE',
        }).expect(201); // saga returns AMBIGUOUS normally, not a thrown error
      }

      const health = await request(app.getHttpServer())
        .get('/api/v1/payments/routing/health')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((health.body as Record<string, { circuitBreaker: string }>).STRIPE.circuitBreaker).toBe('OPEN');

      // The throttle counter is already at 20 (17 + 3 above); this
      // merchant's routing history is still 100% STRIPE, well past
      // MerchantPspExposureService's concentration threshold, so this one
      // next request should get DEGRADED_MERCHANT_CHARGE_RATE_LIMIT_MAX's
      // stricter ceiling applied and be rejected — proof the guard is
      // actually lowering the limit, not just computing exposure and
      // discarding it. Under the base per-merchant ceiling
      // (CHARGE_RATE_LIMIT_MAX's e2e-test value, 2000) this would sail
      // through instead.
      const throttledRes = await signedCharge({
        amount: 5,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      });
      expect(throttledRes.status).toBe(429);
    },
    30_000,
  );
});
