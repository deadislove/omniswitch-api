import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId, SeededMerchant } from './utils/seed';
import { signHmacRequest } from './utils/signing';
import { TaxForm1099KService } from '../src/modules/payment/application/services/tax-form-1099k.service';

const USD_BIN = { bin: '424242', country: 'US', cardBrand: 'VISA', cardType: 'CREDIT' };

/**
 * `TaxForm1099KService` — see docs/technical/compliance-certification-roadmap.md's
 * 1099-K section for the full writeup this exercises: gross (Box 1a) is
 * deliberately NOT reduced by refunds, `reportable` checks against the
 * configured threshold (default $600), and the annual sweep only
 * considers merchants with `country` set to `US`.
 */
describe('1099-K tax forms (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let taxFormService: TaxForm1099KService;
  const taxYear = new Date().getUTCFullYear();

  beforeAll(async () => {
    app = await createTestApp();
    taxFormService = app.get(TaxForm1099KService);
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('1099k-admin')));
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

  async function chargeImmediate(merchant: SeededMerchant, token: string, amount: number) {
    const bodyObj = {
      amount,
      currency: 'USD',
      paymentMethodId: 'pm_card_visa',
      orderId: uniqueId('order'),
      binInfo: USD_BIN,
    };
    const res = await signedRequest(merchant, token, 'post', '/api/v1/payments/charge', bodyObj).expect(201);
    expect(res.body.status).toBe('SUCCEEDED');
    return res.body;
  }

  async function setCountry(merchantId: string, country: string | null) {
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchantId}/tax-country`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ country })
      .expect(200);
  }

  async function generateTaxForm(merchantId: string, year: number) {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchantId}/tax-forms/1099k/generate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taxYear: year })
      .expect(200);
    return res.body;
  }

  it('a US merchant over the threshold is reportable, and gross is NOT reduced by a refund (real Box 1a semantics)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('1099k-over') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await setCountry(merchant.merchantId, 'US');

    const payment = await chargeImmediate(merchant, token, 1000);
    await signedRequest(merchant, token, 'post', `/api/v1/payments/${payment.paymentId}/refund`, {
      amount: 200,
    }).expect(200);

    const form = await generateTaxForm(merchant.merchantId, taxYear);
    expect(form.currencyCode).toBe('USD');
    expect(form.grossAmount).toBeCloseTo(1000, 5); // unaffected by the $200 refund
    expect(form.transactionCount).toBe(1);
    expect(form.thresholdApplied).toBeCloseTo(600, 5);
    expect(form.reportable).toBe(true);
    expect(form.monthlyAmounts).toHaveLength(12);
    expect(form.monthlyAmounts.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1000, 5);
  });

  it('a US merchant under the threshold is not reportable', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('1099k-under') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await setCountry(merchant.merchantId, 'US');

    await chargeImmediate(merchant, token, 50);

    const form = await generateTaxForm(merchant.merchantId, taxYear);
    expect(form.grossAmount).toBeCloseTo(50, 5);
    expect(form.reportable).toBe(false);
  });

  it('a merchant with no country set can still be generated on demand (on-demand generation ignores country)', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('1099k-unknown') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    // country intentionally left unset

    await chargeImmediate(merchant, token, 1000);

    const form = await generateTaxForm(merchant.merchantId, taxYear);
    expect(form.grossAmount).toBeCloseTo(1000, 5);
    expect(form.reportable).toBe(true);
  });

  it('regenerating the same tax year is idempotent', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('1099k-idem') });
    const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    await setCountry(merchant.merchantId, 'US');

    await chargeImmediate(merchant, token, 700);
    const first = await generateTaxForm(merchant.merchantId, taxYear);

    await chargeImmediate(merchant, token, 5000); // happens after generation, same tax year
    const second = await generateTaxForm(merchant.merchantId, taxYear);

    expect(second.id).toBe(first.id);
    expect(second.grossAmount).toBeCloseTo(700, 5);
  });

  it("the annual sweep only generates for merchants with country='US', skipping others — on-demand generation still works for them", async () => {
    const usMerchant = await seedMerchant(app, { merchantId: uniqueId('1099k-sweep-us') });
    const usToken = await login(app, usMerchant.apiKeyId, usMerchant.apiKeySecret);
    await setCountry(usMerchant.merchantId, 'US');
    await chargeImmediate(usMerchant, usToken, 1000);

    const gbMerchant = await seedMerchant(app, { merchantId: uniqueId('1099k-sweep-gb') });
    const gbToken = await login(app, gbMerchant.apiKeyId, gbMerchant.apiKeySecret);
    await setCountry(gbMerchant.merchantId, 'GB');
    await chargeImmediate(gbMerchant, gbToken, 1000);

    // Pretend "now" is Jan 2nd of next year so the sweep's own
    // `taxYear = now.getUTCFullYear() - 1` lands on the real current
    // year these two charges were just made in.
    const pretendNow = new Date(Date.UTC(taxYear + 1, 0, 2, 3, 0, 0));
    await taxFormService.runAnnualSweep(pretendNow);

    const usRes = await request(app.getHttpServer())
      .get(`/api/v1/admin/merchants/${usMerchant.merchantId}/tax-forms/1099k`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(usRes.body.some((f: any) => f.taxYear === taxYear)).toBe(true);

    const gbRes = await request(app.getHttpServer())
      .get(`/api/v1/admin/merchants/${gbMerchant.merchantId}/tax-forms/1099k`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(gbRes.body.some((f: any) => f.taxYear === taxYear)).toBe(false);

    // The sweep skipped it, but an operator can still force it on demand.
    const gbForm = await generateTaxForm(gbMerchant.merchantId, taxYear);
    expect(gbForm.grossAmount).toBeCloseTo(1000, 5);
  });

  it('a merchant can view their own 1099-K by year; another merchant has no access to it (data is scoped by caller identity, not a fetch-then-check)', async () => {
    const owner = await seedMerchant(app, { merchantId: uniqueId('1099k-owner') });
    const ownerToken = await login(app, owner.apiKeyId, owner.apiKeySecret);
    await setCountry(owner.merchantId, 'US');
    await chargeImmediate(owner, ownerToken, 1000);
    await generateTaxForm(owner.merchantId, taxYear);

    const ownRes = await request(app.getHttpServer())
      .get(`/api/v1/tax-forms/1099k/${taxYear}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(ownRes.body.merchantId).toBe(owner.merchantId);

    const intruder = await seedMerchant(app, { merchantId: uniqueId('1099k-intruder') });
    const intruderToken = await login(app, intruder.apiKeyId, intruder.apiKeySecret);
    await request(app.getHttpServer())
      .get(`/api/v1/tax-forms/1099k/${taxYear}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(404);
  });
});
