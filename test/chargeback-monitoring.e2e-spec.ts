import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';
import { DisputeEntity } from '../src/modules/payment/adapters/persistence/entities/dispute.entity';
import { ChargebackMonitoringService } from '../src/modules/payment/application/services/chargeback-monitoring.service';

interface CapturedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Same same-process capture server as aml-review-monitoring.e2e-spec.ts — see its docblock. */
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
 * Chargeback Monitoring (VDMP/ECP) — see ChargebackMonitoringService's
 * docblock. Thresholds overridden here to round, easy-to-seed numbers
 * (10%/30% instead of the real-world-adjacent 0.65%/1.8% defaults) —
 * same "override via env in beforeAll, before createTestApp()
 * constructs the singleton" reasoning AmlReviewMonitoringService's own
 * e2e test uses, and for the same documented reason (the constructor
 * reads these once, at DI-container-build time).
 *
 * No inline trigger point exists for this service (unlike
 * RiskTieringService, which DisputeService.recordDispute() calls
 * inline for its own auto-decision purposes) — every test below calls
 * ChargebackMonitoringService.evaluateMerchant() directly, the same way
 * production code would only ever reach it via the daily
 * @Cron sweep.
 */
describe('Chargeback monitoring program — dispute-ratio tiers + notification (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: SeededMerchant;
  let adminToken: string;
  let capture: { port: number; requests: CapturedRequest[]; close: () => Promise<void> };
  let monitoringService: ChargebackMonitoringService;
  const originalMonitoring = process.env.CHARGEBACK_MONITORING_THRESHOLD;
  const originalExcessive = process.env.CHARGEBACK_EXCESSIVE_THRESHOLD;
  const originalMinCharges = process.env.CHARGEBACK_MONITORING_MIN_SETTLED_CHARGES;

  beforeAll(async () => {
    process.env.CHARGEBACK_MONITORING_THRESHOLD = '0.1'; // >10%
    process.env.CHARGEBACK_EXCESSIVE_THRESHOLD = '0.3'; // >30%
    process.env.CHARGEBACK_MONITORING_MIN_SETTLED_CHARGES = '5';
    capture = await startCaptureServer();
    app = await createTestApp();
    dataSource = app.get(DataSource);
    monitoringService = app.get(ChargebackMonitoringService);
    ({ admin, adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
    await capture.close();
    if (originalMonitoring === undefined) delete process.env.CHARGEBACK_MONITORING_THRESHOLD;
    else process.env.CHARGEBACK_MONITORING_THRESHOLD = originalMonitoring;
    if (originalExcessive === undefined) delete process.env.CHARGEBACK_EXCESSIVE_THRESHOLD;
    else process.env.CHARGEBACK_EXCESSIVE_THRESHOLD = originalExcessive;
    if (originalMinCharges === undefined) delete process.env.CHARGEBACK_MONITORING_MIN_SETTLED_CHARGES;
    else process.env.CHARGEBACK_MONITORING_MIN_SETTLED_CHARGES = originalMinCharges;
  });

  /** Direct entity inserts, same "testing the counting/tiering logic, not the charge/webhook path itself" reasoning as aml-review-monitoring.e2e-spec.ts's seedHistoricalHardDecline(). */
  async function seedSettledPayment(merchantId: string): Promise<string> {
    const payment = new PaymentEntity();
    payment.id = randomUUID();
    payment.merchantId = merchantId;
    payment.amountMinorUnits = '1000';
    payment.currencyCode = 'USD';
    payment.currencyMinorUnits = 2;
    payment.status = 'SUCCEEDED' as any;
    payment.idempotencyKey = randomUUID();
    payment.pspProvider = 'STRIPE' as any;
    payment.refunds = [];
    payment.captures = [];
    await dataSource.getRepository(PaymentEntity).save(payment);
    return payment.id;
  }

  async function seedDispute(merchantId: string, paymentId: string): Promise<void> {
    const dispute = new DisputeEntity();
    dispute.id = randomUUID();
    dispute.paymentId = paymentId;
    dispute.merchantId = merchantId;
    dispute.pspProvider = 'STRIPE' as any;
    dispute.pspDisputeId = 'dp_' + uniqueId('chargeback-monitoring');
    dispute.amountMinorUnits = '1000';
    dispute.currencyCode = 'USD';
    dispute.reason = 'fraudulent';
    dispute.status = 'NEEDS_RESPONSE';
    dispute.respondBy = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await dataSource.getRepository(DisputeEntity).save(dispute);
  }

  async function getSummary(merchantId: string): Promise<any> {
    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return listRes.body.find((x: any) => x.merchantId === merchantId);
  }

  it('stays NONE below the minimum settled-charge sample size, even at a high dispute ratio', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const paymentIds = await Promise.all([1, 2, 3].map(() => seedSettledPayment(m.merchantId)));
    await seedDispute(m.merchantId, paymentIds[0]);
    await seedDispute(m.merchantId, paymentIds[1]); // 2/3 = 67% — would be EXCESSIVE, if the sample were large enough

    const result = await monitoringService.evaluateMerchant(m.merchantId, new Date());
    expect(result).toBeNull();

    const summary = await getSummary(m.merchantId);
    expect(summary.chargebackMonitoringTier).toBe('NONE');
  });

  it('stays NONE below the monitoring threshold', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    for (let i = 0; i < 5; i++) await seedSettledPayment(m.merchantId);
    // 0 disputes / 5 settled = 0%

    await monitoringService.evaluateMerchant(m.merchantId, new Date());
    const summary = await getSummary(m.merchantId);
    expect(summary.chargebackMonitoringTier).toBe('NONE');
  });

  it('escalates to MONITORING once the dispute ratio crosses 10%, and fires a real notification', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const paymentIds = await Promise.all([1, 2, 3, 4, 5].map(() => seedSettledPayment(m.merchantId)));
    await seedDispute(m.merchantId, paymentIds[0]); // 1/5 = 20% -> MONITORING

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring-notification-channel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'WEBHOOK', target: `http://127.0.0.1:${capture.port}/chargeback-monitoring-webhook` })
      .expect(200);

    const before = capture.requests.length;
    const result = await monitoringService.evaluateMerchant(m.merchantId, new Date());
    expect(result).toEqual({ tier: 'MONITORING', changed: true });

    await waitFor(() => capture.requests.length > before);
    const captured = capture.requests[capture.requests.length - 1];
    expect(captured.path).toBe('/chargeback-monitoring-webhook');
    const payload = JSON.parse(captured.body);
    expect(payload.event).toBe('chargeback_monitoring.tier_changed');
    expect(payload.merchantId).toBe(m.merchantId);
    expect(payload.previousTier).toBe('NONE');
    expect(payload.tier).toBe('MONITORING');
    expect(payload.disputeCount).toBe(1);
    expect(payload.settledCharges).toBe(5);

    const summary = await getSummary(m.merchantId);
    expect(summary.chargebackMonitoringTier).toBe('MONITORING');
    expect(summary.chargebackMonitoringReason).toMatch(/20\.00% dispute rate/);
    expect(summary.chargebackMonitoringFlaggedBy).toBeNull(); // automated, not manual
    expect(summary.chargebackMonitoringAutoManaged).toBe(true);
  });

  it('escalates further to EXCESSIVE once the ratio crosses 30%, and notifies again (unlike AmlReviewMonitoringService, which stays silent while already flagged)', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const paymentIds = await Promise.all([1, 2, 3, 4, 5].map(() => seedSettledPayment(m.merchantId)));
    await seedDispute(m.merchantId, paymentIds[0]);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring-notification-channel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'WEBHOOK', target: `http://127.0.0.1:${capture.port}/chargeback-monitoring-webhook` })
      .expect(200);
    await monitoringService.evaluateMerchant(m.merchantId, new Date()); // -> MONITORING
    const afterFirst = capture.requests.length;

    await seedDispute(m.merchantId, paymentIds[1]);
    await seedDispute(m.merchantId, paymentIds[2]); // 3/5 = 60% -> EXCESSIVE

    const result = await monitoringService.evaluateMerchant(m.merchantId, new Date());
    expect(result).toEqual({ tier: 'EXCESSIVE', changed: true });

    await waitFor(() => capture.requests.length > afterFirst);
    const captured = capture.requests[capture.requests.length - 1];
    const payload = JSON.parse(captured.body);
    expect(payload.previousTier).toBe('MONITORING');
    expect(payload.tier).toBe('EXCESSIVE');

    const summary = await getSummary(m.merchantId);
    expect(summary.chargebackMonitoringTier).toBe('EXCESSIVE');
  });

  it('de-escalates, and notifies for the good-news direction too', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const paymentIds = await Promise.all([1, 2, 3, 4, 5].map(() => seedSettledPayment(m.merchantId)));
    await seedDispute(m.merchantId, paymentIds[0]);
    await seedDispute(m.merchantId, paymentIds[1]); // 2/5 = 40% -> EXCESSIVE
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring-notification-channel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'WEBHOOK', target: `http://127.0.0.1:${capture.port}/chargeback-monitoring-webhook` })
      .expect(200);
    await monitoringService.evaluateMerchant(m.merchantId, new Date());
    expect((await getSummary(m.merchantId)).chargebackMonitoringTier).toBe('EXCESSIVE');
    const afterFirst = capture.requests.length;

    // Diluting the ratio with more clean settled charges, no new disputes
    // — same 2 disputes, now 2/15 = 13.3% -> MONITORING.
    for (let i = 0; i < 10; i++) await seedSettledPayment(m.merchantId);

    const result = await monitoringService.evaluateMerchant(m.merchantId, new Date());
    expect(result).toEqual({ tier: 'MONITORING', changed: true });

    await waitFor(() => capture.requests.length > afterFirst);
    const payload = JSON.parse(capture.requests[capture.requests.length - 1].body);
    expect(payload.previousTier).toBe('EXCESSIVE');
    expect(payload.tier).toBe('MONITORING');
  });

  it('a merchant with chargebackMonitoringAutoManaged disabled is skipped entirely by evaluateMerchant()', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const paymentIds = await Promise.all([1, 2, 3, 4, 5].map(() => seedSettledPayment(m.merchantId)));
    await seedDispute(m.merchantId, paymentIds[0]);
    await seedDispute(m.merchantId, paymentIds[1]); // would be EXCESSIVE

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tier: 'NONE', reason: 'Manually cleared pending investigation' })
      .expect(200);

    const result = await monitoringService.evaluateMerchant(m.merchantId, new Date());
    expect(result).toBeNull();
    expect((await getSummary(m.merchantId)).chargebackMonitoringTier).toBe('NONE');
  });

  it('manual PATCH .../chargeback-monitoring requires a reason (422 without it)', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tier: 'MONITORING' })
      .expect(422);
  });

  it('rejects an unknown tier value with 422', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tier: 'SUPER_EXCESSIVE', reason: 'x' })
      .expect(422);
  });

  it('manual tier set records the acting admin, disables chargebackMonitoringAutoManaged, and can be re-enabled', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });

    const setRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tier: 'MONITORING', reason: 'Manually placed pending network correspondence' })
      .expect(200);
    expect(setRes.body.chargebackMonitoringTier).toBe('MONITORING');
    expect(setRes.body.chargebackMonitoringFlaggedBy).toBe(admin.merchantId);
    expect(setRes.body.chargebackMonitoringAutoManaged).toBe(false);

    const clearRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tier: 'NONE', reason: 'Network correspondence resolved' })
      .expect(200);
    expect(clearRes.body.chargebackMonitoringTier).toBe('NONE');
    expect(clearRes.body.chargebackMonitoringAutoManaged).toBe(false); // still manually managed

    const reEnableRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring-auto`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true })
      .expect(200);
    expect(reEnableRes.body.chargebackMonitoringAutoManaged).toBe(true);
  });

  it('a MERCHANT-role token cannot call any of these admin endpoints', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const mToken = await login(app, m.apiKeyId, m.apiKeySecret);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring`)
      .set('Authorization', `Bearer ${mToken}`)
      .send({ tier: 'MONITORING', reason: 'x' })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring-auto`)
      .set('Authorization', `Bearer ${mToken}`)
      .send({ enabled: true })
      .expect(403);
  });

  it('rejects an unknown notification channel value with 422', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/chargeback-monitoring-notification-channel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ channel: 'CARRIER_PIGEON', target: 'irrelevant' });
    expect(res.status).toBe(422);
  });
});
