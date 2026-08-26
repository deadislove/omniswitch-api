import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { resetCircuitBreakerState } from './utils/circuit-breaker';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Proves the per-PSP bulkhead (Semaphore, wired into
 * StripePSPAdapter/AdyenPSPAdapter's makeRequest()) actually bounds
 * concurrent in-flight calls to a PSP, rather than just existing in code
 * with no observable effect — see the bulkhead's own docblock in either
 * adapter for the full design rationale.
 *
 * Deliberately uses real wall-clock delays (mock-psp's `forceslow`
 * marker, the same one Gap 3.2's circuit-breaker test uses) rather than
 * mocking time away — the whole point is to observe real queuing, so
 * this test takes ~12s to run. That's expected, not a bug.
 *
 * PSP_BULKHEAD_MAX_CONCURRENT is set low (3) for this file only.
 * StripePSPAdapter/AdyenPSPAdapter read it fresh in their constructor
 * (not a module-level constant), so setting process.env before
 * createTestApp() boots the app — which is when Nest actually
 * constructs the adapters — is enough; no module-cache tricks needed.
 * Restored in afterAll so it doesn't leak into whichever e2e file runs
 * next in the same process (maxWorkers: 1).
 *
 * The 5 concurrent `forceslow` calls below are also, incidentally,
 * exactly enough real-6-second-slow STRIPE calls to satisfy
 * RedisCircuitBreakerService's independent slow-call-rate trigger
 * (SLOW_CALL_MIN_CALLS=5, 100% slow) — even though every one of them
 * succeeds, this can trip STRIPE's circuit breaker OPEN as a side
 * effect of proving the bulkhead queues. Reset before and after, same
 * reasoning as resetCircuitBreakerState's own docblock: this state is
 * shared Redis state across every e2e file (maxWorkers: 1, no flush
 * between files) — confirmed live as the root cause of
 * chargeWithForcedThreeDS() flakiness in webhooks.e2e-spec.ts and
 * marketplace-split-refunds.e2e-spec.ts when this file ran before them
 * without a reset: STRIPE's leaked OPEN state made their
 * `preferredProvider: 'STRIPE'` override fall through to ADYEN, which
 * doesn't understand the FORCE_3DS mock marker.
 */
describe('PSP bulkhead isolation (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;
  const originalBulkheadEnv = process.env.PSP_BULKHEAD_MAX_CONCURRENT;

  beforeAll(async () => {
    process.env.PSP_BULKHEAD_MAX_CONCURRENT = '3';
    app = await createTestApp();
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  afterAll(async () => {
    // This file's 5 concurrent slow STRIPE calls can trip the slow-call-rate
    // breaker trigger as a side effect (see class docblock) — reset before
    // app.close() so that state doesn't leak into whichever e2e file runs
    // next in the same process (maxWorkers: 1).
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
    await app.close();
    if (originalBulkheadEnv === undefined) {
      delete process.env.PSP_BULKHEAD_MAX_CONCURRENT;
    } else {
      process.env.PSP_BULKHEAD_MAX_CONCURRENT = originalBulkheadEnv;
    }
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
    '5 concurrent slow STRIPE calls against a bulkhead of 3 take meaningfully longer than 1 batch — the 4th and 5th queue for a permit',
    async () => {
      const start = Date.now();

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          signedCharge({
            amount: 20,
            currency: 'USD',
            paymentMethodId: 'pm_forceslow',
            orderId: uniqueId('order'),
            binInfo: USD_BIN,
            preferredProvider: 'STRIPE',
          }),
        ),
      );

      const elapsedMs = Date.now() - start;

      for (const res of results) {
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('SUCCEEDED');
        expect(res.body.pspProvider).toBe('STRIPE');
      }

      // Unbounded, all 5 would finish in ~1 mock-psp delay (~6s). Bounded
      // to 3 concurrent, the 4th/5th have to wait for a permit freed by
      // one of the first 3 — pushing this well past a single 6s delay.
      // 10s is a conservative floor (2 delay-lengths minus scheduling
      // slop), not a tight bound on the exact queuing math.
      expect(elapsedMs).toBeGreaterThan(10_000);
    },
    20_000,
  );
});
