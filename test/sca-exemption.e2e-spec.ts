import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { PaymentEntity } from '../src/modules/payment/adapters/persistence/entities/payment.entity';
import { SubscriptionEntity } from '../src/modules/payment/adapters/persistence/entities/subscription.entity';

const EU_CARD = { bin: '424242', country: 'DE', cardBrand: 'VISA', cardType: 'CREDIT' };
const US_CARD = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * evaluateScaExemption() — exercised through the real charge path
 * (PaymentCheckoutSaga, both PSP adapters, and mock-psp's own real-field
 * simulation: Adyen's `scaExemption`/`shopperInteraction`, Stripe's
 * `off_session`). Same "assert against the persisted entity" pattern as
 * interchange-qualification.e2e-spec.ts.
 */
describe('SCA exemption (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('scaadmin')));
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

  it('a small EU charge qualifies for LOW_VALUE, and Adyen actually honors it (no challenge)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('sca-lowvalue') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 25,
      currency: 'EUR',
      paymentMethodId: uniqueId('pm_eu'),
      preferredProvider: 'ADYEN',
      binInfo: EU_CARD,
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.scaExemptionRequested).toBe('LOW_VALUE');
    expect(payment?.scaExemptionIndicator).toBe('LOW_VALUE');
  });

  it('a mid-size, low-risk EU charge qualifies for TRANSACTION_RISK_ANALYSIS instead', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('sca-tra') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 100,
      currency: 'EUR',
      paymentMethodId: uniqueId('pm_eu'),
      preferredProvider: 'ADYEN',
      binInfo: EU_CARD,
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.scaExemptionRequested).toBe('TRANSACTION_RISK_ANALYSIS');
    expect(payment?.scaExemptionIndicator).toBe('TRANSACTION_RISK_ANALYSIS');
  });

  it('an EU charge over both caps gets no exemption and is genuinely challenged', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('sca-noexempt') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 300,
      currency: 'EUR',
      paymentMethodId: uniqueId('pm_eu'),
      preferredProvider: 'ADYEN',
      binInfo: EU_CARD,
    }).expect(201);

    expect(res.body.status).toBe('REQUIRES_ACTION');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.scaExemptionRequested == null).toBe(true);
    expect(payment?.scaExemptionIndicator == null).toBe(true);
  });

  it('a non-European card never evaluates an exemption at all', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('sca-us') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 25,
      currency: 'USD',
      paymentMethodId: uniqueId('pm_us'),
      preferredProvider: 'ADYEN',
      binInfo: US_CARD,
    }).expect(201);

    expect(res.body.status).toBe('SUCCEEDED');

    // Not just scaExemptionRequested — the saga never calls
    // evaluateScaExemption() at all for a non-European, non-MIT charge
    // (gated on isMitRenewal || isEuropean, the same "only present when
    // the needed signal exists" posture as taxRecord/interchangeQualification),
    // so scaExemptionReason stays null too, rather than recording "not
    // a European card" on every single ordinary domestic charge.
    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.scaExemptionRequested == null).toBe(true);
    expect(payment?.scaExemptionReason == null).toBe(true);
  });

  it('Stripe has no request field for LOW_VALUE/TRA — this platform still claims it, but the challenge still happens', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('sca-stripe-asym') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 25,
      currency: 'EUR',
      paymentMethodId: uniqueId('pm_eu'),
      preferredProvider: 'STRIPE',
      binInfo: EU_CARD,
    }).expect(201);

    // Unlike the Adyen LOW_VALUE test above, Stripe has no request field
    // for this — the platform's own claim doesn't change what Stripe
    // actually does, so the EU-forces-3DS branch still fires.
    expect(res.body.status).toBe('REQUIRES_ACTION');

    const payment = await findOneOnMaster(PaymentEntity, { id: res.body.paymentId });
    expect(payment?.scaExemptionRequested).toBe('LOW_VALUE');
    expect(payment?.scaExemptionIndicator == null).toBe(true);
  });

  it('the LOW_VALUE streak cap: 5 consecutive exemptions on one payment method are honored, the 6th is challenged', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('sca-streak') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const paymentMethodId = uniqueId('pm_eu_streak');

    for (let i = 0; i < 5; i++) {
      const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
        amount: 25,
        currency: 'EUR',
        paymentMethodId,
        preferredProvider: 'ADYEN',
        orderId: uniqueId(`order-${i}`),
        binInfo: EU_CARD,
      }).expect(201);
      expect(res.body.status).toBe('SUCCEEDED');
    }

    const sixth = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 25,
      currency: 'EUR',
      paymentMethodId,
      preferredProvider: 'ADYEN',
      orderId: uniqueId('order-6'),
      binInfo: EU_CARD,
    }).expect(201);

    expect(sixth.body.status).toBe('REQUIRES_ACTION');
    const payment = await findOneOnMaster(PaymentEntity, { id: sixth.body.paymentId });
    expect(payment?.scaExemptionRequested == null).toBe(true);
    expect(payment?.scaExemptionReason).toMatch(/already reached the cap/i);
  });

  it('GET /payments/:id surfaces the exemption fields on the charge record', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('sca-surface') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const chargeRes = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', {
      amount: 25,
      currency: 'EUR',
      paymentMethodId: uniqueId('pm_eu'),
      preferredProvider: 'ADYEN',
      binInfo: EU_CARD,
    }).expect(201);

    const detailRes = await request(app.getHttpServer())
      .get(`/api/v1/payments/${chargeRes.body.paymentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detailRes.body.scaExemptionRequested).toBe('LOW_VALUE');
    expect(detailRes.body.scaExemptionIndicator).toBe('LOW_VALUE');
  });

  it('a subscription renewal claims MIT regardless of card origin, since no binInfo is ever carried for one', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('sca-mit') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const subRes = await signedRequest(merchant, token, 'post', '/api/v1/subscriptions', {
      amount: 9.99,
      currency: 'USD',
      customerId: uniqueId('cust'),
      interval: 'month',
      intervalCount: 1,
      paymentMethodId: 'pm_card_visa',
    }).expect(201);

    await dataSource
      .getRepository(SubscriptionEntity)
      .update(subRes.body.id, { currentPeriodEnd: new Date(Date.now() - 60_000) });

    await request(app.getHttpServer())
      .post('/api/v1/admin/subscriptions/run-billing')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const renewalPayment = await findOneOnMaster(PaymentEntity, {
      merchantId: merchant.merchantId,
      status: 'SUCCEEDED' as any,
    });
    expect(renewalPayment?.scaExemptionRequested).toBe('MIT');
    expect(renewalPayment?.scaExemptionIndicator).toBe('MIT');
  });
});
