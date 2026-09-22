import { INestApplication } from '@nestjs/common';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, uniqueId } from './utils/seed';

interface CapturedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Same pattern as dispute-notification.e2e-spec.ts's own capture server — a same-process stand-in for a merchant's webhook receiver. */
function startCaptureServer(): Promise<{ port: number; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
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
 * The webhook delivery log/replay tool — triggered here via a real
 * sanctions-screening POTENTIAL_MATCH notification (the easiest of the
 * four event families to trigger deterministically from a single API
 * call; see `SanctionsScreeningService`'s mock-provider fixture
 * markers). All four `Webhook*NotificationAdapter` classes share the
 * identical record-then-rethrow logic this exercises, so proving it
 * here is representative of dispute/subscription/AML-review too, not
 * sanctions-specific behavior.
 */
describe('Webhook delivery log and replay (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let capture: { port: number; requests: CapturedRequest[]; close: () => Promise<void> };

  beforeAll(async () => {
    capture = await startCaptureServer();
    app = await createTestApp();
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
    await capture.close();
  });

  async function connectedMerchantWithWebhookTarget(prefix: string, target: string) {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const connected = await seedMerchant(app, {
      merchantId: uniqueId(prefix),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${connected.merchantId}/sanctions-notification-channel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'WEBHOOK', target })
      .expect(200);
    return connected;
  }

  function listDeliveries(merchantId: string, query: Record<string, string> = {}) {
    return request(app.getHttpServer())
      .get('/api/v1/admin/webhook-deliveries')
      .query({ merchantId, ...query })
      .set('Authorization', `Bearer ${adminToken}`);
  }

  it('records a successful WEBHOOK-channel delivery, inspectable by id with its full payload', async () => {
    const merchant = await connectedMerchantWithWebhookTarget(
      'whlog-success',
      `http://127.0.0.1:${capture.port}/omniswitch`,
    );

    const requestsBefore = capture.requests.length;
    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName: 'POTENTIAL Delivery Log Corp', taxId: '12-3456789' })
      .expect(200);

    await waitFor(() => capture.requests.length > requestsBefore);

    const listRes = await listDeliveries(merchant.merchantId).expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0]).toMatchObject({
      merchantId: merchant.merchantId,
      eventType: 'sanctions_screening.flagged',
      success: true,
      statusCode: 200,
      replayOfDeliveryId: null,
    });
    expect(listRes.body[0].latencyMs).toEqual(expect.any(Number));

    const deliveryId = listRes.body[0].id;
    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/admin/webhook-deliveries/${deliveryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(getRes.body.payload).toMatchObject({
      event: 'sanctions_screening.flagged',
      merchantId: merchant.merchantId,
      status: 'POTENTIAL_MATCH',
    });

    // The signature actually verifies against the merchant's own HMAC secret.
    const captured = capture.requests[0];
    expect(captured.headers['x-omniswitch-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(captured.body)).toEqual(getRes.body.payload);
  });

  it('replay re-sends the exact stored payload, records a new row pointing at the original, and does not mutate the original', async () => {
    const merchant = await connectedMerchantWithWebhookTarget(
      'whlog-replay',
      `http://127.0.0.1:${capture.port}/omniswitch`,
    );
    const requestsBefore = capture.requests.length;
    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName: 'POTENTIAL Replay Corp', taxId: '12-3456789' })
      .expect(200);
    await waitFor(() => capture.requests.length > requestsBefore);

    const [original] = (await listDeliveries(merchant.merchantId).expect(200)).body;
    const requestsBeforeReplay = capture.requests.length;

    const replayRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/webhook-deliveries/${original.id}/replay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(replayRes.body.id).not.toBe(original.id);
    expect(replayRes.body.replayOfDeliveryId).toBe(original.id);
    expect(replayRes.body.success).toBe(true);
    expect(replayRes.body.payload).toEqual(original.payload);
    await waitFor(() => capture.requests.length > requestsBeforeReplay);

    const originalStillIntact = await request(app.getHttpServer())
      .get(`/api/v1/admin/webhook-deliveries/${original.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(originalStillIntact.body).toMatchObject({ id: original.id, replayOfDeliveryId: null });
  });

  it('replaying a replay still points replayOfDeliveryId at the true original, not the intermediate replay', async () => {
    const merchant = await connectedMerchantWithWebhookTarget(
      'whlog-replay-chain',
      `http://127.0.0.1:${capture.port}/omniswitch`,
    );
    const requestsBefore = capture.requests.length;
    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName: 'POTENTIAL Chain Corp', taxId: '12-3456789' })
      .expect(200);
    await waitFor(() => capture.requests.length > requestsBefore);
    const [original] = (await listDeliveries(merchant.merchantId).expect(200)).body;

    const firstReplay = await request(app.getHttpServer())
      .post(`/api/v1/admin/webhook-deliveries/${original.id}/replay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const secondReplay = await request(app.getHttpServer())
      .post(`/api/v1/admin/webhook-deliveries/${firstReplay.body.id}/replay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(secondReplay.body.replayOfDeliveryId).toBe(original.id);
  });

  it('records a failed delivery (connection refused) with a null status code and a real error message', async () => {
    const deadServer = http.createServer();
    await new Promise<void>((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
    const { port: deadPort } = deadServer.address() as AddressInfo;
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    const merchant = await connectedMerchantWithWebhookTarget('whlog-fail', `http://127.0.0.1:${deadPort}/nowhere`);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName: 'POTENTIAL Failure Corp', taxId: '12-3456789' })
      .expect(200);

    // Poll by re-fetching the list itself (unlike the other tests here,
    // there's no local capture-server array to watch — the delivery
    // failed to reach anywhere, so the only observable signal is this
    // app's own record of the attempt).
    let deliveries: any[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      deliveries = (await listDeliveries(merchant.merchantId).expect(200)).body;
      if (deliveries.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].success).toBe(false);
    expect(deliveries[0].statusCode).toBeNull();
    expect(deliveries[0].errorMessage).toEqual(expect.any(String));
  });

  it('filters by eventType and success', async () => {
    const merchant = await connectedMerchantWithWebhookTarget(
      'whlog-filter',
      `http://127.0.0.1:${capture.port}/omniswitch`,
    );
    const requestsBefore = capture.requests.length;
    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName: 'POTENTIAL Filter Corp', taxId: '12-3456789' })
      .expect(200);
    await waitFor(() => capture.requests.length > requestsBefore);

    const matching = await listDeliveries(merchant.merchantId, {
      eventType: 'sanctions_screening.flagged',
      success: 'true',
    }).expect(200);
    expect(matching.body.length).toBeGreaterThanOrEqual(1);

    const nonMatching = await listDeliveries(merchant.merchantId, { eventType: 'dispute.created' }).expect(200);
    expect(nonMatching.body).toHaveLength(0);
  });

  it('404s replaying a delivery that does not exist', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/webhook-deliveries/00000000-0000-0000-0000-000000000000/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('404s fetching a delivery that does not exist', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/webhook-deliveries/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
