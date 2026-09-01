import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook } from './utils/signing';
import { StripePSPAdapter } from '../src/modules/payment/adapters/psp/stripe/stripe-psp.adapter';
import { PaymentLifecycleService } from '../src/modules/payment/application/services/payment-lifecycle.service';

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const EU_BIN = { bin: '491761', country: 'DE', cardBrand: 'VISA', cardType: 'CREDIT' };

describe('Payments: charge / refund / capture / cancel (e2e)', () => {
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

  /** Signs and sends a request the same way HmacSignatureGuard expects it. */
  function signedRequest(method: 'post', path: string, body: object, hmacSecret = merchant.hmacSecret) {
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(hmacSecret, method, path, bodyStr);
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', merchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  describe('POST /payments/charge', () => {
    it('rejects a request with no HMAC signature', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/payments/charge')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amount: 10, currency: 'USD', orderId: uniqueId('order') })
        .expect(401);
    });

    it('rejects a request signed with the wrong HMAC secret', async () => {
      await signedRequest(
        'post',
        '/api/v1/payments/charge',
        { amount: 10, currency: 'USD', orderId: uniqueId('order'), binInfo: USD_BIN },
        'completely-wrong-secret-that-is-still-32-chars',
      ).expect(401);
    });

    it('rejects a cardToken that looks like a raw card number (PCI defense-in-depth)', async () => {
      await signedRequest('post', '/api/v1/payments/charge', {
        amount: 10,
        currency: 'USD',
        cardToken: '4242-4242-4242-4242',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(422);
    });

    it('charges successfully (automatic capture) and the payment is retrievable', async () => {
      const res = await signedRequest('post', '/api/v1/payments/charge', {
        amount: 25.5,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(201);

      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.body.pspTransactionId).toEqual(expect.any(String));

      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/payments/${res.body.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.status).toBe('SUCCEEDED');
      expect(getRes.body.amount).toBe(25.5);
    });

    // Regression test for a fixed bug: a European card used to trip a
    // pre-emptive risk-score check that put the payment into
    // REQUIRES_ACTION *without ever calling the PSP* — no pspTransactionId,
    // permanently unresolvable by any webhook. The PSP (mock-psp) is now
    // always actually called, and it simulates real SCA enforcement for
    // European cards (see scripts/mock-psp/server.js's EU_COUNTRIES check) —
    // so this asserts a real, trackable pspTransactionId comes back, not a
    // fabricated 3ds.omniswitch.io URL.
    it('a high-value European card gets a real, PSP-issued 3DS challenge — not a pre-emptive fake redirect', async () => {
      const res = await signedRequest('post', '/api/v1/payments/charge', {
        amount: 15000,
        currency: 'EUR',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: EU_BIN,
      }).expect(201);

      expect(res.body.status).toBe('REQUIRES_ACTION');
      expect(res.body.requiresAction).toBe(true);
      expect(res.body.pspTransactionId).toEqual(expect.any(String));
      expect(res.body.actionUrl).not.toContain('3ds.omniswitch.io');
      expect(res.body.actionUrl).toContain(res.body.pspTransactionId);
    });

    it('captureMethod: manual leaves the payment REQUIRES_CAPTURE, not charged yet', async () => {
      const res = await signedRequest('post', '/api/v1/payments/charge', {
        amount: 40,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        captureMethod: 'manual',
        binInfo: USD_BIN,
      }).expect(201);

      expect(res.body.status).toBe('REQUIRES_CAPTURE');
    });

    it('two different merchants using the identical Idempotency-Key must not collide', async () => {
      const otherMerchant = await seedMerchant(app, { merchantId: uniqueId('other') });
      const otherToken = await login(app, otherMerchant.apiKeyId, otherMerchant.apiKeySecret);
      const sharedIdempotencyKey = randomUUID();

      const bodyA = { amount: 10, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN };
      const { signature: sigA, timestamp: tsA } = signHmacRequest(merchant.hmacSecret, 'post', '/api/v1/payments/charge', JSON.stringify(bodyA));
      const resA = await request(app.getHttpServer())
        .post('/api/v1/payments/charge')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', sharedIdempotencyKey)
        .set('X-Signature', sigA)
        .set('X-Timestamp', tsA)
        .set('X-Merchant-Id', merchant.merchantId)
        .set('Content-Type', 'application/json')
        .send(bodyA)
        .expect(201);

      const bodyB = { amount: 77, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN };
      const { signature: sigB, timestamp: tsB } = signHmacRequest(otherMerchant.hmacSecret, 'post', '/api/v1/payments/charge', JSON.stringify(bodyB));
      const resB = await request(app.getHttpServer())
        .post('/api/v1/payments/charge')
        .set('Authorization', `Bearer ${otherToken}`)
        .set('Idempotency-Key', sharedIdempotencyKey)
        .set('X-Signature', sigB)
        .set('X-Timestamp', tsB)
        .set('X-Merchant-Id', otherMerchant.merchantId)
        .set('Content-Type', 'application/json')
        .send(bodyB)
        .expect(201);

      // Merchant B must get its own independent charge — not merchant A's
      // cached response replayed back to it because the Idempotency-Key
      // happened to collide across tenants.
      expect(resB.body.paymentId).not.toBe(resA.body.paymentId);

      const fetchedB = await request(app.getHttpServer())
        .get(`/api/v1/payments/${resB.body.paymentId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(200);
      expect(fetchedB.body.amount).toBe(77);
    });

    it('a different merchant cannot read this merchant\'s payment', async () => {
      const chargeRes = await signedRequest('post', '/api/v1/payments/charge', {
        amount: 12,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(201);

      const otherMerchant = await seedMerchant(app, { merchantId: uniqueId('other') });
      const otherToken = await login(app, otherMerchant.apiKeyId, otherMerchant.apiKeySecret);

      await request(app.getHttpServer())
        .get(`/api/v1/payments/${chargeRes.body.paymentId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);
    });
  });

  describe('Refund / Capture / Cancel lifecycle', () => {
    async function charge(overrides: Record<string, unknown> = {}) {
      const res = await signedRequest('post', '/api/v1/payments/charge', {
        amount: 100,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
        ...overrides,
      }).expect(201);
      return res.body;
    }

    it('capture completes a REQUIRES_CAPTURE payment', async () => {
      const payment = await charge({ captureMethod: 'manual' });
      expect(payment.status).toBe('REQUIRES_CAPTURE');

      const captureRes = await signedRequest('post', `/api/v1/payments/${payment.paymentId}/capture`, {}).expect(
        200,
      );
      expect(captureRes.body.status).toBe('SUCCEEDED');
    });

    it('capturing a payment that is not REQUIRES_CAPTURE returns 409', async () => {
      const payment = await charge(); // automatic capture -> already SUCCEEDED
      await signedRequest('post', `/api/v1/payments/${payment.paymentId}/capture`, {}).expect(409);
    });

    it('multiple partial captures against one authorization: PARTIALLY_CAPTURED, then SUCCEEDED once the full amount is captured', async () => {
      const payment = await charge({ amount: 100, captureMethod: 'manual' });
      expect(payment.status).toBe('REQUIRES_CAPTURE');

      const first = await signedRequest('post', `/api/v1/payments/${payment.paymentId}/capture`, {
        amount: 30,
      }).expect(200);
      expect(first.body.status).toBe('PARTIALLY_CAPTURED');
      expect(first.body.totalCaptured).toBe(30);
      expect(first.body.remainingCapturable).toBe(70);
      expect(first.body.captures).toHaveLength(1);

      // A second partial capture is accepted — this is exactly what used to
      // be impossible: any capture at all used to flip status to SUCCEEDED
      // and permanently block ever capturing the remainder.
      const second = await signedRequest('post', `/api/v1/payments/${payment.paymentId}/capture`, {
        amount: 25,
      }).expect(200);
      expect(second.body.status).toBe('PARTIALLY_CAPTURED');
      expect(second.body.totalCaptured).toBe(55);
      expect(second.body.remainingCapturable).toBe(45);
      expect(second.body.captures).toHaveLength(2);

      // Omitting `amount` on the final call captures whatever's left, not
      // the original full amount (which would over-capture).
      const final = await signedRequest('post', `/api/v1/payments/${payment.paymentId}/capture`, {}).expect(200);
      expect(final.body.status).toBe('SUCCEEDED');
      expect(final.body.totalCaptured).toBe(100);
      expect(final.body.remainingCapturable).toBe(0);
      expect(final.body.captures).toHaveLength(3);

      // Fully captured — no more capturing possible.
      await signedRequest('post', `/api/v1/payments/${payment.paymentId}/capture`, {}).expect(409);

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(fetched.body.status).toBe('SUCCEEDED');
      expect(fetched.body.captures).toHaveLength(3);
    });

    it('two concurrent partial captures on the same authorization: the loser gets rejected, not a silently dropped captures[] entry', async () => {
      // A real HTTP-level Promise.all([...]) isn't a reliable way to
      // reproduce this race: in practice the two requests' DB writes don't
      // land close enough together to overlap (the second one's read
      // already observes the first's commit), so this drives the
      // interleaving directly instead — two independent in-memory copies
      // of the *same* pre-capture row, exactly what two truly concurrent
      // requests would each hold right after their own read.
      const payment = await charge({ amount: 100, captureMethod: 'manual' });
      expect(payment.status).toBe('REQUIRES_CAPTURE');

      const lifecycleService: PaymentLifecycleService = app.get(PaymentLifecycleService);
      const [copy1, copy2] = await Promise.all([
        lifecycleService.getOwnedPayment(payment.paymentId),
        lifecycleService.getOwnedPayment(payment.paymentId),
      ]);

      const results = await Promise.allSettled([
        lifecycleService.capture({ payment: copy1, amount: 30, idempotencyKey: randomUUID() }),
        lifecycleService.capture({ payment: copy2, amount: 25, idempotencyKey: randomUUID() }),
      ]);

      // Exactly one of the two concurrent calls must lose the race — both
      // succeeding would mean the second write silently overwrote the
      // first's captures[] entry instead of being rejected.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.response.code).toBe('CONCURRENT_MODIFICATION');

      const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
      expect(winner.captures).toHaveLength(1);
      expect(winner.status).toBe('PARTIALLY_CAPTURED');

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(fetched.body.captures).toHaveLength(1);
    });

    it('a capture request exceeding the remaining capturable amount is rejected with 409, not silently over-captured', async () => {
      const payment = await charge({ amount: 50, captureMethod: 'manual' });

      await signedRequest('post', `/api/v1/payments/${payment.paymentId}/capture`, { amount: 30 }).expect(200);

      // Only $20 remains capturable; asking for $30 more must be rejected,
      // not clamped or partially honored.
      const res = await signedRequest('post', `/api/v1/payments/${payment.paymentId}/capture`, {
        amount: 30,
      }).expect(409);
      expect(res.body.code).toBe('CAPTURE_EXCEEDS_AUTHORIZATION');
    });

    it('cancel releases a REQUIRES_CAPTURE payment, and re-cancelling is idempotent', async () => {
      const payment = await charge({ captureMethod: 'manual' });

      await signedRequest('post', `/api/v1/payments/${payment.paymentId}/cancel`, {})
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('CANCELLED'));

      // Idempotent re-cancel — still 200, still CANCELLED.
      await signedRequest('post', `/api/v1/payments/${payment.paymentId}/cancel`, {})
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('CANCELLED'));

      // Cancelled payments can't be captured.
      await signedRequest('post', `/api/v1/payments/${payment.paymentId}/capture`, {}).expect(409);
    });

    it('partial refund, then full refund of the remainder', async () => {
      const payment = await charge({ amount: 100 });

      const partial = await signedRequest('post', `/api/v1/payments/${payment.paymentId}/refund`, {
        amount: 40,
        reason: 'customer_request',
      }).expect(200);
      expect(partial.body.status).toBe('PARTIALLY_REFUNDED');
      expect(partial.body.remainingRefundable).toBe(60);

      const full = await signedRequest('post', `/api/v1/payments/${payment.paymentId}/refund`, {
        amount: 60,
      }).expect(200);
      expect(full.body.status).toBe('REFUNDED');
      expect(full.body.remainingRefundable).toBe(0);
    });

    it('two concurrent partial refunds on the same payment: the loser gets rejected, not a silently dropped refunds[] entry', async () => {
      // See the matching capture test above for why this drives the
      // interleaving directly via two pre-fetched in-memory copies rather
      // than a real HTTP-level Promise.all([...]).
      const payment = await charge({ amount: 100 });

      const lifecycleService: PaymentLifecycleService = app.get(PaymentLifecycleService);
      const [copy1, copy2] = await Promise.all([
        lifecycleService.getOwnedPayment(payment.paymentId),
        lifecycleService.getOwnedPayment(payment.paymentId),
      ]);

      const results = await Promise.allSettled([
        lifecycleService.refund({ payment: copy1, amount: 40, idempotencyKey: randomUUID() }),
        lifecycleService.refund({ payment: copy2, amount: 25, idempotencyKey: randomUUID() }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.response.code).toBe('CONCURRENT_MODIFICATION');

      const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
      expect(winner.refunds).toHaveLength(1);
      expect(winner.status).toBe('PARTIALLY_REFUNDED');

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(fetched.body.refunds).toHaveLength(1);
    });

    it('refunding more than the remaining balance is rejected with 409, not sent to the PSP', async () => {
      const payment = await charge({ amount: 50 });

      await signedRequest('post', `/api/v1/payments/${payment.paymentId}/refund`, {
        amount: 999,
      })
        .expect(409)
        .expect((res) => expect(res.body.code).toBe('REFUND_EXCEEDS_BALANCE'));
    });

    it('refunding a DISPUTED payment is rejected with 409, not sent to the PSP', async () => {
      const payment = await charge({ amount: 75, preferredProvider: 'STRIPE' });

      const disputeBody = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_' + uniqueId('test'), payment_intent: payment.pspTransactionId, reason: 'fraudulent' } },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, disputeBody))
        .set('Content-Type', 'application/json')
        .send(disputeBody)
        .expect(200);

      const disputed = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(disputed.body.status).toBe('DISPUTED');

      // The actual regression this guards against: a status check that
      // only fires *after* the PSP has already been called would make
      // this spy record a call even though the HTTP response is (or
      // should be) a 409 — asserting on the response status alone isn't
      // enough to catch that ordering bug.
      const refundSpy = jest.spyOn(app.get(StripePSPAdapter), 'refund');
      try {
        await signedRequest('post', `/api/v1/payments/${payment.paymentId}/refund`, {
          amount: 75,
        })
          .expect(409)
          .expect((res) => expect(res.body.code).toBe('NOT_REFUNDABLE'));
        expect(refundSpy).not.toHaveBeenCalled();
      } finally {
        refundSpy.mockRestore();
      }
    });

    it('a different merchant cannot refund/capture/cancel this payment', async () => {
      const payment = await charge();

      const otherMerchant = await seedMerchant(app, { merchantId: uniqueId('other') });
      const otherToken = await login(app, otherMerchant.apiKeyId, otherMerchant.apiKeySecret);
      const bodyStr = JSON.stringify({ amount: 1 });
      const { signature, timestamp } = signHmacRequest(
        otherMerchant.hmacSecret,
        'post',
        `/api/v1/payments/${payment.paymentId}/refund`,
        bodyStr,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/payments/${payment.paymentId}/refund`)
        .set('Authorization', `Bearer ${otherToken}`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Signature', signature)
        .set('X-Timestamp', timestamp)
        .set('X-Merchant-Id', otherMerchant.merchantId)
        .set('Content-Type', 'application/json')
        .send({ amount: 1 })
        .expect(403);
    });
  });
});
