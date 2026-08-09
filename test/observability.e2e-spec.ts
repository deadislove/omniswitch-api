import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Payment-volume metrics: GET /metrics used to only cover PSP circuit
 * breaker health and ledger outbox backlog — `omniswitch_payments_total`
 * (charges by status/provider) was a documented gap (DEV_README.md's
 * Observability section). Deliberately a pull-computed gauge (a live
 * `SELECT ... GROUP BY status, pspProvider` against the `payments` table
 * at scrape time — see PaymentRepositoryPort.countByStatusAndProvider()'s
 * docblock), not an in-process counter incremented from
 * PaymentCheckoutSaga — the same reasoning MetricsController's other
 * gauges already use, and the reason this is actually testable here: the
 * value reflects real, durable state, not per-process counters that would
 * reset between this test file's own beforeAll and a previous file's run.
 */
describe('Observability: payment-volume metrics (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    merchant = await seedMerchant(app, { merchantId: uniqueId('obsmerchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
  });

  afterAll(async () => {
    await app.close();
  });

  function signedCharge(body: object) {
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(merchant.hmacSecret, 'post', '/api/v1/payments/charge', bodyStr);
    return request(app.getHttpServer())
      .post('/api/v1/payments/charge')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', merchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  async function metricValue(status: string, provider: string): Promise<number> {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    const line = res.text
      .split('\n')
      .find((l) => l.startsWith('omniswitch_payments_total{') && l.includes(`status="${status}"`) && l.includes(`provider="${provider}"`));
    if (!line) return 0;
    return Number(line.trim().split(' ').pop());
  }

  it('reflects a real SUCCEEDED charge, with the correct PSP provider label', async () => {
    const res = await signedCharge({
      amount: 20, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
    }).expect(201);
    expect(res.body.status).toBe('SUCCEEDED');

    const value = await metricValue('SUCCEEDED', res.body.pspProvider);
    expect(value).toBeGreaterThanOrEqual(1);
  });

  it('is cumulative across repeated scrapes and increments by exactly one per additional charge on the same (status, provider) pair', async () => {
    const charge1 = await signedCharge({
      amount: 20, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
    }).expect(201);
    const provider = charge1.body.pspProvider;
    const valueAfterFirst = await metricValue('SUCCEEDED', provider);
    expect(valueAfterFirst).toBeGreaterThanOrEqual(1);

    const charge2 = await signedCharge({
      amount: 20, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
    }).expect(201);
    // Identical low-risk US-card inputs route deterministically in this
    // codebase's SmartRoutingStrategy — same provider both times, so the
    // delta below is attributable to exactly this one additional charge,
    // not routing variance.
    expect(charge2.body.pspProvider).toBe(provider);

    const valueAfterSecond = await metricValue('SUCCEEDED', provider);
    expect(valueAfterSecond).toBe(valueAfterFirst + 1);
  });

  it('reflects a real PSP decline as FAILED, distinct from SUCCEEDED', async () => {
    // "carddeclined" is the mock PSP's decline-code marker in
    // paymentMethodId (scripts/mock-psp/server.js's DECLINE_CODE_MARKERS)
    // — a real PSP-returned decline, so the saga completes normally with
    // status FAILED (HTTP 201), landing a real row the gauge can count.
    const res = await signedCharge({
      amount: 20, currency: 'USD', paymentMethodId: 'pm_card_carddeclined', orderId: uniqueId('order'), binInfo: USD_BIN,
    }).expect(201);
    expect(res.body.status).toBe('FAILED');

    const value = await metricValue('FAILED', res.body.pspProvider);
    expect(value).toBeGreaterThanOrEqual(1);
  });

  it('exposes HELP/TYPE metadata for the new gauge, same as every other metric on this endpoint', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toContain('# HELP omniswitch_payments_total');
    expect(res.text).toContain('# TYPE omniswitch_payments_total gauge');
  });
});
