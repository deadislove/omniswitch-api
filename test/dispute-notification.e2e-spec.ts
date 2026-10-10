import { INestApplication } from '@nestjs/common';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { createHmac, randomUUID } from 'crypto';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook } from './utils/signing';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

interface CapturedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A same-process HTTP server standing in for a merchant's webhook/Slack endpoint, and (via EMAIL_PROVIDER_URL) for the email provider. */
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
 * DisputeNotificationDispatcherService's per-channel delivery — the
 * @OnEvent('dispute.created')/@OnEvent('dispute.resolved') listener that
 * `dispute.created`/`dispute.resolved` never had a subscriber for before
 * (see DisputeNotificationListener's docblock; dispute-policy.e2e-spec.ts
 * already covers the auto-decision policy itself, not this delivery
 * layer). EMAIL_PROVIDER_URL is overridden to point at this file's own
 * capture server (same "set env before createTestApp(), restore in
 * afterAll" pattern as bank-transfer-rail.e2e-spec.ts's
 * BANK_TRANSFER_PROVIDER) so the email channel's request body can be
 * inspected directly, the same way WEBHOOK/SLACK targets already can be
 * by pointing disputeNotificationTarget straight at the capture server —
 * no docker-compose mock-psp round trip needed for any of the three.
 */
