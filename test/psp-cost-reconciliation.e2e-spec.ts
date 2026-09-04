import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

// Mirrors mock-psp's own realFeeForTransactionMinorUnits() exactly (same
// hash, same "premium card" surcharge on 1-in-5 transactions) — lets this
// test predict the *real* fee PSPAdapterPort.fetchFeeStatement() will
// return for a specific, known pspTransactionId, rather than only
// asserting "some positive number came back".
function mockPspRealFeeMinorUnits(txId: string, amountMinorUnits: number, feePercentage: number, fixedFee: number) {
  let hash = 0;
  for (let i = 0; i < txId.length; i++) {
    hash = (hash * 31 + txId.charCodeAt(i)) >>> 0;
  }
  const isPremiumCard = hash % 5 === 0;
  const effectivePercentage = feePercentage + (isPremiumCard ? 1.5 : 0);
  return Math.round((amountMinorUnits * effectivePercentage) / 100) + fixedFee;
}

/**
 * Exercises `POST /admin/psp-cost-reconciliation/run` end-to-end against
 * real seeded charges — proves both sides of the report are computed
 * from real data: the estimate from real settled ledger volume
 * (PspFeeScheduleService's configured rate), and the "actual" side from
 * a real call to PSPAdapterPort.fetchFeeStatement() against mock-psp's
 * own `/statement` endpoint (a deterministic simulated real fee,
 * verified here against an independent re-implementation of mock-psp's
 * own fee math) — not an operator-typed number, unless explicitly
 * overridden.
 */
describe('PSP cost reconciliation admin endpoint (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    merchant = await seedMerchant(app, { merchantId: uniqueId('pspcostmerchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('pspcostadmin')));
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

  function runReport(body: object) {
    return request(app.getHttpServer())
      .post('/api/v1/admin/psp-cost-reconciliation/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  }

  it('auto-fetches the actual fee from mock-psp and computes both sides for real, from real settled STRIPE charges', async () => {
    const since = new Date();

    // Two real, distinct STRIPE charges — $10.00 and $25.00 — so the
    // report's gross volume/estimate is checkable against a known sum
    // rather than an opaque "some positive number".
    const chargeA = await signedCharge({
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);
    expect(chargeA.body.status).toBe('SUCCEEDED');

    const chargeB = await signedCharge({
      amount: 25,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);
    expect(chargeB.body.status).toBe('SUCCEEDED');

    const until = new Date();

    // No actualInvoicedFeeMinorUnits — exercises the automatic
    // PSPAdapterPort.fetchFeeStatement() path, not a manual override.
    const res = await runReport({
      provider: 'STRIPE',
      currency: 'USD',
      since: since.toISOString(),
      until: until.toISOString(),
    }).expect(200);

    expect(res.body.actualFeeSource).toBe('PSP_STATEMENT');

    // >= 2, not === 2 — findByProviderAndDateRange scopes by provider and
    // time window across every merchant, not just this test's own, so
    // another spec file's STRIPE/USD charge landing in the same narrow
    // window is possible in principle, just not something this test can
    // rule out entirely. The arithmetic relationships below hold
    // regardless of how many charges were actually counted.
    expect(res.body.chargesEvaluated).toBeGreaterThanOrEqual(2);
    const grossVolumeMinorUnits = BigInt(res.body.grossVolumeMinorUnits);
    expect(grossVolumeMinorUnits).toBeGreaterThanOrEqual(3500n); // $10 + $25, in cents

    // Default STRIPE schedule (PspFeeScheduleService): 2.9% + $0.30/charge.
    // Mirrors PspCostReconciliationService's own Number-based rounding
    // (Math.round, not bigint truncation) so this matches exactly rather
    // than drifting by a cent on a rounding-method mismatch.
    const percentageFee = Math.round((Number(grossVolumeMinorUnits) * 2.9) / 100);
    const fixedFee = 30 * res.body.chargesEvaluated;
    const expectedEstimate = BigInt(percentageFee) + BigInt(fixedFee);
    expect(BigInt(res.body.estimatedFeeMinorUnits)).toBe(expectedEstimate);

    // The real, deterministic fee mock-psp's /statement endpoint computes
    // for exactly these two known charges — reproduced here independently
    // (mockPspRealFeeMinorUnits, above) from their real pspTransactionIds,
    // not just re-trusting whatever the endpoint returned.
    const expectedActualForKnownCharges =
      BigInt(mockPspRealFeeMinorUnits(chargeA.body.pspTransactionId, 1000, 2.9, 30)) +
      BigInt(mockPspRealFeeMinorUnits(chargeB.body.pspTransactionId, 2500, 2.9, 30));
    const actualInvoicedFeeMinorUnits = BigInt(res.body.actualInvoicedFeeMinorUnits);
    // >= , not === — the window may also catch another test's STRIPE/USD
    // charge (same reasoning as chargesEvaluated above); the two known
    // charges' own contribution is still exactly predictable and must be
    // present in the total.
    expect(actualInvoicedFeeMinorUnits).toBeGreaterThanOrEqual(expectedActualForKnownCharges);

    const deltaMinorUnits = actualInvoicedFeeMinorUnits - expectedEstimate;
    expect(BigInt(res.body.deltaMinorUnits)).toBe(deltaMinorUnits);
    expect(res.body.deltaPercent).toBeCloseTo((Number(deltaMinorUnits) / Number(expectedEstimate)) * 100, 5);
  });

  it('a manual actualInvoicedFeeMinorUnits overrides the auto-fetched figure', async () => {
    const since = new Date();
    await signedCharge({
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);
    const until = new Date();

    const res = await runReport({
      provider: 'STRIPE',
      currency: 'USD',
      since: since.toISOString(),
      until: until.toISOString(),
      actualInvoicedFeeMinorUnits: '999999',
    }).expect(200);

    expect(res.body.actualFeeSource).toBe('MANUAL_OVERRIDE');
    expect(res.body.actualInvoicedFeeMinorUnits).toBe('999999');
  });

  it('a currency with no settled charges in the window reports zero on both sides, not an error', async () => {
    const since = new Date();
    const until = new Date(since.getTime() + 1000);

    const res = await runReport({
      provider: 'ADYEN',
      currency: 'JPY',
      since: since.toISOString(),
      until: until.toISOString(),
    }).expect(200);

    expect(res.body.actualFeeSource).toBe('PSP_STATEMENT');
    expect(res.body.chargesEvaluated).toBe(0);
    expect(res.body.grossVolumeMinorUnits).toBe('0');
    expect(res.body.estimatedFeeMinorUnits).toBe('0');
    expect(res.body.actualInvoicedFeeMinorUnits).toBe('0');
    expect(res.body.deltaPercent).toBeNull();
  });

  it('rejects an unknown provider', async () => {
    // 422, not 400 — this app's global ValidationPipe uses
    // errorHttpStatusCode: 422 (main.ts), so RunPspCostReconciliationDto's
    // @IsIn(RECONCILED_PROVIDERS) failure surfaces as Unprocessable Entity.
    await runReport({
      provider: 'PAYPAL',
      currency: 'USD',
      since: new Date().toISOString(),
      until: new Date().toISOString(),
      actualInvoicedFeeMinorUnits: '0',
    }).expect(422);
  });

  it('a non-admin merchant cannot run a report', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/psp-cost-reconciliation/run')
      .set('Authorization', `Bearer ${token}`)
      .send({
        provider: 'STRIPE',
        currency: 'USD',
        since: new Date().toISOString(),
        until: new Date().toISOString(),
        actualInvoicedFeeMinorUnits: '0',
      })
      .expect(403);
  });
});
