import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * PaymentAggregate.recordTaxRecord() — a cross-border audit record (not
 * a tax calculation), populated at the same 4 ledger-booking call sites
 * and under the same condition as settlementConversion (see
 * fx-conversion.e2e-spec.ts for that mechanism's own tests) — see
 * src/modules/payment/domain/services/tax-record.ts's docblock for why
 * jurisdiction is derived from BinInfo.country, not a real tax-nexus
 * determination.
 */
describe('Cross-border tax record (e2e)', () => {
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

  // Same replica-lag concern as fx-conversion.e2e-spec.ts — force reads
  // that follow a write in the same test onto master.
  async function findOneOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<T | null> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.findOne(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

  it('a cross-border charge (different settlement currency) records a jurisdiction from the card-issuing country', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('taxeur'), settlementCurrency: 'EUR' });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const before = Date.now();
    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.taxRecord).toBeTruthy();
    expect(payment!.taxRecord!.jurisdiction).toBe('US');
    expect(payment!.taxRecord!.jurisdictionBasis).toBe('card-issuing-country');
    // The amount actually collected from the customer — 100 USD, not the
    // post-conversion EUR amount the merchant is paid out.
    expect(payment!.taxRecord!.collectedAmountMinorUnits).toBe('10000');
    expect(payment!.taxRecord!.currencyCode).toBe('USD');
    const capturedAt = new Date(payment!.taxRecord!.capturedAt).getTime();
    expect(capturedAt).toBeGreaterThanOrEqual(before);
    expect(capturedAt).toBeLessThanOrEqual(Date.now());
  });

  it('a merchant settled in the same currency they were charged in produces no tax record', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('taxsamecur'), settlementCurrency: 'USD' });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.taxRecord == null).toBe(true);
  });

  it('a merchant with no settlement currency configured at all produces no tax record', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('taxnofx') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.taxRecord == null).toBe(true);
  });

  it('manual capture (a separate ledger-booking call site) also records the tax record', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('taxeurcapture'), settlementCurrency: 'EUR' });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      captureMethod: 'manual',
      binInfo: USD_BIN,
    }).expect(201);
    expect(chargeRes.body.status).toBe('REQUIRES_CAPTURE');

    // No settlementConversion (and so no tax record) is booked until the
    // funds are actually confirmed captured — mirrors
    // fx-conversion.e2e-spec.ts's own manual-capture case.
    const beforeCapture = await findOneOnMaster(PaymentEntity, { id: chargeRes.body.paymentId });
    expect(beforeCapture?.taxRecord == null).toBe(true);

    await signedRequest(merchant, token, 'post', `/api/v1/payments/${chargeRes.body.paymentId}/capture`, {}).expect(
      200,
    );

    const afterCapture = await findOneOnMaster(PaymentEntity, { id: chargeRes.body.paymentId });
    expect(afterCapture?.taxRecord).toBeTruthy();
    expect(afterCapture!.taxRecord!.jurisdiction).toBe('US');
    expect(afterCapture!.taxRecord!.collectedAmountMinorUnits).toBe('4000');
  });
});
