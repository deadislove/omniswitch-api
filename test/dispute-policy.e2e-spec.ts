import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook } from './utils/signing';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

/**
 * Dispute resolution policy layer: DisputeService.recordDispute() now
 * computes an auto-decision (ACCEPT/CONTEST/MANUAL_REVIEW) at creation
 * time via dispute-policy.ts — see that file's docblock for the
 * (deliberately simple, illustrative) thresholds/reason-code table this
 * exercises directly. CONTEST also auto-submits templated evidence to
 * the PSP for real; ACCEPT/MANUAL_REVIEW are advisory only.
 */
describe('Dispute resolution policy layer (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;
  let admin: SeededMerchant;
  let adminToken: string;
  let dataSource: DataSource;
  let eventEmitter: EventEmitter2;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    eventEmitter = app.get(EventEmitter2);
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);
  });

  afterAll(async () => {
    await app.close();
  });

  async function chargeImmediate(amount: number) {
    const bodyObj = { amount, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN };
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

  async function fireDisputeCreated(pspTransactionId: string, reason: string): Promise<string> {
    const disputeId = 'dp_' + uniqueId('policy');
    const body = JSON.stringify({
      id: 'evt_' + uniqueId('policy'),
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, payment_intent: pspTransactionId, reason } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, body))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
    return disputeId;
  }

  async function getDisputeByPaymentId(paymentId: string) {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/disputes')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ merchantId: merchant.merchantId })
      .expect(200);
    return res.body.find((d: any) => d.paymentId === paymentId);
  }

  it('a low-value dispute is auto-decided ACCEPT and left untouched (no PSP action, still NEEDS_RESPONSE)', async () => {
    const payment = await chargeImmediate(9.99); // below the $15 illustrative threshold
    await fireDisputeCreated(payment.pspTransactionId, 'fraudulent');

    const dispute = await getDisputeByPaymentId(payment.paymentId);
    expect(dispute.autoDecision).toBe('ACCEPT');
    expect(dispute.status).toBe('NEEDS_RESPONSE');
    expect(dispute.evidence).toBeNull(); // TypeORM reads an empty nullable column back as null, not undefined
  });

  it('a high-value dispute with an auto-contestable reason is CONTESTed automatically — real PSP evidence submission, no operator action', async () => {
    const payment = await chargeImmediate(60);
    await fireDisputeCreated(payment.pspTransactionId, 'product_not_received');

    const dispute = await getDisputeByPaymentId(payment.paymentId);
    expect(dispute.autoDecision).toBe('CONTEST');
    expect(dispute.status).toBe('UNDER_REVIEW');
    expect(dispute.evidence).toContain('Automated response');

    // Already UNDER_REVIEW — the manual endpoint correctly refuses a second
    // submission, same guard a human-submitted dispute already has.
    await request(app.getHttpServer())
      .post(`/api/v1/admin/disputes/${dispute.id}/evidence`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ evidence: 'trying to override the auto-submitted evidence' })
      .expect(409);
  });

  it('a high-value dispute with a non-contestable reason (fraudulent) is left for MANUAL_REVIEW — an operator can still act on it normally', async () => {
    const payment = await chargeImmediate(60);
    await fireDisputeCreated(payment.pspTransactionId, 'fraudulent');

    const dispute = await getDisputeByPaymentId(payment.paymentId);
    expect(dispute.autoDecision).toBe('MANUAL_REVIEW');
    expect(dispute.status).toBe('NEEDS_RESPONSE');
    expect(dispute.evidence).toBeNull(); // TypeORM reads an empty nullable column back as null, not undefined

    // The manual path is completely unaffected by the auto-decision — it's
    // advisory only for MANUAL_REVIEW/ACCEPT, never blocks a human.
    const evidenceRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/disputes/${dispute.id}/evidence`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ evidence: 'Operator-submitted evidence after manual review.' })
      .expect(200);
    expect(evidenceRes.body.status).toBe('UNDER_REVIEW');

    // autoDecision is immutable — it still reflects what the policy
    // originally recommended, not overwritten by the later manual action.
    const afterManual = await getDisputeByPaymentId(payment.paymentId);
    expect(afterManual.autoDecision).toBe('MANUAL_REVIEW');
  });

  it('evidenceGuidance is reason-code-specific, shown regardless of autoDecision', async () => {
    const fraudPayment = await chargeImmediate(60);
    await fireDisputeCreated(fraudPayment.pspTransactionId, 'fraudulent');
    const fraudDispute = await getDisputeByPaymentId(fraudPayment.paymentId);
    expect(fraudDispute.evidenceGuidance).toContain('AVS/CVV');

    const unknownReasonPayment = await chargeImmediate(60);
    await fireDisputeCreated(unknownReasonPayment.pspTransactionId, 'some_reason_code_not_in_the_table');
    const unknownReasonDispute = await getDisputeByPaymentId(unknownReasonPayment.paymentId);
    expect(unknownReasonDispute.evidenceGuidance).toContain('No specific guidance');
  });

  it('emits a structured dispute.created event (a real notification integration point, even though nothing subscribes today)', async () => {
    const payment = await chargeImmediate(9.99);

    const received: any[] = [];
    const listener = (payload: any) => received.push(payload);
    eventEmitter.on('dispute.created', listener);
    try {
      await fireDisputeCreated(payment.pspTransactionId, 'fraudulent');
    } finally {
      eventEmitter.off('dispute.created', listener);
    }

    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({
      paymentId: payment.paymentId,
      merchantId: merchant.merchantId,
      autoDecision: 'ACCEPT',
      status: 'NEEDS_RESPONSE',
      reason: 'fraudulent',
    });
  });

  it('emits a structured dispute.resolved event on WON/LOST resolution', async () => {
    const payment = await chargeImmediate(60);
    const disputeId = await fireDisputeCreated(payment.pspTransactionId, 'fraudulent');

    const received: any[] = [];
    const listener = (payload: any) => received.push(payload);
    eventEmitter.on('dispute.resolved', listener);
    try {
      const closeBody = JSON.stringify({
        id: 'evt_' + uniqueId('policy'),
        type: 'charge.dispute.closed',
        data: { object: { id: disputeId, status: 'won' } },
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, closeBody))
        .set('Content-Type', 'application/json')
        .send(closeBody)
        .expect(200);
    } finally {
      eventEmitter.off('dispute.resolved', listener);
    }

    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({
      paymentId: payment.paymentId,
      merchantId: merchant.merchantId,
      outcome: 'WON',
      autoDecision: 'MANUAL_REVIEW',
    });
  });
});
