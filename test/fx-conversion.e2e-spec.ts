import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { LedgerOutboxEntity } from '../src/modules/payment/adapters/persistence/entities/ledger-outbox.entity';
import { MerchantEntity } from '../src/modules/merchant/merchant.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * FXRateProviderPort now has a real (mocked, but real-HTTP) implementation
 * — scripts/mock-psp/server.js's /fx/rates endpoint — wired into all three
 * ledger-booking call sites via MerchantEntity.settlementCurrency. Before
 * this, Money.convertTo() existed but nothing in the application layer
 * ever called it with a real rate. See DEV_README.md's FX conversion entry
 * and LedgerOutboxEvent.createChargeEntries()'s settlementConversion param
 * for why this needs two separately-currency-balanced ledger legs, not
 * just a third entry in the existing charge-currency group.
 */
describe('FX conversion: merchant settlement currency (e2e)', () => {
  let app: INestApplication;
  let admin: SeededMerchant;
  let adminToken: string;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);
  });

  afterAll(async () => {
    await app.close();
  });

  function signedRequest(m: SeededMerchant, t: string, method: 'post', path: string, body: object) {
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(m.hmacSecret, method, path, bodyStr);
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${t}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', m.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  // Every read here follows a write it just made — that races the
  // ambient DataSource's replica routing (app.module.ts's `replication`
  // config sends plain repository reads to the replica, which has ~1s
  // streaming lag behind master; see reserve.service.ts's release() and
  // test/ledger-and-outbox.e2e-spec.ts for the same issue confirmed
  // live elsewhere). This forces the read onto master instead.
  async function findOneOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<T | null> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.findOne(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

  async function ledgerEntries(paymentId: string): Promise<any[]> {
    const event = await findOneOnMaster(LedgerOutboxEntity, { paymentId });
    return (event?.entries as any[]) ?? [];
  }

  it('a merchant with no settlement currency keeps booking in the charge currency (unchanged default behavior)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('nofx') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const entries = await ledgerEntries(res.body.paymentId);
    expect(entries.every((e) => e.accountType !== 'FX_CLEARING')).toBe(true);
    const merchantEntry = entries.find((e) => e.accountType === 'MERCHANT');
    expect(merchantEntry.currencyCode).toBe('USD');
  });

  it('a merchant settled in the same currency they were charged in is not converted (identity, no FX_CLEARING legs)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('samecur'), settlementCurrency: 'USD' });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const entries = await ledgerEntries(res.body.paymentId);
    expect(entries.every((e) => e.accountType !== 'FX_CLEARING')).toBe(true);
  });

  it('charging a merchant settled in a different currency books two balanced legs and converts the merchant payout at the real (mock) rate', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('eurmerchant'), settlementCurrency: 'EUR' });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const entries = await ledgerEntries(res.body.paymentId);

    // PSP_SETTLEMENT debit 100 USD, FEE credit 1.50 USD (default 150bps),
    // FX_CLEARING credit 98.50 USD — this group balances on its own.
    const pspDebit = entries.find((e) => e.accountType === 'PSP_SETTLEMENT');
    expect(pspDebit.amountMinorUnits).toBe('10000');
    expect(pspDebit.currencyCode).toBe('USD');
    const feeCredit = entries.find((e) => e.accountType === 'FEE');
    expect(feeCredit.amountMinorUnits).toBe('150');
    const fxCreditLeg = entries.find((e) => e.accountType === 'FX_CLEARING' && e.currencyCode === 'USD');
    expect(fxCreditLeg.amountMinorUnits).toBe('9850');

    // FX_CLEARING debit + MERCHANT credit, both in EUR at the mock rate
    // (USD->EUR = 0.92): 98.50 * 0.92 = 90.62 EUR exactly.
    const fxDebitLeg = entries.find((e) => e.accountType === 'FX_CLEARING' && e.currencyCode === 'EUR');
    expect(fxDebitLeg.amountMinorUnits).toBe('9062');
    const merchantCredit = entries.find((e) => e.accountType === 'MERCHANT');
    expect(merchantCredit.currencyCode).toBe('EUR');
    expect(merchantCredit.amountMinorUnits).toBe('9062');

    // If this hadn't balanced per-currency, LedgerOutboxEvent's constructor
    // would have thrown when the charge was processed and this 201 would
    // never have happened — the charge succeeding is itself part of the
    // proof, not just these explicit assertions.
  });

  it('manual capture also converts to the settlement currency (a separate ledger-booking call site from immediate charge)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('eurcapture'), settlementCurrency: 'EUR' });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      captureMethod: 'manual',
      binInfo: USD_BIN,
    }).expect(201);
    expect(chargeRes.body.status).toBe('REQUIRES_CAPTURE');

    const captureRes = await signedRequest(merchant, token, 'post', `/api/v1/payments/${chargeRes.body.paymentId}/capture`, {}).expect(200);
    expect(captureRes.body.status).toBe('SUCCEEDED');

    const entries = await ledgerEntries(chargeRes.body.paymentId);
    const merchantCredit = entries.find((e: any) => e.accountType === 'MERCHANT');
    expect(merchantCredit.currencyCode).toBe('EUR');
    // $40 - 1.5% fee ($0.60) = $39.40 net, * 0.92 = 36.248 -> rounds to 3625 minor units EUR.
    expect(merchantCredit.amountMinorUnits).toBe('3625');
  });

  describe('Admin: settlement currency management', () => {
    it('creates a merchant with a settlement currency, and it is visible in the summary', async () => {
      const merchantId = uniqueId('created-with-fx');
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ merchantId, name: 'FX Test', roles: ['MERCHANT'], settlementCurrency: 'gbp' })
        .expect(201);
      expect(res.body.settlementCurrency).toBe('GBP');
    });

    it('PATCH settlement-currency sets it, and sending null actually clears it in the database, not just the API response', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('patchfx') });

      const setRes = await request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchant.merchantId}/settlement-currency`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ settlementCurrency: 'jpy' })
        .expect(200);
      expect(setRes.body.settlementCurrency).toBe('JPY');

      const afterSet = await findOneOnMaster(MerchantEntity, { merchantId: merchant.merchantId });
      expect(afterSet?.settlementCurrency).toBe('JPY');

      const clearRes = await request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchant.merchantId}/settlement-currency`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ settlementCurrency: null })
        .expect(200);
      expect(clearRes.body.settlementCurrency).toBeNull();

      // The real assertion: re-fetch straight from the database, not the
      // API response, to confirm the column actually went back to NULL —
      // TypeORM's save() silently skipping an `undefined` property (instead
      // of writing NULL) would pass every check above and still leave
      // stale data in Postgres.
      const afterClear = await findOneOnMaster(MerchantEntity, { merchantId: merchant.merchantId });
      expect(afterClear?.settlementCurrency == null).toBe(true);
    });

    it('a non-admin cannot change settlement currency', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('nonadminfx') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchant.merchantId}/settlement-currency`)
        .set('Authorization', `Bearer ${token}`)
        .send({ settlementCurrency: 'EUR' })
        .expect(403);
    });
  });
});
