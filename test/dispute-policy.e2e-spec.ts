import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook } from './utils/signing';
import { MerchantEntity } from '../src/modules/merchant/merchant.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  let adminToken: string;
  let eventEmitter: EventEmitter2;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    eventEmitter = app.get(EventEmitter2);
    dataSource = app.get(DataSource);
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
  });

  async function chargeImmediate(amount: number) {
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

  it('emits a structured dispute.created event (DisputeNotificationListener is the real subscriber — see dispute-notification.e2e-spec.ts)', async () => {
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

  // Same shape as the seed/resolve helpers in risk-tiering.e2e-spec.ts —
  // duplicated locally (not imported) since this is the only place in
  // this file that needs to drive a merchant into a specific risk tier,
  // and cross-file test-helper coupling isn't worth it for one use.
  async function chargeAs(m: SeededMerchant, t: string, amount = 20) {
    const bodyObj = {
      amount,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    };
    const bodyStr = JSON.stringify(bodyObj);
    const { signature, timestamp } = signHmacRequest(m.hmacSecret, 'post', '/api/v1/payments/charge', bodyStr);
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/charge')
      .set('Authorization', `Bearer ${t}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', m.merchantId)
      .set('Content-Type', 'application/json')
      .send(bodyObj)
      .expect(201);
    return res.body;
  }

  async function resolveLost(pspTransactionId: string, reason = 'fraudulent'): Promise<void> {
    const disputeId = 'dp_' + uniqueId('tierseed');
    const createBody = JSON.stringify({
      id: 'evt_' + uniqueId('tierseed'),
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, payment_intent: pspTransactionId, reason } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, createBody))
      .set('Content-Type', 'application/json')
      .send(createBody)
      .expect(200);
    const closeBody = JSON.stringify({
      id: 'evt_' + uniqueId('tierseed'),
      type: 'charge.dispute.closed',
      data: { object: { id: disputeId, status: 'lost' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, closeBody))
      .set('Content-Type', 'application/json')
      .send(closeBody)
      .expect(200);
  }

  async function getDisputeByPaymentIdFor(m: SeededMerchant, paymentId: string) {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/disputes')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ merchantId: m.merchantId })
      .expect(200);
    return res.body.find((d: any) => d.paymentId === paymentId);
  }

  it('a LOW-risk-tier merchant gets a lower auto-accept threshold and an expanded contestable-reason set (subscription_canceled auto-CONTESTs instead of MANUAL_REVIEW)', async () => {
    const lowMerchant = await seedMerchant(app, { merchantId: uniqueId('lowtier') });
    const lowToken = await login(app, lowMerchant.apiKeyId, lowMerchant.apiKeySecret);

    // Backdate createdAt so a brand-new test merchant doesn't also trip
    // RiskTieringService's new-account-age escalation modifier (< 30 days
    // old always escalates one tier) — this test is about the lost-
    // dispute-rate signal landing at LOW, not account age.
    await dataSource
      .getRepository(MerchantEntity)
      .update({ merchantId: lowMerchant.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

    // 10 settled charges, zero lost disputes — RiskTieringService.
    // evaluateMerchant() needs >= MIN_SAMPLE_SIZE (10) settled charges to
    // evaluate at all; a 0% lost-dispute rate lands this merchant at LOW.
    const charges: any[] = [];
    for (let i = 0; i < 10; i++) {
      charges.push(await chargeAs(lowMerchant, lowToken));
    }

    // $20 is below the base $15 threshold's *doubling* but above the
    // LOW-tier *halved* threshold (15 * 0.5 = $7.50) — reaches the reason
    // check either way. subscription_canceled is only contestable for a
    // LOW-tier merchant (see LOW_RISK_EXTRA_CONTESTABLE_REASONS in
    // dispute-policy.ts) — the top-level 'a high-value dispute with a
    // non-contestable reason' test in this file already proves a
    // *default-tier* merchant with a non-default-contestable reason lands
    // on MANUAL_REVIEW; this is the same shape, but the reason (and the
    // tier) is what flips it to CONTEST.
    const disputeId = 'dp_' + uniqueId('lowtier');
    const createBody = JSON.stringify({
      id: 'evt_' + uniqueId('lowtier'),
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, payment_intent: charges[0].pspTransactionId, reason: 'subscription_canceled' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, createBody))
      .set('Content-Type', 'application/json')
      .send(createBody)
      .expect(200);

    const dispute = await getDisputeByPaymentIdFor(lowMerchant, charges[0].paymentId);
    expect(dispute.merchantRiskTierAtDecision).toBe('LOW');
    expect(dispute.autoDecision).toBe('CONTEST');
    expect(dispute.status).toBe('UNDER_REVIEW');
    expect(dispute.evidence).toContain('Automated response');
  });

  it('a HIGH-risk-tier merchant gets a higher auto-accept threshold — a dispute that would otherwise reach the reason check is ACCEPTed outright', async () => {
    const highMerchant = await seedMerchant(app, { merchantId: uniqueId('hightier') });
    const highToken = await login(app, highMerchant.apiKeyId, highMerchant.apiKeySecret);

    // Same backdating as the LOW-tier test above, same reason — isolate
    // the lost-dispute-rate signal from the new-account-age escalation.
    await dataSource
      .getRepository(MerchantEntity)
      .update({ merchantId: highMerchant.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

    const charges: any[] = [];
    for (let i = 0; i < 10; i++) {
      charges.push(await chargeAs(highMerchant, highToken));
    }
    // 1 fraudulent LOST dispute / 10 settled charges = 10% weighted
    // lost-dispute rate (fraudulent carries full weight — see
    // dispute-risk-weight.ts), well above the 1% HIGH threshold. The
    // disputed charge still counts toward settledCharges afterward (its
    // payment status moves to REFUNDED, which is in SETTLED_STATUSES).
    await resolveLost(charges[0].pspTransactionId, 'fraudulent');

    // $20 is above the base $15 threshold (would normally reach the
    // reason check) but below the HIGH-tier *doubled* threshold
    // (15 * 2 = $30) — ACCEPTed before 'duplicate' (normally
    // auto-contestable) is even looked at. Fired against charges[1], a
    // different, still-undisputed payment from the seed disputes above.
    const disputeId = 'dp_' + uniqueId('hightier');
    const createBody = JSON.stringify({
      id: 'evt_' + uniqueId('hightier'),
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, payment_intent: charges[1].pspTransactionId, reason: 'duplicate' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, createBody))
      .set('Content-Type', 'application/json')
      .send(createBody)
      .expect(200);

    const dispute = await getDisputeByPaymentIdFor(highMerchant, charges[1].paymentId);
    expect(dispute.merchantRiskTierAtDecision).toBe('HIGH');
    expect(dispute.autoDecision).toBe('ACCEPT');
    expect(dispute.status).toBe('NEEDS_RESPONSE');
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
