import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';

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

    it('refunding more than the remaining balance is rejected with 409, not sent to the PSP', async () => {
      const payment = await charge({ amount: 50 });

      await signedRequest('post', `/api/v1/payments/${payment.paymentId}/refund`, {
        amount: 999,
      })
        .expect(409)
        .expect((res) => expect(res.body.code).toBe('REFUND_EXCEEDS_BALANCE'));
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
