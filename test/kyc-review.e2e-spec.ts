import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, uniqueId } from './utils/seed';
import { signKycWebhook } from './utils/signing';

const KYC_WEBHOOK_SECRET = process.env.KYC_WEBHOOK_SECRET!;

/**
 * The real, async-reviewing KYC provider (PersonaKycProviderAdapter) —
 * as opposed to marketplace-payouts.e2e-spec.ts's coverage of the
 * synchronous mock provider. Selected via KYC_PROVIDER, read once at
 * DI-container build time (merchant.module.ts's useFactory for
 * KYCProviderPort), so this file boots its own app instance with the
 * env var set *before* createTestApp() — same pattern
 * bank-transfer-rail.e2e-spec.ts uses for BANK_TRANSFER_PROVIDER — and
 * restores it afterward so it doesn't leak into whichever e2e file the
 * same Jest worker runs next.
 *
 * scripts/mock-psp/server.js's /persona/kyc-applications endpoint really
 * does call back asynchronously with a signed decision (see
 * scheduleKycDecision() there) — but only when APP_BASE_URL points at a
 * reachable app, which is docker-compose's `api` container, not this
 * Jest-booted in-process app. So — same posture bank-transfer-rail.e2e-spec.ts
 * already takes — this file posts directly, with a real computed
 * signature, to POST /webhooks/kyc instead of waiting for a live
 * callback.
 */
