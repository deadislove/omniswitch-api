import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

const VISA_CONSUMER_US = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };
const VISA_COMMERCIAL_US = {
  bin: '424242',
  country: 'US',
  cardBrand: 'VISA',
  cardType: 'CREDIT',
  cardProduct: 'COMMERCIAL',
};

/**
 * evaluateInterchangeQualification() — exercised through the real charge
 * path (PaymentCheckoutSaga's immediate-capture branch and
 * PaymentLifecycleService.capture()'s manual-capture branch), same
 * "assert against the persisted entity" pattern as tax-record.e2e-spec.ts.
 * AVS/CVV outcomes are deterministic via MockPSPAdapter's "AVSFAIL"/
 * "CVVFAIL" marker in `description` (Stripe-routed) — see
 * scripts/mock-psp/server.js's /v1/payment_intents route.
 */
describe('Interchange qualification/downgrade (e2e)', () => {
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

  async function findOneOnMaster<T extends object>(entityClass: new () => T, where: object): Promise<T | null> {
    const queryRunner = dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.findOne(entityClass, { where });
    } finally {
      await queryRunner.release();
    }
  }

  it('a clean AVS/CVV match qualifies at the VISA consumer rate with no downgrade', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('iq-clean') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      preferredProvider: 'STRIPE',
      binInfo: VISA_CONSUMER_US,
    }).expect(201);

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    const iq = payment?.interchangeQualification as any;
    expect(iq).toBeTruthy();
    expect(iq.cardBrand).toBe('VISA');
    expect(iq.cardProduct).toBe('CONSUMER');
    expect(iq.downgraded).toBe(false);
    expect(iq.downgradeReasons).toEqual([]);
    expect(iq.qualifiedBps).toBe(180);
    expect(iq.appliedBps).toBe(180);
  });

  it('a COMMERCIAL card qualifies at the higher commercial rate', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('iq-commercial') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      preferredProvider: 'STRIPE',
      binInfo: VISA_COMMERCIAL_US,
    }).expect(201);

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    const iq = payment?.interchangeQualification as any;
    expect(iq.cardProduct).toBe('COMMERCIAL');
    expect(iq.qualifiedBps).toBe(250);
    expect(iq.downgraded).toBe(false);
  });

  it('an AVS mismatch downgrades and adds the surcharge on top of the qualified rate', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('iq-avsfail') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      preferredProvider: 'STRIPE',
      description: 'AVSFAIL downgrade test',
      binInfo: VISA_CONSUMER_US,
    }).expect(201);

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.avsResult).toBe('NO_MATCH');
    expect(payment?.cvvResult).toBe('MATCH');
    const iq = payment?.interchangeQualification as any;
    expect(iq.downgraded).toBe(true);
    expect(iq.downgradeReasons).toEqual(['AVS_NOT_MATCHED']);
    expect(iq.appliedBps).toBe(180 + 80);
  });

  it('a CVV mismatch downgrades independently of AVS', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('iq-cvvfail') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      preferredProvider: 'STRIPE',
      description: 'CVVFAIL downgrade test',
      binInfo: VISA_CONSUMER_US,
    }).expect(201);

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.cvvResult).toBe('NO_MATCH');
    const iq = payment?.interchangeQualification as any;
    expect(iq.downgraded).toBe(true);
    expect(iq.downgradeReasons).toEqual(['CVV_NOT_MATCHED']);
  });

  it('no binInfo at all means no interchange qualification is recorded', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('iq-nobin') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      preferredProvider: 'STRIPE',
    }).expect(201);

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.interchangeQualification == null).toBe(true);
  });

  it('manual capture (a separate ledger-booking call site) also records interchange qualification', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('iq-capture') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 40,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      preferredProvider: 'STRIPE',
      captureMethod: 'manual',
      binInfo: VISA_CONSUMER_US,
    }).expect(201);
    expect(chargeRes.body.status).toBe('REQUIRES_CAPTURE');

    const beforeCapture = await findOneOnMaster(PaymentEntity, { id: chargeRes.body.paymentId });
    expect(beforeCapture?.interchangeQualification == null).toBe(true);

    await signedRequest(merchant, token, 'post', `/api/v1/payments/${chargeRes.body.paymentId}/capture`, {}).expect(
      200,
    );

    const afterCapture = await findOneOnMaster(PaymentEntity, { id: chargeRes.body.paymentId });
    const iq = afterCapture?.interchangeQualification as any;
    expect(iq).toBeTruthy();
    expect(iq.downgraded).toBe(false);
    expect(iq.downgradeReasons).toEqual([]);
  });

  it('GET /payments/:id surfaces the downgrade reason on the charge record', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('iq-surface') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      preferredProvider: 'STRIPE',
      description: 'AVSFAIL downgrade test',
      binInfo: VISA_CONSUMER_US,
    }).expect(201);

    const detailRes = await request(app.getHttpServer())
      .get(`/api/v1/payments/${chargeRes.body.paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detailRes.body.interchangeQualification.downgraded).toBe(true);
    expect(detailRes.body.interchangeQualification.downgradeReasons).toEqual(['AVS_NOT_MATCHED']);
  });
});
