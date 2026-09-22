import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, uniqueId } from './utils/seed';
import { MerchantService } from '../src/modules/merchant/merchant.service';

/**
 * Exercises sanctions/watchlist screening against the default
 * `SANCTIONS_PROVIDER=mock` adapter — deterministic by fixture marker in
 * `scripts/mock-psp/server.js`'s `/sanctions/screen` handler (`name`
 * containing "SANCTIONED" -> HIT, "POTENTIAL" -> POTENTIAL_MATCH). See
 * `ofac-sdn-sanctions.adapter.spec.ts` for real fuzzy-match coverage
 * against the bundled OFAC snapshot, which doesn't need a running app.
 */
describe('Sanctions/watchlist screening (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
  });

  function createMerchant(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/admin/merchants')
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

  it('a HIT on legalName blocks creation outright — no merchant, no credentials', async () => {
    const merchantId = uniqueId('sanctioned');
    const res = await createMerchant({
      merchantId,
      name: 'Display Name Co',
      legalName: 'SANCTIONED Test Entity',
      roles: ['MERCHANT'],
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SANCTIONS_SCREENING_HIT');

    const merchant = await getMerchant(merchantId);
    expect(merchant).toBeUndefined();
  });

  it('a HIT falling back to the display name (no legalName supplied) also blocks creation', async () => {
    const merchantId = uniqueId('sanctioned-display');
    const res = await createMerchant({ merchantId, name: 'SANCTIONED Display Co', roles: ['MERCHANT'] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SANCTIONS_SCREENING_HIT');
  });

  it('a POTENTIAL_MATCH does not block creation — merchant is created and flagged for review', async () => {
    const merchantId = uniqueId('potential');
    const res = await createMerchant({
      merchantId,
      name: 'Display Name Co',
      legalName: 'POTENTIAL Match Corp',
      roles: ['MERCHANT'],
    }).expect(201);

    expect(res.body.sanctionsScreeningStatus).toBe('POTENTIAL_MATCH');
    expect(res.body.apiKeySecret).toEqual(expect.any(String));
  });

  it('an unremarkable name clears at FULL confidence when legalName is supplied', async () => {
    const merchantId = uniqueId('clear');
    const res = await createMerchant({
      merchantId,
      name: 'Display Name Co',
      legalName: 'Acme Corporation Inc.',
      roles: ['MERCHANT'],
    }).expect(201);

    expect(res.body.sanctionsScreeningStatus).toBe('CLEAR');
  });

  it('omitting legalName screens the display name at DEGRADED confidence', async () => {
    const merchantId = uniqueId('degraded');
    await createMerchant({ merchantId, name: 'Acme Corporation Inc.', roles: ['MERCHANT'] }).expect(201);

    const merchant = await getMerchant(merchantId);
    expect(merchant.sanctionsScreeningStatus).toBe('CLEAR');
  });

  it('KYC submission re-screens at full confidence and blocks on HIT without advancing kycStatus', async () => {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    const connected = await seedMerchant(app, {
      merchantId: uniqueId('connected'),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${connected.merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName: 'SANCTIONED KYC Entity', taxId: '12-3456789' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SANCTIONS_SCREENING_HIT');

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kycStatus).toBe('NOT_STARTED');
  });

  it('POST /admin/merchants/:id/sanctions/rescreen re-screens on demand against the currently-stored identity', async () => {
    const merchant = await seedMerchant(app, {
      merchantId: uniqueId('rescreen'),
      legalName: 'POTENTIAL Rescreen Corp',
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchant.merchantId}/sanctions/rescreen`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.sanctionsScreeningStatus).toBe('POTENTIAL_MATCH');
  });

  it('PATCH .../sanctions-review with CLEARED resets sanctionsScreeningStatus back to CLEAR', async () => {
    const merchant = await seedMerchant(app, {
      merchantId: uniqueId('review-cleared'),
      legalName: 'POTENTIAL Review Corp',
    });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/sanctions-review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolution: 'CLEARED', reason: 'Confirmed different individual via secondary ID' })
      .expect(200);

    expect(res.body.sanctionsScreeningStatus).toBe('CLEAR');
    expect(res.body.sanctionsReviewedBy).toEqual(expect.any(String));
  });

  it('PATCH .../sanctions-review with CONFIRMED leaves sanctionsScreeningStatus unchanged', async () => {
    const merchant = await seedMerchant(app, {
      merchantId: uniqueId('review-confirmed'),
      legalName: 'POTENTIAL Confirmed Corp',
    });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/sanctions-review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolution: 'CONFIRMED', reason: 'Escalated to compliance outside this system' })
      .expect(200);

    expect(res.body.sanctionsScreeningStatus).toBe('POTENTIAL_MATCH');
  });

  it('rejects a sanctions-review with an empty reason', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('review-empty-reason') });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/merchants/${merchant.merchantId}/sanctions-review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolution: 'CLEARED', reason: '' });

    expect(res.status).toBe(422);
  });

  it('a merchant with a HIT status cannot have new delegations created', async () => {
    const merchant = await seedMerchant(app, { merchantId: uniqueId('hit-delegation') });

    // Onboarding/KYC-submit both block *before* a HIT is ever persisted
    // (see MerchantService.createMerchant()/submitKyc()) — the only
    // legitimate way an existing merchant ends up with
    // sanctionsScreeningStatus: 'HIT' is the periodic sweep discovering
    // a merchant clean at onboarding but since listed. Simulating that
    // via the same real method the sweep calls
    // (MerchantService.applySanctionsScreeningResult()), rather than
    // inventing a test-only backdoor.
    const merchantService = app.get(MerchantService);
    await merchantService.applySanctionsScreeningResult(merchant.merchantId, {
      status: 'HIT',
      confidence: 'FULL',
      matchedListEntry: 'TEST LATER-LISTED ENTITY',
      score: 1,
    });

    const merchantToken = await request(app.getHttpServer())
      .post('/api/v1/auth/token')
      .send({ apiKeyId: merchant.apiKeyId, apiKeySecret: merchant.apiKeySecret })
      .expect(200)
      .then((res) => res.body.accessToken);

    const res = await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ agentName: 'Test Agent', perTransactionLimit: 10, monthlyLimit: 100, currency: 'USD' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SANCTIONS_SCREENING_HIT');
  });
});
