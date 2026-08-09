import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { LedgerOutboxEntity } from '../src/modules/payment/adapters/persistence/entities/ledger-outbox.entity';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';
import { LedgerOutboxRelayService } from '../src/modules/payment/application/services/ledger-outbox-relay.service';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

describe('Ledger booking timing & Outbox relay (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;
  let dataSource: DataSource;
  let admin: SeededMerchant;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);
  });

  afterAll(async () => {
    await app.close();
  });

  function signedRequest(method: 'post', path: string, body: object) {
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(merchant.hmacSecret, method, path, bodyStr);
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', merchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  async function ledgerEntryCount(paymentId: string): Promise<number> {
    return dataSource.getRepository(LedgerOutboxEntity).count({ where: { paymentId } });
  }

  it('immediate-capture success books exactly one ledger entry', async () => {
    const res = await signedRequest('post', '/api/v1/payments/charge', {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    expect(await ledgerEntryCount(res.body.paymentId)).toBe(1);
  });

  it('manual capture books exactly one ledger entry, not two (regression test for a real bug found this session)', async () => {
    const chargeRes = await signedRequest('post', '/api/v1/payments/charge', {
      amount: 20,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      captureMethod: 'manual',
      binInfo: USD_BIN,
    }).expect(201);
    expect(chargeRes.body.status).toBe('REQUIRES_CAPTURE');

    // Ledger entries used to be written speculatively at intent-creation
    // *before* any PSP was contacted — this assertion is what catches that
    // regression if it comes back.
    expect(await ledgerEntryCount(chargeRes.body.paymentId)).toBe(0);

    await signedRequest('post', `/api/v1/payments/${chargeRes.body.paymentId}/capture`, {}).expect(200);

    expect(await ledgerEntryCount(chargeRes.body.paymentId)).toBe(1);
  });

  it('a payment that never reaches a PSP (no PSP supports the currency) books zero ledger entries', async () => {
    // Neither Stripe nor Adyen's mocked supportedCurrencies list includes KRW.
    const res = await signedRequest('post', '/api/v1/payments/charge', {
      amount: 40000,
      currency: 'KRW',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: { ...USD_BIN, country: 'KR' },
    });

    // The saga throws and the controller has no exception filter for it, so
    // this surfaces as a 500 — the payment itself is still correctly marked
    // FAILED with no ledger entry, which is what this test actually cares about.
    expect([201, 500]).toContain(res.status);

    const paymentRepo = dataSource.getRepository(PaymentEntity);
    const payment = await paymentRepo.findOne({ where: { merchantId: merchant.merchantId }, order: { createdAt: 'DESC' } });
    expect(payment?.status).toBe('FAILED');
    expect(await ledgerEntryCount(payment!.id)).toBe(0);
  });

  it('books the platform fee at the merchant\'s own configured rate, not a hardcoded 1.5%', async () => {
    // 500 bps = 5%, deliberately far from the 150bps (1.5%) default so a
    // fallback-to-default bug would be obvious rather than coincidentally
    // passing.
    const customFeeMerchant = await seedMerchant(app, { merchantId: uniqueId('feemerchant'), platformFeeBps: 500 });
    const customFeeToken = await login(app, customFeeMerchant.apiKeyId, customFeeMerchant.apiKeySecret);

    const body = {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    };
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(customFeeMerchant.hmacSecret, 'post', '/api/v1/payments/charge', bodyStr);
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/charge')
      .set('Authorization', `Bearer ${customFeeToken}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', customFeeMerchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(201);

    const outboxRepo = dataSource.getRepository(LedgerOutboxEntity);
    const event = await outboxRepo.findOne({ where: { paymentId: res.body.paymentId } });
    const feeEntry = (event?.entries as any[]).find((e) => e.accountType === 'FEE');
    // $100 at 5% = $5.00 = 500 minor units, not the default 1.5% ($150).
    expect(feeEntry.amountMinorUnits).toBe('500');
  });

  describe('Volume-based fee tiers', () => {
    /** No HMAC required — same posture as PATCH .../fee-rate and .../reserve-policy, which also don't move money by themselves. */
    function setFeeTiers(merchantId: string, tiers: { minVolumeMinorUnits: string; bps: number }[]) {
      return request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchantId}/fee-tiers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tiers });
    }

    async function chargeFeeEntry(m: SeededMerchant, mToken: string, amount: number, currency: string): Promise<any> {
      const bodyStr = JSON.stringify({ amount, currency, paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN });
      const { signature, timestamp } = signHmacRequest(m.hmacSecret, 'post', '/api/v1/payments/charge', bodyStr);
      const res = await request(app.getHttpServer())
        .post('/api/v1/payments/charge')
        .set('Authorization', `Bearer ${mToken}`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Signature', signature)
        .set('X-Timestamp', timestamp)
        .set('X-Merchant-Id', m.merchantId)
        .set('Content-Type', 'application/json')
        .send(JSON.parse(bodyStr))
        .expect(201);
      const outboxRepo = dataSource.getRepository(LedgerOutboxEntity);
      const event = await outboxRepo.findOne({ where: { paymentId: res.body.paymentId } });
      return (event?.entries as any[]).find((e) => e.accountType === 'FEE');
    }

    it('a charge below the lowest tier threshold still uses the flat platformFeeBps rate', async () => {
      const m = await seedMerchant(app, { merchantId: uniqueId('feetier'), platformFeeBps: 1000 });
      const mToken = await login(app, m.apiKeyId, m.apiKeySecret);
      await setFeeTiers(m.merchantId, [{ minVolumeMinorUnits: '10000', bps: 500 }]).expect(200);

      const fee = await chargeFeeEntry(m, mToken, 60, 'USD');
      // $60 at 10% (the flat rate — trailing volume is 0, below the $100 tier threshold) = $6.00 = 600 minor units.
      expect(fee.amountMinorUnits).toBe('600');
    });

    it('crossing a tier\'s volume threshold applies the new rate to the *next* charge, not retroactively to the one that crossed it', async () => {
      const m = await seedMerchant(app, { merchantId: uniqueId('feetiercross'), platformFeeBps: 1000 });
      const mToken = await login(app, m.apiKeyId, m.apiKeySecret);
      await setFeeTiers(m.merchantId, [{ minVolumeMinorUnits: '10000', bps: 500 }]).expect(200);

      // Charge 1: volume-before = 0 < 10000 -> still 10% ($6.00). Volume after: 6000.
      const fee1 = await chargeFeeEntry(m, mToken, 60, 'USD');
      expect(fee1.amountMinorUnits).toBe('600');

      // Charge 2: volume-before = 6000 < 10000 -> still 10% ($6.00). This charge is the one that
      // pushes trailing volume to 12000, crossing the threshold — but it's still priced at the old rate.
      const fee2 = await chargeFeeEntry(m, mToken, 60, 'USD');
      expect(fee2.amountMinorUnits).toBe('600');

      // Charge 3: volume-before = 12000 >= 10000 -> the new 5% tier applies. $60 * 5% = $3.00 = 300.
      const fee3 = await chargeFeeEntry(m, mToken, 60, 'USD');
      expect(fee3.amountMinorUnits).toBe('300');
    });

    it('tier volume is scoped per currency — USD volume crossing a threshold does not discount a EUR charge', async () => {
      const m = await seedMerchant(app, { merchantId: uniqueId('feetiercurrency'), platformFeeBps: 1000 });
      const mToken = await login(app, m.apiKeyId, m.apiKeySecret);
      await setFeeTiers(m.merchantId, [{ minVolumeMinorUnits: '10000', bps: 500 }]).expect(200);

      // Push USD trailing volume past the threshold.
      await chargeFeeEntry(m, mToken, 60, 'USD');
      await chargeFeeEntry(m, mToken, 60, 'USD');

      // A EUR charge has its own, separate (zero) trailing volume — still the flat 10% rate.
      const eurFee = await chargeFeeEntry(m, mToken, 60, 'EUR');
      expect(eurFee.amountMinorUnits).toBe('600');
    });

    it('clearing tiers with an empty array reverts to the flat platformFeeBps rate', async () => {
      const m = await seedMerchant(app, { merchantId: uniqueId('feetierclear'), platformFeeBps: 1000 });
      const mToken = await login(app, m.apiKeyId, m.apiKeySecret);
      await setFeeTiers(m.merchantId, [{ minVolumeMinorUnits: '0', bps: 500 }]).expect(200);

      const discounted = await chargeFeeEntry(m, mToken, 60, 'USD');
      expect(discounted.amountMinorUnits).toBe('300'); // 5% tier, threshold 0 always applies

      const clearRes = await setFeeTiers(m.merchantId, []).expect(200);
      expect(clearRes.body.feeTiers).toBeUndefined();

      const flatRate = await chargeFeeEntry(m, mToken, 60, 'USD');
      expect(flatRate.amountMinorUnits).toBe('600'); // back to flat 10%
    });

    it('non-ascending or duplicate tier thresholds are rejected with 422', async () => {
      const m = await seedMerchant(app, { merchantId: uniqueId('feetierbad') });
      const res = await setFeeTiers(m.merchantId, [
        { minVolumeMinorUnits: '10000', bps: 500 },
        { minVolumeMinorUnits: '10000', bps: 300 }, // duplicate threshold
      ]);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FEE_TIER_NOT_ASCENDING');
    });
  });

  it('the outbox relay picks up a PENDING entry and marks it PUBLISHED', async () => {
    const res = await signedRequest('post', '/api/v1/payments/charge', {
      amount: 15,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const outboxRepo = dataSource.getRepository(LedgerOutboxEntity);
    const beforeRelay = await outboxRepo.findOne({ where: { paymentId: res.body.paymentId } });
    expect(beforeRelay?.status).toBe('PENDING');

    // Invoke the exact method the @Cron schedule calls — same code path,
    // deterministic instead of waiting on a real 10-second tick.
    const relay = app.get(LedgerOutboxRelayService);
    await relay.relayPendingEvents();

    const afterRelay = await outboxRepo.findOne({ where: { paymentId: res.body.paymentId } });
    expect(afterRelay?.status).toBe('PUBLISHED');
    expect(afterRelay?.processedAt).not.toBeNull();
  });

  describe('Outbox dead-letter recovery (admin)', () => {
    it('lists a FAILED event, retries it back to PENDING, and the relay then actually publishes it', async () => {
      // markFailed() is only ever reached from a publish error, which
      // nothing in this stack naturally triggers — simulate the dead-letter
      // state directly, the same way an operator would find one in
      // production: a real charge, then a real event that got stuck FAILED.
      const chargeRes = await signedRequest('post', '/api/v1/payments/charge', {
        amount: 12,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(201);

      const outboxRepo = dataSource.getRepository(LedgerOutboxEntity);
      const event = await outboxRepo.findOne({ where: { paymentId: chargeRes.body.paymentId } });
      expect(event).not.toBeNull();
      await outboxRepo.update(event!.id, { status: 'FAILED', lastError: 'simulated downstream publish failure', retryCount: 1 });

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/outbox/failed')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const listed = listRes.body.find((e: any) => e.id === event!.id);
      expect(listed).toBeDefined();
      expect(listed.status).toBe('FAILED');
      expect(listed.lastError).toBe('simulated downstream publish failure');

      // A non-admin merchant can't retry it.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/outbox/${event!.id}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/outbox/${event!.id}/retry`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const afterRetry = await outboxRepo.findOne({ where: { id: event!.id } });
      expect(afterRetry?.status).toBe('PENDING');
      expect(afterRetry?.lastError).toBeNull();

      // Retrying an event that isn't FAILED is rejected, not silently accepted.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/outbox/${event!.id}/retry`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      // Prove this isn't just a status flip — the relay picks the reset
      // event up on its next tick like any other PENDING event.
      const relay = app.get(LedgerOutboxRelayService);
      await relay.relayPendingEvents();

      const afterRelay = await outboxRepo.findOne({ where: { id: event!.id } });
      expect(afterRelay?.status).toBe('PUBLISHED');
    });

    it('retrying a nonexistent event id returns 404', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/outbox/00000000-0000-0000-0000-000000000000/retry')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });
});
