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
const BANK_TRANSFER_WEBHOOK_SECRET = process.env.BANK_TRANSFER_WEBHOOK_SECRET!;

/**
 * The real, async-settling bank transfer rails (AchBankTransferAdapter/
 * WireBankTransferAdapter) — as opposed to marketplace-payouts.e2e-spec.ts's
 * coverage of the synchronous mock rail. Selected via BANK_TRANSFER_PROVIDER,
 * read once at DI-container build time (payment.module.ts's useFactory for
 * BankTransferPort), so this file boots its own app instance with the env
 * var set *before* createTestApp() — same pattern
 * psp-bulkhead-isolation.e2e-spec.ts uses for PSP_BULKHEAD_MAX_CONCURRENT —
 * and restores it afterward so it doesn't leak into whichever e2e file the
 * same Jest worker runs next (every other file relies on the 'mock'
 * default).
 *
 * scripts/mock-psp/server.js's /ach/transfers and /wire/transfers endpoints
 * really do call back asynchronously with a signed settlement confirmation
 * (see scheduleBankTransferSettlement() there) — but only when APP_BASE_URL
 * points at a reachable app, which is docker-compose's `api` container, not
 * this Jest-booted in-process app (mock-psp can't reach into this process).
 * So — same posture webhooks.e2e-spec.ts already takes toward Stripe/Adyen
 * webhooks — this file posts directly, with a real computed signature, to
 * POST /webhooks/bank-transfer instead of waiting for a live callback. That
 * exercises the exact same guard + PayoutService.confirmTransfer() code
 * path a real callback would hit; only the network hop from mock-psp is
 * skipped.
 */
describe('Bank transfer rail: ACH/Wire (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let payoutService: PayoutService;
  const originalProvider = process.env.BANK_TRANSFER_PROVIDER;
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

  async function verifiedConnectedPayout(merchantIdPrefix: string, amount = 40, splitAmount = 25): Promise<string> {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId(merchantIdPrefix),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
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
    return payouts[0].id;
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

  it('initiating a transfer against the ACH rail lands the payout in PENDING_CONFIRMATION, not INITIATED', async () => {
    const payoutId = await verifiedConnectedPayout('connected-ach-pending');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.transferStatus).toBe('PENDING_CONFIRMATION');
    expect(res.body.transferId).toEqual(expect.any(String));
    expect(String(res.body.transferId)).toMatch(/^ach_mock_/);

    const persisted = await payoutService.findById(payoutId);
    expect(persisted!.transferStatus).toBe('PENDING_CONFIRMATION');
  });

  it('a second initiate-transfer call while PENDING_CONFIRMATION is rejected with 409', async () => {
    const payoutId = await verifiedConnectedPayout('connected-ach-double-init');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(res.body.code).toBe('PAYOUT_TRANSFER_ALREADY_INITIATED');
  });

  it('a signed "settled" webhook confirms a PENDING_CONFIRMATION transfer to INITIATED', async () => {
    const payoutId = await verifiedConnectedPayout('connected-ach-settle');
    const initRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const transferId = initRes.body.transferId as string;

    await postBankTransferWebhook({ transferId, status: 'settled' }).expect(200);

    const confirmed = await payoutService.findById(payoutId);
    expect(confirmed!.transferStatus).toBe('INITIATED');
    expect(confirmed!.transferId).toBe(transferId);
  });

  it('a signed "failed" webhook moves a PENDING_CONFIRMATION transfer to FAILED with the given reason', async () => {
    const payoutId = await verifiedConnectedPayout('connected-ach-clearing-fail');
    const initRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const transferId = initRes.body.transferId as string;

    await postBankTransferWebhook({ transferId, status: 'failed', reason: 'insufficient_funds' }).expect(200);

    const failed = await payoutService.findById(payoutId);
    expect(failed!.transferStatus).toBe('FAILED');
    expect(failed!.transferError).toBe('insufficient_funds');
  });

  it('redelivering the same "settled" webhook twice is idempotent (no error, stays INITIATED)', async () => {
    const payoutId = await verifiedConnectedPayout('connected-ach-idempotent');
    const initRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const transferId = initRes.body.transferId as string;

    for (let i = 0; i < 2; i++) {
      await postBankTransferWebhook({ transferId, status: 'settled' }).expect(200);
    }

    const confirmed = await payoutService.findById(payoutId);
    expect(confirmed!.transferStatus).toBe('INITIATED');
  });

  it('a webhook for an unknown transferId is a no-op 200, not an error (unrecognized/retried delivery)', async () => {
    await postBankTransferWebhook({ transferId: 'ach_mock_does_not_exist', status: 'settled' }).expect(200);
  });

  it('rejects a bank-transfer webhook with no signature header', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/bank-transfer')
      .send({ transferId: 'ach_mock_x', status: 'settled' })
      .expect(401);
  });

  it('rejects a bank-transfer webhook with an invalid signature', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/bank-transfer')
      .set('X-Bank-Transfer-Signature', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`)
      .send({ transferId: 'ach_mock_x', status: 'settled' })
      .expect(401);
  });

  it('the ACH rail\'s outright-rejection marker ("transferreject" in merchantId) fails synchronously, without ever reaching PENDING_CONFIRMATION', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected-transferreject'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });
    await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 30,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 15 }],
    }).expect(201);
    await payoutService.runSweep();
    const payouts = await payoutService.findMany({ merchantId: connected.merchantId });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payouts[0].id}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(422);
    expect(res.body.code).toBe('PAYOUT_TRANSFER_FAILED');

    const afterReject = await payoutService.findById(payouts[0].id);
    expect(afterReject!.transferStatus).toBe('FAILED');
  });
});

describe('Bank transfer rail: Wire (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let payoutService: PayoutService;
  const originalProvider = process.env.BANK_TRANSFER_PROVIDER;
  const sharedRedisDb = forceSharedRedisDbForSweepLock();
  let releaseSweepMutex: () => Promise<void>;

  beforeAll(async () => {
    process.env.BANK_TRANSFER_PROVIDER = 'wire';
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

  it('the same PENDING_CONFIRMATION -> webhook -> INITIATED flow works against the Wire rail too, proving the mechanism generalizes across providers', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected-wire'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
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

    const initRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payouts[0].id}/initiate-transfer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(initRes.body.transferStatus).toBe('PENDING_CONFIRMATION');
    expect(String(initRes.body.transferId)).toMatch(/^wire_mock_/);

    const webhookBody = JSON.stringify({ transferId: initRes.body.transferId, status: 'settled' });
    const signature2 = signBankTransferWebhook(BANK_TRANSFER_WEBHOOK_SECRET, webhookBody);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/bank-transfer')
      .set('X-Bank-Transfer-Signature', signature2)
      .set('Content-Type', 'application/json')
      .send(webhookBody)
      .expect(200);

    const confirmed = await payoutService.findById(payouts[0].id);
    expect(confirmed!.transferStatus).toBe('INITIATED');
  });
});
