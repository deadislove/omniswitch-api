import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { resetCircuitBreakerState } from './utils/circuit-breaker';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';
import { LedgerOutboxEntity } from '../src/modules/payment/adapters/persistence/entities/ledger-outbox.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Phase 1 (manual resolution + visibility) of the AMBIGUOUS-resolution
 * gap — see AmbiguousPaymentService's docblock and
 * docs/business-domain/payment-lifecycle.md's note on AMBIGUOUS. There
 * is still no *automated* way out of AMBIGUOUS (that's the not-yet-built
 * Phase 2) — this covers the admin-facing manual escape hatch this phase
 * actually adds: list AMBIGUOUS payments, and resolve one to
 * SUCCEEDED/FAILED after an operator has checked the PSP directly.
 *
 * Every test here forces STRIPE into AMBIGUOUS via `pm_forcetimeoutalways`
 * (primary attempt + one same-provider retry, both timing out) — two
 * STRIPE failures per call, enough across this file's ~6 calls to reach
 * RedisCircuitBreakerService's FAILURE_THRESHOLD (5) and trip STRIPE's
 * circuit OPEN as a side effect — same category of leak
 * `ambiguous-payment-outcome.e2e-spec.ts`/`psp-bulkhead-isolation.e2e-spec.ts`
 * also reset for. Reset before and after (and, since this file alone makes enough such
 * calls to cross FAILURE_THRESHOLD within itself, before *every* test
 * too) so it doesn't happen here or leak into whichever e2e file runs
 * next (maxWorkers: 1, no Redis flush between files).
 */
