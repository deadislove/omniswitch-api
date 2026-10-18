import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { BnplOrderEntity } from '../src/modules/payment/adapters/persistence/entities/bnpl-order.entity';

/**
 * The Klarna BNPL mechanism (`BnplService`/`KlarnaBnplAdapter`) — see
 * docs/business-domain/bnpl.md for the full lifecycle/settlement-shape
 * writeup. Exercised through the real HTTP surface against
 * scripts/mock-psp/server.js's `/klarna/...` routes; `klarnareject`/
 * `klarnacapturefail`/`klarnarefundfail` anywhere in the order's
 * `description` *at creation time* are this mock's decline markers —
 * same "magic substring" convention as every other mocked PSP
 * integration in this codebase. All three live in `description` only:
 * capture/refund failures are carried into the generated `order_id` at
 * creation (see mock-psp/server.js), not read from the refund call's
 * own `reason`.
 */
describe('BNPL (Klarna) orders (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  function signedRequest(
    m: SeededMerchant,
    t: string,
    method: 'post',
    path: string,
    body: object,
    idempotencyKey = randomUUID(),
  ) {
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(m.hmacSecret, method, path, bodyStr);
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${t}`)
      .set('Idempotency-Key', idempotencyKey)
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

  it('creates and immediately captures a BNPL order', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('bnpl-happy') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', {
      amount: 299.99,
      currency: 'USD',
      customerId: 'cust_xyz',
      description: 'Sofa + 2 armchairs',
    }).expect(201);

    expect(res.body.status).toBe('CAPTURED');
    expect(res.body.providerOrderId).toBeTruthy();
    expect(res.body.providerCaptureId).toBeTruthy();
    expect(res.body.amount).toBe(299.99);
    expect(res.body.capturedAt).toBeTruthy();
  });

  it('a Klarna-rejected order never reaches CAPTURED and surfaces 422', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('bnpl-reject') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', {
      amount: 150,
      currency: 'USD',
      description: 'klarnareject this one',
    }).expect(422);

    expect(res.body.code).toBe('BNPL_ORDER_REJECTED');

    const order = await findOneOnMaster(BnplOrderEntity, { merchantId: merchant.merchantId });
    expect(order?.status).toBe('REJECTED');
    expect(order?.failureReason).toBeTruthy();
  });

  it('a capture failure after authorization leaves the order AUTHORIZED, not silently discarded', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('bnpl-capfail') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', {
      amount: 150,
      currency: 'USD',
      description: 'klarnacapturefail this one',
    }).expect(422);

    expect(res.body.code).toBe('BNPL_CAPTURE_FAILED');

    const order = await findOneOnMaster(BnplOrderEntity, { merchantId: merchant.merchantId });
    expect(order?.status).toBe('AUTHORIZED');
    expect(order?.providerOrderId).toBeTruthy();
    expect(order?.providerCaptureId).toBeFalsy();
  });

  it('fully refunds a captured order, routed back through Klarna', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('bnpl-refund') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const createRes = await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', {
      amount: 100,
      currency: 'USD',
    }).expect(201);
    const orderId = createRes.body.id;

    const refundRes = await signedRequest(merchant, token, 'post', `/api/v1/bnpl/orders/${orderId}/refund`, {
      amount: 100,
      reason: 'Customer returned the item',
    }).expect(200);

    expect(refundRes.body.status).toBe('REFUNDED');
    expect(refundRes.body.refunds).toHaveLength(1);
    expect(refundRes.body.refunds[0].providerRefundId).toBeTruthy();
  });

  it('partially refunds a captured order and stays PARTIALLY_REFUNDED', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('bnpl-partial') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const createRes = await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', {
      amount: 100,
      currency: 'USD',
    }).expect(201);
    const orderId = createRes.body.id;

    const refundRes = await signedRequest(merchant, token, 'post', `/api/v1/bnpl/orders/${orderId}/refund`, {
      amount: 40,
      reason: 'Partial return',
    }).expect(200);

    expect(refundRes.body.status).toBe('PARTIALLY_REFUNDED');
  });

  it('a Klarna-declined refund leaves the order CAPTURED and surfaces 422', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('bnpl-refundfail') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    // The refundfail marker travels with the order's providerOrderId
    // (set at create time from `description`), not the refund's own
    // `reason` — see mock-psp/server.js's /klarna/payments/v1/authorizations
    // route and KlarnaBnplAdapter's own docblock for why.
    const createRes = await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', {
      amount: 100,
      currency: 'USD',
      description: 'klarnarefundfail this one',
    }).expect(201);
    const orderId = createRes.body.id;

    const refundRes = await signedRequest(merchant, token, 'post', `/api/v1/bnpl/orders/${orderId}/refund`, {
      amount: 50,
      reason: 'Customer returned the item',
    }).expect(422);
    expect(refundRes.body.code).toBe('BNPL_REFUND_FAILED');

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/bnpl/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(getRes.body.status).toBe('CAPTURED');
  });

  it('GET /bnpl/orders/:id returns the order', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('bnpl-get') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const createRes = await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', {
      amount: 75,
      currency: 'USD',
    }).expect(201);

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/bnpl/orders/${createRes.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(getRes.body.id).toBe(createRes.body.id);
    expect(getRes.body.status).toBe('CAPTURED');
  });

  it("a merchant cannot read another merchant's BNPL order", async () => {
    const owner = await seedMerchant(app, { merchantId: uniqueId('bnpl-owner') });
    const ownerToken = await login(app, owner.apiKeyId, owner.apiKeySecret);
    const intruder = await seedMerchant(app, { merchantId: uniqueId('bnpl-intruder') });
    const intruderToken = await login(app, intruder.apiKeyId, intruder.apiKeySecret);

    const createRes = await signedRequest(owner, ownerToken, 'post', '/api/v1/bnpl/orders', {
      amount: 60,
      currency: 'USD',
    }).expect(201);

    await request(app.getHttpServer())
      .get(`/api/v1/bnpl/orders/${createRes.body.id}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(403);
  });

  it('a retried create with the same Idempotency-Key replays the same order rather than placing a second one', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('bnpl-idem') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    const idempotencyKey = randomUUID();
    const body = { amount: 80, currency: 'USD' };

    const first = await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', body, idempotencyKey).expect(201);
    const second = await signedRequest(merchant, token, 'post', '/api/v1/bnpl/orders', body, idempotencyKey).expect(
      201,
    );

    expect(second.body.id).toBe(first.body.id);
  });
});
