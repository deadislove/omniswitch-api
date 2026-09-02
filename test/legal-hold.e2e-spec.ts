import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { archivePayments } from '../src/jobs/run-archiving-job';
import { AppDataSource } from '../src/database/data-source';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Legal hold (Phase 3 follow-up #5 — see docs/compliance/data-
 * retention.md). Exercises the actual admin HTTP surface
 * (LegalHoldAdminController), not LegalHoldService directly — this is
 * the one piece of the whole data-retention feature set that's reached
 * over HTTP rather than as a standalone job, so it gets its own e2e
 * spec instead of living in data-retention-jobs.e2e-spec.ts alongside
 * the archiving/deletion/partition-maintenance jobs.
 */
describe('Legal hold (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let merchant: SeededMerchant;
  let token: string;
  let admin: SeededMerchant;
  let adminToken: string;
  const archivedPaymentIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    // archivePayments() (src/jobs/run-archiving-job.ts) is a standalone
    // script written to run outside the Nest DI container — it uses its
    // own plain `AppDataSource`, never the app's NestJS-managed
    // `DataSource` above. Same physical Postgres, separate connection;
    // both need to be live for this spec.
    await AppDataSource.initialize();
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    ({ admin, adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    if (archivedPaymentIds.length > 0) {
      await dataSource.query(`DELETE FROM "archive"."payments" WHERE "id" = ANY($1)`, [archivedPaymentIds]);
    }
    await AppDataSource.destroy();
    await app.close();
  });

  async function chargeImmediate(): Promise<{ paymentId: string }> {
    const bodyObj = { amount: 25, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN };
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
    return { paymentId: res.body.paymentId };
  }

  async function seedArchivedPayment(): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO "archive"."payments" (
         "id", "merchant_id", "amount_minor_units", "currency_code", "currency_minor_units",
         "status", "idempotency_key", "created_at", "updated_at"
       ) VALUES ($1, $2, 2500, 'USD', 2, 'SUCCEEDED', $3, now() - interval '200 days', now())`,
      [id, merchant.merchantId, `idem_${id}`],
    );
    archivedPaymentIds.push(id);
    return id;
  }

  it('places a hold on a live payment, which then excludes it from archiving', async () => {
    const { paymentId } = await chargeImmediate();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${paymentId}/legal-hold`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toEqual({ id: paymentId, legalHold: true, location: 'live' });

    // Backdate past the archive threshold directly — this payment
    // would otherwise be immediately archive-eligible.
    await dataSource.query(`UPDATE "payments" SET created_at = now() - interval '200 days' WHERE id = $1`, [paymentId]);

    const before = await archivePayments();
    void before;
    const stillLive = await dataSource.query(`SELECT "id" FROM "payments" WHERE "id" = $1`, [paymentId]);
    expect(stillLive).toHaveLength(1);
    const notArchived = await dataSource.query(`SELECT "id" FROM "archive"."payments" WHERE "id" = $1`, [paymentId]);
    expect(notArchived).toHaveLength(0);
  });

  it('releases a hold, after which the payment becomes archive-eligible again', async () => {
    const { paymentId } = await chargeImmediate();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${paymentId}/legal-hold`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await dataSource.query(`UPDATE "payments" SET created_at = now() - interval '200 days' WHERE id = $1`, [paymentId]);

    const releaseRes = await request(app.getHttpServer())
      .delete(`/api/v1/admin/payments/${paymentId}/legal-hold`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(releaseRes.body).toEqual({ id: paymentId, legalHold: false, location: 'live' });

    await archivePayments();
    const archived = await dataSource.query(`SELECT "id" FROM "archive"."payments" WHERE "id" = $1`, [paymentId]);
    expect(archived).toHaveLength(1);
    archivedPaymentIds.push(paymentId);
  });

  it('placing a hold on an already-archived payment restores it to the live table', async () => {
    const paymentId = await seedArchivedPayment();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${paymentId}/legal-hold`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toEqual({ id: paymentId, legalHold: true, location: 'restored-from-archive' });

    const liveRow = await dataSource.query(`SELECT "id", "legal_hold" FROM "payments" WHERE "id" = $1`, [paymentId]);
    expect(liveRow).toHaveLength(1);
    expect(liveRow[0].legal_hold).toBe(true);
    const archivedRow = await dataSource.query(`SELECT "id" FROM "archive"."payments" WHERE "id" = $1`, [paymentId]);
    expect(archivedRow).toHaveLength(0);
  });

  it('returns 404 placing a hold on a payment that does not exist anywhere', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${randomUUID()}/legal-hold`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('returns 404 releasing a hold on a payment that is not currently live', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/payments/${randomUUID()}/legal-hold`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
