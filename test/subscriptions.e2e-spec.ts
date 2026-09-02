import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { uuidv5 } from '../src/shared/utils/uuid';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { SubscriptionEntity } from '../src/modules/payment/adapters/persistence/entities/subscription.entity';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

const SUBSCRIPTION_PAYMENT_NAMESPACE = '7c9c9f2e-2c1a-4b8e-9c1a-1f6b6f8b9a10';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Recurring billing / subscriptions: a Subscription produces charges over
 * time by reusing PaymentCheckoutSaga.execute() per period — see
 * Subscription aggregate's and SubscriptionService's docblocks for the
 * dunning/crash-recovery design. Renewals never carry binInfo (no live
 * card entry happens for an off-session renewal). Forcing a *charge*
 * failure in this suite uses one of two tricks: a currency neither mock
 * PSP supports (KRW, for a generic/routing failure with no decline code —
 * the same trick test/ledger-and-outbox.e2e-spec.ts already uses), or a
 * `paymentMethodId` decline-code marker (`insufficientfunds`,
 * `stolencard`, `expiredcard`, ... — see scripts/mock-psp/server.js's
 * DECLINE_CODE_MARKERS) for a real, PSP-returned decline code — see
 * "Decline-code-aware dunning" below. Trial *creation* now also runs a
 * real payment-method verification call (see "Trial payment method
 * verification" below); its own decline marker is a `paymentMethodId`
 * containing "invalid" (see scripts/mock-psp/server.js's
 * /v1/setup_intents and /adyen/payments/verify handlers) — deliberately
 * distinct from the charge-time decline-code markers, so a decline-code
 * test's `paymentMethodId` (e.g. `pm_card_stolencard`) still passes
 * verification and only fails once actually charged at renewal, the same
 * real-world distinction between "this payment method reference is
 * valid" and "this specific charge attempt succeeded" — so the two
 * markers exist for different
 * PSP calls and aren't interchangeable.
 */
describe('Recurring billing / subscriptions (e2e)', () => {
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

  async function pushPeriodEndIntoPast(subscriptionId: string, msAgo = 60_000): Promise<void> {
    await dataSource.getRepository(SubscriptionEntity).update(subscriptionId, {
      currentPeriodEnd: new Date(Date.now() - msAgo),
    });
  }

  /** Forces a PAST_DUE subscription's next dunning retry to be immediately eligible, bypassing the real day 1/3/7 backoff — see Subscription.recordFailedCharge()'s docblock. */
  async function pushNextRetryIntoPast(subscriptionId: string): Promise<void> {
    await dataSource.getRepository(SubscriptionEntity).update(subscriptionId, {
      nextRetryAt: new Date(Date.now() - 60_000),
    });
  }

  /**
   * Flips an already-created subscription to KRW directly in the
   * database — trial *creation* now verifies the payment method (see
   * "Trial payment method verification" below), and neither mock PSP
   * supports KRW, so a trial can no longer be *created* with it. Tests
   * that need a guaranteed-to-fail *renewal* still create the trial with
   * a real, verifiable currency (USD) and switch it to KRW afterward —
   * verification only runs at creation time, not on every billing
   * attempt, so this reproduces the exact same "no PSP available"
   * renewal failure the dunning tests below rely on.
   */
  async function forceCurrencyToKRW(subscriptionId: string): Promise<void> {
    await dataSource.getRepository(SubscriptionEntity).update(subscriptionId, {
      currencyCode: 'KRW',
    });
  }

  // Every read in this file follows a write it just made (or a billing
  // sweep that just ran) — that races the ambient DataSource's replica
  // routing (app.module.ts's `replication` config sends plain repository
  // reads to the replica, which has ~1s streaming lag behind master; see
  // reserve.service.ts's release() and test/ledger-and-outbox.e2e-spec.ts
  // for the same issue confirmed live elsewhere). These helpers force the
  // read onto master. .update()/.save() calls above don't need it —
  // TypeORM's replication mode always routes writes to master regardless
  // of which repository issues them.
  async function findOneOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<T | null> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.findOne(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

  async function countOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<number> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.count(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

  async function runBillingNow(): Promise<{ charged: number; canceled: number; failed: number }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/subscriptions/run-billing')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return res.body;
  }

  it('creating a subscription with no trial charges the first period immediately', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subactive') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const before = Date.now();
    const res = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
      amount: 29.99,
      currency: 'USD',
      customerId: uniqueId('cust'),
      interval: 'month',
      intervalCount: 1,
      paymentMethodId: 'pm_card_visa',
    }).expect(201);

    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.failedAttempts).toBe(0);
    const periodEnd = new Date(res.body.currentPeriodEnd).getTime();
    const periodStart = new Date(res.body.currentPeriodStart).getTime();
    expect(periodStart).toBeGreaterThanOrEqual(before);
    // ~1 month out (28-31 days) — not asserting the exact day, since
    // month-length varies; just confirms it advanced by "about a month",
    // not by the trial-length or a full renewal miscalculation.
    expect(periodEnd - periodStart).toBeGreaterThan(27 * DAY_MS);
    expect(periodEnd - periodStart).toBeLessThan(32 * DAY_MS);

    const paymentCount = await countOnMaster(PaymentEntity, { merchantId: merchant.merchantId });
    expect(paymentCount).toBe(1);
  });

  it('creating a subscription with a trial does not charge until the trial elapses', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subtrial') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
      amount: 9.99,
      currency: 'USD',
      customerId: uniqueId('cust'),
      interval: 'month',
      trialDays: 14,
      paymentMethodId: 'pm_card_visa',
    }).expect(201);

    expect(res.body.status).toBe('TRIALING');
    const periodEnd = new Date(res.body.currentPeriodEnd).getTime();
    const periodStart = new Date(res.body.currentPeriodStart).getTime();
    expect(Math.round((periodEnd - periodStart) / DAY_MS)).toBe(14);

    const paymentCount = await countOnMaster(PaymentEntity, { merchantId: merchant.merchantId });
    expect(paymentCount).toBe(0);
  });

  describe('Trial payment method verification', () => {
    it('a payment method that fails verification is rejected — no trial, no subscription at all', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subverifyfail') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      // "invalid" anywhere in the payment method id is this mock's decline
      // marker for verification — see scripts/mock-psp/server.js's
      // /v1/setup_intents and /adyen/payments/verify handlers.
      const res = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 9.99,
        currency: 'USD',
        customerId: uniqueId('cust'),
        interval: 'month',
        trialDays: 14,
        paymentMethodId: 'pm_card_invalid',
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SUBSCRIPTION_PAYMENT_METHOD_VERIFICATION_FAILED');

      const list = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions?merchantId=${merchant.merchantId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(list.body.length).toBe(0);

      // No PaymentAggregate is created for a trial at all (verification
      // doesn't move money, and the trial itself was never created either).
      const paymentCount = await countOnMaster(PaymentEntity, { merchantId: merchant.merchantId });
      expect(paymentCount).toBe(0);
    });

    it('a currency neither mock PSP supports fails verification the same way a real charge would fail routing', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subverifykrw') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const res = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 10,
        currency: 'KRW',
        customerId: uniqueId('cust'),
        interval: 'month',
        trialDays: 14,
        paymentMethodId: 'pm_card_visa',
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SUBSCRIPTION_PAYMENT_METHOD_VERIFICATION_FAILED');

      const list = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions?merchantId=${merchant.merchantId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(list.body.length).toBe(0);
    });
  });

  it('if the first (non-trial) charge does not succeed, no subscription is created', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('subfirstfail') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
      amount: 10,
      currency: 'KRW', // neither mock PSP supports this — see file docblock
      customerId: uniqueId('cust'),
      interval: 'month',
      paymentMethodId: 'pm_card_visa',
    });
    // The saga rethrows on a routing failure with no exception filter
    // catching it (same as payments.e2e-spec.ts's identical KRW case) —
    // accept either the clean 422 (a real PSP decline) or the 500 a
    // routing throw surfaces as; either way, no subscription should exist.
    expect([422, 500]).toContain(res.status);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/subscriptions?merchantId=${merchant.merchantId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(list.body.length).toBe(0);
  });

  describe('Billing sweep', () => {
    it('renews an ACTIVE subscription whose period has ended, anchoring the new period to the schedule, not to "now"', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subrenew') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 5,
        currency: 'USD',
        customerId: uniqueId('cust'),
        interval: 'day',
        paymentMethodId: 'pm_card_visa',
      }).expect(201);

      await pushPeriodEndIntoPast(createRes.body.id, 5 * 60_000); // 5 minutes ago
      // Read back what was actually written, rather than independently
      // recomputing it — the two are only guaranteed to match if this
      // test's own arithmetic exactly mirrors pushPeriodEndIntoPast()'s,
      // which is exactly the kind of assumption worth not making twice.
      const pushedPeriodEnd = (await findOneOnMaster(SubscriptionEntity, { id: createRes.body.id }))!.currentPeriodEnd.getTime();

      const sweep = await runBillingNow();
      expect(sweep.charged).toBeGreaterThanOrEqual(1);

      const afterRes = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions/${createRes.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(afterRes.body.status).toBe('ACTIVE');
      expect(afterRes.body.failedAttempts).toBe(0);
      // New period end = old (schedule) period end + 1 day, not
      // now + 1 day — proves recordSuccessfulCharge() anchors to the
      // schedule rather than to whenever the sweep actually ran.
      const newPeriodEnd = new Date(afterRes.body.currentPeriodEnd).getTime();
      expect(newPeriodEnd).toBe(pushedPeriodEnd + DAY_MS);

      const paymentCount = await countOnMaster(PaymentEntity, { merchantId: merchant.merchantId });
      expect(paymentCount).toBe(2); // original + renewal
    });

    it('crash-recovery: if a period was already charged (payment SUCCEEDED) but the subscription was never advanced, the sweep advances it without charging again', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subrecover') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 5,
        currency: 'USD',
        customerId: uniqueId('cust'),
        interval: 'day',
        paymentMethodId: 'pm_card_visa',
      }).expect(201);

      await pushPeriodEndIntoPast(createRes.body.id, 5 * 60_000);
      const afterPush = await findOneOnMaster(SubscriptionEntity, { id: createRes.body.id });

      // Fabricate the exact deterministic payment id the sweep would use
      // for this subscription+period, already SUCCEEDED — simulating a
      // process crash between the saga committing the charge and this
      // service advancing the subscription.
      const periodPaymentId = uuidv5(`${createRes.body.id}:${afterPush!.currentPeriodEnd.toISOString()}`, SUBSCRIPTION_PAYMENT_NAMESPACE);
      const SENTINEL = 'sentinel_already_charged_do_not_recharge';
      await dataSource.getRepository(PaymentEntity).save({
        id: periodPaymentId,
        merchantId: merchant.merchantId,
        customerId: 'cust_recovery',
        amountMinorUnits: '500',
        currencyCode: 'USD',
        currencyMinorUnits: 2,
        status: 'SUCCEEDED' as any,
        idempotencyKey: periodPaymentId,
        pspProvider: 'STRIPE' as any,
        pspTransactionId: SENTINEL,
        refunds: [],
        captures: [],
      });

      const sweep = await runBillingNow();
      expect(sweep.charged).toBeGreaterThanOrEqual(1);

      const afterRes = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions/${createRes.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(afterRes.body.status).toBe('ACTIVE');
      expect(afterRes.body.failedAttempts).toBe(0);

      // If the sweep had actually re-run the saga instead of recognizing
      // the period as already charged, PaymentAggregate.create() would
      // have overwritten this row via its own save() and wiped the
      // sentinel value.
      const paymentAfter = await findOneOnMaster(PaymentEntity, { id: periodPaymentId });
      expect(paymentAfter!.pspTransactionId).toBe(SENTINEL);
    });

    it('applies dunning on repeated failed renewal attempts and cancels after the max attempts', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subdunning') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      // Trial creation now verifies the payment method for real (see
      // "Trial payment method verification" below) — created with USD so
      // that verification actually succeeds, then switched to KRW
      // afterward so the *renewal* attempt is the one that hits "no PSP
      // available", exercising dunning starting from TRIALING exactly
      // the same way it would from ACTIVE.
      const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 10,
        currency: 'USD',
        customerId: uniqueId('cust'),
        interval: 'day',
        trialDays: 1,
        paymentMethodId: 'pm_card_visa',
      }).expect(201);
      expect(createRes.body.status).toBe('TRIALING');

      await forceCurrencyToKRW(createRes.body.id);
      await pushPeriodEndIntoPast(createRes.body.id, 60_000);

      // 1 initial attempt + 3 retries (day 1/3/7 backoff — see
      // Subscription.recordFailedCharge()'s docblock) before giving up.
      // Each retry's nextRetryAt is pushed into the past first — a real
      // deployment waits for the schedule, this test doesn't.
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (attempt > 1) await pushNextRetryIntoPast(createRes.body.id);
        await runBillingNow();
        const res = await request(app.getHttpServer())
          .get(`/api/v1/subscriptions/${createRes.body.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(res.body.failedAttempts).toBe(attempt); // recordFailedCharge always increments, even on the attempt that finally cancels it
        if (attempt < 4) {
          expect(res.body.status).toBe('PAST_DUE');
          expect(res.body.nextRetryAt).toEqual(expect.any(String));
        } else {
          expect(res.body.status).toBe('CANCELED');
          expect(res.body.canceledAt).toBeTruthy();
        }
      }
    });

    it('a retry is not attempted before its scheduled day 1/3/7 backoff slot — the sweep leaves it alone', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subretrygate') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 10, currency: 'USD', customerId: uniqueId('cust'), interval: 'day', trialDays: 1, paymentMethodId: 'pm_card_visa',
      }).expect(201);
      await forceCurrencyToKRW(createRes.body.id);
      await pushPeriodEndIntoPast(createRes.body.id, 60_000);

      await runBillingNow();
      const afterFirst = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions/${createRes.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(afterFirst.body.status).toBe('PAST_DUE');
      expect(afterFirst.body.failedAttempts).toBe(1);
      const nextRetryAt = new Date(afterFirst.body.nextRetryAt).getTime();
      // Roughly 1 day out (RETRY_SCHEDULE_DAYS[0]), not "the very next sweep tick".
      expect(nextRetryAt - Date.now()).toBeGreaterThan(20 * 60 * 60 * 1000);

      // Without pushing nextRetryAt into the past, a second sweep run
      // (currentPeriodEnd is still in the past, so it would still be
      // "due" by the old logic) must NOT retry — this is the actual bug
      // fix: every sweep tick used to retry immediately.
      await runBillingNow();
      const afterSecond = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions/${createRes.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(afterSecond.body.failedAttempts).toBe(1);
      expect(afterSecond.body.status).toBe('PAST_DUE');
    });

    it('emits subscription.past_due and subscription.canceled events, not just a log line', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subevents') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      const eventEmitter = app.get(EventEmitter2);

      const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 10, currency: 'USD', customerId: uniqueId('cust'), interval: 'day', trialDays: 1, paymentMethodId: 'pm_card_visa',
      }).expect(201);
      await forceCurrencyToKRW(createRes.body.id);
      await pushPeriodEndIntoPast(createRes.body.id, 60_000);

      const pastDueEvents: any[] = [];
      const canceledEvents: any[] = [];
      const pastDueListener = (p: any) => pastDueEvents.push(p);
      const canceledListener = (p: any) => canceledEvents.push(p);
      eventEmitter.on('subscription.past_due', pastDueListener);
      eventEmitter.on('subscription.canceled', canceledListener);

      try {
        for (let attempt = 1; attempt <= 4; attempt++) {
          if (attempt > 1) await pushNextRetryIntoPast(createRes.body.id);
          await runBillingNow();
        }
      } finally {
        eventEmitter.off('subscription.past_due', pastDueListener);
        eventEmitter.off('subscription.canceled', canceledListener);
      }

      expect(pastDueEvents).toHaveLength(3); // attempts 1-3 go PAST_DUE; attempt 4 cancels instead
      expect(pastDueEvents[0]).toMatchObject({ subscriptionId: createRes.body.id, merchantId: merchant.merchantId, failedAttempts: 1 });
      expect(canceledEvents).toHaveLength(1);
      expect(canceledEvents[0]).toMatchObject({ subscriptionId: createRes.body.id, merchantId: merchant.merchantId, reason: 'dunning_exhausted' });
    });

    describe('Decline-code-aware dunning', () => {
      it('a retryable decline (insufficient_funds) records the code and still uses the day 1/3/7 backoff schedule', async () => {
        const merchant = await seedMerchant(app, { merchantId: uniqueId('subretryable') });
        const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

        // "insufficientfunds" in paymentMethodId is the mock PSP's decline
        // marker for a retryable code — see scripts/mock-psp/server.js's
        // DECLINE_CODE_MARKERS. Passes SetupIntent verification at trial
        // creation (that mock only declines on "invalid"), and only fails
        // once actually charged at renewal — the same real-world distinction
        // between "this payment method reference is valid" and "this
        // specific charge attempt succeeded".
        const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
          amount: 10, currency: 'USD', customerId: uniqueId('cust'), interval: 'day', trialDays: 1,
          paymentMethodId: 'pm_card_insufficientfunds',
        }).expect(201);
        await pushPeriodEndIntoPast(createRes.body.id, 60_000);

        await runBillingNow();
        const afterFirst = await request(app.getHttpServer())
          .get(`/api/v1/subscriptions/${createRes.body.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(afterFirst.body.status).toBe('PAST_DUE');
        expect(afterFirst.body.failedAttempts).toBe(1);
        expect(afterFirst.body.lastDeclineCode).toBe('insufficient_funds');
        // Still gets the real day 1/3/7 backoff — a retryable code doesn't
        // skip the schedule the way a hard decline does.
        const nextRetryAt = new Date(afterFirst.body.nextRetryAt).getTime();
        expect(nextRetryAt - Date.now()).toBeGreaterThan(20 * 60 * 60 * 1000);
      });

      it('a hard decline (stolen_card) cancels immediately on the very first attempt — no retry schedule, no PAST_DUE', async () => {
        const merchant = await seedMerchant(app, { merchantId: uniqueId('subharddecline') });
        const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

        const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
          amount: 10, currency: 'USD', customerId: uniqueId('cust'), interval: 'day', trialDays: 1,
          paymentMethodId: 'pm_card_stolencard',
        }).expect(201);
        await pushPeriodEndIntoPast(createRes.body.id, 60_000);

        await runBillingNow();
        const afterRes = await request(app.getHttpServer())
          .get(`/api/v1/subscriptions/${createRes.body.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        // Canceled on attempt 1, not after 4 like a retryable decline would need.
        expect(afterRes.body.failedAttempts).toBe(1);
        expect(afterRes.body.status).toBe('CANCELED');
        expect(afterRes.body.canceledAt).toBeTruthy();
        expect(afterRes.body.lastDeclineCode).toBe('stolen_card');
        expect(afterRes.body.nextRetryAt).toBeUndefined();
      });

      it('a hard decline emits subscription.canceled with reason hard_decline, not dunning_exhausted', async () => {
        const merchant = await seedMerchant(app, { merchantId: uniqueId('subharddeclineevent') });
        const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
        const eventEmitter = app.get(EventEmitter2);

        const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
          amount: 10, currency: 'USD', customerId: uniqueId('cust'), interval: 'day', trialDays: 1,
          paymentMethodId: 'pm_card_expiredcard',
        }).expect(201);
        await pushPeriodEndIntoPast(createRes.body.id, 60_000);

        const canceledEvents: any[] = [];
        const pastDueEvents: any[] = [];
        const canceledListener = (p: any) => canceledEvents.push(p);
        const pastDueListener = (p: any) => pastDueEvents.push(p);
        eventEmitter.on('subscription.canceled', canceledListener);
        eventEmitter.on('subscription.past_due', pastDueListener);
        try {
          await runBillingNow();
        } finally {
          eventEmitter.off('subscription.canceled', canceledListener);
          eventEmitter.off('subscription.past_due', pastDueListener);
        }

        expect(pastDueEvents).toHaveLength(0); // never goes PAST_DUE at all
        expect(canceledEvents).toHaveLength(1);
        expect(canceledEvents[0]).toMatchObject({
          subscriptionId: createRes.body.id,
          merchantId: merchant.merchantId,
          reason: 'hard_decline',
          declineCode: 'expired_card',
        });
      });

      it('lastDeclineCode is cleared once a subsequent charge succeeds', async () => {
        const merchant = await seedMerchant(app, { merchantId: uniqueId('subdeclineclear') });
        const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

        const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
          amount: 10, currency: 'USD', customerId: uniqueId('cust'), interval: 'day', trialDays: 1,
          paymentMethodId: 'pm_card_insufficientfunds',
        }).expect(201);
        await pushPeriodEndIntoPast(createRes.body.id, 60_000);
        await runBillingNow();

        const afterFail = await request(app.getHttpServer())
          .get(`/api/v1/subscriptions/${createRes.body.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(afterFail.body.lastDeclineCode).toBe('insufficient_funds');

        // Switch to a working payment method the same way the dunning
        // tests switch currency — directly in the DB, since there's no
        // "update payment method" API and this is just proving the field
        // resets on a real success, not testing payment-method rotation.
        await dataSource.getRepository(SubscriptionEntity).update(createRes.body.id, { paymentMethodId: 'pm_card_visa' });
        await pushNextRetryIntoPast(createRes.body.id);
        await runBillingNow();

        const afterSuccess = await request(app.getHttpServer())
          .get(`/api/v1/subscriptions/${createRes.body.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(afterSuccess.body.status).toBe('ACTIVE');
        expect(afterSuccess.body.lastDeclineCode).toBeUndefined();
      });
    });

    it('a subscription canceled at period end keeps billing through the current period, then stops without a further charge', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subcancelend') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 5,
        currency: 'USD',
        customerId: uniqueId('cust'),
        interval: 'day',
        paymentMethodId: 'pm_card_visa',
      }).expect(201);

      const cancelRes = await signedRequest(merchant, token, 'post', `/api/v1/subscriptions/${createRes.body.id}/cancel`, {
        atPeriodEnd: true,
      }).expect(200);
      expect(cancelRes.body.status).toBe('ACTIVE'); // still active — takes effect at period end
      expect(cancelRes.body.cancelAtPeriodEnd).toBe(true);

      await pushPeriodEndIntoPast(createRes.body.id, 60_000);
      const sweep = await runBillingNow();
      expect(sweep.canceled).toBeGreaterThanOrEqual(1);

      const afterRes = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions/${createRes.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(afterRes.body.status).toBe('CANCELED');
      expect(afterRes.body.canceledAt).toBeTruthy();

      // Only the original creation charge — the period-end cancellation
      // must not have attempted one more renewal charge first.
      const paymentCount = await countOnMaster(PaymentEntity, { merchantId: merchant.merchantId });
      expect(paymentCount).toBe(1);
    });

    it('an immediate cancel takes effect right away, with no cancelAtPeriodEnd flag', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subcancelnow') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const createRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 5,
        currency: 'USD',
        customerId: uniqueId('cust'),
        interval: 'month',
        paymentMethodId: 'pm_card_visa',
      }).expect(201);

      const cancelRes = await signedRequest(merchant, token, 'post', `/api/v1/subscriptions/${createRes.body.id}/cancel`, {}).expect(200);
      expect(cancelRes.body.status).toBe('CANCELED');
      expect(cancelRes.body.cancelAtPeriodEnd).toBe(false);
      expect(cancelRes.body.canceledAt).toBeTruthy();
    });
  });

  describe('Ownership and access control', () => {
    it('a merchant cannot see or cancel another merchant\'s subscription', async () => {
      const owner = await seedMerchant(app, { merchantId: uniqueId('subowner') });
      const ownerToken = await login(app, owner.apiKeyId, owner.apiKeySecret);
      const intruder = await seedMerchant(app, { merchantId: uniqueId('subintruder') });
      const intruderToken = await login(app, intruder.apiKeyId, intruder.apiKeySecret);

      const createRes = await signedRequest(owner, ownerToken, 'post', '/api/v1/subscriptions', {
        amount: 5,
        currency: 'USD',
        customerId: uniqueId('cust'),
        interval: 'month',
        paymentMethodId: 'pm_card_visa',
      }).expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/subscriptions/${createRes.body.id}`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .expect(403);

      await signedRequest(intruder, intruderToken, 'post', `/api/v1/subscriptions/${createRes.body.id}/cancel`, {}).expect(403);
    });

    it('a MERCHANT listing subscriptions only ever sees their own, even if a merchantId filter for another merchant is supplied', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('subscopelist') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
        amount: 5, currency: 'USD', customerId: uniqueId('cust'), interval: 'month', paymentMethodId: 'pm_card_visa',
      }).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/subscriptions?merchantId=${admin.merchantId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.every((s: any) => s.merchantId === merchant.merchantId)).toBe(true);
    });
  });
});
