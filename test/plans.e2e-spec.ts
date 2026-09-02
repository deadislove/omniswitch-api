import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { SubscriptionEntity } from '../src/modules/payment/adapters/persistence/entities/subscription.entity';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

/**
 * Subscription plan catalog & proration: a reusable Plan (amount/
 * currency/interval defined once) can back a subscription instead of the
 * subscription carrying its own pricing directly — see Plan aggregate's
 * docblock for why plans are immutable/deactivate-only,
 * Subscription.computeUpgradeProration()'s docblock for the upgrade
 * proration design (charges immediately), and computeDowngradeCredit()'s
 * for the downgrade side (issues a credit applied against a future
 * period's charge instead of a refund now).
 */
describe('Subscription plan catalog & proration (e2e)', () => {
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

  async function createPlan(m: SeededMerchant, t: string, body: object) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${t}`)
      .send(body)
      .expect(201);
    return res.body;
  }

  // Every read in this file follows a write it just made — that races
  // the ambient DataSource's replica routing (app.module.ts's
  // `replication` config sends plain repository reads to the replica,
  // which has ~1s streaming lag behind master; see reserve.service.ts's
  // release() and test/ledger-and-outbox.e2e-spec.ts for the same issue).
  // This helper forces the read onto master.
  // .update()/.save() calls don't need it — TypeORM's replication mode
  // always routes writes to master regardless of which repository issues
  // them.
  async function countOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<number> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.count(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

  async function findOnMaster<T extends object>(entityClass: new () => T, where: object, order?: object): Promise<T[]> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.find(entityClass, { where, ...(order ? { order } : {}) });
    } finally {
      await queryRunner.release();
    }
  }

  /** Sets the subscription's current period to an exact, known midpoint (50% elapsed) for deterministic proration math. */
  async function setPeriodToMidpoint(subscriptionId: string, periodDays: number): Promise<void> {
    const now = Date.now();
    const halfMs = (periodDays * 24 * 60 * 60 * 1000) / 2;
    await dataSource.getRepository(SubscriptionEntity).update(subscriptionId, {
      currentPeriodStart: new Date(now - halfMs),
      currentPeriodEnd: new Date(now + halfMs),
    });
  }

  it('creates a plan and lists/gets it', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('planbasic') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const plan = await createPlan(merchant, token, { name: 'Pro Monthly', amount: 29.99, currency: 'USD', interval: 'month' });
    expect(plan.name).toBe('Pro Monthly');
    expect(plan.amount).toBe(29.99);
    expect(plan.intervalCount).toBe(1);
    expect(plan.isActive).toBe(true);

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/plans/${plan.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(getRes.body.id).toBe(plan.id);

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listRes.body.some((p: any) => p.id === plan.id)).toBe(true);
  });

  it('creating a subscription from a plan derives amount/currency/interval from it', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('planderive') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const plan = await createPlan(merchant, token, { name: 'Basic', amount: 15, currency: 'USD', interval: 'week', intervalCount: 2 });

    const subRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
      planId: plan.id,
      customerId: uniqueId('cust'),
      paymentMethodId: 'pm_card_visa',
    }).expect(201);

    expect(subRes.body.planId).toBe(plan.id);
    expect(subRes.body.amount).toBe(15);
    expect(subRes.body.currency).toBe('USD');
    expect(subRes.body.interval).toBe('week');
    expect(subRes.body.intervalCount).toBe(2);
    expect(subRes.body.status).toBe('ACTIVE');
  });

  it('a subscription can still be created without a plan, directly (backward compatible)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('plandirect') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const subRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
      amount: 12, currency: 'USD', interval: 'month', customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
    }).expect(201);

    // Undefined, not null — this response is the in-memory object the
    // service just constructed, never round-tripped through Postgres (see
    // plan.controller.ts vs. a fresh DB read for why that distinction
    // matters — TypeORM only ever reads an empty nullable column back as
    // null, not undefined).
    expect(subRes.body.planId).toBeUndefined();
    expect(subRes.body.amount).toBe(12);
  });

  it('creating a subscription with neither a plan nor direct pricing fails with 422', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('planmissing') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
      customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
    }).expect(422);
  });

  describe('Plan changes and proration', () => {
    it('an upgrade mid-period charges exactly the prorated difference (deterministic: exactly 50% of the period remaining)', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('planupgrade') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      const planA = await createPlan(merchant, token, { name: 'Basic', amount: 20, currency: 'USD', interval: 'day', intervalCount: 30 });
      const planB = await createPlan(merchant, token, { name: 'Pro', amount: 40, currency: 'USD', interval: 'day', intervalCount: 30 });

      const subRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        planId: planA.id, customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
      }).expect(201);

      await setPeriodToMidpoint(subRes.body.id, 30);

      const changeRes = await signedRequest(merchant, token, 'post', `/api/v1/subscriptions/${subRes.body.id}/change-plan`, {
        planId: planB.id,
      }).expect(200);

      // (40 - 20) * 0.5 remaining = 10 exactly.
      expect(changeRes.body.prorationCharged).toBe(10);
      expect(changeRes.body.subscription.planId).toBe(planB.id);
      expect(changeRes.body.subscription.amount).toBe(40);
      expect(changeRes.body.subscription.interval).toBe('day');

      // A real charge happened — 2 payments total (the original + the proration).
      const paymentCount = await countOnMaster(PaymentEntity, { merchantId: merchant.merchantId });
      expect(paymentCount).toBe(2);
    });

    it('a downgrade mid-period charges nothing immediately, but issues a credit for a future period — the price changes going forward', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('plandowngrade') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      const planA = await createPlan(merchant, token, { name: 'Pro', amount: 40, currency: 'USD', interval: 'day', intervalCount: 30 });
      const planB = await createPlan(merchant, token, { name: 'Basic', amount: 20, currency: 'USD', interval: 'day', intervalCount: 30 });

      const subRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        planId: planA.id, customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
      }).expect(201);

      await setPeriodToMidpoint(subRes.body.id, 30);

      const changeRes = await signedRequest(merchant, token, 'post', `/api/v1/subscriptions/${subRes.body.id}/change-plan`, {
        planId: planB.id,
      }).expect(200);

      expect(changeRes.body.prorationCharged).toBeUndefined();
      // (40 - 20) * 0.5 remaining = 10 exactly — the unused portion of the old, pricier plan.
      expect(changeRes.body.creditIssued).toBe(10);
      expect(changeRes.body.subscription.amount).toBe(20);
      expect(changeRes.body.subscription.pendingCredit).toBe(10);

      // No new charge — still just the original payment. The credit is
      // only ever applied against a *future* period's charge, not
      // refunded now.
      const paymentCount = await countOnMaster(PaymentEntity, { merchantId: merchant.merchantId });
      expect(paymentCount).toBe(1);
    });

    it('a downgrade credit partially reduces the next period\'s charge, and is fully consumed if it exceeds that charge', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('plandowngradecredit') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      const planA = await createPlan(merchant, token, { name: 'Pro', amount: 40, currency: 'USD', interval: 'day', intervalCount: 30 });
      const planB = await createPlan(merchant, token, { name: 'Basic', amount: 20, currency: 'USD', interval: 'day', intervalCount: 30 });

      const subRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        planId: planA.id, customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
      }).expect(201);
      await setPeriodToMidpoint(subRes.body.id, 30);

      const changeRes = await signedRequest(merchant, token, 'post', `/api/v1/subscriptions/${subRes.body.id}/change-plan`, {
        planId: planB.id,
      }).expect(200);
      expect(changeRes.body.creditIssued).toBe(10); // credit is $10, next period's price is $20 (planB)

      // Push the period into the past so the billing sweep considers it due, then run it.
      await dataSource.getRepository(SubscriptionEntity).update(subRes.body.id, { currentPeriodEnd: new Date(Date.now() - 60_000) });
      const sweepRes = await request(app.getHttpServer())
        .post('/api/v1/admin/subscriptions/run-billing')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(sweepRes.body.charged).toBeGreaterThanOrEqual(1);

      const afterRes = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions/${subRes.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(afterRes.body.status).toBe('ACTIVE');
      expect(afterRes.body.pendingCredit).toBeUndefined(); // fully consumed ($10 credit < $20 charge)

      // The renewal charge should be $20 - $10 = $10, not the full $20.
      const payments = await findOnMaster(PaymentEntity, { merchantId: merchant.merchantId }, { createdAt: 'ASC' });
      expect(payments).toHaveLength(2); // original $40 charge + this $10 renewal
      expect(payments[1].amountMinorUnits).toBe('1000');
    });

    it('changing to a plan in a different currency is rejected with 409', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('plancurrency') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      const planUsd = await createPlan(merchant, token, { name: 'USD Plan', amount: 20, currency: 'USD', interval: 'month' });
      const planEur = await createPlan(merchant, token, { name: 'EUR Plan', amount: 20, currency: 'EUR', interval: 'month' });

      const subRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        planId: planUsd.id, customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
      }).expect(201);

      await signedRequest(merchant, token, 'post', `/api/v1/subscriptions/${subRes.body.id}/change-plan`, {
        planId: planEur.id,
      }).expect(409);
    });

    it('changing plan on a canceled subscription is rejected with 409', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('plancanceled') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      const planA = await createPlan(merchant, token, { name: 'A', amount: 20, currency: 'USD', interval: 'month' });
      const planB = await createPlan(merchant, token, { name: 'B', amount: 30, currency: 'USD', interval: 'month' });

      const subRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        planId: planA.id, customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
      }).expect(201);
      await signedRequest(merchant, token, 'post', `/api/v1/subscriptions/${subRes.body.id}/cancel`, {}).expect(200);

      await signedRequest(merchant, token, 'post', `/api/v1/subscriptions/${subRes.body.id}/change-plan`, {
        planId: planB.id,
      }).expect(409);
    });
  });

  describe('Deactivation and ownership', () => {
    it('a deactivated plan cannot be used for a new subscription, but existing subscribers are unaffected', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('plandeactivate') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      const plan = await createPlan(merchant, token, { name: 'Legacy', amount: 20, currency: 'USD', interval: 'month' });

      const subRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        planId: plan.id, customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
      }).expect(201);

      const deactivateRes = await request(app.getHttpServer())
        .post(`/api/v1/plans/${plan.id}/deactivate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(deactivateRes.body.isActive).toBe(false);

      // A new subscription can no longer use it.
      await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        planId: plan.id, customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
      }).expect(404);

      // The already-subscribed customer keeps working exactly as before —
      // the plan's amount was snapshotted onto the subscription, not a
      // live reference.
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions/${subRes.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.status).toBe('ACTIVE');
      expect(getRes.body.amount).toBe(20);
    });

    it('a merchant cannot see or use another merchant\'s plan', async () => {
      const owner = await seedMerchant(app, { merchantId: uniqueId('planowner') });
      const ownerToken = await login(app, owner.apiKeyId, owner.apiKeySecret);
      const intruder = await seedMerchant(app, { merchantId: uniqueId('planintruder') });
      const intruderToken = await login(app, intruder.apiKeyId, intruder.apiKeySecret);

      const plan = await createPlan(owner, ownerToken, { name: 'Private', amount: 20, currency: 'USD', interval: 'month' });

      await request(app.getHttpServer())
        .get(`/api/v1/plans/${plan.id}`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .expect(403);

      await signedRequest(intruder, intruderToken, 'post', '/api/v1/subscriptions', {
        planId: plan.id, customerId: uniqueId('cust'), paymentMethodId: 'pm_card_visa',
      }).expect(403);
    });
  });
});
