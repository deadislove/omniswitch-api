import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, uniqueId, login } from './utils/seed';

/**
 * Exercises MATCH termination-for-cause reporting against the default
 * `MockMatchReportingAdapter`, which hits `scripts/mock-psp/server.js`'s
 * `/match/report` endpoint — deterministic by fixture marker in `reason`
 * ("FAIL_REPORT" simulates a provider-side filing failure).
 */
describe('MATCH termination reporting (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
  });

  function getMerchant(merchantId: string) {
    return request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .then((res) => res.body.find((m: any) => m.merchantId === merchantId));
  }

  it('terminates for cause: deactivates, records the MATCH reason code, and files a report', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('terminate') });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/terminate-for-cause`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonCode: '04', reason: 'Dispute rate stayed EXCESSIVE for 3 consecutive sweeps' })
      .expect(200);

    expect(res.body.isActive).toBe(false);
    expect(res.body.matchTerminatedForCause).toBe(true);
    expect(res.body.matchReasonCode).toBe('04');
    expect(res.body.matchTerminatedBy).toEqual(expect.any(String));
    expect(res.body.matchTerminatedAt).toEqual(expect.any(String));
    expect(res.body.matchReportedAt).toEqual(expect.any(String));
    expect(res.body.matchReportId).toEqual(expect.any(String));
  });

  it('revokes all active sessions on termination, same as an ordinary deactivation', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('terminate-revoke') });
    const merchantToken = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/terminate-for-cause`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonCode: '03', reason: 'Confirmed laundering activity' })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/delegations')
      .set('Authorization', `Bearer ${merchantToken}`)
      .expect(401);
  });

  it('rejects a reasonCode outside the MATCH taxonomy', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('terminate-bad-code') });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/terminate-for-cause`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonCode: '99', reason: 'Not a real code' });

    expect(res.status).toBe(422);
  });

  it('rejects a termination with an empty reason', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('terminate-empty-reason') });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/terminate-for-cause`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonCode: '04', reason: '' });

    expect(res.status).toBe(422);
  });

  it('records the termination even when the MATCH filing itself fails, and leaves matchReportedAt null', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('terminate-file-fail') });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/terminate-for-cause`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonCode: '11', reason: 'Illegal transactions — FAIL_REPORT' })
      .expect(200);

    expect(res.body.isActive).toBe(false);
    expect(res.body.matchTerminatedForCause).toBe(true);
    expect(res.body.matchReportedAt).toBeNull();
    expect(res.body.matchReportId).toBeNull();
  });

  it('POST .../match/report surfaces a still-failing filing without repeating the termination', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('terminate-retry') });

    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/terminate-for-cause`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonCode: '11', reason: 'Illegal transactions — FAIL_REPORT' })
      .expect(200);

    let merchantRow = await getMerchant(merchant.merchantId);
    expect(merchantRow.matchReportedAt).toBeNull();
    const terminatedAt = merchantRow.matchTerminatedAt;

    // The stored reason still carries the mock's FAIL_REPORT marker, so
    // the retry hits the same simulated provider failure. Unlike
    // terminateForCause()'s own try/catch (which swallows this to avoid
    // blocking the termination decision), this endpoint is a caller
    // explicitly asking for a retry and should see the failure directly.
    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/match/report`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(500);

    merchantRow = await getMerchant(merchant.merchantId);
    expect(merchantRow.matchTerminatedAt).toBe(terminatedAt);
    expect(merchantRow.matchReportedAt).toBeNull();
  });

  it('POST .../match/report rejects a merchant that was never terminated for cause', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('retry-never-terminated') });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/match/report`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NOT_TERMINATED_FOR_CAUSE');
  });

  it('MERCHANT-role callers cannot terminate for cause', async () => {
    const admin = await seedMerchant(app, { merchantId: uniqueId('terminate-forbidden') });
    const merchantToken = await login(app, admin.apiKeyId, admin.apiKeySecret);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${admin.merchantId}/terminate-for-cause`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ reasonCode: '04', reason: 'Attempted self-termination' });

    expect(res.status).toBe(403);
  });
});
