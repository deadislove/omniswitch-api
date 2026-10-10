import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { resetCircuitBreakerState } from './utils/circuit-breaker';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

interface CapturedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Same same-process capture server as subscription-notification.e2e-spec.ts — see its docblock. */
function startCaptureServer(): Promise<{ port: number; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'captured_' + Date.now(), status: 'queued' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate never became true within ${timeoutMs}ms`);
}

/**
 * AML Review Monitoring — see AmlReviewMonitoringService's docblock.
 * Purely observational: flags a HIGH-industry merchant once its
 * hard-decline count crosses AML_REVIEW_HARD_DECLINE_THRESHOLD within
 * AML_REVIEW_WINDOW_DAYS, and fires a real notification the first time
 * it trips.
 */
describe('AML review monitoring — hard-decline threshold + notification (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: SeededMerchant;
  let adminToken: string;
  let capture: { port: number; requests: CapturedRequest[]; close: () => Promise<void> };
  const originalThreshold = process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD;
  const originalWindow = process.env.AML_REVIEW_WINDOW_DAYS;

  beforeAll(async () => {
    process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD = '5';
    process.env.AML_REVIEW_WINDOW_DAYS = '30';
    capture = await startCaptureServer();
    app = await createTestApp();
    dataSource = app.get(DataSource);
    ({ admin, adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  beforeEach(async () => {
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  afterAll(async () => {
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
    await app.close();
    await capture.close();
    if (originalThreshold === undefined) delete process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD;
    else process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD = originalThreshold;
    if (originalWindow === undefined) delete process.env.AML_REVIEW_WINDOW_DAYS;
    else process.env.AML_REVIEW_WINDOW_DAYS = originalWindow;
  });

  function signedCharge(m: SeededMerchant, t: string, body: object) {
    const path = '/api/v1/payments/charge';
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(m.hmacSecret, 'post', path, bodyStr);
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${t}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', m.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  async function seedHighRiskMerchant(): Promise<{ m: SeededMerchant; t: string }> {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const t = await login(app, m.apiKeyId, m.apiKeySecret);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/mcc-code`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mccCode: '7995' }) // Betting/casino gambling — HIGH per mcc-risk-lookup.ts
      .expect(200);
    return { m, t };
  }

  async function seedHistoricalHardDecline(merchantId: string): Promise<void> {
    // Directly-seeded FAILED payment with a real Stripe hard-decline code
    // — testing the counting/threshold logic, not the charge path itself
    // (the last, real triggering charge below already covers that).
    const payment = new PaymentEntity();
    payment.id = randomUUID();
    payment.merchantId = merchantId;
    payment.amountMinorUnits = '1000';
    payment.currencyCode = 'USD';
    payment.currencyMinorUnits = 2;
    payment.status = 'FAILED' as any;
    payment.idempotencyKey = randomUUID();
    payment.failureCode = 'stolen_card';
    payment.pspProvider = 'STRIPE' as any;
    payment.refunds = [];
    payment.captures = [];
    await dataSource.getRepository(PaymentEntity).save(payment);
  }

  it('does not flag a HIGH-industry merchant below the hard-decline threshold', async () => {
    const { m } = await seedHighRiskMerchant();
    for (let i = 0; i < 4; i++) await seedHistoricalHardDecline(m.merchantId);

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
    expect(summary.amlReviewFlagged).toBe(false);
  });

  it('flags a HIGH-industry merchant once the 5th hard-decline lands, and fires a real notification', async () => {
    const { m, t } = await seedHighRiskMerchant();
    for (let i = 0; i < 4; i++) await seedHistoricalHardDecline(m.merchantId);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/aml-review-notification-channel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'WEBHOOK', target: `http://127.0.0.1:${capture.port}/aml-review-webhook` })
      .expect(200);

    const before = capture.requests.length;

    // 5th hard-decline — the real one, through the actual saga.
    const res = await signedCharge(m, t, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_stolencard',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);
    expect(res.body.status).toBe('FAILED');

    await waitFor(() => capture.requests.length > before);
    const captured = capture.requests[capture.requests.length - 1];
    expect(captured.path).toBe('/aml-review-webhook');
    const payload = JSON.parse(captured.body);
    expect(payload.event).toBe('aml_review.flagged');
    expect(payload.merchantId).toBe(m.merchantId);
    expect(payload.hardDeclineCount).toBe(5);

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
    expect(summary.amlReviewFlagged).toBe(true);
    expect(summary.amlReviewFlagReason).toMatch(/5 hard-declines/);
    expect(summary.amlReviewFlaggedBy).toBeNull(); // automated, not manual
    expect(summary.amlReviewAutoManaged).toBe(true);
  });

  it('does not flag a LOW/UNKNOWN-industry merchant even with 5+ hard-declines', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const t = await login(app, m.apiKeyId, m.apiKeySecret);
    for (let i = 0; i < 4; i++) await seedHistoricalHardDecline(m.merchantId);

    await signedCharge(m, t, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_stolencard',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
    expect(summary.amlReviewFlagged).toBe(false);
  });

  it('a retryable decline does not count toward the threshold', async () => {
    const { m, t } = await seedHighRiskMerchant();
    for (let i = 0; i < 5; i++) {
      const payment = new PaymentEntity();
      payment.id = randomUUID();
      payment.merchantId = m.merchantId;
      payment.amountMinorUnits = '1000';
      payment.currencyCode = 'USD';
      payment.currencyMinorUnits = 2;
      payment.status = 'FAILED' as any;
      payment.idempotencyKey = randomUUID();
      payment.failureCode = 'insufficient_funds'; // retryable, not hard
      payment.pspProvider = 'STRIPE' as any;
      payment.refunds = [];
      payment.captures = [];
      await dataSource.getRepository(PaymentEntity).save(payment);
    }
    // One real hard-decline — 1 total hard-decline, below the threshold
    // of 5, proving the 5 retryable failures above didn't count.
    await signedCharge(m, t, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_stolencard',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
    expect(summary.amlReviewFlagged).toBe(false);
  });

  it('manual PATCH .../aml-review requires a reason (422 without it)', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/aml-review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ flagged: true })
      .expect(422);
  });

  it('manual flag/clear records the acting admin, disables amlReviewAutoManaged, and can be re-enabled', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });

    const flagRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/aml-review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ flagged: true, reason: 'Pending compliance review of recent chargebacks' })
      .expect(200);
    expect(flagRes.body.amlReviewFlagged).toBe(true);
    expect(flagRes.body.amlReviewFlaggedBy).toBe(admin.merchantId);
    expect(flagRes.body.amlReviewAutoManaged).toBe(false);

    const clearRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/aml-review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ flagged: false, reason: 'Review complete, no action needed' })
      .expect(200);
    expect(clearRes.body.amlReviewFlagged).toBe(false);
    expect(clearRes.body.amlReviewAutoManaged).toBe(false); // still manually managed

    const reEnableRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/aml-review-auto`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true })
      .expect(200);
    expect(reEnableRes.body.amlReviewAutoManaged).toBe(true);
  });

  it('a MERCHANT-role token cannot call any of these admin endpoints', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const mToken = await login(app, m.apiKeyId, m.apiKeySecret);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/aml-review`)
      .set('Authorization', `Bearer ${mToken}`)
      .send({ flagged: true, reason: 'x' })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/aml-review-auto`)
      .set('Authorization', `Bearer ${mToken}`)
      .send({ enabled: true })
      .expect(403);
  });

  it('rejects an unknown notification channel value with 422', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/aml-review-notification-channel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'CARRIER_PIGEON', target: 'irrelevant' });
    expect(res.status).toBe(422);
  });
});
