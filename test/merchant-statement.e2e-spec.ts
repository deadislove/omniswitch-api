import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook } from './utils/signing';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

/**
 * `MerchantStatementService` — see docs/business-domain/ledger-accounting.md's
 * statement section for the full field-by-field writeup this exercises:
 * grossVolume/platformFee/providerFee from this merchant's own direct
 * charges, refundedAmount/chargebackAmount overlapping on purpose (a lost
 * dispute books through the same createRefundEntries() path as an
 * ordinary refund), and netSettlement always reconciling independently
 * against the real MERCHANT-type ledger balance.
 */
describe('Merchant statements (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('stmt-admin')));
  });

  afterAll(async () => {
    await app.close();
  });

  function signedRequest(
    m: SeededMerchant,
    t: string,
    method: 'post',
    path: string,
    body: object,
    idempotencyKey = randomUUID(),
  ) {
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(m.hmacSecret, method, path, bodyStr);
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${t}`)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', m.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  async function chargeImmediate(merchant: SeededMerchant, token: string, amount: number) {
    const bodyObj = {
      amount,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    };
    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', bodyObj).expect(201);
    expect(res.body.status).toBe('SUCCEEDED');
    return res.body;
  }

  async function refund(merchant: SeededMerchant, token: string, paymentId: string, amount: number) {
    const res = await signedRequest(merchant, token, 'post', `/api/v1/payments/${paymentId}/refund`, {
      amount,
    }).expect(200);
    return res.body;
  }

  async function resolveLost(pspTransactionId: string): Promise<void> {
    const disputeId = 'dp_' + uniqueId('stmt');
    const createBody = JSON.stringify({
      id: 'evt_' + uniqueId('stmt'),
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, payment_intent: pspTransactionId, reason: 'fraudulent' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, createBody))
      .set('Content-Type', 'application/json')
      .send(createBody)
      .expect(200);
    const closeBody = JSON.stringify({
      id: 'evt_' + uniqueId('stmt'),
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

  async function waitForDisputeResolved(merchantId: string, paymentId: string, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    do {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ merchantId })
        .expect(200);
      const found = res.body.find((d: any) => d.paymentId === paymentId);
      if (found && found.status === 'LOST') return;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    throw new Error('dispute never resolved LOST within timeout');
  }

  async function generate(merchantId: string, periodStart: Date, periodEnd: Date) {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchantId}/statements/generate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() })
      .expect(200);
    return res.body;
  }

  it("a direct charge's gross volume, platform fee, and net settlement are correctly broken out", async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('stmt-happy') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const periodStart = new Date(Date.now() - 5000);

    await chargeImmediate(merchant, token, 100);
    const periodEnd = new Date(Date.now() + 5000);

    const statement = await generate(merchant.merchantId, periodStart, periodEnd);
    expect(statement.breakdowns).toHaveLength(1);
    const usd = statement.breakdowns[0];
    expect(usd.currencyCode).toBe('USD');
    expect(usd.chargeCount).toBe(1);
    expect(usd.grossVolume).toBeCloseTo(100, 5);
    expect(usd.platformFee).toBeCloseTo(1.5, 5); // default platformFeeBps = 150 (1.5%)
    expect(usd.netSettlement).toBeCloseTo(98.5, 5);
    expect(usd.refundedAmount).toBe(0);
    expect(usd.chargebackCount).toBe(0);
  });

  it('a partial refund reduces net settlement without changing the already-booked grossVolume/platformFee', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('stmt-refund') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const periodStart = new Date(Date.now() - 5000);

    const payment = await chargeImmediate(merchant, token, 100);
    await refund(merchant, token, payment.paymentId, 40);
    const periodEnd = new Date(Date.now() + 5000);

    const statement = await generate(merchant.merchantId, periodStart, periodEnd);
    const usd = statement.breakdowns[0];
    expect(usd.grossVolume).toBeCloseTo(100, 5);
    expect(usd.platformFee).toBeCloseTo(1.5, 5);
    expect(usd.refundedAmount).toBeCloseTo(40, 5);
    expect(usd.netSettlement).toBeCloseTo(100 - 1.5 - 40, 5);
  });

  it('a lost dispute is counted as a chargeback and also reflected in refundedAmount (same ledger path)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('stmt-chargeback') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const periodStart = new Date(Date.now() - 5000);

    const payment = await chargeImmediate(merchant, token, 100);
    await resolveLost(payment.pspTransactionId);
    await waitForDisputeResolved(merchant.merchantId, payment.paymentId);
    const periodEnd = new Date(Date.now() + 5000);

    const statement = await generate(merchant.merchantId, periodStart, periodEnd);
    const usd = statement.breakdowns[0];
    expect(usd.chargebackCount).toBe(1);
    expect(usd.chargebackAmount).toBeCloseTo(100, 5);
    expect(usd.refundedAmount).toBeCloseTo(100, 5);
    expect(usd.netSettlement).toBeCloseTo(100 - 1.5 - 100, 5);
  });

  it('a BNPL (Klarna) capture is broken out with its own providerFee, alongside platformFee', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('stmt-bnpl') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const periodStart = new Date(Date.now() - 5000);

    await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', { amount: 100, currency: 'USD' }).expect(201);
    const periodEnd = new Date(Date.now() + 5000);

    const statement = await generate(merchant.merchantId, periodStart, periodEnd);
    const usd = statement.breakdowns[0];
    expect(usd.chargeCount).toBe(1);
    expect(usd.platformFee).toBeCloseTo(1.5, 5);
    expect(usd.providerFee).toBeCloseTo(3.99, 5); // KLARNA_MERCHANT_FEE_BPS = 399 (3.99%)
    expect(usd.grossVolume).toBeCloseTo(100, 5);
    expect(usd.netSettlement).toBeCloseTo(100 - 1.5 - 3.99, 5);
  });

  it('regenerating the same period is idempotent — returns the original statement unchanged even if more activity happens afterward', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('stmt-idem') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const periodStart = new Date(Date.now() - 5000);

    await chargeImmediate(merchant, token, 50);
    const periodEnd = new Date(Date.now() + 10_000);

    const first = await generate(merchant.merchantId, periodStart, periodEnd);
    await chargeImmediate(merchant, token, 999); // happens after generation, still inside [periodStart, periodEnd)
    const second = await generate(merchant.merchantId, periodStart, periodEnd);

    expect(second.id).toBe(first.id);
    expect(second.breakdowns[0].chargeCount).toBe(1);
    expect(second.breakdowns[0].grossVolume).toBeCloseTo(50, 5);
  });

  it("a merchant can list and fetch their own statements but not another merchant's", async () => {
    const owner = await seedMerchant(app, { merchantId: uniqueId('stmt-owner') });
    const ownerToken = await login(app, owner.apiKeyId, owner.apiKeySecret);
    const intruder = await seedMerchant(app, { merchantId: uniqueId('stmt-intruder') });
    const intruderToken = await login(app, intruder.apiKeyId, intruder.apiKeySecret);

    const periodStart = new Date(Date.now() - 5000);
    await chargeImmediate(owner, ownerToken, 20);
    const periodEnd = new Date(Date.now() + 5000);
    const statement = await generate(owner.merchantId, periodStart, periodEnd);

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/statements')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(listRes.body.some((s: any) => s.id === statement.id)).toBe(true);

    await request(app.getHttpServer())
      .get(`/api/v1/statements/${statement.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/statements/${statement.id}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(403);
  });

  it('rejects a generate request whose periodEnd is before periodStart, rather than silently returning an empty statement', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('stmt-badrange') });
    const periodStart = new Date(Date.now() + 5000);
    const periodEnd = new Date(Date.now() - 5000);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/statements/generate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() })
      .expect(400);
    expect(res.body.code).toBe('INVALID_PERIOD_RANGE');
  });
});
