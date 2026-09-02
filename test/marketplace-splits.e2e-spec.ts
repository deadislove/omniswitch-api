import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { LedgerOutboxEntity } from '../src/modules/payment/adapters/persistence/entities/ledger-outbox.entity';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Marketplace & split payments (phase 1): a PLATFORM merchant can route
 * part of a charge's net proceeds directly to its own CONNECTED merchants
 * via POST /payments/charge's `splits`. See MerchantEntity.accountType/
 * platformMerchantId and ChargeLedgerParamsResolverService.resolve() for
 * the mechanism. Deliberately not attempted here (see DEV_README.md):
 * connected-account KYC/onboarding review, and independent payout
 * scheduling (a rolling reserve) — a split's MERCHANT credit lands on the
 * connected account's ledger balance exactly like a direct charge would,
 * with no separate payout step.
 */
describe('Marketplace & split payments (e2e)', () => {
  let app: INestApplication;
  let admin: SeededMerchant;
  let adminToken: string;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    ({ admin, adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
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
  // release() and test/ledger-and-outbox.e2e-spec.ts for the same issue
  // confirmed live elsewhere). These helpers force the read onto master.
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

  async function platformWithConnected(): Promise<{ platform: SeededMerchant; platformToken: string; connected: SeededMerchant }> {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });
    return { platform, platformToken, connected };
  }

  describe('Admin: onboarding connected accounts', () => {
    it('creates a CONNECTED merchant under a PLATFORM merchant', async () => {
      const platformId = uniqueId('platform-onboard');
      await request(app.getHttpServer())
        .post('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ merchantId: platformId, name: 'Platform', roles: ['MERCHANT'] })
        .expect(201);

      const connectedId = uniqueId('connected-onboard');
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ merchantId: connectedId, name: 'Seller', roles: ['MERCHANT'], accountType: 'CONNECTED', platformMerchantId: platformId })
        .expect(201);
      expect(res.body.accountType).toBe('CONNECTED');
      expect(res.body.platformMerchantId).toBe(platformId);
    });

    it('a default (PLATFORM) merchant has accountType PLATFORM and no platformMerchantId', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('defaultplatform') });
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const found = res.body.find((m: any) => m.merchantId === merchant.merchantId);
      expect(found.accountType).toBe('PLATFORM');
      expect(found.platformMerchantId).toBeNull();
    });

    it('CONNECTED without platformMerchantId is rejected', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ merchantId: uniqueId('bad-connected'), name: 'Bad', roles: ['MERCHANT'], accountType: 'CONNECTED' })
        .expect(409);
    });

    it('CONNECTED referencing an unknown platform is rejected', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ merchantId: uniqueId('orphan-connected'), name: 'Orphan', roles: ['MERCHANT'], accountType: 'CONNECTED', platformMerchantId: uniqueId('nonexistent') })
        .expect(404);
    });

    it('a CONNECTED merchant cannot itself be a platform for another connected account (one level only)', async () => {
      const { connected } = await platformWithConnected();
      await request(app.getHttpServer())
        .post('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ merchantId: uniqueId('grandchild'), name: 'Grandchild', roles: ['MERCHANT'], accountType: 'CONNECTED', platformMerchantId: connected.merchantId })
        .expect(409);
    });
  });

  it('a split charge credits the connected merchant directly and the remainder to the platform', async () => {
    const { platform, platformToken, connected } = await platformWithConnected();

    const res = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 30 }],
    }).expect(201);
    expect(res.body.status).toBe('SUCCEEDED');

    const entries = await ledgerEntries(res.body.paymentId);
    const merchantCredits = entries.filter((e) => e.accountType === 'MERCHANT');
    expect(merchantCredits).toHaveLength(2);

    const connectedCredit = merchantCredits.find((e) => e.accountId === connected.merchantId);
    expect(connectedCredit.amountMinorUnits).toBe('3000'); // $30.00

    const platformCredit = merchantCredits.find((e) => e.accountId === platform.merchantId);
    // $100 - 1.5% fee ($1.50) = $98.50 net, minus the $30 split = $68.50 remainder.
    expect(platformCredit.amountMinorUnits).toBe('6850');

    // Double-entry validated the whole event on construction (see
    // LedgerOutboxEvent's constructor) — this just confirms independently
    // that the two MERCHANT credits plus the FEE credit add back up to the
    // PSP_SETTLEMENT debit.
    const debit = entries.find((e) => e.accountType === 'PSP_SETTLEMENT');
    const fee = entries.find((e) => e.accountType === 'FEE');
    const creditTotal = BigInt(connectedCredit.amountMinorUnits) + BigInt(platformCredit.amountMinorUnits) + BigInt(fee.amountMinorUnits);
    expect(creditTotal.toString()).toBe(debit.amountMinorUnits);
  });

  it('a split that exactly exhausts the net payout leaves no separate platform credit', async () => {
    const { platform, platformToken, connected } = await platformWithConnected();

    // $50 charge, 1.5% fee = $0.75, net = $49.25 — split the exact net amount.
    const res = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 49.25 }],
    }).expect(201);

    const entries = await ledgerEntries(res.body.paymentId);
    const merchantCredits = entries.filter((e) => e.accountType === 'MERCHANT');
    expect(merchantCredits).toHaveLength(1);
    expect(merchantCredits[0].accountId).toBe(connected.merchantId);
    expect(merchantCredits[0].amountMinorUnits).toBe('4925');
  });

  it('a split total exceeding the net payout amount is rejected with 422, and no ledger entry is written', async () => {
    const { platform, platformToken, connected } = await platformWithConnected();

    const res = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 200 }],
    }).expect(422);
    expect(res.body.code).toBe('SPLIT_EXCEEDS_NET_AMOUNT');

    const payments = await findOnMaster(PaymentEntity, { merchantId: platform.merchantId });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('FAILED');
    const event = await findOneOnMaster(LedgerOutboxEntity, { paymentId: payments[0].id });
    expect(event).toBeNull();
  });

  it('splitting to a merchant that is not a connected account of the charging merchant is rejected with 422', async () => {
    const { platform, platformToken } = await platformWithConnected();
    const stranger = await seedMerchant(app, { merchantId: uniqueId('stranger') });

    const res = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: stranger.merchantId, amount: 10 }],
    }).expect(422);
    expect(res.body.code).toBe('SPLIT_RECIPIENT_INVALID');
  });

  it('splitting to a connected account owned by a different platform is rejected with 422', async () => {
    const { platform, platformToken } = await platformWithConnected();
    const { connected: otherConnected } = await platformWithConnected();

    const res = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: otherConnected.merchantId, amount: 10 }],
    }).expect(422);
    expect(res.body.code).toBe('SPLIT_RECIPIENT_INVALID');
  });

  it('splits with a manual capture method are rejected with 409 before any PSP call', async () => {
    const { platform, platformToken, connected } = await platformWithConnected();

    const res = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      captureMethod: 'manual',
      splits: [{ merchantId: connected.merchantId, amount: 10 }],
    }).expect(409);
    expect(res.body.code).toBe('SPLIT_REQUIRES_AUTOMATIC_CAPTURE');

    // Rejected before PaymentCheckoutSaga.execute() was ever called — no
    // payment row at all, not even a FAILED one.
    const payments = await findOnMaster(PaymentEntity, { merchantId: platform.merchantId });
    expect(payments).toHaveLength(0);
  });

  it('splits are rejected for a platform merchant with an active settlement-currency conversion', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platformfx'), settlementCurrency: 'EUR' });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connectedfx'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });

    const res = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 10 }],
    }).expect(409);
    expect(res.body.code).toBe('SPLIT_WITH_SETTLEMENT_CONVERSION_UNSUPPORTED');
  });

  it('a charge with no splits behaves exactly as before (single MERCHANT credit to the charging merchant)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('nosplits') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const entries = await ledgerEntries(res.body.paymentId);
    const merchantCredits = entries.filter((e) => e.accountType === 'MERCHANT');
    expect(merchantCredits).toHaveLength(1);
    expect(merchantCredits[0].accountId).toBe(merchant.merchantId);
  });
});
