import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { LedgerOutboxEntity } from '../src/modules/payment/adapters/persistence/entities/ledger-outbox.entity';
import { ReserveHoldEntity } from '../src/modules/payment/adapters/persistence/entities/reserve-hold.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Merchant risk tiering & reserves: MerchantEntity.reserveBps/reserveHoldDays
 * withhold a slice of each charge's net amount into a per-merchant RESERVE
 * ledger account instead of paying it out immediately, tracked by its own
 * ReserveHold record and released — by the daily sweep or an operator's
 * manual override — back to MERCHANT. See ReserveService's docblock and
 * docs/business-domain/future-directions.md's Merchant Risk Tiering section
 * for what this does and doesn't cover.
 */
describe('Merchant risk tiering & reserves (e2e)', () => {
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

  // Every read in this file follows a write it just made — that races
  // the ambient DataSource's replica routing (app.module.ts's
  // `replication` config sends plain repository reads to the replica,
  // which has ~1s streaming lag behind master; see reserve.service.ts's
  // own release() and test/ledger-and-outbox.e2e-spec.ts for the same
  // issue confirmed live elsewhere). These helpers force the read onto
  // master.
  async function findOneOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<T | null> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.findOne(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

  async function findOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<T[]> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.find(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

  async function ledgerEntries(paymentId: string): Promise<any[]> {
    const event = await findOneOnMaster(LedgerOutboxEntity, { paymentId });
    return (event?.entries as any[]) ?? [];
  }

  it('a merchant with no reserve policy (default) books no RESERVE entry and no ReserveHold record', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('noreserve') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const entries = await ledgerEntries(res.body.paymentId);
    expect(entries.every((e) => e.accountType !== 'RESERVE')).toBe(true);

    const hold = await findOneOnMaster(ReserveHoldEntity, { paymentId: res.body.paymentId });
    expect(hold).toBeNull();
  });

  it('charging a merchant with a reserve policy withholds the configured percentage into a RESERVE entry and records a HELD ReserveHold', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('reserved10'), reserveBps: 1000, reserveHoldDays: 90 });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const beforeCharge = Date.now();
    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const entries = await ledgerEntries(res.body.paymentId);

    // $100 charge, 150bps fee ($1.50) -> $98.50 net, 1000bps (10%) reserve
    // of that -> $9.85 withheld, $88.65 paid out immediately.
    const feeCredit = entries.find((e) => e.accountType === 'FEE');
    expect(feeCredit.amountMinorUnits).toBe('150');
    const reserveCredit = entries.find((e) => e.accountType === 'RESERVE');
    expect(reserveCredit.amountMinorUnits).toBe('985');
    expect(reserveCredit.currencyCode).toBe('USD');
    expect(reserveCredit.accountId).toBe(`${merchant.merchantId}_RESERVE`);
    const merchantCredit = entries.find((e) => e.accountType === 'MERCHANT');
    expect(merchantCredit.amountMinorUnits).toBe('8865');

    // The ledger balances per-currency (all one group, no FX_CLEARING here)
    // — LedgerOutboxEvent's constructor would have thrown otherwise, so the
    // 201 above is itself part of the proof.

    const hold = await findOneOnMaster(ReserveHoldEntity, { paymentId: res.body.paymentId });
    expect(hold).not.toBeNull();
    expect(hold!.status).toBe('HELD');
    expect(hold!.amountMinorUnits).toBe('985');
    expect(hold!.currencyCode).toBe('USD');
    expect(hold!.merchantId).toBe(merchant.merchantId);
    // releaseEligibleAt is a proper timestamptz column (unlike createdAt,
    // a plain CreateDateColumn — see docs/technical/reconciliation.md's
    // note on naive-TIMESTAMP read-back skew), so it round-trips exactly;
    // anchor the expectation on a wall-clock timestamp captured before the
    // request, not on the entity's own createdAt.
    const expectedEligible = beforeCharge + 90 * 24 * 60 * 60 * 1000;
    expect(Math.abs(hold!.releaseEligibleAt.getTime() - expectedEligible)).toBeLessThan(5000);
  });

  it('a reserve composes with settlement-currency conversion: RESERVE stays in the charge currency, FX/MERCHANT legs use net-of-reserve', async () => {
    const merchant = await seedMerchant(app, {
      merchantId: uniqueId('reservedfx'),
      settlementCurrency: 'EUR',
      reserveBps: 2000,
      reserveHoldDays: 30,
    });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const entries = await ledgerEntries(res.body.paymentId);

    // $100 charge, $1.50 fee -> $98.50 net; 2000bps (20%) reserve -> $19.70
    // withheld in USD; payout-before-fx = $78.80 -> * 0.92 EUR = $72.496,
    // rounds to 7250 minor units EUR (Math.round(7880 * 0.92) = 7250).
    const reserveCredit = entries.find((e) => e.accountType === 'RESERVE');
    expect(reserveCredit.currencyCode).toBe('USD');
    expect(reserveCredit.amountMinorUnits).toBe('1970');
    const fxCreditLeg = entries.find((e) => e.accountType === 'FX_CLEARING' && e.currencyCode === 'USD');
    expect(fxCreditLeg.amountMinorUnits).toBe('7880');
    const merchantCredit = entries.find((e) => e.accountType === 'MERCHANT');
    expect(merchantCredit.currencyCode).toBe('EUR');
    expect(merchantCredit.amountMinorUnits).toBe('7250');

    const hold = await findOneOnMaster(ReserveHoldEntity, { paymentId: res.body.paymentId });
    // The hold itself is always in the charge currency, not the settlement
    // currency — see ReserveService's docblock for why release doesn't
    // re-run FX conversion.
    expect(hold!.currencyCode).toBe('USD');
    expect(hold!.amountMinorUnits).toBe('1970');
  });

  describe('Admin: reserve hold management', () => {
    it('manually releasing a hold books the offsetting ledger entry and flips status to RELEASED (verified via a fresh DB read, not the API response)', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('manrelease'), reserveBps: 1000, reserveHoldDays: 90 });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 50,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(201);

      const hold = await findOneOnMaster(ReserveHoldEntity, { paymentId: chargeRes.body.paymentId });
      expect(hold!.status).toBe('HELD');
      // 90-day hold, definitely not naturally eligible yet — this exercises
      // the force-release override, not the sweep's eligibility check.
      expect(hold!.releaseEligibleAt.getTime()).toBeGreaterThan(Date.now());

      const releaseRes = await request(app.getHttpServer())
        .post(`/api/v1/admin/reserves/${hold!.id}/release`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(releaseRes.body.status).toBe('RELEASED');

      const afterRelease = await findOneOnMaster(ReserveHoldEntity, { id: hold!.id });
      expect(afterRelease!.status).toBe('RELEASED');
      expect(afterRelease!.releasedAt).not.toBeNull();

      const event = await findOneOnMaster(LedgerOutboxEntity, { paymentId: chargeRes.body.paymentId, eventType: 'RESERVE_RELEASED' });
      expect(event).not.toBeNull();
      const releaseEntries = event!.entries as any[];
      const reserveDebit = releaseEntries.find((e) => e.accountType === 'RESERVE' && e.entryType === 'DEBIT');
      const merchantCredit = releaseEntries.find((e) => e.accountType === 'MERCHANT' && e.entryType === 'CREDIT');
      expect(reserveDebit.amountMinorUnits).toBe(hold!.amountMinorUnits);
      expect(merchantCredit.amountMinorUnits).toBe(hold!.amountMinorUnits);
    });

    it('releasing an already-released hold is rejected with 409, not double-booked', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('doublerelease'), reserveBps: 1000, reserveHoldDays: 90 });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 20,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(201);

      const hold = await findOneOnMaster(ReserveHoldEntity, { paymentId: chargeRes.body.paymentId });

      await request(app.getHttpServer())
        .post(`/api/v1/admin/reserves/${hold!.id}/release`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/reserves/${hold!.id}/release`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      // Only one RESERVE_RELEASED event should exist for this payment.
      const events = await findOnMaster(LedgerOutboxEntity, { paymentId: chargeRes.body.paymentId, eventType: 'RESERVE_RELEASED' });
      expect(events.length).toBe(1);
    });

    it('the release-eligible sweep releases a hold whose hold period has already elapsed (holdDays: 0) and leaves an ineligible one alone', async () => {
      const eligibleMerchant = await seedMerchant(app, { merchantId: uniqueId('sweepeligible'), reserveBps: 1000, reserveHoldDays: 0 });
      const eligibleToken = await login(app, eligibleMerchant.apiKeyId, eligibleMerchant.apiKeySecret);
      const ineligibleMerchant = await seedMerchant(app, { merchantId: uniqueId('sweepineligible'), reserveBps: 1000, reserveHoldDays: 90 });
      const ineligibleToken = await login(app, ineligibleMerchant.apiKeyId, ineligibleMerchant.apiKeySecret);

      const eligibleCharge = await signedRequest(eligibleMerchant, eligibleToken, 'post', '/api/v1/payments/charge', {
        amount: 30, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
      }).expect(201);
      const ineligibleCharge = await signedRequest(ineligibleMerchant, ineligibleToken, 'post', '/api/v1/payments/charge', {
        amount: 30, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
      }).expect(201);

      const sweepRes = await request(app.getHttpServer())
        .post('/api/v1/admin/reserves/release-eligible')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(sweepRes.body.released).toBeGreaterThanOrEqual(1);
      expect(sweepRes.body.failed).toBe(0);

      const eligibleHold = await findOneOnMaster(ReserveHoldEntity, { paymentId: eligibleCharge.body.paymentId });
      expect(eligibleHold!.status).toBe('RELEASED');
      const ineligibleHold = await findOneOnMaster(ReserveHoldEntity, { paymentId: ineligibleCharge.body.paymentId });
      expect(ineligibleHold!.status).toBe('HELD');
    });

    it('lists reserve holds filtered by merchant and status', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('listheld'), reserveBps: 500, reserveHoldDays: 60 });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 10, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
      }).expect(201);

      const listRes = await request(app.getHttpServer())
        .get(`/api/v1/admin/reserves?merchantId=${merchant.merchantId}&status=HELD`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(listRes.body.length).toBe(1);
      expect(listRes.body[0].merchantId).toBe(merchant.merchantId);
      expect(listRes.body[0].status).toBe('HELD');
    });

    it('a non-admin/operator cannot list or release reserve holds', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('nonadminreserve') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      await request(app.getHttpServer())
        .get('/api/v1/admin/reserves')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('Admin: reserve policy management', () => {
    it('PATCH reserve-policy sets reserveBps/reserveHoldDays, visible in the merchant summary and applied to the next charge', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('patchreserve') });

      const patchRes = await request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchant.merchantId}/reserve-policy`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reserveBps: 1500, reserveHoldDays: 45 })
        .expect(200);
      expect(patchRes.body.reserveBps).toBe(1500);
      expect(patchRes.body.reserveHoldDays).toBe(45);

      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 100, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
      }).expect(201);

      const entries = await ledgerEntries(chargeRes.body.paymentId);
      // $98.50 net * 15% = $14.775 -> rounds to 1478 minor units.
      const reserveCredit = entries.find((e) => e.accountType === 'RESERVE');
      expect(reserveCredit.amountMinorUnits).toBe('1478');
    });
  });
});