describe('Dispute notification channels: email/Slack/webhook (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;
  let adminToken: string;
  let capture: { port: number; requests: CapturedRequest[]; close: () => Promise<void> };
  const originalEmailProviderUrl = process.env.EMAIL_PROVIDER_URL;

  beforeAll(async () => {
    capture = await startCaptureServer();
    process.env.EMAIL_PROVIDER_URL = `http://127.0.0.1:${capture.port}/v1/email`;
    app = await createTestApp();
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
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

  async function fireDisputeCreated(pspTransactionId: string, reason = 'fraudulent'): Promise<string> {
    const disputeId = 'dp_' + uniqueId('notif');
    const body = JSON.stringify({
      id: 'evt_' + uniqueId('notif'),
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

  async function fireDisputeClosed(pspDisputeId: string, status: 'won' | 'lost'): Promise<void> {
    const body = JSON.stringify({
      id: 'evt_' + uniqueId('notif'),
      type: 'charge.dispute.closed',
      data: { object: { id: pspDisputeId, status } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, body))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
  }

  /** DisputeService.recordDispute() emits event.disputeId as its own internally-generated aggregate id, not the PSP-supplied dispute id fireDisputeCreated() faked above — this looks that real id up by paymentId, same as dispute-policy.e2e-spec.ts's getDisputeByPaymentId(). */
  async function getDisputeByPaymentId(paymentId: string) {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/disputes')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ merchantId: merchant.merchantId })
      .expect(200);
    return res.body.find((d: any) => d.paymentId === paymentId);
  }

  function setChannel(channel: 'EMAIL' | 'SLACK' | 'WEBHOOK', target: string | null) {
    return request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/dispute-notification-channel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel, target });
  }

  it('a merchant defaults to WEBHOOK with no target configured', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const found = res.body.find((m: any) => m.merchantId === merchant.merchantId);
    expect(found.disputeNotificationChannel).toBe('WEBHOOK');
    expect(found.disputeNotificationTarget).toBeNull();
  });

  it('with no target configured, a new dispute triggers no notification attempt at all', async () => {
    const before = capture.requests.length;
    const payment = await chargeImmediate(20);
    await fireDisputeCreated(payment.pspTransactionId);
    // Give the (non-existent) notification a moment it would need if it
    // were going to happen, then assert nothing arrived.
    await new Promise((r) => setTimeout(r, 300));
    expect(capture.requests.length).toBe(before);
  });

  it("WEBHOOK channel: a new dispute is delivered with a valid HMAC signature over the exact body, using the merchant's own hmac secret", async () => {
    await setChannel('WEBHOOK', `http://127.0.0.1:${capture.port}/dispute-webhook`).expect(200);
    const before = capture.requests.length;
    const payment = await chargeImmediate(25);
    await fireDisputeCreated(payment.pspTransactionId, 'fraudulent');

    await waitFor(() => capture.requests.length > before);
    const captured = capture.requests[capture.requests.length - 1];
    expect(captured.path).toBe('/dispute-webhook');

    const dispute = await getDisputeByPaymentId(payment.paymentId);
    const payload = JSON.parse(captured.body);
    expect(payload.event).toBe('dispute.created');
    expect(payload.disputeId).toBe(dispute.id);
    expect(payload.merchantId).toBe(merchant.merchantId);
    expect(payload.reason).toBe('fraudulent');

    const sigHeader = captured.headers['x-omniswitch-signature'] as string;
    expect(sigHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const [, tsPart, sigPart] = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    const expected = createHmac('sha256', merchant.hmacSecret).update(`${tsPart}.${captured.body}`).digest('hex');
    expect(sigPart).toBe(expected);
  });

  it('WEBHOOK channel: dispute.resolved is also delivered, with the outcome', async () => {
    await setChannel('WEBHOOK', `http://127.0.0.1:${capture.port}/dispute-webhook`).expect(200);
    const before = capture.requests.length;
    const payment = await chargeImmediate(9); // below the illustrative auto-accept threshold — ACCEPT is advisory only, dispute stays NEEDS_RESPONSE until resolved below
    const pspDisputeId = await fireDisputeCreated(payment.pspTransactionId, 'duplicate');
    await waitFor(() => capture.requests.length > before);

    const dispute = await getDisputeByPaymentId(payment.paymentId);
    const beforeResolved = capture.requests.length;
    await fireDisputeClosed(pspDisputeId, 'won');
    await waitFor(() => capture.requests.length > beforeResolved);

    const captured = capture.requests[capture.requests.length - 1];
    const payload = JSON.parse(captured.body);
    expect(payload.event).toBe('dispute.resolved');
    expect(payload.disputeId).toBe(dispute.id);
    expect(payload.outcome).toBe('WON');
  });

  it("SLACK channel: posts Slack's {text} shape to the configured incoming-webhook URL", async () => {
    await setChannel('SLACK', `http://127.0.0.1:${capture.port}/slack-target`).expect(200);
    const before = capture.requests.length;
    const payment = await chargeImmediate(30);
    await fireDisputeCreated(payment.pspTransactionId, 'product_not_received');
    await waitFor(() => capture.requests.length > before);

    const dispute = await getDisputeByPaymentId(payment.paymentId);
    const captured = capture.requests[capture.requests.length - 1];
    expect(captured.path).toBe('/slack-target');
    const payload = JSON.parse(captured.body);
    expect(typeof payload.text).toBe('string');
    expect(payload.text).toContain(dispute.id);
    // No HMAC header on the Slack path — the webhook URL's secrecy is the
    // access control, not a signature.
    expect(captured.headers['x-omniswitch-signature']).toBeUndefined();
  });

  it('EMAIL channel: posts {to, subject, body} to EMAIL_PROVIDER_URL/send', async () => {
    await setChannel('EMAIL', 'merchant-ops@example.com').expect(200);
    const before = capture.requests.length;
    const payment = await chargeImmediate(15);
    await fireDisputeCreated(payment.pspTransactionId, 'unrecognized');
    await waitFor(() => capture.requests.length > before);

    const dispute = await getDisputeByPaymentId(payment.paymentId);
    const captured = capture.requests[capture.requests.length - 1];
    expect(captured.path).toBe('/v1/email/send');
    const payload = JSON.parse(captured.body);
    expect(payload.to).toBe('merchant-ops@example.com');
    expect(payload.subject).toContain(dispute.id);
    expect(typeof payload.body).toBe('string');
  });

  it('clearing the target (channel unchanged) goes back to no notification being sent', async () => {
    await setChannel('WEBHOOK', `http://127.0.0.1:${capture.port}/dispute-webhook`).expect(200);
    await setChannel('WEBHOOK', null).expect(200);
    const before = capture.requests.length;
    const payment = await chargeImmediate(12);
    await fireDisputeCreated(payment.pspTransactionId);
    await new Promise((r) => setTimeout(r, 300));
    expect(capture.requests.length).toBe(before);
  });

  it('rejects an unknown channel value with 422', async () => {
    const res = await setChannel('CARRIER_PIGEON' as any, 'irrelevant');
    expect(res.status).toBe(422);
  });
});
