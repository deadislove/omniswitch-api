import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
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
  let adminToken: string;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
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
    // The marker is Stripe-only in the mock, so preferredProvider pins
    // routing to STRIPE — now a true override (SmartRoutingStrategy), not
    // a scoring nudge that could still lose and silently send this to
    // ADYEN, where the marker has no effect.
    const bodyObj = {
      amount: 30,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      description: 'FORCE_3DS e2e test',
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
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

  /**
   * GET /payments/:id is deliberately served off the replica (see
   * PaymentRepositoryPort.findByIdOnMaster()'s docblock) — read-only,
   * latency-insensitive, fine to lag by the replica's ~1s streaming
   * window. Every test in this file that checks "did the webhook I just
   * sent actually take effect" via this endpoint has to tolerate that
   * documented window instead of asserting on a single immediate read.
   * Polls until `expectedStatus` shows up or `timeoutMs` elapses; returns
   * the last response either way so the caller's own `expect(...)` still
   * produces the real failure message if it never arrives.
   */
  async function getPaymentEventually(paymentId: string, expectedStatus: string, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    let res: request.Response;
    do {
      res = await request(app.getHttpServer())
        .get(`/api/v1/payments/${paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      if (res.body.status === expectedStatus) return res;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    return res;
  }

  async function refundPayment(paymentId: string, amount: number) {
    const bodyObj = { amount };
    const bodyStr = JSON.stringify(bodyObj);
    const { signature, timestamp } = signHmacRequest(
      merchant.hmacSecret,
      'post',
      `/api/v1/payments/${paymentId}/refund`,
      bodyStr,
    );
    const res = await request(app.getHttpServer())
      .post(`/api/v1/payments/${paymentId}/refund`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', merchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(bodyObj)
      .expect(200);
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

      const getRes = await getPaymentEventually(payment.paymentId, 'SUCCEEDED');
      expect(getRes.body.status).toBe('SUCCEEDED');
    });

    it('redelivering the same webhook is idempotent (no error, no duplicate effect)', async () => {
      const payment = await chargeWithForcedThreeDS();
      const body = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'payment_intent.succeeded',
        data: { object: { id: payment.pspTransactionId, status: 'succeeded' } },
      });
      // Signed once, reused for both deliveries — signStripeWebhook()
      // embeds the current timestamp, so recomputing it per iteration
      // would send two distinctly-signed requests instead of actually
      // replaying the same webhook delivery twice.
      const signature = signStripeWebhook(STRIPE_WEBHOOK_SECRET, body);

      for (let i = 0; i < 2; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/webhooks/stripe')
          .set('Stripe-Signature', signature)
          .set('Content-Type', 'application/json')
          .send(body)
          .expect(200);
      }

      const getRes = await getPaymentEventually(payment.paymentId, 'SUCCEEDED');
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

      const getRes = await getPaymentEventually(payment.paymentId, 'SUCCEEDED');
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

      const getRes = await getPaymentEventually(payment.paymentId, 'DISPUTED');
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

    it('a dispute-created webhook for a PARTIALLY_REFUNDED payment still creates a Dispute record, not a silently dropped webhook', async () => {
      const payment = await chargeImmediate(100);
      const refundRes = await refundPayment(payment.paymentId, 40);
      expect(refundRes.status).toBe('PARTIALLY_REFUNDED');

      const disputeId = 'dp_' + uniqueId('test');
      const body = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'charge.dispute.created',
        data: { object: { id: disputeId, payment_intent: payment.pspTransactionId, reason: 'fraudulent' } },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, body))
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);

      const getRes = await getPaymentEventually(payment.paymentId, 'DISPUTED');
      expect(getRes.body.status).toBe('DISPUTED');

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ merchantId: merchant.merchantId })
        .expect(200);
      const matching = listRes.body.filter((d: any) => d.paymentId === payment.paymentId);
      expect(matching).toHaveLength(1);
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
        .send({ evidence: "Tracking number 1Z999 shows delivery confirmed on the customer's doorstep." })
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

      const getRes = await getPaymentEventually(payment.paymentId, 'SUCCEEDED');
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
      // and test/ledger-and-outbox.e2e-spec.ts for the same issue).
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

      const getRes = await getPaymentEventually(payment.paymentId, 'REFUNDED');
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

    it('winning a dispute on a PARTIALLY_REFUNDED payment restores PARTIALLY_REFUNDED, not SUCCEEDED', async () => {
      // Restoring to SUCCEEDED here would silently erase the $40 refund
      // that already happened — remainingRefundable would read as the
      // full $100 again, letting the merchant over-refund later.
      const payment = await chargeImmediate(100);
      await refundPayment(payment.paymentId, 40);

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

      const getRes = await getPaymentEventually(payment.paymentId, 'PARTIALLY_REFUNDED');
      expect(getRes.body.status).toBe('PARTIALLY_REFUNDED');
      // Still exactly the one $40 refund from before the dispute — winning
      // it didn't erase that history or add a second entry.
      expect(getRes.body.refunds).toHaveLength(1);
      expect(getRes.body.refunds[0].amount).toBe(40);
    });

    it('losing a dispute on a PARTIALLY_REFUNDED payment claws back only the remaining balance, not the full original amount', async () => {
      // The real regression this guards against: recording the disputed
      // amount as the full $100 (instead of the $60 actually still at
      // risk) would double-count the $40 already refunded once this
      // pushes its own refund record — totalRefunded would read $140
      // against a $100 payment.
      const payment = await chargeImmediate(100);
      await refundPayment(payment.paymentId, 40);

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

      const listAfterCreate = await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ merchantId: merchant.merchantId })
        .expect(200);
      // The recorded dispute amount is what's actually still at risk ($60),
      // not the full original charge ($100).
      expect(listAfterCreate.body.find((d: any) => d.paymentId === payment.paymentId).amount).toBe(60);

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

      const getRes = await getPaymentEventually(payment.paymentId, 'REFUNDED');
      expect(getRes.body.status).toBe('REFUNDED');
      // Exactly two refund records ($40 original + $60 dispute-lost), not
      // a third double-counting one, and they sum to the full $100 — not
      // $140, which is what double-counting the already-refunded $40
      // would have produced.
      expect(getRes.body.refunds).toHaveLength(2);
      const totalRefunded = getRes.body.refunds.reduce((sum: number, r: { amount: number }) => sum + r.amount, 0);
      expect(totalRefunded).toBe(100);
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
          notificationItems: [
            {
              NotificationRequestItem: {
                ...notifyFields,
                amount: { value: notifyFields.amountValue, currency: notifyFields.amountCurrency },
                additionalData: { hmacSignature: signAdyenNotification(ADYEN_HMAC_KEY, notifyFields) },
              },
            },
          ],
        })
        .expect(200);

      const getResAfterDispute = await getPaymentEventually(payment.paymentId, 'DISPUTED');
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
          notificationItems: [
            {
              NotificationRequestItem: {
                ...reversalFields,
                amount: { value: reversalFields.amountValue, currency: reversalFields.amountCurrency },
                additionalData: { hmacSignature: signAdyenNotification(ADYEN_HMAC_KEY, reversalFields) },
              },
            },
          ],
        })
        .expect(200);

      const getResAfterReversal = await getPaymentEventually(payment.paymentId, 'SUCCEEDED');
      expect(getResAfterReversal.body.status).toBe('SUCCEEDED');
    });
  });

  describe('Edge cases: out-of-order delivery and signature-scheme drift', () => {
    // PSPs don't guarantee webhook delivery order — a retry, a transient
    // 5xx on the first attempt, or two events queued close together can
    // all reorder what this endpoint actually receives. This isn't a
    // hypothetical: WebhookProcessingService/DisputeService's status
    // checks (see each handler's own guard clauses) already defend
    // against it, but until now nothing proved that defense actually
    // works end to end — only plain redelivery-of-the-same-event was
    // tested above.
    it('a charge.dispute.closed webhook arriving before its charge.dispute.created is dropped safely, not crashed or misapplied', async () => {
      const payment = await chargeImmediate(55);
      const disputeId = 'dp_' + uniqueId('test');

      // The resolution arrives first — DisputeService.resolveByPspDisputeId()
      // finds no Dispute record for this pspDisputeId yet.
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
        .expect(200); // acked regardless — a PSP must not be told to keep retrying a no-op

      // Nothing to misapply it against: still SUCCEEDED, no Dispute record.
      const afterClose = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(afterClose.body.status).toBe('SUCCEEDED');
      const listBeforeCreate = await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ merchantId: merchant.merchantId })
        .expect(200);
      expect(listBeforeCreate.body.some((d: any) => d.paymentId === payment.paymentId)).toBe(false);

      // The correctly-ordered event eventually arrives — the system
      // recovers to a normal, consistent state rather than staying stuck
      // or compounding the earlier no-op into a later error.
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

      const getRes = await getPaymentEventually(payment.paymentId, 'DISPUTED');
      expect(getRes.body.status).toBe('DISPUTED');
      const listAfterCreate = await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ merchantId: merchant.merchantId })
        .expect(200);
      const matching = listAfterCreate.body.find((d: any) => d.paymentId === payment.paymentId);
      // NEEDS_RESPONSE, not WON/LOST — the earlier out-of-order
      // resolution is gone for good, not retroactively applied once the
      // dispute record finally exists. A real deployment would need a
      // human (or reconciliation) to notice the PSP already considers
      // this resolved; that gap is a documented limitation, not a crash.
      expect(matching.status).toBe('NEEDS_RESPONSE');
    });

    it('a late payment_intent.succeeded arriving after the payment was already terminalized by a failure webhook is ignored, not double-applied', async () => {
      const payment = await chargeWithForcedThreeDS();

      const failBody = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: payment.pspTransactionId,
            last_payment_error: { message: 'Card declined', code: 'card_declined' },
          },
        },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, failBody))
        .set('Content-Type', 'application/json')
        .send(failBody)
        .expect(200);

      const afterFail = await getPaymentEventually(payment.paymentId, 'FAILED');
      expect(afterFail.body.status).toBe('FAILED');

      const queryRunner = dataSource.createQueryRunner('master');
      let entriesBeforeLateSuccess: number;
      try {
        entriesBeforeLateSuccess = await queryRunner.manager.count(LedgerOutboxEntity, {
          where: { paymentId: payment.paymentId },
        });
      } finally {
        await queryRunner.release();
      }

      // The success notification for the same PSP transaction shows up
      // late (e.g. a delayed retry of an earlier attempt) — the payment
      // is already FAILED, neither PROCESSING nor REQUIRES_ACTION, so
      // markSucceeded()'s own status guard must reject this rather than
      // flip a terminalized payment back to SUCCEEDED.
      const succeedBody = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'payment_intent.succeeded',
        data: { object: { id: payment.pspTransactionId, status: 'succeeded' } },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, succeedBody))
        .set('Content-Type', 'application/json')
        .send(succeedBody)
        .expect(200);

      const afterLateSuccess = await request(app.getHttpServer())
        .get(`/api/v1/payments/${payment.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(afterLateSuccess.body.status).toBe('FAILED');

      const queryRunner2 = dataSource.createQueryRunner('master');
      try {
        const entriesAfter = await queryRunner2.manager.count(LedgerOutboxEntity, {
          where: { paymentId: payment.paymentId },
        });
        // No ledger entry booked off the back of the ignored late success —
        // a FAILED payment never had one, and the late webhook must not
        // create one now.
        expect(entriesAfter).toBe(entriesBeforeLateSuccess);
        expect(entriesAfter).toBe(0);
      } finally {
        await queryRunner2.release();
      }
    });

    // Stripe's own docs describe the signature scheme (`t=`/`v1=`) as
    // versioned — a real rotation to a future scheme this app doesn't
    // know about yet is exactly the "signing scheme drift" scenario, not
    // a hypothetical. The guard must reject it cleanly (401), not crash
    // (500) or — far worse — silently accept an unverifiable payload.
    it('a Stripe-Signature header using an unrecognized scheme (no v1) is rejected with 401, not a crash', async () => {
      const body = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_should_never_be_read', status: 'succeeded' } },
      });
      const timestamp = Math.floor(Date.now() / 1000);

      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        // A hypothetical future scheme (v2) alongside a garbage v1 —
        // StripeWebhookGuard only ever reads `t`/`v1`, so this exercises
        // "recognizes v1 is present but wrong", covered elsewhere; this
        // case is the sibling where v1 is entirely absent, which a
        // scheme migration would produce during a transition window.
        .set('Stripe-Signature', `t=${timestamp},v2=${'a'.repeat(64)}`)
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(401);

      expect(res.body.code).toBe('INVALID_SIGNATURE_HEADER');
    });

    it('a Stripe-Signature header in a completely unrecognized format is rejected with 401, not a crash', async () => {
      const body = JSON.stringify({
        id: 'evt_' + uniqueId('test'),
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_should_never_be_read', status: 'succeeded' } },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', 'whsec_v2_totally_different_envelope_format')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(401);

      expect(res.body.code).toBe('INVALID_SIGNATURE_HEADER');
    });
  });
});
