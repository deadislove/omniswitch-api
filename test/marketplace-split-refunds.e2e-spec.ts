import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest, signStripeWebhook } from './utils/signing';
import { LedgerOutboxEntity } from '../src/modules/payment/adapters/persistence/entities/ledger-outbox.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

/**
 * Marketplace splits: reversing a split on refund or dispute loss.
 * PaymentAggregate.recordSplits() now remembers the *original* charge-time
 * splits, and LedgerOutboxEvent.createRefundEntries() proportions a
 * refund/dispute-loss clawback against them — each connected merchant is
 * debited its share of the refund, the platform absorbs the (rounding)
 * remainder, rather than every refund debiting only the platform's own
 * account regardless of how the original charge was split. See
 * docs/business-domain/ledger-and-settlement.md#marketplace-splits.
 */
describe('Marketplace splits: refund & dispute-loss reversal (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
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

  // This read follows a write it just made — that races the ambient
  // DataSource's replica routing (app.module.ts's `replication` config
  // sends plain repository reads to the replica, which has ~1s streaming
  // lag behind master; see reserve.service.ts's release() and
  // test/ledger-and-outbox.e2e-spec.ts for the same issue). This forces
  // the read onto master instead.
  async function ledgerEntries(paymentId: string): Promise<any[]> {
    const queryRunner = dataSource.createQueryRunner('master');
    let events: LedgerOutboxEntity[];
    try {
      events = await queryRunner.manager.find(LedgerOutboxEntity, {
        where: { paymentId },
        order: { createdAt: 'ASC' },
      });
    } finally {
      await queryRunner.release();
    }
    return events.flatMap((e) => e.entries as any[]);
  }

  async function platformWithConnected(): Promise<{
    platform: SeededMerchant;
    platformToken: string;
    connected: SeededMerchant;
  }> {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });
    return { platform, platformToken, connected };
  }

  it('a full refund of a split payment reverses each recipient in the original split proportion', async () => {
    const { platform, platformToken, connected } = await platformWithConnected();

    const chargeRes = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 30 }],
    }).expect(201);

    const refundRes = await signedRequest(
      platform,
      platformToken,
      'post',
      `/api/v1/payments/${chargeRes.body.paymentId}/refund`,
      {},
    ).expect(200);
    expect(refundRes.body.status).toBe('REFUNDED');

    const entries = await ledgerEntries(chargeRes.body.paymentId);
    const merchantDebits = entries.filter((e) => e.accountType === 'MERCHANT' && e.entryType === 'DEBIT');
    expect(merchantDebits).toHaveLength(2);

    const connectedDebit = merchantDebits.find((e) => e.accountId === connected.merchantId);
    expect(connectedDebit.amountMinorUnits).toBe('3000'); // exactly the original $30 split

    const platformDebit = merchantDebits.find((e) => e.accountId === platform.merchantId);
    // A refund debits the full charge amount minus the connected share —
    // the platform fee is never given back on refund (pre-existing
    // behavior, unrelated to splits): $100 - $30 = $70, not $68.50 (which
    // would be the fee-adjusted remainder the platform actually netted at
    // charge time).
    expect(platformDebit.amountMinorUnits).toBe('7000');
  });

  it('a partial refund of a split payment reverses proportionally, with rounding remainder absorbed by the platform', async () => {
    const { platform, platformToken, connected } = await platformWithConnected();

    const chargeRes = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 33.33 }],
    }).expect(201);

    // 10% partial refund: connected's exact proportional share of $10 is
    // $3.333 -> floors to $3.33 (330 minor units); the platform absorbs
    // the truncated remainder so the two debits still sum to exactly $10.
    const refundRes = await signedRequest(
      platform,
      platformToken,
      'post',
      `/api/v1/payments/${chargeRes.body.paymentId}/refund`,
      {
        amount: 10,
      },
    ).expect(200);
    expect(refundRes.body.status).toBe('PARTIALLY_REFUNDED');

    const entries = await ledgerEntries(chargeRes.body.paymentId);
    const merchantDebits = entries.filter((e) => e.accountType === 'MERCHANT' && e.entryType === 'DEBIT');
    const connectedDebit = merchantDebits.find((e) => e.accountId === connected.merchantId);
    const platformDebit = merchantDebits.find((e) => e.accountId === platform.merchantId);

    expect(connectedDebit.amountMinorUnits).toBe('333');
    expect(platformDebit.amountMinorUnits).toBe('667');
    expect((BigInt(connectedDebit.amountMinorUnits) + BigInt(platformDebit.amountMinorUnits)).toString()).toBe('1000');
  });

  it('a lost dispute on a split payment claws back proportionally, same as a refund', async () => {
    const { platform, platformToken, connected } = await platformWithConnected();

    const chargeRes = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 60,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 20 }],
    }).expect(201);

    const disputeId = 'dp_' + uniqueId('split');
    const createBody = JSON.stringify({
      id: 'evt_' + uniqueId('split'),
      type: 'charge.dispute.created',
      data: { object: { id: disputeId, payment_intent: chargeRes.body.pspTransactionId, reason: 'fraudulent' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, createBody))
      .set('Content-Type', 'application/json')
      .send(createBody)
      .expect(200);

    const closeBody = JSON.stringify({
      id: 'evt_' + uniqueId('split'),
      type: 'charge.dispute.closed',
      data: { object: { id: disputeId, status: 'lost' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, closeBody))
      .set('Content-Type', 'application/json')
      .send(closeBody)
      .expect(200);

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/payments/${chargeRes.body.paymentId}`)
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    expect(getRes.body.status).toBe('REFUNDED');

    const entries = await ledgerEntries(chargeRes.body.paymentId);
    const merchantDebits = entries.filter((e) => e.accountType === 'MERCHANT' && e.entryType === 'DEBIT');
    const connectedDebit = merchantDebits.find((e) => e.accountId === connected.merchantId);
    const platformDebit = merchantDebits.find((e) => e.accountId === platform.merchantId);

    expect(connectedDebit.amountMinorUnits).toBe('2000'); // full $20 original split
    expect(platformDebit.amountMinorUnits).toBe('4000'); // $60 - $20
  });

  it('a full refund of a split payment replays each side\'s original FX rate, not a fresh lookup', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platformfxr'), settlementCurrency: 'EUR' });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connectedfxr'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
      settlementCurrency: 'GBP',
    });

    // $100 charge, fee $1.50, net $98.50, split $30 to connected (GBP @
    // 0.79 = 23.70 GBP), remainder $68.50 to platform (EUR @ 0.92 = 63.02
    // EUR) — same charge as the "different currencies, different rates"
    // case in marketplace-splits.e2e-spec.ts.
    const chargeRes = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 30 }],
    }).expect(201);

    const refundRes = await signedRequest(
      platform,
      platformToken,
      'post',
      `/api/v1/payments/${chargeRes.body.paymentId}/refund`,
      {},
    ).expect(200);
    expect(refundRes.body.status).toBe('REFUNDED');

    const entries = await ledgerEntries(chargeRes.body.paymentId);
    const merchantDebits = entries.filter((e) => e.accountType === 'MERCHANT' && e.entryType === 'DEBIT');
    expect(merchantDebits).toHaveLength(2);

    // Connected's full $30 original split, reversed at the *original* 0.79
    // rate — 30 * 0.79 = 23.70 GBP, exactly what it was credited.
    const connectedDebit = merchantDebits.find((e) => e.accountId === connected.merchantId);
    expect(connectedDebit.currencyCode).toBe('GBP');
    expect(connectedDebit.amountMinorUnits).toBe('2370');

    // Platform's share of a refund is $100 - $30 = $70 (fee never given
    // back, same pre-existing behavior as the plain-USD refund test above),
    // reversed at the *original* 0.92 rate — 70 * 0.92 = 64.40 EUR.
    const platformDebit = merchantDebits.find((e) => e.accountId === platform.merchantId);
    expect(platformDebit.currencyCode).toBe('EUR');
    expect(platformDebit.amountMinorUnits).toBe('6440');
  });

  it('a partial refund of a split payment with FX conversion proportions each side in the original charge currency first, then converts at each side\'s original rate', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platformfxpr'), settlementCurrency: 'EUR' });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connectedfxpr'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
      settlementCurrency: 'GBP',
    });

    const chargeRes = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 30 }],
    }).expect(201);

    // 50% partial refund ($50 of $100). The proportional-reversal math
    // (LedgerOutboxEvent.createRefundEntries()) works in the *original
    // charge currency* first — connected's share is
    // 30 * (5000/10000) = 15.00 USD, platform absorbs the rest,
    // 50 - 15 = 35.00 USD — and only *then* does each side convert at its
    // own original rate: 15.00 * 0.79 = 11.85 GBP, 35.00 * 0.92 = 32.20
    // EUR. Converting the already-split USD amounts (not, say, splitting
    // pre-converted GBP/EUR amounts) is what this test actually proves.
    const refundRes = await signedRequest(
      platform,
      platformToken,
      'post',
      `/api/v1/payments/${chargeRes.body.paymentId}/refund`,
      { amount: 50 },
    ).expect(200);
    expect(refundRes.body.status).toBe('PARTIALLY_REFUNDED');

    const entries = await ledgerEntries(chargeRes.body.paymentId);
    const merchantDebits = entries.filter((e) => e.accountType === 'MERCHANT' && e.entryType === 'DEBIT');
    expect(merchantDebits).toHaveLength(2);

    const connectedDebit = merchantDebits.find((e) => e.accountId === connected.merchantId);
    expect(connectedDebit.currencyCode).toBe('GBP');
    expect(connectedDebit.amountMinorUnits).toBe('1185');

    const platformDebit = merchantDebits.find((e) => e.accountId === platform.merchantId);
    expect(platformDebit.currencyCode).toBe('EUR');
    expect(platformDebit.amountMinorUnits).toBe('3220');
  });

  it('a split charge that needs a 3DS challenge still books the correct split once confirmed via webhook', async () => {
    const { platform, platformToken, connected } = await platformWithConnected();

    // scripts/mock-psp/server.js returns requires_action when the
    // description contains this marker — same forcing mechanism
    // webhooks.e2e-spec.ts uses. This is the regression case for a bug
    // where `splits` used to only be recorded on the Payment when the
    // saga's SUCCEEDED branch ran immediately — a charge that instead
    // came back REQUIRES_ACTION and was only confirmed later via webhook
    // would silently lose its split.
    // The marker is Stripe-only in the mock, so preferredProvider pins
    // routing to STRIPE — now a true override, not a scoring nudge that
    // could still lose and silently send this to ADYEN instead.
    const bodyObj = {
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      description: 'FORCE_3DS e2e test',
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
      splits: [{ merchantId: connected.merchantId, amount: 15 }],
    };
    const chargeRes = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', bodyObj).expect(
      201,
    );
    expect(chargeRes.body.status).toBe('REQUIRES_ACTION');
    expect(chargeRes.body.pspTransactionId).toEqual(expect.any(String));

    // No ledger entries yet — nothing was confirmed captured.
    expect(await ledgerEntries(chargeRes.body.paymentId)).toHaveLength(0);

    const webhookBody = JSON.stringify({
      id: 'evt_' + uniqueId('split3ds'),
      type: 'payment_intent.succeeded',
      data: { object: { id: chargeRes.body.pspTransactionId, status: 'succeeded' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, webhookBody))
      .set('Content-Type', 'application/json')
      .send(webhookBody)
      .expect(200);

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/payments/${chargeRes.body.paymentId}`)
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    expect(getRes.body.status).toBe('SUCCEEDED');

    const entries = await ledgerEntries(chargeRes.body.paymentId);
    const merchantCredits = entries.filter((e) => e.accountType === 'MERCHANT');
    expect(merchantCredits).toHaveLength(2);
    const connectedCredit = merchantCredits.find((e) => e.accountId === connected.merchantId);
    expect(connectedCredit.amountMinorUnits).toBe('1500');
  });

  it('a 3DS-deferred split charge with FX books the correct converted amounts once confirmed, and a later refund replays the same rates — not the request-time snapshot', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform3dsfx'), settlementCurrency: 'EUR' });
    const platformToken = await login(app, platform.apiKeyId, platform.apiKeySecret);
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected3dsfx'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
      settlementCurrency: 'GBP',
    });

    // Same FORCE_3DS forcing mechanism as the plain-USD 3DS test above.
    // PaymentAggregate.recordSplits() runs at request time (Step 1, before
    // the PSP is ever called) with whatever FX rate that first resolve()
    // call found — this is the regression case for a real gap found
    // during Phase 2 review: a 3DS-deferred confirmation re-resolves FX
    // fresh (WebhookProcessingService.markSucceeded()), and without
    // PaymentAggregate.finalizeSplitConversions() overwriting the
    // request-time snapshot with whatever was actually booked,
    // `payment.splits` (what a refund replays against) could in principle
    // drift from the ledger. The mock FX provider returns a fixed rate
    // per currency pair, so this test can't force the two resolve() calls
    // to actually disagree — what it *does* prove is that the full
    // record → finalize → persist → refund-replay pipeline produces
    // correct, consistent numbers end-to-end for this combination, which
    // had zero test coverage before.
    const bodyObj = {
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      description: 'FORCE_3DS e2e test',
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
      splits: [{ merchantId: connected.merchantId, amount: 15 }],
    };
    const chargeRes = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', bodyObj).expect(
      201,
    );
    expect(chargeRes.body.status).toBe('REQUIRES_ACTION');
    expect(await ledgerEntries(chargeRes.body.paymentId)).toHaveLength(0);

    const webhookBody = JSON.stringify({
      id: 'evt_' + uniqueId('split3dsfx'),
      type: 'payment_intent.succeeded',
      data: { object: { id: chargeRes.body.pspTransactionId, status: 'succeeded' } },
    });
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Stripe-Signature', signStripeWebhook(STRIPE_WEBHOOK_SECRET, webhookBody))
      .set('Content-Type', 'application/json')
      .send(webhookBody)
      .expect(200);

    // $40 charge, fee $0.60, net $39.40, split $15 to connected (GBP @
    // 0.79 = $11.85 GBP), remainder $24.40 to platform (EUR @ 0.92 =
    // $22.45 EUR).
    const entries = await ledgerEntries(chargeRes.body.paymentId);
    const merchantCredits = entries.filter((e) => e.accountType === 'MERCHANT');
    const connectedCredit = merchantCredits.find((e) => e.accountId === connected.merchantId);
    expect(connectedCredit.currencyCode).toBe('GBP');
    expect(connectedCredit.amountMinorUnits).toBe('1185');
    const platformCredit = merchantCredits.find((e) => e.accountId === platform.merchantId);
    expect(platformCredit.currencyCode).toBe('EUR');
    expect(platformCredit.amountMinorUnits).toBe('2245');

    // Full refund — replays whatever `payment.splits` actually holds
    // post-confirmation (finalizeSplitConversions()'s job), which should
    // exactly match what was just booked above, at the same rates. Note
    // the platform's refund share is $40 - $15 = $25.00 (original charge
    // minus the split), *not* the $24.40 fee-adjusted remainder it was
    // actually credited at charge time — same "the fee is never given
    // back on refund" behavior the plain-USD refund tests above document,
    // converted at the same original 0.92 rate: 25.00 * 0.92 = 23.00 EUR.
    const refundRes = await signedRequest(
      platform,
      platformToken,
      'post',
      `/api/v1/payments/${chargeRes.body.paymentId}/refund`,
      {},
    ).expect(200);
    expect(refundRes.body.status).toBe('REFUNDED');

    const afterRefund = await ledgerEntries(chargeRes.body.paymentId);
    const merchantDebits = afterRefund.filter((e) => e.accountType === 'MERCHANT' && e.entryType === 'DEBIT');
    const connectedDebit = merchantDebits.find((e) => e.accountId === connected.merchantId);
    expect(connectedDebit.currencyCode).toBe('GBP');
    expect(connectedDebit.amountMinorUnits).toBe('1185'); // exactly what was credited — full refund
    const platformDebit = merchantDebits.find((e) => e.accountId === platform.merchantId);
    expect(platformDebit.currencyCode).toBe('EUR');
    expect(platformDebit.amountMinorUnits).toBe('2300');
  });
});
