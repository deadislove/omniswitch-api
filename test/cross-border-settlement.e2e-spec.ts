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
 * Cross-border settlement remainder: refunds/lost disputes now replay the
 * *original* charge-time settlement-conversion rate (see
 * PaymentAggregate.recordSettlementConversion()'s docblock) instead of
 * always booking against the merchant in the charge currency regardless
 * of what they were actually paid out in. Also covers presentment
 * currency — a purely informational, non-persisted conversion of the
 * charge amount for display.
 */
describe('Cross-border settlement remainder (e2e)', () => {
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

  // This read follows a write it just made — that races the ambient
  // DataSource's replica routing (app.module.ts's `replication` config
  // sends plain repository reads to the replica, which has ~1s streaming
  // lag behind master; see reserve.service.ts's release() and
  // test/ledger-and-outbox.e2e-spec.ts for the same issue confirmed live
  // elsewhere). This forces the read onto master instead.
  async function ledgerEntries(paymentId: string, eventType?: string): Promise<any[]> {
    const where: any = { paymentId };
    if (eventType) where.eventType = eventType;
    const queryRunner = dataSource.createQueryRunner('master');
    let event: LedgerOutboxEntity | null;
    try {
      event = await queryRunner.manager.findOne(LedgerOutboxEntity, { where, order: { createdAt: 'DESC' } });
    } finally {
      await queryRunner.release();
    }
    return (event?.entries as any[]) ?? [];
  }

  describe('Refunds replay the original charge-time settlement rate', () => {
    it('a full refund of a settlement-converted payment debits the merchant in the settlement currency, at the original rate', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('refundfx'), settlementCurrency: 'EUR' });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 100,
        currency: 'USD',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(201);

      // Confirm the charge itself converted as expected first (same math
      // as fx-conversion.e2e-spec.ts): $100 - 1.5% fee = $98.50 net,
      // * 0.92 (mock USD->EUR) = 9062 minor units EUR.
      const chargeEntries = await ledgerEntries(chargeRes.body.paymentId, 'PAYMENT_CHARGED');
      const chargeMerchantCredit = chargeEntries.find((e) => e.accountType === 'MERCHANT');
      expect(chargeMerchantCredit.currencyCode).toBe('EUR');
      expect(chargeMerchantCredit.amountMinorUnits).toBe('9062');

      const refundRes = await signedRequest(merchant, token, 'post', `/api/v1/payments/${chargeRes.body.paymentId}/refund`, {
        amount: 100,
        reason: 'requested_by_customer',
      }).expect(200);
      expect(refundRes.body.status).toBe('REFUNDED');

      const refundEntries = await ledgerEntries(chargeRes.body.paymentId, 'PAYMENT_REFUNDED');
      // PSP_SETTLEMENT credit 100 USD, FX_CLEARING debit 100 USD — this
      // group balances on its own (charge-currency side of the refund).
      const pspCredit = refundEntries.find((e) => e.accountType === 'PSP_SETTLEMENT');
      expect(pspCredit.currencyCode).toBe('USD');
      expect(pspCredit.amountMinorUnits).toBe('10000');
      const fxDebitLeg = refundEntries.find((e) => e.accountType === 'FX_CLEARING' && e.entryType === 'DEBIT');
      expect(fxDebitLeg.currencyCode).toBe('USD');
      expect(fxDebitLeg.amountMinorUnits).toBe('10000');

      // FX_CLEARING credit + MERCHANT debit, both in EUR at the *same*
      // rate the original charge used (0.92) — not a fresh lookup.
      // $100 * 0.92 = 9200 minor units EUR (the full charge amount this
      // time, not the net-of-fee amount — a refund reverses the whole
      // PSP debit, not just what the merchant was paid).
      const fxCreditLeg = refundEntries.find((e) => e.accountType === 'FX_CLEARING' && e.entryType === 'CREDIT');
      expect(fxCreditLeg.currencyCode).toBe('EUR');
      expect(fxCreditLeg.amountMinorUnits).toBe('9200');
      const merchantDebit = refundEntries.find((e) => e.accountType === 'MERCHANT' && e.entryType === 'DEBIT');
      expect(merchantDebit.currencyCode).toBe('EUR');
      expect(merchantDebit.amountMinorUnits).toBe('9200');

      // If this hadn't balanced per-currency, LedgerOutboxEvent's
      // constructor would have thrown when the refund was processed —
      // the 200 above is itself part of the proof.
    });

    it('a merchant with no settlement currency configured still refunds in the plain charge currency (unchanged default behavior)', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('refundnofx') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 50, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
      }).expect(201);

      await signedRequest(merchant, token, 'post', `/api/v1/payments/${chargeRes.body.paymentId}/refund`, { amount: 50 }).expect(200);

      const refundEntries = await ledgerEntries(chargeRes.body.paymentId, 'PAYMENT_REFUNDED');
      expect(refundEntries.every((e) => e.accountType !== 'FX_CLEARING')).toBe(true);
      const merchantDebit = refundEntries.find((e) => e.accountType === 'MERCHANT');
      expect(merchantDebit.currencyCode).toBe('USD');
      expect(merchantDebit.amountMinorUnits).toBe('5000');
    });
  });

  describe('A lost dispute replays the same rate a refund would', () => {
    it('claws back a settlement-converted payment in the settlement currency, at the original charge-time rate', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('disputefx'), settlementCurrency: 'EUR' });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 40, currency: 'USD', paymentMethodId: 'pm_card_visa', orderId: uniqueId('order'), binInfo: USD_BIN,
      }).expect(201);

      const disputeId = 'dp_' + uniqueId('fx');
      const createBody = JSON.stringify({
        id: 'evt_' + uniqueId('fx'),
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
        id: 'evt_' + uniqueId('fx'),
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
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.status).toBe('REFUNDED');

      const disputeEntries = await ledgerEntries(chargeRes.body.paymentId, 'PAYMENT_REFUNDED');
      const merchantDebit = disputeEntries.find((e) => e.accountType === 'MERCHANT' && e.entryType === 'DEBIT');
      // $40 * 0.92 = 3680 minor units EUR.
      expect(merchantDebit.currencyCode).toBe('EUR');
      expect(merchantDebit.amountMinorUnits).toBe('3680');
    });
  });

  describe('Presentment currency', () => {
    it('a charge with presentmentCurrency returns a converted display amount, without changing what is actually charged/settled', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('presentment') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 100,
        currency: 'USD',
        presentmentCurrency: 'EUR',
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(201);

      expect(res.body.presentmentCurrency).toBe('EUR');
      // $100 * 0.92 = 92.
      expect(res.body.presentmentAmount).toBeCloseTo(92, 5);

      // The actual charge/ledger stay entirely in USD — presentment never
      // touches settlement.
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/payments/${res.body.paymentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(getRes.body.currency).toBe('USD');
      expect(getRes.body.amount).toBe(100);

      const entries = await ledgerEntries(res.body.paymentId, 'PAYMENT_CHARGED');
      expect(entries.every((e) => e.currencyCode === 'USD')).toBe(true);
    });

    it('an unsupported presentmentCurrency does not fail the charge — the response just omits it', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('presentmentbad') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 25,
        currency: 'USD',
        presentmentCurrency: 'ZZZ', // not a real currency mock-psp's /fx/rates supports
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(201);

      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.body.presentmentAmount).toBeUndefined();
      expect(res.body.presentmentCurrency).toBeUndefined();
    });

    it('presentmentCurrency equal to currency is a no-op (no conversion attempted)', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('presentmentsame') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 25,
        currency: 'USD',
        presentmentCurrency: 'usd', // case-insensitive match against currency
        paymentMethodId: 'pm_card_visa',
        orderId: uniqueId('order'),
        binInfo: USD_BIN,
      }).expect(201);

      expect(res.body.presentmentAmount).toBeUndefined();
      expect(res.body.presentmentCurrency).toBeUndefined();
    });
  });
});
