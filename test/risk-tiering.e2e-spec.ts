import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook } from './utils/signing';
import { MerchantEntity } from '../src/modules/merchant/merchant.entity';
import { DisputeEntity } from '../src/modules/payment/adapters/persistence/entities/dispute.entity';
import { ReserveHoldEntity } from '../src/modules/payment/adapters/persistence/entities/reserve-hold.entity';

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
  let adminToken: string;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
  });

  async function chargeImmediate(m: SeededMerchant, t: string, amount = 20) {
    const bodyObj = {
      amount,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    };
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
  async function createLostDispute(payment: any, reason = 'fraudulent'): Promise<string> {
    const disputeId = 'dp_' + uniqueId('risktier');
    const createBody = JSON.stringify({
      id: 'evt_' + uniqueId('risktier'),
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, payment_intent: payment.pspTransactionId, reason } },
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
  // for the same issue). This helper forces the
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

    // Concurrent, not sequential — each call has its own randomUUID()
    // idempotency key and orderId, so there's no shared state making 10
    // sequential real round-trips necessary; under real contention
    // (`maxWorkers` > 1 — see ci-cd.md's "Parallelizing e2e workers"),
    // 10 sequential real charges compounded per-call latency enough to
    // exceed even a raised test timeout, in this file specifically —
    // this is the actual fix, not a longer timeout papering over it.
    const payments: any[] = await Promise.all(Array.from({ length: 10 }, () => chargeImmediate(merchant, token)));
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

    // Concurrent, not sequential — each call has its own randomUUID()
    // idempotency key and orderId, so there's no shared state making 10
    // sequential real round-trips necessary; under real contention
    // (`maxWorkers` > 1 — see ci-cd.md's "Parallelizing e2e workers"),
    // 10 sequential real charges compounded per-call latency enough to
    // exceed even a raised test timeout, in this file specifically —
    // this is the actual fix, not a longer timeout papering over it.
    const payments: any[] = await Promise.all(Array.from({ length: 10 }, () => chargeImmediate(merchant, token)));
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

  it("a merchant's reserve tapers back down once the lost dispute driving it falls outside the trailing 90-day window", async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('risktaper') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    // A merchant whose dispute history reaches back 100 days (below)
    // couldn't actually be a brand-new account — backdate createdAt to
    // match, so this scenario doesn't also trip the new-account-age
    // escalation modifier (RiskTieringService.evaluateMerchant()) on top
    // of the lost-dispute-rate signal this test is actually about.
    await dataSource
      .getRepository(MerchantEntity)
      .update({ merchantId: merchant.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

    // Concurrent, not sequential — each call has its own randomUUID()
    // idempotency key and orderId, so there's no shared state making 10
    // sequential real round-trips necessary; under real contention
    // (`maxWorkers` > 1 — see ci-cd.md's "Parallelizing e2e workers"),
    // 10 sequential real charges compounded per-call latency enough to
    // exceed even a raised test timeout, in this file specifically —
    // this is the actual fix, not a longer timeout papering over it.
    const payments: any[] = await Promise.all(Array.from({ length: 10 }, () => chargeImmediate(merchant, token)));
    const disputeId = await createLostDispute(payments[0]);
    await runTieringNow();

    const escalated = await getMerchant(merchant.merchantId);
    expect(escalated.reserveBps).toBe(1500);

    // Push the dispute's createdAt to 100 days ago — outside the 90-day
    // trailing window RiskTieringService actually looks at — simulating
    // time passing without touching real wall-clock time.
    const disputeEntity = await findOneOnMaster(DisputeEntity, { pspDisputeId: disputeId });
    await dataSource
      .getRepository(DisputeEntity)
      .update(disputeEntity!.id, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

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

  it('a high-risk MCC escalates an otherwise-clean merchant from LOW to MEDIUM', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskmcc') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    // Old enough to not also trip the new-account-age modifier — this
    // test is isolating the MCC signal specifically.
    await dataSource
      .getRepository(MerchantEntity)
      .update({ merchantId: merchant.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/mcc-code`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mccCode: '7995' }) // Betting/casino — HIGH in mcc-risk-lookup.ts
      .expect(200);

    await Promise.all(Array.from({ length: 10 }, () => chargeImmediate(merchant, token)));
    await runTieringNow();

    const after = await getMerchant(merchant.merchantId);
    expect(after.industryRiskCategory).toBe('HIGH');
    // Clean dispute history alone would be LOW (0bps) — the high-risk
    // MCC escalates it one step to MEDIUM, not all the way to HIGH.
    expect(after.reserveBps).toBe(500);
    expect(after.reserveHoldDays).toBe(30);
  });

  it('an unset MCC leaves risk tiering exactly as it was before this signal existed', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskmccunset') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await dataSource
      .getRepository(MerchantEntity)
      .update({ merchantId: merchant.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

    await Promise.all(Array.from({ length: 10 }, () => chargeImmediate(merchant, token)));
    await runTieringNow();

    const after = await getMerchant(merchant.merchantId);
    expect(after.mccCode).toBeNull();
    expect(after.industryRiskCategory).toBe('UNKNOWN');
    expect(after.reserveBps).toBe(0);
  });

  it('an unverified KYC status forces a CONNECTED merchant to HIGH regardless of an otherwise-clean dispute history', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('riskkycplatform') });
    const merchant = await seedMerchant(app, {
      merchantId: uniqueId('riskkyc'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await dataSource
      .getRepository(MerchantEntity)
      .update({ merchantId: merchant.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

    await Promise.all(Array.from({ length: 10 }, () => chargeImmediate(merchant, token)));

    const before = await getMerchant(merchant.merchantId);
    expect(before.kycStatus).toBe('NOT_STARTED'); // never submitted — this is the point

    await runTieringNow();

    const after = await getMerchant(merchant.merchantId);
    expect(after.reserveBps).toBe(1500);
    expect(after.reserveHoldDays).toBe(90);
  });

  it("a PLATFORM merchant's unstarted KYC status never forces HIGH — kycStatus is only meaningful for CONNECTED merchants", async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskkycplatformonly') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await dataSource
      .getRepository(MerchantEntity)
      .update({ merchantId: merchant.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

    await Promise.all(Array.from({ length: 10 }, () => chargeImmediate(merchant, token)));

    const before = await getMerchant(merchant.merchantId);
    expect(before.accountType).toBe('PLATFORM');
    expect(before.kycStatus).toBe('NOT_STARTED');

    await runTieringNow();

    const after = await getMerchant(merchant.merchantId);
    expect(after.reserveBps).toBe(0);
  });

  it('an account younger than the new-merchant age threshold is escalated from LOW to MEDIUM even with a clean dispute history', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskage') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    // Deliberately NOT backdating createdAt — this test is exactly about
    // a genuinely-fresh account.

    await Promise.all(Array.from({ length: 10 }, () => chargeImmediate(merchant, token)));
    await runTieringNow();

    const after = await getMerchant(merchant.merchantId);
    expect(after.reserveBps).toBe(500);
    expect(after.reserveHoldDays).toBe(30);
  });

  it('PATCH .../mcc-code rejects a malformed code and requires admin', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskmccvalidate') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/mcc-code`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mccCode: 'not-a-code' })
      .expect(422);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/mcc-code`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mccCode: '5411' })
      .expect(403);
  });

  it('the same number of LOST disputes lands two merchants in different tiers depending on reason code', async () => {
    const fraudMerchant = await seedMerchant(app, { merchantId: uniqueId('riskreasonfraud') });
    const fraudToken = await login(app, fraudMerchant.apiKeyId, fraudMerchant.apiKeySecret);
    const dupeMerchant = await seedMerchant(app, { merchantId: uniqueId('riskreasondupe') });
    const dupeToken = await login(app, dupeMerchant.apiKeyId, dupeMerchant.apiKeySecret);
    await Promise.all(
      [fraudMerchant, dupeMerchant].map((m) =>
        dataSource
          .getRepository(MerchantEntity)
          .update({ merchantId: m.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) }),
      ),
    );

    // 1 LOST dispute / 50 settled charges = 2% raw rate for both
    // merchants — identical count, identical rate. Only the reason code
    // differs: 'fraudulent' weight 1.0 keeps it at 2% (> 1% HIGH
    // threshold); 'duplicate' weight 0.25 brings it down to 0.5% (not >
    // 0.5%, so LOW) — see dispute-risk-weight.ts.
    //
    // Chunked, not one flat Promise.all(100) — the global IP-scoped
    // burst limiter (RATE_LIMIT_BURST_MAX, 1s window) is shared across
    // every merchant this test process talks to; 20/batch (10 per
    // merchant) with a pause between batches stays comfortably under it.
    const fraudPayments: any[] = [];
    const dupePayments: any[] = [];
    for (let batch = 0; batch < 5; batch++) {
      const [f, d] = await Promise.all([
        Promise.all(Array.from({ length: 10 }, () => chargeImmediate(fraudMerchant, fraudToken))),
        Promise.all(Array.from({ length: 10 }, () => chargeImmediate(dupeMerchant, dupeToken))),
      ]);
      fraudPayments.push(...f);
      dupePayments.push(...d);
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    await Promise.all([
      createLostDispute(fraudPayments[0], 'fraudulent'),
      createLostDispute(dupePayments[0], 'duplicate'),
    ]);

    await runTieringNow();

    const fraudAfter = await getMerchant(fraudMerchant.merchantId);
    const dupeAfter = await getMerchant(dupeMerchant.merchantId);
    expect(fraudAfter.reserveBps).toBe(1500); // HIGH
    expect(dupeAfter.reserveBps).toBe(0); // LOW — same dispute count, lower-weight reason
  });

  async function getHoldByPaymentId(paymentId: string): Promise<ReserveHoldEntity> {
    return (await findOneOnMaster(ReserveHoldEntity, { paymentId }))!;
  }

  it('a tier escalation tops up still-HELD reserves to the new rate, leaves RELEASED holds alone, and a later de-escalation never reverses the top-up', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('risktopup') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await dataSource
      .getRepository(MerchantEntity)
      .update({ merchantId: merchant.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) });

    // Stage 1: 100 clean settled charges (reserveBps still 0/LOW here —
    // none of these create a ReserveHold row) + 1 fraudulent LOST dispute
    // = exactly 1% weighted rate -> MEDIUM (500bps), not HIGH yet.
    const payments: any[] = [];
    for (let batch = 0; batch < 10; batch++) {
      payments.push(...(await Promise.all(Array.from({ length: 10 }, () => chargeImmediate(merchant, token)))));
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    await createLostDispute(payments[0], 'fraudulent');
    await runTieringNow();
    const afterFirstEscalation = await getMerchant(merchant.merchantId);
    expect(afterFirstEscalation.reserveBps).toBe(500); // MEDIUM

    // Now at MEDIUM (500bps): two $1000 charges each create a real
    // ReserveHold at netAmount*5%. One stays HELD; the other is released
    // (operator override) before the next escalation — it must come out
    // of this untouched.
    const heldPayment = await chargeImmediate(merchant, token, 1000);
    const releasedPayment = await chargeImmediate(merchant, token, 1000);
    const heldHoldBefore = await getHoldByPaymentId(heldPayment.paymentId);
    const releasedHoldBefore = await getHoldByPaymentId(releasedPayment.paymentId);
    // netAmount = 1000 - 1.5% platform fee = 985; 985 * 5% = 49.25 -> 4925 minor units.
    expect(heldHoldBefore.amountMinorUnits).toBe('4925');
    expect(heldHoldBefore.netAmountMinorUnits).toBe('98500');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/reserves/${releasedHoldBefore.id}/release`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const releasedHoldMidway = await findOneOnMaster(ReserveHoldEntity, { id: releasedHoldBefore.id });
    expect(releasedHoldMidway!.status).toBe('RELEASED');

    // Stage 2: one more fraudulent LOST dispute (against an existing
    // settled charge, no new charges needed) pushes the rate to
    // 2/101 ≈ 1.98% -> HIGH (1500bps). This is the escalation the top-up
    // sweep should react to.
    await createLostDispute(payments[1], 'fraudulent');
    await runTieringNow();
    const afterSecondEscalation = await getMerchant(merchant.merchantId);
    expect(afterSecondEscalation.reserveBps).toBe(1500); // HIGH

    const heldHoldAfter = await findOneOnMaster(ReserveHoldEntity, { id: heldHoldBefore.id });
    const releasedHoldAfter = await findOneOnMaster(ReserveHoldEntity, { id: releasedHoldBefore.id });
    // Topped up from 5% to 15% of the same 98500 net amount: 985 * 15% = 147.75 -> 14775.
    expect(heldHoldAfter!.amountMinorUnits).toBe('14775');
    expect(heldHoldAfter!.status).toBe('HELD');
    // Already RELEASED before the escalation — completely untouched.
    expect(releasedHoldAfter!.amountMinorUnits).toBe(releasedHoldBefore.amountMinorUnits);
    expect(releasedHoldAfter!.status).toBe('RELEASED');

    // Stage 3: age both disputes out of the trailing 90-day window ->
    // rate falls back to 0% -> LOW. De-escalation must never claw back
    // the top-up already applied.
    await dataSource
      .getRepository(DisputeEntity)
      .update({ merchantId: merchant.merchantId }, { createdAt: new Date(Date.now() - 100 * DAY_MS) });
    await runTieringNow();
    const afterDeescalation = await getMerchant(merchant.merchantId);
    expect(afterDeescalation.reserveBps).toBe(0); // LOW

    const heldHoldAfterDeescalation = await findOneOnMaster(ReserveHoldEntity, { id: heldHoldBefore.id });
    expect(heldHoldAfterDeescalation!.amountMinorUnits).toBe('14775'); // still the topped-up HIGH amount, not reverted
  });

  it('a manual PATCH .../reserve-policy escalation also tops up still-HELD reserves, not just the automatic sweep', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskmanualtopup'), reserveBps: 500 });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const payment = await chargeImmediate(merchant, token, 1000);
    const holdBefore = await getHoldByPaymentId(payment.paymentId);
    // netAmount = 1000 - 1.5% platform fee = 985; 985 * 5% = 49.25 -> 4925 minor units.
    expect(holdBefore.amountMinorUnits).toBe('4925');

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/reserve-policy`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reserveBps: 1500, reserveHoldDays: 90 })
      .expect(200);

    // The listener reacts to an emitted event, not inline in the PATCH
    // request/response cycle — give it a moment to run.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const holdAfter = await findOneOnMaster(ReserveHoldEntity, { id: holdBefore.id });
    // Topped up from 5% to 15% of the same 98500 net amount: 985 * 15% = 147.75 -> 14775.
    expect(holdAfter!.amountMinorUnits).toBe('14775');
    expect(holdAfter!.status).toBe('HELD');
  });

  it('a manual PATCH .../reserve-policy de-escalation does not claw back any already-topped-up reserve', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('riskmanualnodeescalate'), reserveBps: 1500 });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const payment = await chargeImmediate(merchant, token, 1000);
    const holdBefore = await getHoldByPaymentId(payment.paymentId);
    // netAmount = 985; 985 * 15% = 147.75 -> 14775.
    expect(holdBefore.amountMinorUnits).toBe('14775');

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/reserve-policy`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reserveBps: 0, reserveHoldDays: 0 })
      .expect(200);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const holdAfter = await findOneOnMaster(ReserveHoldEntity, { id: holdBefore.id });
    expect(holdAfter!.amountMinorUnits).toBe('14775'); // unchanged — de-escalation never claws back
    expect(holdAfter!.status).toBe('HELD');
  });
});