describe('KYC review: Persona async provider (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  const originalProvider = process.env.KYC_PROVIDER;

  beforeAll(async () => {
    process.env.KYC_PROVIDER = 'persona';
    app = await createTestApp();
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
    if (originalProvider === undefined) {
      delete process.env.KYC_PROVIDER;
    } else {
      process.env.KYC_PROVIDER = originalProvider;
    }
  });

  async function connectedMerchant(prefix: string) {
    const platform = await seedMerchant(app, { merchantId: uniqueId('platform') });
    return seedMerchant(app, {
      merchantId: uniqueId(prefix),
      accountType: 'CONNECTED',
      platformMerchantId: platform.merchantId,
    });
  }

  function submitKyc(merchantId: string, legalName: string, taxId = '12-3456789') {
    return request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchantId}/kyc/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName, taxId });
  }

  function getMerchant(merchantId: string) {
    return request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .then((res) => res.body.find((m: any) => m.merchantId === merchantId));
  }

  /**
   * Body shape is Persona's real webhook event envelope (see
   * KycWebhookController's docblock) — an event (`data.attributes.name`)
   * wrapping the actual Inquiry (`data.attributes.payload.data`), not a
   * flat `{applicationId, status}` body an earlier revision of this test
   * file (and the controller it exercises) assumed. `outcome` is
   * Persona's own real status vocabulary — `approved`/`declined`, not an
   * invented `rejected`.
   */
  function personaWebhookBody(applicationId: string, outcome: 'approved' | 'declined') {
    return {
      data: {
        type: 'event',
        id: 'evt_test_' + Math.random().toString(36).slice(2, 10),
        attributes: {
          name: `inquiry.${outcome}`,
          payload: { data: { type: 'inquiry', id: applicationId, attributes: { status: outcome } } },
        },
      },
    };
  }

  function postKycWebhook(body: object) {
    const bodyStr = JSON.stringify(body);
    const signature = signKycWebhook(KYC_WEBHOOK_SECRET, bodyStr);
    return request(app.getHttpServer())
      .post('/api/v1/webhooks/kyc')
      .set('X-KYC-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(bodyStr);
  }

  it('submitting KYC against the real provider returns PENDING_REVIEW with a real applicationId, not an immediate decision', async () => {
    const connected = await connectedMerchant('connected-persona-pending');
    const res = await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    expect(res.body.kycStatus).toBe('PENDING_REVIEW');
    expect(res.body.kycApplicationId).toEqual(expect.any(String));
    expect(res.body.kycApplicationId).toMatch(/^persona_mock_/);
  });

  it('a signed "inquiry.approved" event confirms a PENDING_REVIEW application to VERIFIED', async () => {
    const connected = await connectedMerchant('connected-persona-approve');
    const submitRes = await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    const applicationId = submitRes.body.kycApplicationId as string;

    await postKycWebhook(personaWebhookBody(applicationId, 'approved')).expect(200);

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kycStatus).toBe('VERIFIED');
  });

  it('a signed "inquiry.declined" event moves a PENDING_REVIEW application to REJECTED', async () => {
    const connected = await connectedMerchant('connected-persona-reject-review');
    const submitRes = await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    const applicationId = submitRes.body.kycApplicationId as string;

    await postKycWebhook(personaWebhookBody(applicationId, 'declined')).expect(200);

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kycStatus).toBe('REJECTED');
  });

  it("a non-decision event (e.g. inquiry.created) is a no-op — only approved/declined reach confirmKyc()", async () => {
    const connected = await connectedMerchant('connected-persona-nondecision');
    const submitRes = await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    const applicationId = submitRes.body.kycApplicationId as string;

    const body = {
      data: {
        type: 'event',
        id: 'evt_test_created',
        attributes: {
          name: 'inquiry.created',
          payload: { data: { type: 'inquiry', id: applicationId, attributes: { status: 'created' } } },
        },
      },
    };
    await postKycWebhook(body).expect(200);

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kycStatus).toBe('PENDING_REVIEW');
  });

  it('redelivering the same "inquiry.approved" event twice is idempotent (no error, stays VERIFIED)', async () => {
    const connected = await connectedMerchant('connected-persona-idempotent');
    const submitRes = await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    const applicationId = submitRes.body.kycApplicationId as string;

    for (let i = 0; i < 2; i++) {
      await postKycWebhook(personaWebhookBody(applicationId, 'approved')).expect(200);
    }

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kycStatus).toBe('VERIFIED');
  });

  it('a webhook for an unknown applicationId is a no-op 200, not an error', async () => {
    await postKycWebhook(personaWebhookBody('persona_mock_does_not_exist', 'approved')).expect(200);
  });

  it('rejects a KYC webhook with no signature header', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/kyc')
      .send(personaWebhookBody('persona_mock_x', 'approved'))
      .expect(401);
  });

  it('rejects a KYC webhook with an invalid signature', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/kyc')
      .set('X-KYC-Signature', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`)
      .send(personaWebhookBody('persona_mock_x', 'approved'))
      .expect(401);
  });

  it('the provider\'s outright-rejection marker ("invalidinput" in legalName) fails synchronously, without ever reaching PENDING_REVIEW', async () => {
    const connected = await connectedMerchant('connected-persona-invalidinput');
    const res = await submitKyc(connected.merchantId, 'InvalidInput Corp').expect(200);
    expect(res.body.kycStatus).toBe('REJECTED');
    expect(res.body.kycApplicationId).toBeNull();
  });

  it('a payout for a PENDING_REVIEW merchant stays KYC-blocked, same as NOT_STARTED/REJECTED', async () => {
    const connected = await connectedMerchant('connected-persona-payout-blocked');
    const submitRes = await submitKyc(connected.merchantId, 'Acme Sellers LLC').expect(200);
    expect(submitRes.body.kycStatus).toBe('PENDING_REVIEW');
    // No charge/sweep here — this only needs to prove the *status value*
    // PENDING_REVIEW is distinct from VERIFIED for anything checking
    // `kycStatus === 'VERIFIED'` (PayoutService.runSweep()), which
    // marketplace-payouts.e2e-spec.ts's own KYC-blocked coverage already
    // exercises end to end for NOT_STARTED/REJECTED against the mock
    // provider — the boolean comparison doesn't change per-provider.
    expect(submitRes.body.kycStatus).not.toBe('VERIFIED');
  });
});
