import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { createHmac, randomUUID } from 'crypto';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { SubscriptionEntity } from '../src/modules/payment/adapters/persistence/entities/subscription.entity';

interface CapturedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Same same-process capture server as dispute-notification.e2e-spec.ts — see its docblock. */
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
 * SubscriptionNotificationDispatcherService's per-channel delivery — the
 * @OnEvent('subscription.past_due')/@OnEvent('subscription.canceled')
 * listener those events never had a subscriber for before (see
 * SubscriptionNotificationListener's docblock; subscriptions.e2e-spec.ts
 * already covers the events themselves being emitted with the right
 * shape, not this delivery layer). Independent
 * subscriptionNotificationChannel/Target fields from disputes' own —
 * dispute-notification.e2e-spec.ts already proves the two don't share
 * state; this only needs to prove the subscription side actually
 * delivers.
 */
describe('Subscription notification channels: email/Slack/webhook (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let capture: { port: number; requests: CapturedRequest[]; close: () => Promise<void> };
  const originalEmailProviderUrl = process.env.EMAIL_PROVIDER_URL;

  beforeAll(async () => {
    capture = await startCaptureServer();
    process.env.EMAIL_PROVIDER_URL = `http://127.0.0.1:${capture.port}/v1/email`;
    app = await createTestApp();
    dataSource = app.get(DataSource);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
    await capture.close();
    if (originalEmailProviderUrl === undefined) {
      delete process.env.EMAIL_PROVIDER_URL;
    } else {
      process.env.EMAIL_PROVIDER_URL = originalEmailProviderUrl;
    }
  });

  function setChannel(merchant: SeededMerchant, channel: 'EMAIL' | 'SLACK' | 'WEBHOOK', target: string | null) {
    return request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/subscription-notification-channel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel, target });
  }

  async function pushPeriodEndIntoPast(subscriptionId: string, msAgo = 60_000): Promise<void> {
    await dataSource.getRepository(SubscriptionEntity).update(subscriptionId, {
      currentPeriodEnd: new Date(Date.now() - msAgo),
    });
  }

  async function runBillingNow(): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/admin/subscriptions/run-billing')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  }

  function signedPost(merchant: SeededMerchant, token: string, path: string, body: object) {
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

  it('a merchant defaults to WEBHOOK with no target configured, independent of disputeNotificationChannel', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subnotifdefault') });
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const found = res.body.find((m: any) => m.merchantId === merchant.merchantId);
    expect(found.subscriptionNotificationChannel).toBe('WEBHOOK');
    expect(found.subscriptionNotificationTarget).toBeNull();
    expect(found.disputeNotificationChannel).toBe('WEBHOOK');
    expect(found.disputeNotificationTarget).toBeNull();
  });

  it("WEBHOOK channel: subscription.past_due is delivered with a valid HMAC signature over the exact body, using the merchant's own hmac secret", async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subnotifpastdue') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await setChannel(merchant, 'WEBHOOK', `http://127.0.0.1:${capture.port}/subscription-webhook`).expect(200);

    const createRes = await signedPost(merchant, token, '/api/v1/subscriptions', {
      amount: 10,
      currency: 'USD',
      customerId: uniqueId('cust'),
      interval: 'day',
      trialDays: 1,
      paymentMethodId: 'pm_card_insufficientfunds',
    }).expect(201);
    await pushPeriodEndIntoPast(createRes.body.id);

    const before = capture.requests.length;
    await runBillingNow();
    await waitFor(() => capture.requests.length > before);

    const captured = capture.requests[capture.requests.length - 1];
    expect(captured.path).toBe('/subscription-webhook');
    const payload = JSON.parse(captured.body);
    expect(payload.event).toBe('subscription.past_due');
    expect(payload.subscriptionId).toBe(createRes.body.id);
    expect(payload.merchantId).toBe(merchant.merchantId);
    expect(payload.failedAttempts).toBe(1);
    // Smart routing can pick either PSP for this renewal (no
    // preferredProvider on subscriptions) — the raw decline code is
    // genuinely PSP-specific (Phase 1's per-PSP HARD_DECLINE_CODES; see
    // scripts/mock-psp/server.js's ADYEN_REFUSAL_REASON_CODES), so either
    // Stripe's semantic string or Adyen's real numeric equivalent is
    // correct here.
    expect(['insufficient_funds', '12']).toContain(payload.declineCode);

    const sigHeader = captured.headers['x-omniswitch-signature'] as string;
    expect(sigHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const [, tsPart, sigPart] = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    const expected = createHmac('sha256', merchant.hmacSecret).update(`${tsPart}.${captured.body}`).digest('hex');
    expect(sigPart).toBe(expected);
  });

  it('WEBHOOK channel: subscription.canceled (hard_decline) is also delivered', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subnotifcanceled') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await setChannel(merchant, 'WEBHOOK', `http://127.0.0.1:${capture.port}/subscription-webhook`).expect(200);

    const createRes = await signedPost(merchant, token, '/api/v1/subscriptions', {
      amount: 10,
      currency: 'USD',
      customerId: uniqueId('cust'),
      interval: 'day',
      trialDays: 1,
      paymentMethodId: 'pm_card_stolencard',
    }).expect(201);
    await pushPeriodEndIntoPast(createRes.body.id);

    const before = capture.requests.length;
    await runBillingNow();
    await waitFor(() => capture.requests.length > before);

    const captured = capture.requests[capture.requests.length - 1];
    const payload = JSON.parse(captured.body);
    expect(payload.event).toBe('subscription.canceled');
    expect(payload.subscriptionId).toBe(createRes.body.id);
    expect(payload.reason).toBe('hard_decline');
    // See the past_due test above for why this is PSP-dependent.
    expect(['stolen_card', '5']).toContain(payload.declineCode);
  });

  it("SLACK channel: posts Slack's {text} shape to the configured incoming-webhook URL", async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subnotifslack') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await setChannel(merchant, 'SLACK', `http://127.0.0.1:${capture.port}/slack-target`).expect(200);

    const createRes = await signedPost(merchant, token, '/api/v1/subscriptions', {
      amount: 10,
      currency: 'USD',
      customerId: uniqueId('cust'),
      interval: 'day',
      trialDays: 1,
      paymentMethodId: 'pm_card_stolencard',
    }).expect(201);
    await pushPeriodEndIntoPast(createRes.body.id);

    const before = capture.requests.length;
    await runBillingNow();
    await waitFor(() => capture.requests.length > before);

    const captured = capture.requests[capture.requests.length - 1];
    expect(captured.path).toBe('/slack-target');
    const payload = JSON.parse(captured.body);
    expect(typeof payload.text).toBe('string');
    expect(payload.text).toContain(createRes.body.id);
    expect(captured.headers['x-omniswitch-signature']).toBeUndefined();
  });

  it('EMAIL channel: posts {to, subject, body} to EMAIL_PROVIDER_URL/send', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subnotifemail') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await setChannel(merchant, 'EMAIL', 'billing-ops@example.com').expect(200);

    const createRes = await signedPost(merchant, token, '/api/v1/subscriptions', {
      amount: 10,
      currency: 'USD',
      customerId: uniqueId('cust'),
      interval: 'day',
      trialDays: 1,
      paymentMethodId: 'pm_card_insufficientfunds',
    }).expect(201);
    await pushPeriodEndIntoPast(createRes.body.id);

    const before = capture.requests.length;
    await runBillingNow();
    await waitFor(() => capture.requests.length > before);

    const captured = capture.requests[capture.requests.length - 1];
    expect(captured.path).toBe('/v1/email/send');
    const payload = JSON.parse(captured.body);
    expect(payload.to).toBe('billing-ops@example.com');
    expect(payload.subject).toContain(createRes.body.id);
    expect(typeof payload.body).toBe('string');
  });

  it('with no target configured, a subscription event triggers no notification attempt at all', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subnotifnone') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const createRes = await signedPost(merchant, token, '/api/v1/subscriptions', {
      amount: 10,
      currency: 'USD',
      customerId: uniqueId('cust'),
      interval: 'day',
      trialDays: 1,
      paymentMethodId: 'pm_card_stolencard',
    }).expect(201);
    await pushPeriodEndIntoPast(createRes.body.id);

    const before = capture.requests.length;
    await runBillingNow();
    await new Promise((r) => setTimeout(r, 300));
    expect(capture.requests.length).toBe(before);
  });

  it('rejects an unknown channel value with 422', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subnotifbadchannel') });
    const res = await setChannel(merchant, 'CARRIER_PIGEON' as any, 'irrelevant');
    expect(res.status).toBe(422);
  });
});
