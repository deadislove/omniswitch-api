import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, uniqueId } from './utils/seed';
import { signKybWebhook } from './utils/signing';

const KYB_WEBHOOK_SECRET = process.env.KYB_WEBHOOK_SECRET!;

/**
 * The real, async-reviewing KYB provider (PersonaKybProviderAdapter) —
 * as opposed to `kyb.e2e-spec.ts`'s coverage of the synchronous mock
 * provider. Same "own app instance, env var read once at DI-container
 * build time" pattern as `kyc-review.e2e-spec.ts` (see that file's own
 * docblock for the full reasoning, which applies identically here).
 */
describe('KYB review: Persona async provider (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  const originalProvider = process.env.KYB_PROVIDER;

  beforeAll(async () => {
    process.env.KYB_PROVIDER = 'persona';
    app = await createTestApp();
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
    if (originalProvider === undefined) {
      delete process.env.KYB_PROVIDER;
    } else {
      process.env.KYB_PROVIDER = originalProvider;
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

  function submitKyb(merchantId: string, legalName: string, taxId = '12-3456789', country = 'US') {
    return request(app.getHttpServer())
      .post(`/api/v1/admin/merchants/${merchantId}/kyb/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ legalName, taxId, country });
  }

  function getMerchant(merchantId: string) {
    return request(app.getHttpServer())
      .get('/api/v1/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .then((res) => res.body.find((m: any) => m.merchantId === merchantId));
  }

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

  function postKybWebhook(body: object) {
    const bodyStr = JSON.stringify(body);
    const signature = signKybWebhook(KYB_WEBHOOK_SECRET, bodyStr);
    return request(app.getHttpServer())
      .post('/api/v1/webhooks/kyb')
      .set('X-KYB-Signature', signature)
      .set('Content-Type', 'application/json')
      .send(bodyStr);
  }

  it('submitting KYB against the real provider returns PENDING_REVIEW with a real applicationId, not an immediate decision', async () => {
    const connected = await connectedMerchant('connected-kyb-persona-pending');
    const res = await submitKyb(connected.merchantId, 'Acme Sellers LLC').expect(200);
    expect(res.body.kybStatus).toBe('PENDING_REVIEW');
    expect(res.body.kybApplicationId).toEqual(expect.any(String));
    expect(res.body.kybApplicationId).toMatch(/^persona_mock_/);
  });

  it('a signed "inquiry.approved" event confirms a PENDING_REVIEW application to VERIFIED', async () => {
    const connected = await connectedMerchant('connected-kyb-persona-approve');
    const submitRes = await submitKyb(connected.merchantId, 'Acme Sellers LLC').expect(200);
    const applicationId = submitRes.body.kybApplicationId as string;

    await postKybWebhook(personaWebhookBody(applicationId, 'approved')).expect(200);

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kybStatus).toBe('VERIFIED');
  });

  it('a signed "inquiry.declined" event moves a PENDING_REVIEW application to REJECTED', async () => {
    const connected = await connectedMerchant('connected-kyb-persona-reject');
    const submitRes = await submitKyb(connected.merchantId, 'Acme Sellers LLC').expect(200);
    const applicationId = submitRes.body.kybApplicationId as string;

    await postKybWebhook(personaWebhookBody(applicationId, 'declined')).expect(200);

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kybStatus).toBe('REJECTED');
  });

  it('redelivering the same "inquiry.approved" event twice is idempotent (no error, stays VERIFIED)', async () => {
    const connected = await connectedMerchant('connected-kyb-persona-idempotent');
    const submitRes = await submitKyb(connected.merchantId, 'Acme Sellers LLC').expect(200);
    const applicationId = submitRes.body.kybApplicationId as string;

    for (let i = 0; i < 2; i++) {
      await postKybWebhook(personaWebhookBody(applicationId, 'approved')).expect(200);
    }

    const merchant = await getMerchant(connected.merchantId);
    expect(merchant.kybStatus).toBe('VERIFIED');
  });

  it('a webhook for an unknown applicationId is a no-op 200, not an error', async () => {
    await postKybWebhook(personaWebhookBody('persona_mock_does_not_exist', 'approved')).expect(200);
  });

  it('rejects a KYB webhook with no signature header', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/kyb')
      .send(personaWebhookBody('persona_mock_x', 'approved'))
      .expect(401);
  });

  it('rejects a KYB webhook with an invalid signature', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/kyb')
      .set('X-KYB-Signature', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`)
      .send(personaWebhookBody('persona_mock_x', 'approved'))
      .expect(401);
  });

  it('rejects a KYB webhook signed with the KYC secret — the two webhook paths use distinct secrets', async () => {
    const bodyStr = JSON.stringify(personaWebhookBody('persona_mock_x', 'approved'));
    const wrongSignature = signKybWebhook('kyc_e2e_test_placeholder', bodyStr);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/kyb')
      .set('X-KYB-Signature', wrongSignature)
      .set('Content-Type', 'application/json')
      .send(bodyStr)
      .expect(401);
  });

  it('the provider\'s outright-rejection marker ("invalidinput" in legalName) fails synchronously, without ever reaching PENDING_REVIEW', async () => {
    const connected = await connectedMerchant('connected-kyb-persona-invalidinput');
    const res = await submitKyb(connected.merchantId, 'InvalidInput Corp').expect(200);
    expect(res.body.kybStatus).toBe('REJECTED');
    expect(res.body.kybApplicationId).toBeNull();
  });
});
