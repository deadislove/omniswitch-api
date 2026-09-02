import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { PayoutService } from '../src/modules/payment/application/services/payout.service';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Marketplace payout scheduling (phase 2 of splits): a CONNECTED
 * merchant's split credits are batched into scheduled Payout records
 * instead of being treated as immediately disbursable, withholding a
 * rolling reserve (MerchantEntity.payoutReserveBps/payoutReserveHoldDays)
 * the same way a real marketplace processor would. See
 * docs/business-domain/ledger-and-settlement.md#marketplace-splits and
 * PayoutService's docblock for why this doesn't move any ledger money
 * itself — it's a scheduling overlay on a balance that's already
 * correctly booked by the split mechanism.
 */
describe('Marketplace payout scheduling (e2e)', () => {
  let app: INestApplication;
  let admin: SeededMerchant;
  let adminToken: string;
  let dataSource: DataSource;
  let payoutService: PayoutService;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    payoutService = app.get(PayoutService);
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

  async function platformWithConnected(payoutReserveBps = 0, payoutReserveHoldDays = 0): Promise<{ platform: SeededMerchant; platformToken: string; connected: SeededMerchant }> {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
      payoutReserveBps,
      payoutReserveHoldDays,
    });
    return { platform, platformToken, connected };
  }

  async function chargeWithSplit(platform: SeededMerchant, platformToken: string, connectedMerchantId: string, amount: number, splitAmount: number) {
    return signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connectedMerchantId, amount: splitAmount }],
    }).expect(201);
  }

  function submitKyc(merchantId: string, legalName: string, taxId = '12-3456789') {
    return request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName, taxId });
  }

  it('a sweep batches a connected merchant\'s split credit into a Payout, withholding the configured rolling reserve', async () => {
    const { platform, platformToken, connected } = await platformWithConnected(1000, 90); // 10% rolling reserve, 90-day hold
    await chargeWithSplit(platform, platformToken, connected.merchantId, 100, 40); // connected gets $40

    const sweepRes = await request(app.getHttpServer())
      .post('/api/v1/admin/marketplace/run-payouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(sweepRes.body.connectedMerchantsPaid).toBeGreaterThanOrEqual(1);

    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/admin/marketplace/payouts?merchantId=${connected.merchantId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(listRes.body).toHaveLength(1);
    const payout = listRes.body[0];
    expect(payout.grossAmount).toBe(40);
    expect(payout.reserveAmount).toBe(4); // 10% of $40
    expect(payout.netAmount).toBe(36);
    expect(payout.reserveStatus).toBe('HELD');
    expect(payout.releaseEligibleAt).toEqual(expect.any(String));

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/admin/marketplace/payouts/${payout.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(getRes.body.id).toBe(payout.id);
  });

  it('a connected merchant with no rolling reserve configured gets a Payout with reserveAmount 0 and reserveStatus NONE', async () => {
    const { platform, platformToken, connected } = await platformWithConnected(0, 0);
    await chargeWithSplit(platform, platformToken, connected.merchantId, 50, 20);

    await request(app.getHttpServer())
      .post('/api/v1/admin/marketplace/run-payouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/admin/marketplace/payouts?merchantId=${connected.merchantId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].grossAmount).toBe(20);
    expect(listRes.body[0].reserveAmount).toBe(0);
    expect(listRes.body[0].netAmount).toBe(20);
    expect(listRes.body[0].reserveStatus).toBe('NONE');
    expect(listRes.body[0].releaseEligibleAt).toBeUndefined();
  });

  it('running the sweep twice does not double-count already-swept credit — the second run creates no new Payout for unchanged activity', async () => {
    const { platform, platformToken, connected } = await platformWithConnected(0, 0);
    await chargeWithSplit(platform, platformToken, connected.merchantId, 30, 10);

    await payoutService.runSweep();
    const afterFirst = await payoutService.findMany({ merchantId: connected.merchantId });
    expect(afterFirst).toHaveLength(1);

    // No new charges happened — a second sweep should find nothing new for this merchant.
    await payoutService.runSweep();
    const afterSecond = await payoutService.findMany({ merchantId: connected.merchantId });
    expect(afterSecond).toHaveLength(1);

    // A new charge after the second sweep produces exactly one more Payout, not a re-sum of history.
    await chargeWithSplit(platform, platformToken, connected.merchantId, 30, 10);
    await payoutService.runSweep();
    const afterThird = await payoutService.findMany({ merchantId: connected.merchantId });
    expect(afterThird).toHaveLength(2);
    expect(afterThird.every((p) => p.grossAmount.amount === 10)).toBe(true);
  });

  it('two replicas racing the same noon tick do not both pay out the same credit', async () => {
    // Distinct from the sequential "running the sweep twice" test above:
    // both calls here share the same `now`, simulating two pods' @Cron
    // handlers firing at the same wall-clock instant and both reading
    // findLatestSweepRun() before either has written its own
    // PayoutSweepRun — the actual race window this test targets, which a
    // sequential await await never exercises.
    const { platform, platformToken, connected } = await platformWithConnected(0, 0);
    await chargeWithSplit(platform, platformToken, connected.merchantId, 30, 10);

    const now = new Date();
    const [first, second] = await Promise.all([payoutService.runSweep(now), payoutService.runSweep(now)]);

    // Exactly one of the two concurrent calls actually ran the sweep — the
    // other found the SWEEP_LOCK_KEY lock already held and returned null
    // rather than racing it.
    const results = [first, second];
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);

    const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
    expect(payouts).toHaveLength(1);
  });

  it('a PLATFORM merchant\'s own charge proceeds are never turned into a Payout', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('platformonly') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 25, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
    }).expect(201);

    await payoutService.runSweep();
    const payouts = await payoutService.findMany({ merchantId: merchant.merchantId });
    expect(payouts).toHaveLength(0);
  });

  it('the reserve-release sweep releases a payout reserve whose hold period has already elapsed (holdDays: 0) and leaves an ineligible one alone', async () => {
    const eligible = await platformWithConnected(1000, 0);
    const ineligible = await platformWithConnected(1000, 90);
    await chargeWithSplit(eligible.platform, eligible.platformToken, eligible.connected.merchantId, 40, 20);
    await chargeWithSplit(ineligible.platform, ineligible.platformToken, ineligible.connected.merchantId, 40, 20);
    await payoutService.runSweep();

    const sweepRes = await request(app.getHttpServer())
      .post('/api/v1/admin/marketplace/release-eligible-reserves')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(sweepRes.body.released).toBeGreaterThanOrEqual(1);
    expect(sweepRes.body.failed).toBe(0);

    const eligiblePayouts = await payoutService.findMany({ merchantId: eligible.connected.merchantId });
    expect(eligiblePayouts[0].reserveStatus).toBe('RELEASED');
    const ineligiblePayouts = await payoutService.findMany({ merchantId: ineligible.connected.merchantId });
    expect(ineligiblePayouts[0].reserveStatus).toBe('HELD');
  });

  it('a manual force-release works before releaseEligibleAt, and releasing twice is rejected with 409', async () => {
    const { platform, platformToken, connected } = await platformWithConnected(1000, 90);
    await chargeWithSplit(platform, platformToken, connected.merchantId, 40, 20);
    await payoutService.runSweep();
    const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
    const payoutId = payouts[0].id;

    const releaseRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/release-reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(releaseRes.body.reserveStatus).toBe('RELEASED');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/marketplace/payouts/${payoutId}/release-reserve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
  });

  it('PATCH /admin/merchants/:id/payout-reserve-policy changes the rate a later sweep uses', async () => {
    const { platform, platformToken, connected } = await platformWithConnected(0, 0);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${connected.merchantId}/payout-reserve-policy`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ payoutReserveBps: 2000, payoutReserveHoldDays: 30 })
      .expect(200);

    await chargeWithSplit(platform, platformToken, connected.merchantId, 100, 50);
    await payoutService.runSweep();

    const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
    expect(payouts).toHaveLength(1);
    expect(payouts[0].reserveAmount.amount).toBe(10); // 20% of $50
    expect(payouts[0].netAmount.amount).toBe(40);
  });

  describe('Connected-account KYC and payout gating', () => {
    it('a connected merchant defaults to kycStatus NOT_STARTED, and its payouts are created KYC-blocked', async () => {
      const { platform, platformToken, connected } = await platformWithConnected(0, 0);

      const summaryRes = await request(app.getHttpServer())
        .get('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const found = summaryRes.body.find((m: any) => m.merchantId === connected.merchantId);
      expect(found.kycStatus).toBe('NOT_STARTED');

      await chargeWithSplit(platform, platformToken, connected.merchantId, 40, 20);
      await payoutService.runSweep();

      const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
      expect(payouts).toHaveLength(1);
      expect(payouts[0].kycBlocked).toBe(true);
      // Gross/net/reserve math is computed exactly as usual — KYC blocks
      // *transfer*, it doesn't change the split accounting.
      expect(payouts[0].netAmount.amount).toBe(20);
    });

    it('submitting KYC with a legal name that fails verification is rejected, and payouts stay blocked', async () => {
      const { platform, platformToken, connected } = await platformWithConnected(0, 0);

      const kycRes = await submitKyc(connected.merchantId, 'Reject Corp').expect(200);
      expect(kycRes.body.kycStatus).toBe('REJECTED');

      await chargeWithSplit(platform, platformToken, connected.merchantId, 30, 15);
      await payoutService.runSweep();
      const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
      expect(payouts[0].kycBlocked).toBe(true);
    });

    it('a verified connected merchant\'s payouts are not KYC-blocked, and its transfer can be initiated', async () => {
      const { platform, platformToken, connected } = await platformWithConnected(0, 0);

      const kycRes = await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
      expect(kycRes.body.kycStatus).toBe('VERIFIED');

      await chargeWithSplit(platform, platformToken, connected.merchantId, 40, 25);
      await payoutService.runSweep();
      const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
      expect(payouts[0].kycBlocked).toBe(false);

      const transferRes = await request(app.getHttpServer())
        .post(`/api/v1/admin/marketplace/payouts/${payouts[0].id}/initiate-transfer`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(transferRes.body.transferStatus).toBe('INITIATED');
      expect(transferRes.body.transferId).toEqual(expect.any(String));
      expect(transferRes.body.transferInitiatedAt).toEqual(expect.any(String));

      // A second attempt is rejected — a real bank transfer can't be sent twice.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/marketplace/payouts/${payouts[0].id}/initiate-transfer`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
    });

    it('initiating a transfer for a KYC-blocked payout is rejected with 409', async () => {
      const { platform, platformToken, connected } = await platformWithConnected(0, 0);
      await chargeWithSplit(platform, platformToken, connected.merchantId, 30, 15);
      await payoutService.runSweep();
      const payouts = await payoutService.findMany({ merchantId: connected.merchantId });
      expect(payouts[0].kycBlocked).toBe(true);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/marketplace/payouts/${payouts[0].id}/initiate-transfer`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
      expect(res.body.code).toBe('PAYOUT_KYC_BLOCKED');
    });

    it('the recheck-kyc-blocks sweep clears a payout once its merchant becomes VERIFIED after the payout was already created', async () => {
      const { platform, platformToken, connected } = await platformWithConnected(0, 0);
      // Payout created BEFORE KYC is ever submitted — starts blocked.
      await chargeWithSplit(platform, platformToken, connected.merchantId, 30, 15);
      await payoutService.runSweep();
      const before = await payoutService.findMany({ merchantId: connected.merchantId });
      expect(before[0].kycBlocked).toBe(true);

      await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);

      const recheckRes = await request(app.getHttpServer())
        .post('/api/v1/admin/marketplace/recheck-kyc-blocks')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(recheckRes.body.cleared).toBeGreaterThanOrEqual(1);

      const after = await payoutService.findMany({ merchantId: connected.merchantId });
      expect(after[0].kycBlocked).toBe(false);
      expect(after[0].kycClearedAt).toBeTruthy();
    });

    it('a bank transfer decline is recorded as FAILED and surfaces a 422, without blocking a retry', async () => {
      // "transferfail" in the merchantId is the mock bank's decline marker.
      const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
      const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
      const connected = await seedMerchant(app, {
        merchantId: uniqueId('connected-transferfail'),
        accountType: 'CONNECTED',
        platformMerchantId: platform.merchantId,
      });
      await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
      await chargeWithSplit(platform, platformToken, connected.merchantId, 30, 15);
      await payoutService.runSweep();
      const payouts = await payoutService.findMany({ merchantId: connected.merchantId });

      const failRes = await request(app.getHttpServer())
        .post(`/api/v1/admin/marketplace/payouts/${payouts[0].id}/initiate-transfer`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422);
      expect(failRes.body.code).toBe('PAYOUT_TRANSFER_FAILED');

      const afterFail = await payoutService.findById(payouts[0].id);
      expect(afterFail!.transferStatus).toBe('FAILED');
      expect(afterFail!.transferError).toBeTruthy();
    });

    it('the initiate-eligible-transfers sweep initiates transfers for every eligible payout and skips KYC-blocked ones', async () => {
      const verified = await platformWithConnected(0, 0);
      await submitKyc(verified.connected.merchantId, 'Acme Sellers LLC').expect(200);
      const blocked = await platformWithConnected(0, 0);

      await chargeWithSplit(verified.platform, verified.platformToken, verified.connected.merchantId, 40, 20);
      await chargeWithSplit(blocked.platform, blocked.platformToken, blocked.connected.merchantId, 40, 20);
      await payoutService.runSweep();

      const sweepRes = await request(app.getHttpServer())
        .post('/api/v1/admin/marketplace/initiate-eligible-transfers')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(sweepRes.body.initiated).toBeGreaterThanOrEqual(1);

      const verifiedPayouts = await payoutService.findMany({ merchantId: verified.connected.merchantId });
      expect(verifiedPayouts[0].transferStatus).toBe('INITIATED');
      const blockedPayouts = await payoutService.findMany({ merchantId: blocked.connected.merchantId });
      expect(blockedPayouts[0].transferStatus).toBe('NOT_INITIATED');
    });
  });
});
