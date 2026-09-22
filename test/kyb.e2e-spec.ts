import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, uniqueId } from './utils/seed';

/**
 * KYB (Know Your Business) against the default synchronous mock provider
 * (`KYB_PROVIDER=mock`) — deterministic by fixture marker in `legalName`
 * (case-insensitive `reject` -> declined), same convention as
 * `/kyc/verify`. See `kyb-review.e2e-spec.ts` for the real, async-reviewing
 * Persona provider coverage.
 */
describe('KYB: Know Your Business (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
  });

  async function connectedMerchant(prefix: string) {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    return seedMerchant(app, {
      merchantId: uniqueId(prefix),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });
  }

  function submitKyb(merchantId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchantId}/kyb/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  }

  function getMerchant(merchantId: string) {
    return request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .then((res) => res.body.find((m: any) => m.merchantId === merchantId));
  }

  it('defaults to kybStatus NOT_STARTED, independent of kycStatus', async () => {
    const connected = await connectedMerchant('kyb-default');
    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kybStatus).toBe('NOT_STARTED');
    expect(merchant.kycStatus).toBe('NOT_STARTED');
  });

  it('approves synchronously against the mock provider and records beneficial owners', async () => {
    const connected = await connectedMerchant('kyb-approve');
    const res = await submitKyb(connected.merchantId, {
      legalName: 'Acme Sellers LLC',
      taxId: '12-3456789',
      country: 'US',
      beneficialOwners: [{ name: 'Jane Doe', ownershipPercentage: 60 }],
    }).expect(200);

    expect(res.body.kybStatus).toBe('VERIFIED');
    expect(res.body.kybApplicationId).toBeNull();
  });

  it('declines synchronously on the "reject" marker, leaving kycStatus untouched', async () => {
    const connected = await connectedMerchant('kyb-reject');
    const res = await submitKyb(connected.merchantId, {
      legalName: 'Reject Business LLC',
      taxId: '12-3456789',
      country: 'US',
    }).expect(200);

    expect(res.body.kybStatus).toBe('REJECTED');
    expect(res.body.kycStatus).toBe('NOT_STARTED');
  });

  it('kybStatus and kycStatus are independently settable — KYC verified does not imply KYB verified', async () => {
    const connected = await connectedMerchant('kyb-independent');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${connected.merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName: 'Acme Sellers LLC', taxId: '12-3456789' })
      .expect(200);

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kycStatus).toBe('VERIFIED');
    expect(merchant.kybStatus).toBe('NOT_STARTED');
  });

  it('re-submitting after a REJECTED decision is allowed and can now approve', async () => {
    const connected = await connectedMerchant('kyb-resubmit');
    await submitKyb(connected.merchantId, {
      legalName: 'Reject Business LLC',
      taxId: '12-3456789',
      country: 'US',
    }).expect(200);

    const retry = await submitKyb(connected.merchantId, {
      legalName: 'Acme Sellers LLC (corrected)',
      taxId: '12-3456789',
      country: 'US',
    }).expect(200);

    expect(retry.body.kybStatus).toBe('VERIFIED');
  });

  it('a sanctions HIT on the submitted legalName blocks the submission — kybStatus stays unchanged', async () => {
    const connected = await connectedMerchant('kyb-sanctions-hit');

    const res = await submitKyb(connected.merchantId, {
      legalName: 'SANCTIONED KYB Entity',
      taxId: '12-3456789',
      country: 'US',
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SANCTIONS_SCREENING_HIT');

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kybStatus).toBe('NOT_STARTED');
  });

  it('rejects submission with a missing required field', async () => {
    const connected = await connectedMerchant('kyb-validation');
    const res = await submitKyb(connected.merchantId, { legalName: 'Acme Sellers LLC', taxId: '12-3456789' });
    expect(res.status).toBe(422);
  });
});
