import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook, signAdyenNotification } from './utils/signing';
import { LedgerOutboxEntity } from '../src/modules/payment/adapters/persistence/entities/ledger-outbox.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
// Matches test/setup-env.ts's default; overridden if the real env sets one.
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const ADYEN_HMAC_KEY = process.env.ADYEN_HMAC_KEY!;

describe('Webhooks: Stripe & Adyen (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;
  let admin: SeededMerchant;
  let adminToken: string;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);
  });

  afterAll(async () => {
    await app.close();
  });

  async function chargeWithForcedThreeDS() {
    // scripts/mock-psp/server.js returns `requires_action` when the
    // description contains this marker (or, more realistically, whenever
    // binCountry is European — see PaymentCheckoutSaga's docblock). Either
    // way the PSP is always actually called now, so this returns a real
    // pspTransactionId — required for a webhook to resolve it later.
    const bodyObj = {
      amount: 30,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      description: 'FORCE_3DS e2e test',
      binInfo: USD_BIN,
    };
    const bodyStr = JSON.stringify(bodyObj);
    const { signature, timestamp } = signHmacRequest(merchant.hmacSecret, 'post', '/api/v1/payments/charge', bodyStr);

    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/charge')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', merchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(bodyObj)
      .expect(201);

    expect(res.body.status).toBe('REQUIRES_ACTION');
    expect(res.body.pspTransactionId).toEqual(expect.any(String));
    return res.body;
  }

  async function chargeImmediate(amount = 50) {
    const bodyObj = {
      amount,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    };
    const bodyStr = JSON.stringify(bodyObj);
    const { signature, timestamp } = signHmacRequest(merchant.hmacSecret, 'post', '/api/v1/payments/charge', bodyStr);

    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/charge')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', merchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(bodyObj)
      .expect(201);

    expect(res.body.status).toBe('SUCCEEDED');
    return res.body;
  }

  describe('POST /webhooks/stripe', () => {
    it('rejects a request with no Stripe-Signature header', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .send({ type: 'payment_intent.succeeded' })
        .expect(401);
    });

    it('rejects an invalid signature', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`)
        .send({ type: 'payment_intent.succeeded' })
        .expect(401);
    });

    it('a correctly-signed payment_intent.succeeded resolves a REQUIRES_ACTION payment to SUCCEEDED', async () => {
      const payment = await chargeWithForcedThreeDS();

      const body = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'payment_intent.succeeded',
        data: { object: { id: payment.pspTransactionId, status: 'succeeded' } },
      });
      const signature = signStripeWebhook(STRIPE_WEBHOOK_SECRET, body);

      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signature)
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);

      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.status).toBe('SUCCEEDED');
    });

    it('redelivering the same webhook is idempotent (no error, no duplicate effect)', async () => {
      const payment = await chargeWithForcedThreeDS();
      const body = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'payment_intent.succeeded',
        data: { object: { id: payment.pspTransactionId, status: 'succeeded' } },
      });
      const signature = signStripeWebhook(STRIPE_WEBHOOK_SECRET, body);

      for (let i = 0; i < 2; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/webhooks/stripe')
          .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, body))
          .set('Content-Type', 'application/json')
          .send(body)
          .expect(200);
      }

      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.status).toBe('SUCCEEDED');
    });
  });

  describe('POST /webhooks/adyen', () => {
    it('rejects a notification item with no hmacSignature', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/adyen')
        .send({
          notificationItems: [
            {
              NotificationRequestItem: {
                pspReference: 'psp_test',
                merchantAccountCode: 'Test',
                merchantReference: 'ref',
                amount: { value: 100, currency: 'USD' },
                eventCode: 'AUTHORISATION',
                success: 'true',
              },
            },
          ],
        })
        .expect(401);
    });

    it('a correctly-signed AUTHORISATION notification resolves a REQUIRES_ACTION payment to SUCCEEDED', async () => {
      const payment = await chargeWithForcedThreeDS();

      const fields = {
        pspReference: payment.pspTransactionId,
        merchantAccountCode: 'TestMerchant',
        merchantReference: payment.paymentId,
        amountValue: 3000,
        amountCurrency: 'USD',
        eventCode: 'AUTHORISATION',
        success: 'true',
      };
      const hmacSignature = signAdyenNotification(ADYEN_HMAC_KEY, fields);

      await request(app.getHttpServer())
        .post('/api/v1/webhooks/adyen')
        .send({
          notificationItems: [
            {
              NotificationRequestItem: {
                pspReference: fields.pspReference,
                merchantAccountCode: fields.merchantAccountCode,
                merchantReference: fields.merchantReference,
                amount: { value: fields.amountValue, currency: fields.amountCurrency },
                eventCode: fields.eventCode,
                success: fields.success,
                additionalData: { hmacSignature },
              },
            },
          ],
        })
        .expect(200);

      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.status).toBe('SUCCEEDED');
    });
  });

  describe('Disputes: creation, evidence, resolution', () => {
    it('a rejects a non-admin caller on the disputes admin API', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('a Stripe charge.dispute.created webhook creates a Dispute record and moves the payment to DISPUTED; redelivery is idempotent', async () => {
      const payment = await chargeImmediate(75);
      const disputeId = 'dp_' + uniqueId('test');

      const body = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'charge.dispute.created',
        data: { object: { id: disputeId, payment_intent: payment.pspTransactionId, reason: 'fraudulent' } },
      });

      for (let i = 0; i < 2; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/webhooks/stripe')
          .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, body))
          .set('Content-Type', 'application/json')
          .send(body)
          .expect(200);
      }

      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.status).toBe('DISPUTED');

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ merchantId: merchant.merchantId })
        .expect(200);
      const matching = listRes.body.filter((d: any) => d.paymentId === payment.paymentId);
      // Exactly one, not two — proves the redelivered webhook didn't create a duplicate.
      expect(matching).toHaveLength(1);
      expect(matching[0].status).toBe('NEEDS_RESPONSE');
      expect(matching[0].amount).toBe(75);
      expect(matching[0].reason).toBe('fraudulent');
      expect(new Date(matching[0].respondBy).getTime()).toBeGreaterThan(Date.now());

      return { payment, disputeId, disputeRecordId: matching[0].id };
    });

    it('submitting evidence moves a dispute to UNDER_REVIEW, calling the PSP', async () => {
      const payment = await chargeImmediate(60);
      const disputeId = 'dp_' + uniqueId('test');
      // 'unrecognized' is deliberately not one of dispute-policy.ts's
      // auto-contestable reasons (see test/dispute-policy.e2e-spec.ts for
      // that behavior) — this test is specifically about the *manual*
      // evidence-submission path staying available, so the dispute needs
      // to land at NEEDS_RESPONSE, not get auto-contested (and moved to
      // UNDER_REVIEW) before this test ever gets to call the endpoint.
      const body = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'charge.dispute.created',
        data: { object: { id: disputeId, payment_intent: payment.pspTransactionId, reason: 'unrecognized' } },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, body))
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ merchantId: merchant.merchantId })
        .expect(200);
      const disputeRecordId = listRes.body.find((d: any) => d.paymentId === payment.paymentId).id;

      const evidenceRes = await request(app.getHttpServer())
        .post(`/api/v1/admin/disputes/${disputeRecordId}/evidence`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ evidence: 'Tracking number 1Z999 shows delivery confirmed on the customer\'s doorstep.' })
        .expect(200);
      expect(evidenceRes.body.status).toBe('UNDER_REVIEW');

      // Can't submit evidence twice.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/disputes/${disputeRecordId}/evidence`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ evidence: 'more evidence' })
        .expect(409);
    });

    it('a charge.dispute.closed webhook with status=won resolves the dispute and returns the payment to SUCCEEDED', async () => {
      const payment = await chargeImmediate(40);
      const disputeId = 'dp_' + uniqueId('test');
      const createBody = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'charge.dispute.created',
        data: { object: { id: disputeId, payment_intent: payment.pspTransactionId, reason: 'fraudulent' } },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, createBody))
        .set('Content-Type', 'application/json')
        .send(createBody)
        .expect(200);

      const closeBody = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'charge.dispute.closed',
        data: { object: { id: disputeId, status: 'won' } },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, closeBody))
        .set('Content-Type', 'application/json')
        .send(closeBody)
        .expect(200);

      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.status).toBe('SUCCEEDED');

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ merchantId: merchant.merchantId })
        .expect(200);
      expect(listRes.body.find((d: any) => d.paymentId === payment.paymentId).status).toBe('WON');
    });

    it('a charge.dispute.closed webhook with status=lost moves the payment to REFUNDED and books a ledger entry', async () => {
      const payment = await chargeImmediate(45);
      const disputeId = 'dp_' + uniqueId('test');
      const createBody = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'charge.dispute.created',
        data: { object: { id: disputeId, payment_intent: payment.pspTransactionId, reason: 'fraudulent' } },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, createBody))
        .set('Content-Type', 'application/json')
        .send(createBody)
        .expect(200);

      // Forced onto master, not the ambient replica-routed connection
      // (app.module.ts's `replication` config) — this is a
      // before/after count straddling two writes, each exposed to the
      // replica's ~1s streaming lag (see reserve.service.ts's release()
      // and test/ledger-and-outbox.e2e-spec.ts for the same issue
      // confirmed live elsewhere).
      const countOnMaster = async (paymentId: string) => {
        const queryRunner = dataSource.createQueryRunner('master');
        try {
          return await queryRunner.manager.count(LedgerOutboxEntity, { where: { paymentId } });
        } finally {
          await queryRunner.release();
        }
      };
      const entriesBeforeResolution = await countOnMaster(payment.paymentId);

      const closeBody = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'charge.dispute.closed',
        data: { object: { id: disputeId, status: 'lost' } },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, closeBody))
        .set('Content-Type', 'application/json')
        .send(closeBody)
        .expect(200);

      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.status).toBe('REFUNDED');

      const entriesAfterResolution = await countOnMaster(payment.paymentId);
      // The original charge entry, plus a new one for the lost-dispute payout.
      expect(entriesAfterResolution).toBe(entriesBeforeResolution + 1);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ merchantId: merchant.merchantId })
        .expect(200);
      expect(listRes.body.find((d: any) => d.paymentId === payment.paymentId).status).toBe('LOST');
    });

    it('Adyen NOTIFICATION_OF_CHARGEBACK creates a dispute, and CHARGEBACK_REVERSED resolves it WON', async () => {
      // Forced to Adyen (preferredProvider) rather than relying on smart
      // routing's default US-card-prefers-Stripe behavior — this test is
      // specifically about Adyen's chargeback event shape.
      const bodyObj = {
        amount: 55,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
        preferredProvider: 'ADYEN',
      };
      const bodyStr = JSON.stringify(bodyObj);
      const { signature, timestamp } = signHmacRequest(merchant.hmacSecret, 'post', '/api/v1/payments/charge', bodyStr);
      const chargeRes = await request(app.getHttpServer())
        .post('/api/v1/payments/charge')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Signature', signature)
        .set('X-Timestamp', timestamp)
        .set('X-Merchant-Id', merchant.merchantId)
        .set('Content-Type', 'application/json')
        .send(bodyObj)
        .expect(201);
      expect(chargeRes.body.status).toBe('SUCCEEDED');
      expect(chargeRes.body.pspProvider).toBe('ADYEN');
      const payment = chargeRes.body;

      const chargebackRef = 'adyen_cb_' + uniqueId('test');
      const notifyFields = {
        pspReference: chargebackRef,
        originalReference: payment.pspTransactionId,
        merchantAccountCode: 'TestMerchant',
        merchantReference: payment.paymentId,
        amountValue: 5500,
        amountCurrency: 'USD',
        eventCode: 'NOTIFICATION_OF_CHARGEBACK',
        success: 'true',
      };
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/adyen')
        .send({
          notificationItems: [{
            NotificationRequestItem: {
              ...notifyFields,
              amount: { value: notifyFields.amountValue, currency: notifyFields.amountCurrency },
              additionalData: { hmacSignature: signAdyenNotification(ADYEN_HMAC_KEY, notifyFields) },
            },
          }],
        })
        .expect(200);

      const getResAfterDispute = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getResAfterDispute.body.status).toBe('DISPUTED');

      const reversalFields = {
        pspReference: 'adyen_rev_' + uniqueId('test'),
        originalReference: chargebackRef,
        merchantAccountCode: 'TestMerchant',
        merchantReference: payment.paymentId,
        amountValue: 5500,
        amountCurrency: 'USD',
        eventCode: 'CHARGEBACK_REVERSED',
        success: 'true',
      };
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/adyen')
        .send({
          notificationItems: [{
            NotificationRequestItem: {
              ...reversalFields,
              amount: { value: reversalFields.amountValue, currency: reversalFields.amountCurrency },
              additionalData: { hmacSignature: signAdyenNotification(ADYEN_HMAC_KEY, reversalFields) },
            },
          }],
        })
        .expect(200);

      const getResAfterReversal = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getResAfterReversal.body.status).toBe('SUCCEEDED');
    });
  });
});