describe('Ambiguous payment admin resolution (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let merchant: SeededMerchant;
  let token: string;
  let admin: SeededMerchant;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    ({ admin, adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  beforeEach(async () => {
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  afterAll(async () => {
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
    await app.close();
  });

  function signedCharge(body: object) {
    const path = '/api/v1/payments/charge';
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

  async function chargeToAmbiguous(amount = 10): Promise<string> {
    const res = await signedCharge({
      amount,
      currency: 'USD',
      paymentMethodId: 'pm_forcetimeoutalways',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);
    expect(res.body.status).toBe('AMBIGUOUS');
    return res.body.paymentId;
  }

  async function ledgerEntries(paymentId: string): Promise<any[]> {
    const queryRunner = dataSource.createQueryRunner('master');
    let events: LedgerOutboxEntity[];
    try {
      events = await queryRunner.manager.find(LedgerOutboxEntity, { where: { paymentId }, order: { createdAt: 'ASC' } });
    } finally {
      await queryRunner.release();
    }
    return events.flatMap((e) => e.entries as any[]);
  }

  it('lists a currently AMBIGUOUS payment via GET /admin/payments/ambiguous', async () => {
    const paymentId = await chargeToAmbiguous();

    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/payments/ambiguous')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const found = res.body.find((p: any) => p.paymentId === paymentId);
    expect(found).toBeDefined();
    expect(found.merchantId).toBe(merchant.merchantId);
    expect(found.pspProvider).toBe('STRIPE');
    expect(found.ageMinutes).toBeGreaterThanOrEqual(0);
  });

  it('olderThanMinutes filters out a payment that just became ambiguous', async () => {
    const paymentId = await chargeToAmbiguous();

    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/payments/ambiguous?olderThanMinutes=60')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.find((p: any) => p.paymentId === paymentId)).toBeUndefined();

    // Backdate it past the 60-minute cutoff and confirm it now shows up —
    // proves the filter is actually reading createdAt, not just present/absent.
    // Computed in SQL (`created_at - INTERVAL`), not by binding a JS Date/
    // ISO-string value for the `createdAt` column — TypeORM's query
    // builder re-coerces any bound value for a Date-typed column back
    // through the driver's own Date serialization (which uses this
    // process's local timezone offset for a `timestamp without time zone`
    // column, the same gotcha PaymentTypeOrmRepository.findByProviderAndDateRange()
    // documents for WHERE-clause parameters), so even an already-UTC ISO
    // string gets re-broken. A raw SQL expression sidesteps the JS/driver
    // round-trip entirely.
    await dataSource
      .createQueryBuilder()
      .update(PaymentEntity)
      .set({ createdAt: () => `created_at - INTERVAL '61 minutes'` })
      .where('id = :id', { id: paymentId })
      .execute();
    const res2 = await request(app.getHttpServer())
      .get('/api/v1/admin/payments/ambiguous?olderThanMinutes=60')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res2.body.find((p: any) => p.paymentId === paymentId)).toBeDefined();
  });

  it('resolving to SUCCEEDED requires pspTransactionId (422 without it)', async () => {
    const paymentId = await chargeToAmbiguous();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${paymentId}/resolve-ambiguous`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outcome: 'SUCCEEDED', reason: 'Checked Stripe dashboard' })
      .expect(422);
    expect(res.body.code).toBe('PSP_TRANSACTION_ID_REQUIRED');
  });

  it('requires a non-empty reason (422 without it, DTO validation)', async () => {
    const paymentId = await chargeToAmbiguous();

    await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${paymentId}/resolve-ambiguous`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outcome: 'FAILED' })
      .expect(422);
  });

  it('resolving to SUCCEEDED with pspTransactionId books ledger entries exactly like a webhook confirmation would', async () => {
    const paymentId = await chargeToAmbiguous(25);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${paymentId}/resolve-ambiguous`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outcome: 'SUCCEEDED', pspTransactionId: 'pi_manually_confirmed_123', reason: 'Confirmed in Stripe dashboard' })
      .expect(200);

    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.pspTransactionId).toBe('pi_manually_confirmed_123');
    expect(res.body.ambiguousResolvedBy).toBe(admin.merchantId);
    expect(res.body.ambiguousResolvedReason).toBe('Confirmed in Stripe dashboard');
    expect(res.body.ambiguousResolvedAt).toEqual(expect.any(String));

    const entries = await ledgerEntries(paymentId);
    expect(entries.length).toBeGreaterThan(0);
    const merchantCredit = entries.find((e) => e.accountType === 'MERCHANT' && e.entryType === 'CREDIT');
    expect(merchantCredit).toBeDefined();

    // No longer AMBIGUOUS — the list endpoint must not return it anymore.
    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/payments/ambiguous')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(listRes.body.find((p: any) => p.paymentId === paymentId)).toBeUndefined();
  });

  it('resolving to FAILED records no ledger entries and needs no pspTransactionId', async () => {
    const paymentId = await chargeToAmbiguous();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${paymentId}/resolve-ambiguous`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outcome: 'FAILED', reason: 'Confirmed no charge in Stripe dashboard' })
      .expect(200);

    expect(res.body.status).toBe('FAILED');
    expect(res.body.ambiguousResolvedBy).toBe(admin.merchantId);
    expect(res.body.ambiguousResolvedReason).toBe('Confirmed no charge in Stripe dashboard');
    expect(await ledgerEntries(paymentId)).toHaveLength(0);
  });

  it('rejects resolving a payment that is not AMBIGUOUS (409)', async () => {
    const chargeRes = await signedCharge({
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);
    expect(chargeRes.body.status).toBe('SUCCEEDED');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${chargeRes.body.paymentId}/resolve-ambiguous`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outcome: 'FAILED', reason: 'Checked Stripe dashboard' })
      .expect(409);
    expect(res.body.code).toBe('PAYMENT_NOT_AMBIGUOUS');
  });

  it('rejects resolving an unknown payment (404)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${randomUUID()}/resolve-ambiguous`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outcome: 'FAILED', reason: 'Checked Stripe dashboard' })
      .expect(404);
  });

  it('a MERCHANT-role token cannot call the admin endpoints', async () => {
    const paymentId = await chargeToAmbiguous();

    await request(app.getHttpServer())
      .get('/api/v1/admin/payments/ambiguous')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${paymentId}/resolve-ambiguous`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'FAILED' })
      .expect(403);
  });
});
