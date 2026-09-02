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
 * Automated PSP-query resolution for AMBIGUOUS payments — see
 * AmbiguousPaymentService.runAutoResolutionSweep()'s docblock. Asks the
 * PSP itself via PSPAdapterPort.queryOutcome() (a read-only lookup keyed
 * by idempotency key, not a new charge attempt — this system never
 * persists the card reference past the original request) rather than
 * requiring an operator to check the PSP's dashboard by hand, the way
 * test/ambiguous-payment-resolution-admin.e2e-spec.ts's manual escape
 * hatch does.
 *
 * `pm_forcetimeoutresolvesucceed`/`pm_forcetimeoutresolvefail` are
 * mock-psp markers that time out on every attempt (same as
 * `pm_forcetimeoutalways`, so the payment genuinely reaches AMBIGUOUS
 * through the existing mechanism) but record what the PSP "actually"
 * decided, revealed later by a queryOutcome() lookup — see
 * scripts/mock-psp/server.js's maybeRecordTimeoutResolution().
 *
 * AMBIGUOUS_AUTO_RESOLUTION_MAX_ATTEMPTS/MIN_AGE_MINUTES are read in
 * AmbiguousPaymentService's constructor, so — same pattern as
 * ambiguous-risk-monitoring.e2e-spec.ts — they're set via process.env
 * before createTestApp() boots the app. MIN_AGE_MINUTES=1 (not 0: this
 * codebase's `Number(process.env.X) || default` config-reading
 * convention treats '0' as falsy, same as PSP_BULKHEAD_MAX_CONCURRENT's
 * pattern elsewhere, so a real positive value plus backdating createdAt
 * via the established raw-SQL-INTERVAL technique — see
 * ambiguous-risk-monitoring.e2e-spec.ts's seedFlaggedMerchant() — is used
 * instead of relying on a same-instant window).
 *
 * Every AMBIGUOUS-inducing charge here is two STRIPE failures (primary +
 * same-provider retry), enough across this file's calls to reach
 * RedisCircuitBreakerService's FAILURE_THRESHOLD (5) — reset before/after
 * and before every test, same as the other AMBIGUOUS e2e files.
 */
