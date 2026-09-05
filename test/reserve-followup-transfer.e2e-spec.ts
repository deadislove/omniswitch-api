import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signBankTransferWebhook } from './utils/signing';
import { PayoutService } from '../src/modules/payment/application/services/payout.service';
import { CachePort } from '../src/modules/payment/ports/outbound/cache.port';
import { forceSharedRedisDbForSweepLock, acquireExclusiveSweepTestSuite } from './utils/shared-redis-db';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * The reserve follow-up transfer: `Payout.recordReserveTransferInitiated()`
 * and `PayoutService.initiateReserveTransfer()` — a second, independent
 * transfer for a reserve released *after* its payout's `netAmount` was
 * already transferred, the gap `docs/business-domain/marketplace-and-payouts.md`
 * used to name explicitly. This file deliberately releases the reserve
 * *after* initiating the net-amount transfer in every test, to prove the
 * exact "already-transferred netAmount, reserve released later" ordering
 * the gap was about — not just that a reserve transfer mechanism exists
 * in the abstract.
 */
describe('Reserve follow-up transfer (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let payoutService: PayoutService;
  const sharedRedisDb = forceSharedRedisDbForSweepLock();
  let releaseSweepMutex: () => Promise<void>;

  beforeAll(async () => {
    app = await createTestApp();
    releaseSweepMutex = await acquireExclusiveSweepTestSuite(app.get(CachePort));
    payoutService = app.get(PayoutService);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await releaseSweepMutex();
    await app.close();
    sharedRedisDb.restore();
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

  function submitKyc(merchantId: string, legalName: string, taxId = '12-3456789') {
    return request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName, taxId });
  }

  /**
   * reserveHoldDays: 0 so the reserve is immediately eligible for
   * release — this test suite's whole point is exercising the sequence
   * *after* release, not the hold-period mechanics
   * marketplace-payouts.e2e-spec.ts already covers.
   */
  async function verifiedPayoutWithNetAmountAlreadyTransferred(
    merchantIdPrefix: string,
    amount = 40,
    splitAmount = 25,
  ): Promise<string> {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId(merchantIdPrefix),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
      payoutReserveBps: 1000, // 10%
      payoutReserveHoldDays: 0,
    });
    await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: splitAmount }],
    }).expect(201);
    await payoutService.runSweep();
    const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
    const payoutId = payouts[0].id;

    // netAmount transferred FIRST, before the reserve is ever released —
    // the exact ordering the gap this file tests was about.
    const netRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(netRes.body.transferStatus).toBe('INITIATED');

    return payoutId;
  }

  it("initiating a reserve transfer before the reserve is released is rejected with 409, even though netAmount's own transfer already succeeded", async () => {
    const payoutId = await verifiedPayoutWithNetAmountAlreadyTransferred('connected-reserve-not-released');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-reserve-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(res.body.code).toBe('PAYOUT_RESERVE_NOT_RELEASED');
  });

  it('releasing the reserve after netAmount was already transferred, then initiating the reserve transfer, actually sends a real, separate follow-up transfer', async () => {
    const payoutId = await verifiedPayoutWithNetAmountAlreadyTransferred('connected-reserve-followup');

    const before = await payoutService.findById(payoutId);
    expect(before!.transferStatus).toBe('INITIATED');
    expect(before!.reserveStatus).toBe('HELD');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/release-reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const reserveRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-reserve-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(reserveRes.body.reserveTransferStatus).toBe('INITIATED');
    expect(reserveRes.body.reserveTransferId).toEqual(expect.any(String));
    // A genuinely separate transfer, not a re-use of the netAmount one.
    expect(reserveRes.body.reserveTransferId).not.toBe(reserveRes.body.transferId);
    // netAmount's own transfer is completely untouched by the reserve transfer.
    expect(reserveRes.body.transferStatus).toBe('INITIATED');
    expect(reserveRes.body.transferId).toBe(before!.transferId);
  });

  it('a second reserve-transfer initiation attempt is rejected with 409', async () => {
    const payoutId = await verifiedPayoutWithNetAmountAlreadyTransferred('connected-reserve-double-init');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/release-reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-reserve-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-reserve-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(res.body.code).toBe('PAYOUT_RESERVE_TRANSFER_ALREADY_INITIATED');
  });

  it('a reserve-transfer decline (merchantId containing "transferfail") is recorded FAILED with a 422, independent of netAmount transfer status', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected-transferfail-reserve'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
      payoutReserveBps: 1000,
      payoutReserveHoldDays: 0,
    });
    await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 25 }],
    }).expect(201);
    await payoutService.runSweep();
    const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
    const payoutId = payouts[0].id;

    // "transferfail" in merchantId is the mock rail's decline marker,
    // and the mock rail declines by merchantId regardless of which leg
    // (net/reserve) is being sent — so netAmount's own transfer isn't
    // initiated first here (it would decline identically). This test's
    // "independent of netAmount transfer status" claim is instead shown
    // by transferStatus staying NOT_INITIATED (untouched) below, while
    // reserveTransferStatus alone moves to FAILED.
    await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/release-reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-reserve-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(422);
    expect(res.body.code).toBe('PAYOUT_RESERVE_TRANSFER_FAILED');

    const after = await payoutService.findById(payoutId);
    expect(after!.reserveTransferStatus).toBe('FAILED');
    expect(after!.transferStatus).toBe('NOT_INITIATED'); // untouched — never initiated in this test
  });

  it('the initiate-eligible-reserve-transfers sweep picks up a payout whose reserve was released after its netAmount transfer already ran', async () => {
    const payoutId = await verifiedPayoutWithNetAmountAlreadyTransferred('connected-reserve-sweep');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/release-reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const sweepRes = await request(app.getHttpServer())
      .post('/api/v1/admin/marketplace/initiate-eligible-reserve-transfers')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(sweepRes.body.initiated).toBeGreaterThanOrEqual(1);

    const after = await payoutService.findById(payoutId);
    expect(after!.reserveTransferStatus).toBe('INITIATED');
  });

  it('a KYC-blocked payout cannot have its reserve transfer initiated, even once the reserve is released', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected-reserve-kyc-blocked'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
      payoutReserveBps: 1000,
      payoutReserveHoldDays: 0,
    });
    // No KYC submission — stays kycBlocked.
    await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 25 }],
    }).expect(201);
    await payoutService.runSweep();
    const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
    const payoutId = payouts[0].id;
    expect(payouts[0].kycBlocked).toBe(true);

    // release-reserve doesn't require KYC — only transfer initiation does.
    await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/release-reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-reserve-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(res.body.code).toBe('PAYOUT_KYC_BLOCKED');
  });
});

