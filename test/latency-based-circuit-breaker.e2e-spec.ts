import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
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
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);

    // The slow-call-rate window (RedisCircuitBreakerService's
    // recentCallCount/slowCallCount, 60s TTL) is keyed by provider only,
    // shared across every e2e spec file that hits STRIPE — running as part
    // of the full suite (maxWorkers: 1, no Redis flush between files) means
    // whatever ran in the previous file within the last 60s is still in
    // this window. Without resetting it here, this test's 5 slow calls get
    // diluted by an unknown number of fast calls from prior files and the
    // ratio never crosses SLOW_CALL_RATE_THRESHOLD — confirmed live: this
    // test passes in isolation but failed intermittently as part of the
    // full suite before this reset was added.
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
});
