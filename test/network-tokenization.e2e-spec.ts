import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

/**
 * PSPChargeResponse.networkTokenized — exercised through the real charge
 * path (both PSP adapters' extractNetworkTokenization(), and mock-psp's
 * own real-field simulation). `pm_...nettoken...` in `paymentMethodId` is
 * this mock's marker that the stored payment method is network-tokenized
 * — see scripts/mock-psp/server.js's /v1/payment_intents and
 * /adyen/payments routes. Same "assert against the persisted entity"
 * pattern as interchange-qualification.e2e-spec.ts.
 */
describe('Network tokenization (e2e)', () => {
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
      return await queryRunner.manager.findOne(entityClass, { where, order: { createdAt: 'DESC' } as any });
    } finally {
      await queryRunner.release();
    }
  }

  it('Stripe: a network-tokenized payment method reports networkTokenized=true', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('nt-stripe-true') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_nettoken'),
      preferredProvider: 'STRIPE',
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.networkTokenized).toBe(true);
  });

  it('Stripe: an ordinary card payment method explicitly reports networkTokenized=false (always populated, never gated behind an opt-in)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('nt-stripe-false') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_card'),
      preferredProvider: 'STRIPE',
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.networkTokenized).toBe(false);
  });

  it('Adyen: a network-tokenized payment method reports networkTokenized=true', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('nt-adyen-true') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_nettoken'),
      preferredProvider: 'ADYEN',
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.networkTokenized).toBe(true);
  });

  it('Adyen: an ordinary card payment method leaves networkTokenized unset — the account-level additionalData opt-in this mock has no way to simulate, not a confirmed false', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('nt-adyen-null') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_card'),
      preferredProvider: 'ADYEN',
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.networkTokenized == null).toBe(true);
  });

  it('GET /payments/:id surfaces networkTokenized on the charge record', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('nt-surface') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_nettoken'),
      preferredProvider: 'STRIPE',
    }).expect(201);

    const detailRes = await request(app.getHttpServer())
      .get(`/api/v1/payments/${chargeRes.body.paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detailRes.body.networkTokenized).toBe(true);
  });
});
