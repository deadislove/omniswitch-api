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
  let admin: SeededMerchant;
  let adminToken: string;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);
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

  async function ledgerEntries(paymentId: string): Promise<any[]> {
    const events = await dataSource.getRepository(LedgerOutboxEntity).find({ where: { paymentId }, order: { createdAt: 'ASC' } });
    return events.flatMap((e) => e.entries as any[]);
  }

  async function platformWithConnected(): Promise<{ platform: SeededMerchant; platformToken: string; connected: SeededMerchant }> {
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

    const refundRes = await signedRequest(platform, platformToken, 'post', `/api/v1/payments/${chargeRes.body.paymentId}/refund`, {}).expect(200);
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
    const refundRes = await signedRequest(platform, platformToken, 'post', `/api/v1/payments/${chargeRes.body.paymentId}/refund`, {
      amount: 10,
    }).expect(200);
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

  it('a split charge that needs a 3DS challenge still books the correct split once confirmed via webhook', async () => {
    const { platform, platformToken, connected } = await platformWithConnected();

    // scripts/mock-psp/server.js returns requires_action when the
    // description contains this marker — same forcing mechanism
    // webhooks.e2e-spec.ts uses. This is the regression case for a bug
    // found while building split-reversal: `splits` used to only be
    // recorded on the Payment when the saga's SUCCEEDED branch ran
    // immediately — a charge that instead came back REQUIRES_ACTION and
    // was only confirmed later via webhook would silently lose its split.
    const bodyObj = {
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      description: 'FORCE_3DS e2e test',
      binInfo: USD_BIN,
      splits: [{ merchantId: connected.merchantId, amount: 15 }],
    };
    const chargeRes = await signedRequest(platform, platformToken, 'post', '/api/v1/payments/charge', bodyObj).expect(201);
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
});
