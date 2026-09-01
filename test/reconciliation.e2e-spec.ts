import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * ReconciliationService is the safety net that catches drift between
 * this system's own ledger and a PSP's settlement report — exactly the
 * kind of service where a silent regression would only be noticed once
 * real numbers stop matching in production. This exercises
 * `POST /admin/reconciliation/run` end-to-end against real seeded data
 * with deliberately introduced mismatches of all three shapes
 * ReconciliationService checks for — the pure diffing/matching logic
 * itself has its own fast, isolated unit
 * coverage in reconciliation.service.spec.ts.
 */
describe('Reconciliation admin endpoint (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let merchant: SeededMerchant;
  let token: string;
  let admin: SeededMerchant;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    merchant = await seedMerchant(app, { merchantId: uniqueId('reconmerchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    admin = await seedMerchant(app, { merchantId: uniqueId('reconadmin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);
  });

  afterAll(async () => {
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

  function runReconciliation(body: { pspProvider: string; since?: string; until?: string }) {
    return request(app.getHttpServer())
      .post('/api/v1/admin/reconciliation/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  }

  it(
    'detects MISSING_AT_PSP, AMOUNT_MISMATCH, and UNKNOWN_AT_PSP in one run against real charges',
    async () => {
      const since = new Date();

      // 1) A normal, real STRIPE charge — mock-psp records a genuine
      //    matching settlement transaction for it. Corrupting our own
      //    stored amount afterward (simulating a ledger bug, not a bad
      //    charge) turns this into an AMOUNT_MISMATCH: both sides agree
      //    the transaction happened, but not on how much.
      const mismatchCharge = await signedCharge({
        amount: 50, currency: 'USD', paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'), binInfo: USD_BIN, preferredProvider: 'STRIPE',
      }).expect(201);
      await dataSource.getRepository(PaymentEntity).update(mismatchCharge.body.paymentId, {
        amountMinorUnits: '4000', // was 5000 — mock-psp still thinks it settled 5000
      });

      // 2) A real STRIPE charge whose own payment row is then deleted —
      //    mock-psp's settlement record is independent of our DB and
      //    still exists, simulating a charge that settled at the PSP but
      //    was never durably recorded on our side (e.g. an interrupted
      //    webhook or a failed insert after the PSP call succeeded).
      const unknownCharge = await signedCharge({
        amount: 30, currency: 'USD', paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'), binInfo: USD_BIN, preferredProvider: 'STRIPE',
      }).expect(201);
      await dataSource.getRepository(PaymentEntity).delete(unknownCharge.body.paymentId);

      // 3) A payment we claim was charged at STRIPE but never actually
      //    was — fabricated directly, simulating a bug that recorded a
      //    charge without the PSP call it claims to represent ever
      //    happening.
      const missingId = randomUUID();
      await dataSource.getRepository(PaymentEntity).save({
        id: missingId,
        merchantId: merchant.merchantId,
        amountMinorUnits: '7500',
        currencyCode: 'USD',
        currencyMinorUnits: 2,
        status: 'SUCCEEDED' as any,
        idempotencyKey: missingId,
        pspProvider: 'STRIPE' as any,
        pspTransactionId: `pi_never_charged_${missingId}`,
        refunds: [],
        captures: [],
      });

      // findByProviderAndDateRange() reads off the replica (~1s streaming
      // lag behind master — see that method's own docblock, an accepted
      // tradeoff for a passive hourly sweep) — give it time to catch up
      // rather than racing it.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const res = await runReconciliation({ pspProvider: 'STRIPE', since: since.toISOString() }).expect(200);

      expect(res.body.status).toBe('MISMATCHES_FOUND');
      const byType = (t: string) => res.body.mismatches.filter((m: { type: string }) => m.type === t);

      const amountMismatches = byType('AMOUNT_MISMATCH');
      expect(amountMismatches.some((m: any) => m.paymentId === mismatchCharge.body.paymentId)).toBe(true);

      const unknownMismatches = byType('UNKNOWN_AT_PSP');
      expect(unknownMismatches.some((m: any) => m.pspTransactionId === unknownCharge.body.pspTransactionId)).toBe(true);

      const missingMismatches = byType('MISSING_AT_PSP');
      expect(missingMismatches.some((m: any) => m.paymentId === missingId)).toBe(true);
    },
    15_000,
  );

  it('a clean charge with no corruption reconciles with zero mismatches for it', async () => {
    const since = new Date();
    const cleanCharge = await signedCharge({
      amount: 15, currency: 'USD', paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'), binInfo: USD_BIN, preferredProvider: 'STRIPE',
    }).expect(201);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const res = await runReconciliation({ pspProvider: 'STRIPE', since: since.toISOString() }).expect(200);

    // Asserted by absence rather than an exact mismatch count/CLEAN status
    // — this window is scoped by wall-clock time only (not per-merchant),
    // so it can't rule out another e2e file's own STRIPE activity landing
    // in the same window when running as part of the full suite.
    const mismatchesForThisPayment = res.body.mismatches.filter(
      (m: { paymentId?: string }) => m.paymentId === cleanCharge.body.paymentId,
    );
    expect(mismatchesForThisPayment).toHaveLength(0);
  });

  it('rejects an unknown pspProvider', async () => {
    // 422, not 400 — this app's global ValidationPipe is configured with
    // errorHttpStatusCode: 422 (main.ts), so DTO validation failures
    // (RunReconciliationDto's @IsIn(RECONCILED_PROVIDERS)) surface as
    // Unprocessable Entity rather than Nest's 400 default.
    await runReconciliation({ pspProvider: 'NOT_A_REAL_PSP' }).expect(422);
  });

  it('a non-admin merchant cannot trigger a reconciliation run', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/reconciliation/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ pspProvider: 'STRIPE' })
      .expect(403);
  });

  it('GET /admin/reconciliation/runs lists a run just triggered', async () => {
    const triggered = await runReconciliation({ pspProvider: 'ADYEN' }).expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/reconciliation/runs?pspProvider=ADYEN')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.some((run: { id: string }) => run.id === triggered.body.id)).toBe(true);
  });
});
