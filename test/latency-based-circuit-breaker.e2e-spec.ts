import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { resetCircuitBreakerState } from './utils/circuit-breaker';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Proves the slow-call-rate circuit-breaker trigger
 * (RedisCircuitBreakerService.recordSlowCallSample()) actually opens the
 * circuit against a real, no-shortcuts elapsed-time delay, not just against
 * FakeCachePort's simulated clock in the unit tests — see that method's
 * own docblock for the full design rationale.
 *
 * Deliberately uses real wall-clock delays (mock-psp's `forceslow` marker,
 * scripts/mock-psp/server.js) rather than jest fake timers or a
 * socket-destroy trick like the ambiguous-outcome spec's timeout
 * simulation — the whole point here is that the adapter's real fetch()
 * takes real time and StripePSPAdapter/RedisCircuitBreakerService measure
 * that real elapsed time, so this test takes ~30s+ to run. That's expected,
 * not a bug — do not "fix" it by mocking the delay away.
 */
describe('Latency-based circuit breaker (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;
  let admin: SeededMerchant;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    ({ admin, adminToken } = await seedAdminMerchant(app, uniqueId('admin')));

    // The slow-call-rate window (RedisCircuitBreakerService's
    // recentCallCount/slowCallCount, 60s TTL) is keyed by provider only,
    // shared across every e2e spec file that hits STRIPE — running as part
    // of the full suite (maxWorkers: 1, no Redis flush between files) means
    // whatever ran in the previous file within the last 60s is still in
    // this window. Without resetting it here, this test's 5 slow calls get
    // diluted by an unknown number of fast calls from prior files and the
    // ratio never crosses SLOW_CALL_RATE_THRESHOLD, making this test flaky
    // as part of the full suite even though it's reliable in isolation.
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

  function routingHealth() {
    return request(app.getHttpServer())
      .get('/api/v1/payments/routing/health')
      .set('Authorization', `Bearer ${adminToken}`);
  }

  it(
    '5 real slow-but-successful STRIPE calls open the circuit, and a subsequent charge preferring STRIPE routes to ADYEN instead',
    async () => {
      for (let i = 0; i < 5; i++) {
        const res = await signedCharge({
          amount: 20,
          currency: 'USD',
          paymentMethodId: 'pm_forceslow',
          orderId: uniqueId('order'),
          binInfo: USD_BIN,
          preferredProvider: 'STRIPE',
        }).expect(201);

        // Each call is genuinely slow but still succeeds — this is the
        // exact scenario the sliding-window failure-count trigger can't
        // see at all, since none of these ever throw.
        expect(res.body.status).toBe('SUCCEEDED');
        expect(res.body.pspProvider).toBe('STRIPE');
      }

      const health = await routingHealth().expect(200);
      expect((health.body as Record<string, { circuitBreaker: string }>).STRIPE.circuitBreaker).toBe('OPEN');

      // A fresh charge that still prefers STRIPE must now route to ADYEN —
      // filterAvailableProviders() excludes an OPEN-circuit provider
      // outright, regardless of preferredProvider's +20 score bonus. This
      // is the direct, observable proof that the slow-call-rate trigger
      // isn't just flipping an internal flag nobody reads — it actually
      // changes routing behavior for the next real charge.
      const nextCharge = await signedCharge({
        amount: 10,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
        preferredProvider: 'STRIPE',
      }).expect(201);
      expect(nextCharge.body.pspProvider).toBe('ADYEN');
    },
    60_000,
  );

  it(
    'once the recovery window passes, a fresh charge preferring STRIPE routes back to it — not stuck on ADYEN forever',
    async () => {
      // Self-contained trip, independent of the test above's leftover state.
      await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);

      for (let i = 0; i < 5; i++) {
        await signedCharge({
          amount: 20,
          currency: 'USD',
          paymentMethodId: 'pm_forceslow',
          orderId: uniqueId('order'),
          binInfo: USD_BIN,
          preferredProvider: 'STRIPE',
        }).expect(201);
      }
      const tripped = await routingHealth().expect(200);
      expect((tripped.body as Record<string, { circuitBreaker: string }>).STRIPE.circuitBreaker).toBe('OPEN');

      // Real wall-clock wait past RECOVERY_TIME_MS (30s) — deliberately with
      // no refund/capture call against STRIPE in between. Before this fix,
      // that was the *only* thing that ever moved a stuck OPEN state
      // forward; a plain health check (the routing layer's own read path)
      // never did, so a PSP could stay excluded from all new-charge
      // routing indefinitely past its recovery window.
      await new Promise((resolve) => setTimeout(resolve, 31_000));

      // The health check itself — a pure read, no charge attempted yet —
      // must already report HALF_OPEN. This is the read path the routing
      // filter actually consults; it used to report OPEN forever here.
      const beforeAnyNewCharge = await routingHealth().expect(200);
      expect((beforeAnyNewCharge.body as Record<string, { circuitBreaker: string }>).STRIPE.circuitBreaker).toBe('HALF_OPEN');

      const recovered = await signedCharge({
        amount: 10,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
        preferredProvider: 'STRIPE',
      }).expect(201);
      // Routed to STRIPE directly (not "failed, then fell back") — proves
      // STRIPE re-entered the routing candidate pool on its own.
      expect(recovered.body.pspProvider).toBe('STRIPE');
      expect(recovered.body.usedFallback).toBe(false);

      const closed = await routingHealth().expect(200);
      expect((closed.body as Record<string, { circuitBreaker: string }>).STRIPE.circuitBreaker).toBe('CLOSED');
    },
    90_000,
  );

  it(
    'an operator can force-close a stuck circuit without waiting out the recovery window',
    async () => {
      await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);

      for (let i = 0; i < 5; i++) {
        await signedCharge({
          amount: 20,
          currency: 'USD',
          paymentMethodId: 'pm_forceslow',
          orderId: uniqueId('order'),
          binInfo: USD_BIN,
          preferredProvider: 'STRIPE',
        }).expect(201);
      }
      const tripped = await routingHealth().expect(200);
      expect((tripped.body as Record<string, { circuitBreaker: string }>).STRIPE.circuitBreaker).toBe('OPEN');

      const reset = await request(app.getHttpServer())
        .post('/api/v1/payments/routing/circuit-breaker/STRIPE/reset')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(reset.body.circuitBreaker).toBe('CLOSED');

      // No 30s wait at all — the whole point of the escape hatch.
      const chargeRightAfter = await signedCharge({
        amount: 10,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
        preferredProvider: 'STRIPE',
      }).expect(201);
      expect(chargeRightAfter.body.pspProvider).toBe('STRIPE');
      expect(chargeRightAfter.body.usedFallback).toBe(false);
    },
    60_000,
  );

  it('resetting an unknown provider is rejected with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payments/routing/circuit-breaker/NOT_A_REAL_PSP/reset')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