describe('Reserve follow-up transfer against a real, async-settling rail (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let payoutService: PayoutService;
  const originalProvider = process.env.BANK_TRANSFER_PROVIDER;
  const BANK_TRANSFER_WEBHOOK_SECRET = process.env.BANK_TRANSFER_WEBHOOK_SECRET!;
  const sharedRedisDb = forceSharedRedisDbForSweepLock();
  let releaseSweepMutex: () => Promise<void>;

  beforeAll(async () => {
    process.env.BANK_TRANSFER_PROVIDER = 'ach';
    app = await createTestApp();
    releaseSweepMutex = await acquireExclusiveSweepTestSuite(app.get(CachePort));
    payoutService = app.get(PayoutService);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await releaseSweepMutex();
    await app.close();
    sharedRedisDb.restore();
    if (originalProvider === undefined) {
      delete process.env.BANK_TRANSFER_PROVIDER;
    } else {
      process.env.BANK_TRANSFER_PROVIDER = originalProvider;
    }
  });

  function postBankTransferWebhook(body: object) {
    const bodyStr = JSON.stringify(body);
    const signature = signBankTransferWebhook(BANK_TRANSFER_WEBHOOK_SECRET, bodyStr);
    return request(app.getHttpServer())
      .post('/api/v1/webhooks/bank-transfer')
      .set('X-Bank-Transfer-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(bodyStr);
  }

  it('a reserve transfer against the ACH rail lands in PENDING_CONFIRMATION, then a signed webhook confirms it to INITIATED, independent of the netAmount leg', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected-reserve-ach'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
      payoutReserveBps: 1000,
      payoutReserveHoldDays: 0,
    });
    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${connected.merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName: 'Acme Sellers LLC', taxId: '12-3456789' })
      .expect(200);

    const bodyStr = JSON.stringify({
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 25 }],
    });
    const { signature, timestamp } = signHmacRequest(platform.hmacSecret, 'post', '/api/v1/payments/charge', bodyStr);
    await request(app.getHttpServer())
      .post('/api/v1/payments/charge')
      .set('Authorization', `Bearer ${platformToken}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', platform.merchantId)
      .set('Content-Type', 'application/json')
      .send(bodyStr)
      .expect(201);
    await payoutService.runSweep();
    const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
    const payoutId = payouts[0].id;

    // netAmount transferred first (lands PENDING_CONFIRMATION on the ACH
    // rail too) and confirmed, before the reserve is ever released.
    const netInitRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(netInitRes.body.transferStatus).toBe('PENDING_CONFIRMATION');
    await postBankTransferWebhook({ transferId: netInitRes.body.transferId, status: 'settled' }).expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/release-reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const reserveInitRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-reserve-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(reserveInitRes.body.reserveTransferStatus).toBe('PENDING_CONFIRMATION');
    const reserveTransferId = reserveInitRes.body.reserveTransferId as string;
    expect(reserveTransferId).not.toBe(netInitRes.body.transferId);

    await postBankTransferWebhook({ transferId: reserveTransferId, status: 'settled' }).expect(200);

    const after = await payoutService.findById(payoutId);
    expect(after!.reserveTransferStatus).toBe('INITIATED');
    expect(after!.transferStatus).toBe('INITIATED'); // netAmount leg unaffected
  });
});