describe('Ambiguous payment auto-resolution (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let merchant: SeededMerchant;
  let token: string;
  let admin: SeededMerchant;
  let adminToken: string;
  const originalMaxAttempts = process.env.AMBIGUOUS_AUTO_RESOLUTION_MAX_ATTEMPTS;
  const originalMinAge = process.env.AMBIGUOUS_AUTO_RESOLUTION_MIN_AGE_MINUTES;

  beforeAll(async () => {
    process.env.AMBIGUOUS_AUTO_RESOLUTION_MAX_ATTEMPTS = '2';
    process.env.AMBIGUOUS_AUTO_RESOLUTION_MIN_AGE_MINUTES = '1';
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
    if (originalMaxAttempts === undefined) delete process.env.AMBIGUOUS_AUTO_RESOLUTION_MAX_ATTEMPTS;
    else process.env.AMBIGUOUS_AUTO_RESOLUTION_MAX_ATTEMPTS = originalMaxAttempts;
    if (originalMinAge === undefined) delete process.env.AMBIGUOUS_AUTO_RESOLUTION_MIN_AGE_MINUTES;
    else process.env.AMBIGUOUS_AUTO_RESOLUTION_MIN_AGE_MINUTES = originalMinAge;
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

  async function chargeToAmbiguous(paymentMethodId: string, amount = 10): Promise<string> {
    const res = await signedCharge({
      amount,
      currency: 'USD',
      paymentMethodId,
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);
    expect(res.body.status).toBe('AMBIGUOUS');
    return res.body.paymentId;
  }

  async function backdate(paymentId: string, minutesAgo: number): Promise<void> {
    // Raw SQL INTERVAL, not a bound JS Date/ISO string — same TypeORM
    // Date-column re-coercion gotcha
    // ambiguous-payment-resolution-admin.e2e-spec.ts's backdate already
    // documents, for the same "timestamp without time zone" reason.
    await dataSource
      .createQueryBuilder()
      .update(PaymentEntity)
      .set({ createdAt: () => `created_at - INTERVAL '${minutesAgo} minutes'` })
      .where('id = :id', { id: paymentId })
      .execute();
  }

  async function getPaymentRow(paymentId: string): Promise<PaymentEntity> {
    const queryRunner = dataSource.createQueryRunner('master');
    let entity: PaymentEntity | null;
    try {
      entity = await queryRunner.manager.findOne(PaymentEntity, { where: { id: paymentId } });
    } finally {
      await queryRunner.release();
    }
    if (!entity) throw new Error(`Payment ${paymentId} not found`);
    return entity;
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

  function triggerSweep() {
    return request(app.getHttpServer())
      .post('/api/v1/admin/payments/ambiguous/run-auto-resolution')
      .set('Authorization', `Bearer ${adminToken}`);
  }

  it('auto-resolves to SUCCEEDED when the PSP query reveals the charge went through, and books ledger entries', async () => {
    const paymentId = await chargeToAmbiguous('pm_forcetimeoutresolvesucceed', 25);
    await backdate(paymentId, 2);

    const sweepRes = await triggerSweep().expect(200);
    expect(sweepRes.body.succeeded).toBeGreaterThanOrEqual(1);

    const row = await getPaymentRow(paymentId);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.pspTransactionId).toEqual(expect.any(String));
    // Automated, not manual — must not fabricate a Phase 1-style manual
    // audit trail it never actually had.
    expect(row.ambiguousResolvedBy).toBeFalsy();

    const entries = await ledgerEntries(paymentId);
    expect(entries.length).toBeGreaterThan(0);
    const merchantCredit = entries.find((e) => e.accountType === 'MERCHANT' && e.entryType === 'CREDIT');
    expect(merchantCredit).toBeDefined();

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/payments/ambiguous')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(listRes.body.find((p: any) => p.paymentId === paymentId)).toBeUndefined();
  });

  it('auto-resolves to FAILED when the PSP query reveals no charge went through, with no ledger entries', async () => {
    const paymentId = await chargeToAmbiguous('pm_forcetimeoutresolvefail');
    await backdate(paymentId, 2);

    const sweepRes = await triggerSweep().expect(200);
    expect(sweepRes.body.failed).toBeGreaterThanOrEqual(1);

    const row = await getPaymentRow(paymentId);
    expect(row.status).toBe('FAILED');
    expect(row.failureCode).toBe('card_declined');
    expect(row.ambiguousResolvedBy).toBeFalsy();
    expect(await ledgerEntries(paymentId)).toHaveLength(0);
  });

  it('keeps incrementing ambiguousAutoRetryCount while the PSP still has no record, then stops once the cap is reached', async () => {
    const paymentId = await chargeToAmbiguous('pm_forcetimeoutalways');
    await backdate(paymentId, 2);

    let sweepRes = await triggerSweep().expect(200);
    expect(sweepRes.body.stillUnknown).toBeGreaterThanOrEqual(1);
    let row = await getPaymentRow(paymentId);
    expect(row.status).toBe('AMBIGUOUS');
    expect(row.ambiguousAutoRetryCount).toBe(1);

    sweepRes = await triggerSweep().expect(200); // 2nd attempt — hits the cap (max=2)
    expect(sweepRes.body.stillUnknown).toBeGreaterThanOrEqual(1);
    row = await getPaymentRow(paymentId);
    expect(row.ambiguousAutoRetryCount).toBe(2);

    // 3rd sweep: no longer eligible (ambiguousAutoRetryCount is no longer
    // < maxAttempts), so it's left alone — stays AMBIGUOUS at count 2,
    // for a human to resolve via alertOnStale()'s escalation instead.
    await triggerSweep().expect(200);
    row = await getPaymentRow(paymentId);
    expect(row.ambiguousAutoRetryCount).toBe(2);
    expect(row.status).toBe('AMBIGUOUS');

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/admin/payments/ambiguous')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const summary = listRes.body.find((p: any) => p.paymentId === paymentId);
    expect(summary).toBeDefined();
    expect(summary.ambiguousAutoRetryCount).toBe(2);
  });

  it('never touches a payment that was already resolved manually before the sweep runs', async () => {
    const paymentId = await chargeToAmbiguous('pm_forcetimeoutalways');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${paymentId}/resolve-ambiguous`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ outcome: 'FAILED', reason: 'Confirmed no charge in Stripe dashboard' })
      .expect(200);

    await triggerSweep().expect(200);

    const row = await getPaymentRow(paymentId);
    expect(row.status).toBe('FAILED');
    expect(row.ambiguousResolvedBy).toBe(admin.merchantId);
    expect(row.ambiguousResolvedReason).toBe('Confirmed no charge in Stripe dashboard');
  });

  it('a MERCHANT-role token cannot trigger the sweep', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/payments/ambiguous/run-auto-resolution')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
