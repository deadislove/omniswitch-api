import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * Per-merchant PSP entitlement: MerchantEntity.enabledPspProviders
 * restricts which PSPs a merchant's charges may route through —
 * SmartRoutingStrategy.filterAvailableProviders() excludes non-entitled
 * PSPs from the candidate pool, and selectProvider() rejects (422) a
 * charge that explicitly requests a preferredProvider outside the
 * entitlement rather than silently rerouting it, since that's a
 * permission boundary an operator configured on purpose, not a technical
 * unavailability. See docs/spec/future/per-merchant-psp-entitlement.md.
 */
describe('Per-merchant PSP entitlement (e2e)', () => {
  let app: INestApplication;
  let admin: SeededMerchant;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
    adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);
  });

  afterAll(async () => {
    await app.close();
  });

  function signedCharge(merchant: SeededMerchant, token: string, body: object) {
    const path = '/api/v1/payments/charge';
    const bodyStr = JSON.stringify(body);
    const { signature, timestamp } = signHmacRequest(merchant.hmacSecret, 'post', path, bodyStr);
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .set('X-Merchant-Id', merchant.merchantId)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  it('a newly onboarded merchant defaults to being entitled to every PSP this system has an adapter for', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const summary = res.body.find((m: { merchantId: string }) => m.merchantId === merchant.merchantId);
    expect(summary.enabledPspProviders.sort()).toEqual(['ADYEN', 'STRIPE']);
  });

  it('PATCH .../psp-entitlement narrows a merchant to a single PSP, reflected in the summary response', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/psp-entitlement`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabledPspProviders: ['ADYEN'] })
      .expect(200);

    expect(res.body.enabledPspProviders).toEqual(['ADYEN']);
  });

  // UpdatePspEntitlementDto's @ArrayNotEmpty() decorator rejects this
  // before the request ever reaches MerchantService.updatePspEntitlement()
  // — the global ValidationPipe is configured with errorHttpStatusCode: 422
  // (see main.ts), not Nest's usual 400, so this and the DTO-validation
  // case below both land on 422 with ValidationPipe's own generic body
  // shape (no PSP_ENTITLEMENT_EMPTY `code`). That custom code/message is
  // still exercised — it's MerchantService.updatePspEntitlement()'s own
  // defense-in-depth guard for a caller that reaches the service directly,
  // bypassing the DTO (there is no HTTP-reachable path to it today).
  it('rejects an empty enabledPspProviders array with 422 (DTO validation)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/psp-entitlement`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabledPspProviders: [] })
      .expect(422);
  });

  it('rejects an unknown PSP name with 422 (DTO validation)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/psp-entitlement`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabledPspProviders: ['PAYPAL'] })
      .expect(422);
  });

  it('a charge with no preferredProvider routes only to the merchant\'s entitled PSP, even when the other PSP would otherwise be viable', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant'), enabledPspProviders: ['ADYEN'] });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedCharge(merchant, token, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    }).expect(201);

    expect(res.body.pspProvider).toBe('ADYEN');
  });

  it('a charge whose preferredProvider IS within the entitlement succeeds normally', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant'), enabledPspProviders: ['STRIPE', 'ADYEN'] });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedCharge(merchant, token, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);

    expect(res.body.pspProvider).toBe('STRIPE');
  });

  it('a charge whose preferredProvider is OUTSIDE the entitlement is rejected 422, not silently rerouted to the entitled PSP', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant'), enabledPspProviders: ['ADYEN'] });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    const res = await signedCharge(merchant, token, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(422);

    expect(res.body.code).toBe('PREFERRED_PROVIDER_NOT_ENTITLED');
  });

  it('narrowing entitlement via PATCH takes effect on the very next charge for an already-seeded merchant', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

    // Both PSPs allowed initially — STRIPE preference succeeds.
    await signedCharge(merchant, token, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/psp-entitlement`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabledPspProviders: ['ADYEN'] })
      .expect(200);

    // Same preference, now rejected — no caching of the prior entitlement.
    const res = await signedCharge(merchant, token, {
      amount: 10,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
      preferredProvider: 'STRIPE',
    }).expect(422);

    expect(res.body.code).toBe('PREFERRED_PROVIDER_NOT_ENTITLED');
  });
});
