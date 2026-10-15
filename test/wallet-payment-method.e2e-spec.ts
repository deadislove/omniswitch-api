import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';

/**
 * PSPChargeResponse.paymentMethodType — exercised through the real charge
 * path (both PSP adapters' extractPaymentMethodType(), and mock-psp's own
 * real-field simulation). `pm_...applepay.../googlepay...` in
 * `paymentMethodId` is this mock's marker that the charge came from a
 * wallet — see scripts/mock-psp/server.js's /v1/payment_intents and
 * /adyen/payments routes. Unlike networkTokenized (network-tokenization.
 * e2e-spec.ts), this field has no account-level opt-in gate on either PSP,
 * so an ordinary card always reports 'card' rather than leaving it unset.
 */
describe('Wallet payment method signal (e2e)', () => {
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

  it('Stripe: an Apple Pay charge reports paymentMethodType=wallet', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('wallet-stripe-apay') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_applepay'),
      preferredProvider: 'STRIPE',
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.paymentMethodType).toBe('wallet');
  });

  it('Stripe: an ordinary card payment method reports paymentMethodType=card', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('wallet-stripe-card') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_card'),
      preferredProvider: 'STRIPE',
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.paymentMethodType).toBe('card');
  });

  it('Adyen: a Google Pay charge reports paymentMethodType=wallet', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('wallet-adyen-gpay') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_googlepay'),
      preferredProvider: 'ADYEN',
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.paymentMethodType).toBe('wallet');
  });

  it('Adyen: an ordinary card payment method reports paymentMethodType=card, not left unset (no additionalData opt-in gate on this field)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('wallet-adyen-card') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_card'),
      preferredProvider: 'ADYEN',
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.paymentMethodType).toBe('card');
  });

  it('GET /payments/:id surfaces paymentMethodType on the charge record', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('wallet-surface') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 50,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_applepay'),
      preferredProvider: 'STRIPE',
    }).expect(201);

    const detailRes = await request(app.getHttpServer())
      .get(`/api/v1/payments/${chargeRes.body.paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detailRes.body.paymentMethodType).toBe('wallet');
  });
});
