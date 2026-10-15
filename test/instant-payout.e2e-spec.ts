import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signBankTransferWebhook } from './utils/signing';
import { PayoutService } from '../src/modules/payment/application/services/payout.service';
import { CachePort } from '../src/modules/payment/ports/outbound/cache.port';
import {
  forceSharedRedisDbForSweepLock,
  acquireExclusiveSweepTestSuite,
  SUITE_MUTEX_ACQUIRE_TIMEOUT_MS,
} from './utils/shared-redis-db';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const BANK_TRANSFER_WEBHOOK_SECRET = process.env.BANK_TRANSFER_WEBHOOK_SECRET!;

/**
 * The instant payout rail (`InstantBankTransferAdapter`) — unlike
 * ACH/WIRE (bank-transfer-rail.e2e-spec.ts), never selected via the
 * global `BANK_TRANSFER_PROVIDER` pin; `PayoutService` injects and
 * resolves it directly per transfer/merchant (see `PayoutRail`'s own
 * docblock), so this file needs no special app-boot env var — same
 * default app every other payout e2e spec uses. Same "post directly to
 * POST /webhooks/bank-transfer rather than wait for mock-psp's own
 * callback" posture as bank-transfer-rail.e2e-spec.ts, for the same
 * reason (this in-process app isn't reachable from mock-psp).
 */
describe('Instant payout rail (e2e)', () => {
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
  }, SUITE_MUTEX_ACQUIRE_TIMEOUT_MS);

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

  function postBankTransferWebhook(body: object) {
    const bodyStr = JSON.stringify(body);
    const signature = signBankTransferWebhook(BANK_TRANSFER_WEBHOOK_SECRET, bodyStr);
    return request(app.getHttpServer())
      .post('/api/v1/webhooks/bank-transfer')
      .set('X-Bank-Transfer-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(bodyStr);
  }

  function settledNotification(transferId: string) {
    return { id: uniqueId('evt'), topic: 'customer_transfer_completed', resourceId: transferId };
  }

  async function verifiedConnectedPayout(
    merchantIdPrefix: string,
    options: { amount?: number; splitAmount?: number; payoutRail?: 'STANDARD' | 'INSTANT' } = {},
  ): Promise<string> {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId(merchantIdPrefix),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
      payoutRail: options.payoutRail,
    });
    await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: options.amount ?? 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: options.splitAmount ?? 25 }],
    }).expect(201);
    await payoutService.runSweep();
    const payouts = await payoutService.findManyOnMaster({ merchantId: connected.merchantId });
    return payouts[0].id;
  }

  it('an explicit rail: INSTANT deducts the premium fee and uses the instant rail, landing in PENDING_CONFIRMATION', async () => {
    const payoutId = await verifiedConnectedPayout('connected-instant-explicit', { amount: 40, splitAmount: 25 });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rail: 'INSTANT' })
      .expect(200);

    expect(res.body.transferStatus).toBe('PENDING_CONFIRMATION');
    expect(res.body.transferRail).toBe('INSTANT');
    // 25 * 150bps = 0.375 -> rounds to 0.38 at 2 decimal places (USD)
    expect(res.body.instantFeeAmount).toBeCloseTo(0.38, 2);
    expect(String(res.body.transferId)).toMatch(/^instant_mock_/);
  });

  it('omitting rail uses STANDARD and resolves synchronously via the mock rail, with no fee', async () => {
    const payoutId = await verifiedConnectedPayout('connected-instant-default-standard');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.transferStatus).toBe('INITIATED');
    expect(res.body.transferRail).toBe('STANDARD');
    expect(res.body.instantFeeAmount).toBeUndefined();
  });

  it("a merchant's own payoutRail=INSTANT default is honored when no explicit rail is given", async () => {
    const payoutId = await verifiedConnectedPayout('connected-instant-merchant-default', { payoutRail: 'INSTANT' });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.transferStatus).toBe('PENDING_CONFIRMATION');
    expect(res.body.transferRail).toBe('INSTANT');
    expect(res.body.instantFeeAmount).toBeGreaterThan(0);
  });

  it('an explicit per-call rail overrides the merchant default', async () => {
    const payoutId = await verifiedConnectedPayout('connected-instant-override', { payoutRail: 'INSTANT' });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rail: 'STANDARD' })
      .expect(200);

    expect(res.body.transferStatus).toBe('INITIATED');
    expect(res.body.transferRail).toBe('STANDARD');
    expect(res.body.instantFeeAmount).toBeUndefined();
  });

  it('a signed "settled" webhook confirms an instant transfer to INITIATED, preserving the recorded rail/fee', async () => {
    const payoutId = await verifiedConnectedPayout('connected-instant-settle');
    const initRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rail: 'INSTANT' })
      .expect(200);
    const transferId = initRes.body.transferId as string;

    await postBankTransferWebhook(settledNotification(transferId)).expect(200);

    const persisted = await payoutService.findByIdOnMaster(payoutId);
    expect(persisted!.transferStatus).toBe('INITIATED');
    expect(persisted!.transferRail).toBe('INSTANT');
    expect(persisted!.instantFeeAmount?.amount).toBeCloseTo(0.38, 2);
  });

  it("PATCH /admin/merchants/:merchantId/payout-rail changes a merchant's default for its next sweep-initiated transfer", async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected-instant-patch'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });
    await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);

    const patchRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${connected.merchantId}/payout-rail`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ payoutRail: 'INSTANT' })
      .expect(200);
    expect(patchRes.body.payoutRail).toBe('INSTANT');

    await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 25 }],
    }).expect(201);
    await payoutService.runSweep();
    const payouts = await payoutService.findManyOnMaster({ merchantId: connected.merchantId });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payouts[0].id}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.transferRail).toBe('INSTANT');
  });
});
