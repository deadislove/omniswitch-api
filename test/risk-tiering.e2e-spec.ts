import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook } from './utils/signing';
import { MerchantEntity } from '../src/modules/merchant/merchant.entity';
import { DisputeEntity } from '../src/modules/payment/adapters/persistence/entities/dispute.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Automatic risk-tier adjustment: RiskTieringService recomputes a
 * merchant's trailing lost-dispute rate and adjusts
 * MerchantEntity.reserveBps/reserveHoldDays accordingly — see that
 * service's docblock for the (deliberately simple, documented as
 * illustrative) thresholds, and MerchantEntity.riskTierAutoManaged for
 * why a manual PATCH .../reserve-policy call takes a merchant out of
 * auto-management.
 */
describe('Automatic risk-tier adjustment (e2e)', () => {
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

  async function chargeImmediate(m: SeededMerchant, t: string, amount = 20) {
    const bodyObj = { amount, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN };
    const bodyStr = JSON.stringify(bodyObj);
    const { signature, timestamp } = signHmacRequest(m.hmacSecret, 'post', '/api/v1/payments/charge', bodyStr);
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/charge')
      .set('Authorization', `Bearer ${t}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', m.merchantId)
      .set('Content-Type', 'application/json')
      .send(bodyObj)
      .expect(201);
    return res.body;
  }

  /** Creates a dispute against `payment` and immediately resolves it LOST — the signal RiskTieringService actually looks at. */
  async function createLostDispute(payment: any): Promise<string> {
    const disputeId = 'dp_' + uniqueId('risktier');
    const createBody = JSON.stringify({
      id: 'evt_' + uniqueId('risktier'),
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, payment_intent: payment.pspTransactionId, reason: 'fraudulent' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, createBody))
      .set('Content-Type', 'application/json')
      .send(createBody)
      .expect(200);

    const closeBody = JSON.stringify({
      id: 'evt_' + uniqueId('risktier'),
      type: 'charge.dispute.closed',
      data: { object: { id: disputeId, status: 'lost' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, closeBody))
      .set('Content-Type', 'application/json')
      .send(closeBody)
      .expect(200);

    return disputeId;
  }

  async function runTieringNow(): Promise<{ evaluated: number; changed: number; skipped: number }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/risk-tiering/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return res.body;
  }

  // Every read in this file follows a write it just made (or an admin
  // sweep that just ran) — that races the ambient DataSource's replica
  // routing (app.module.ts's `replication` config sends plain repository
  // reads to the replica, which has ~1s streaming lag behind master; see
  // reserve.service.ts's release() and test/ledger-and-outbox.e2e-spec.ts
  // for the same issue confirmed live elsewhere). This helper forces the
  // read onto master.
  async function findOneOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<T | null> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.findOne(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

  async function getMerchant(merchantId: string): Promise<MerchantEntity> {
    return (await findOneOnMaster(MerchantEntity, { merchantId }))!;
  }

  it('a merchant with fewer than the minimum sample size of settled charges is skipped — reserve policy stays untouched', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('risklowvol') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    for (let i = 0; i < 3; i++) {
      await chargeImmediate(merchant, token);
    }

    await runTieringNow();

    const after = await getMerchant(merchant.merchantId);
    expect(after.reserveBps).toBe(0);
    expect(after.reserveHoldDays).toBe(0);
    expect(after.riskTierAutoManaged).toBe(true);
  });

  it('a merchant with a high lost-dispute rate over sufficient volume is auto-escalated to a higher reserve tier', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskhigh') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const payments: any[] = [];
    for (let i = 0; i < 10; i++) {
      payments.push(await chargeImmediate(merchant, token));
    }
    // 1 lost dispute / 10 settled charges = 10% — comfortably over the
    // (deliberately low, illustrative) 1% HIGH-risk threshold.
    await createLostDispute(payments[0]);

    const sweep = await runTieringNow();
    expect(sweep.evaluated).toBeGreaterThanOrEqual(1);

    const after = await getMerchant(merchant.merchantId);
    expect(after.reserveBps).toBe(1500);
    expect(after.reserveHoldDays).toBe(90);
  });

  it('a manual reserve-policy change disables auto-management, and the sweep leaves it alone even with a high dispute rate', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskmanual') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const patchRes = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/reserve-policy`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reserveBps: 250, reserveHoldDays: 14 })
      .expect(200);
    expect(patchRes.body.riskTierAutoManaged).toBe(false);

    const payments: any[] = [];
    for (let i = 0; i < 10; i++) {
      payments.push(await chargeImmediate(merchant, token));
    }
    await createLostDispute(payments[0]);

    await runTieringNow();

    // Untouched — still exactly the manually-set values, not HIGH tier.
    const after = await getMerchant(merchant.merchantId);
    expect(after.reserveBps).toBe(250);
    expect(after.reserveHoldDays).toBe(14);
    expect(after.riskTierAutoManaged).toBe(false);

    // Re-enabling auto-management lets the *next* sweep act on it.
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/risk-tier-auto`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true })
      .expect(200);
    await runTieringNow();

    const afterReenable = await getMerchant(merchant.merchantId);
    expect(afterReenable.reserveBps).toBe(1500);
    expect(afterReenable.reserveHoldDays).toBe(90);
  });

  it('a merchant\'s reserve tapers back down once the lost dispute driving it falls outside the trailing 90-day window', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('risktaper') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const payments: any[] = [];
    for (let i = 0; i < 10; i++) {
      payments.push(await chargeImmediate(merchant, token));
    }
    const disputeId = await createLostDispute(payments[0]);
    await runTieringNow();

    const escalated = await getMerchant(merchant.merchantId);
    expect(escalated.reserveBps).toBe(1500);

    // Push the dispute's createdAt to 100 days ago — outside the 90-day
    // trailing window RiskTieringService actually looks at — simulating
    // time passing without touching real wall-clock time.
    const disputeEntity = await findOneOnMaster(DisputeEntity, { pspDisputeId: disputeId });
    await dataSource.getRepository(DisputeEntity).update(disputeEntity!.id, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

    await runTieringNow();

    const tapered = await getMerchant(merchant.merchantId);
    expect(tapered.reserveBps).toBe(0);
    expect(tapered.reserveHoldDays).toBe(0);
  });

  it('a non-admin/operator cannot trigger the risk tiering sweep', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('risknonadmin') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    await request(app.getHttpServer())
      .post('/api/v1/admin/risk-tiering/run')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
