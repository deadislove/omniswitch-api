import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { resetCircuitBreakerState } from './utils/circuit-breaker';
import { MerchantEntity } from '../src/modules/merchant/merchant.entity';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Phase 2.a (passive risk observation) of the AMBIGUOUS-resolution gap —
 * see AmbiguousRiskMonitoringService's docblock and
 * docs/spec/future/ambiguous-payment-resolution.md. Purely observational:
 * flags a merchant, doesn't change how their charges are processed.
 *
 * Two describe blocks, each with its own app instance and its own
 * threshold env vars — AmbiguousRiskMonitoringService reads
 * AMBIGUOUS_RISK_DAILY_THRESHOLD/AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD in
 * its constructor (not as module-level constants — see that class'
 * comment for why), so a low test-friendly value has to be set via
 * process.env *before* createTestApp() boots the app in each block,
 * matching psp-bulkhead-isolation.e2e-spec.ts's PSP_BULKHEAD_MAX_CONCURRENT
 * pattern. A single shared app/threshold config can't cleanly test both
 * the daily-volume and consecutive-streak triggers in isolation from each
 * other.
 */
describe('Ambiguous risk monitoring — consecutive-streak trigger + manual override + auto-clear (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let merchant: SeededMerchant;
  let token: string;
  let admin: SeededMerchant;
  let adminToken: string;
  const originalDaily = process.env.AMBIGUOUS_RISK_DAILY_THRESHOLD;
  const originalConsecutive = process.env.AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD;

  beforeAll(async () => {
    // High daily threshold so it never fires ahead of the consecutive
    // check in this block's tests; low consecutive threshold so 3 real
    // ambiguous charges in a row is enough to trigger it.
    process.env.AMBIGUOUS_RISK_DAILY_THRESHOLD = '1000';
    process.env.AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD = '3';
    app = await createTestApp();
    dataSource = app.get(DataSource);
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  beforeEach(async () => {
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  afterAll(async () => {
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
    await app.close();
    if (originalDaily === undefined) delete process.env.AMBIGUOUS_RISK_DAILY_THRESHOLD;
    else process.env.AMBIGUOUS_RISK_DAILY_THRESHOLD = originalDaily;
    if (originalConsecutive === undefined) delete process.env.AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD;
    else process.env.AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD = originalConsecutive;
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

  async function chargeToAmbiguous(m: SeededMerchant, t: string): Promise<void> {
    const res = await signedCharge(m, t, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_forcetimeoutalways',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);
    expect(res.body.status).toBe('AMBIGUOUS');
  }

  it('flags a merchant after N consecutive AMBIGUOUS charges, with a reason mentioning the streak', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const t = await login(app, m.apiKeyId, m.apiKeySecret);

    await chargeToAmbiguous(m, t);
    await chargeToAmbiguous(m, t);

    // Not flagged yet — only 2 of the 3 needed.
    let listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    let summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
    expect(summary.ambiguousRiskFlagged).toBe(false);

    await chargeToAmbiguous(m, t); // 3rd — crosses the threshold

    listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
    expect(summary.ambiguousRiskFlagged).toBe(true);
    expect(summary.ambiguousRiskFlagReason).toMatch(/consecutive/);
    expect(summary.ambiguousRiskFlaggedAt).toEqual(expect.any(String));
    expect(summary.ambiguousRiskFlaggedBy).toBeNull(); // automated, not manual
    expect(summary.ambiguousRiskAutoManaged).toBe(true);
  });

  it('a merchant with an unbroken run of AMBIGUOUS-then-manually-resolved payments still counts as a streak (status alone isn\'t the signal)', async () => {
    // Sanity check on countAmbiguousIncidentsSince/findRecentAmbiguousFlags'
    // "ever ambiguous" definition — resolve the first two via Phase 1's
    // admin endpoint (moving them out of AMBIGUOUS into SUCCEEDED) before
    // the third charge, and confirm the streak still trips.
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const t = await login(app, m.apiKeyId, m.apiKeySecret);

    for (let i = 0; i < 2; i++) {
      const res = await signedCharge(m, t, {
        amount: 10,
        currency: 'USD',
        paymentMethodId: 'pm_forcetimeoutalways',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
        preferredProvider: 'STRIPE',
      }).expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/payments/${res.body.paymentId}/resolve-ambiguous`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ outcome: 'FAILED', reason: 'Confirmed no charge in Stripe dashboard' })
        .expect(200);
    }
    await chargeToAmbiguous(m, t); // 3rd, still AMBIGUOUS

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
    expect(summary.ambiguousRiskFlagged).toBe(true);
  });

  it('manual PATCH .../ambiguous-risk requires a reason (422 without it)', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/ambiguous-risk`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ flagged: true })
      .expect(422);
  });

  it('manual flag/clear records the acting admin, disables ambiguousRiskAutoManaged, and can be re-enabled', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });

    const flagRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/ambiguous-risk`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ flagged: true, reason: '3 customer complaints this week about failed charges' })
      .expect(200);
    expect(flagRes.body.ambiguousRiskFlagged).toBe(true);
    expect(flagRes.body.ambiguousRiskFlaggedBy).toBe(admin.merchantId);
    expect(flagRes.body.ambiguousRiskAutoManaged).toBe(false);

    const clearRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/ambiguous-risk`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ flagged: false, reason: 'False positive, confirmed with merchant' })
      .expect(200);
    expect(clearRes.body.ambiguousRiskFlagged).toBe(false);
    expect(clearRes.body.ambiguousRiskAutoManaged).toBe(false); // still manually managed

    const reEnableRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/ambiguous-risk-auto`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true })
      .expect(200);
    expect(reEnableRes.body.ambiguousRiskAutoManaged).toBe(true);
  });

  it('a MERCHANT-role token cannot call any of these admin endpoints', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const mToken = await login(app, m.apiKeyId, m.apiKeySecret);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/ambiguous-risk`)
      .set('Authorization', `Bearer ${mToken}`)
      .send({ flagged: true, reason: 'x' })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${m.merchantId}/ambiguous-risk-auto`)
      .set('Authorization', `Bearer ${mToken}`)
      .send({ enabled: true })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/admin/merchants/ambiguous-risk/run-auto-clear')
      .set('Authorization', `Bearer ${mToken}`)
      .expect(403);
  });

  describe('auto-clear sweep', () => {
    async function seedFlaggedMerchant(daysAgo: number, autoManaged: boolean): Promise<SeededMerchant> {
      const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
      // Raw SQL interval, not a bound JS Date/ISO string — same
      // TypeORM Date-column re-coercion gotcha
      // test/ambiguous-payment-resolution-admin.e2e-spec.ts's backdate
      // already documents, for the same "timestamp without time zone"
      // reason.
      await dataSource
        .createQueryBuilder()
        .update(MerchantEntity)
        .set({
          ambiguousRiskFlagged: true,
          ambiguousRiskFlagReason: 'seeded for auto-clear test',
          ambiguousRiskAutoManaged: autoManaged,
          ambiguousRiskFlaggedAt: () => `NOW() - INTERVAL '${daysAgo} days'`,
        })
        .where('merchant_id = :merchantId', { merchantId: m.merchantId })
        .execute();
      return m;
    }

    it('clears a flagged, auto-managed merchant whose flag is older than AMBIGUOUS_RISK_AUTO_CLEAR_DAYS', async () => {
      const m = await seedFlaggedMerchant(61, true);

      const sweepRes = await request(app.getHttpServer())
        .post('/api/v1/admin/merchants/ambiguous-risk/run-auto-clear')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(sweepRes.body.cleared).toBeGreaterThanOrEqual(1);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
      expect(summary.ambiguousRiskFlagged).toBe(false);
    });

    it('does not clear a flag younger than AMBIGUOUS_RISK_AUTO_CLEAR_DAYS', async () => {
      const m = await seedFlaggedMerchant(10, true);

      await request(app.getHttpServer())
        .post('/api/v1/admin/merchants/ambiguous-risk/run-auto-clear')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
      expect(summary.ambiguousRiskFlagged).toBe(true);
    });

    it('does not clear an old flag if it was set manually (ambiguousRiskAutoManaged: false)', async () => {
      const m = await seedFlaggedMerchant(61, false);

      await request(app.getHttpServer())
        .post('/api/v1/admin/merchants/ambiguous-risk/run-auto-clear')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
      expect(summary.ambiguousRiskFlagged).toBe(true);
    });
  });
});

describe('Ambiguous risk monitoring — daily-volume trigger (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: SeededMerchant;
  let adminToken: string;
  const originalDaily = process.env.AMBIGUOUS_RISK_DAILY_THRESHOLD;
  const originalConsecutive = process.env.AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD;

  beforeAll(async () => {
    // Low daily threshold; high consecutive threshold so the seeded
    // history + one real triggering charge can't also look like a streak
    // — isolates the volume mechanism from the consecutive one.
    process.env.AMBIGUOUS_RISK_DAILY_THRESHOLD = '5';
    process.env.AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD = '50';
    app = await createTestApp();
    dataSource = app.get(DataSource);
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
  });

  afterAll(async () => {
    await resetCircuitBreakerState(app, ['STRIPE', 'ADYEN']);
    await app.close();
    if (originalDaily === undefined) delete process.env.AMBIGUOUS_RISK_DAILY_THRESHOLD;
    else process.env.AMBIGUOUS_RISK_DAILY_THRESHOLD = originalDaily;
    if (originalConsecutive === undefined) delete process.env.AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD;
    else process.env.AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD = originalConsecutive;
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

  it('flags a merchant once trailing-24h AMBIGUOUS incidents exceed the daily threshold, with a reason mentioning the window', async () => {
    const m = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const t = await login(app, m.apiKeyId, m.apiKeySecret);

    // Seed 5 historical "ever ambiguous" payments directly — alternating
    // with a SUCCEEDED row between each so this never reads as a
    // consecutive streak, isolating the volume mechanism. Real 5x
    // timeout-retry charges here would take several minutes; this is
    // testing the counting/threshold logic, not the charge path itself
    // (already covered by ambiguous-payment-outcome.e2e-spec.ts).
    for (let i = 0; i < 5; i++) {
      const ambiguous = new PaymentEntity();
      ambiguous.id = randomUUID();
      ambiguous.merchantId = m.merchantId;
      ambiguous.amountMinorUnits = '1000';
      ambiguous.currencyCode = 'USD';
      ambiguous.currencyMinorUnits = 2;
      ambiguous.status = 'AMBIGUOUS' as any;
      ambiguous.idempotencyKey = randomUUID();
      ambiguous.refunds = [];
      ambiguous.captures = [];
      await dataSource.getRepository(PaymentEntity).save(ambiguous);

      const succeeded = new PaymentEntity();
      succeeded.id = randomUUID();
      succeeded.merchantId = m.merchantId;
      succeeded.amountMinorUnits = '1000';
      succeeded.currencyCode = 'USD';
      succeeded.currencyMinorUnits = 2;
      succeeded.status = 'SUCCEEDED' as any;
      succeeded.idempotencyKey = randomUUID();
      succeeded.refunds = [];
      succeeded.captures = [];
      await dataSource.getRepository(PaymentEntity).save(succeeded);
    }

    // 6th real ambiguous incident — the one that actually triggers
    // evaluate() through the production code path (PaymentCheckoutSaga.
    // compensate_markAmbiguous()), same as every other AMBIGUOUS-creation
    // test in this suite.
    const res = await signedCharge(m, t, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_forcetimeoutalways',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);
    expect(res.body.status).toBe('AMBIGUOUS');

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const summary = listRes.body.find((x: any) => x.merchantId === m.merchantId);
    expect(summary.ambiguousRiskFlagged).toBe(true);
    expect(summary.ambiguousRiskFlagReason).toMatch(/trailing 24 hours/);
  });
});
