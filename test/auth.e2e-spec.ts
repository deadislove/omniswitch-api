import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, seedAdminMerchant, login, uniqueId } from './utils/seed';

describe('Auth & Merchant Admin (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ adminToken } = await seedAdminMerchant(app, uniqueId('admin')));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/token', () => {
    it('rejects an unknown apiKeyId', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: 'ak_does_not_exist', apiKeySecret: 'whatever' })
        .expect(401)
        .expect((res) => {
          expect(res.body.code).toBe('INVALID_CREDENTIALS');
        });
    });

    it('rejects a wrong secret for a real apiKeyId', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('m') });
      await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: merchant.apiKeyId, apiKeySecret: 'wrong-secret' })
        .expect(401);
    });

    it('issues a JWT for correct credentials, usable against a protected route', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('m') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
      expect(typeof token).toBe('string');

      // 404 (not 401) proves the token actually authenticated.
      await request(app.getHttpServer())
        .get('/api/v1/payments/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('rejects login for a deactivated merchant', async () => {
      const merchantId = uniqueId('m');
      const merchant = await seedMerchant(app, { merchantId });
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchantId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: merchant.apiKeyId, apiKeySecret: merchant.apiKeySecret })
        .expect(401);
    });
  });

  describe('POST /auth/revoke', () => {
    it('immediately invalidates the token used to call it', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('m') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      await request(app.getHttpServer())
        .get('/api/v1/payments/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(404); // authenticated, just no such payment

      await request(app.getHttpServer())
        .post('/api/v1/auth/revoke')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect({ revoked: true });

      await request(app.getHttpServer())
        .get('/api/v1/payments/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
        .expect((res) => {
          expect(res.body.code).toBe('TOKEN_REVOKED');
        });
    });
  });

  describe('Merchant Admin API (RBAC + lifecycle)', () => {
    it('rejects a non-ADMIN caller', async () => {
      const merchant = await seedMerchant(app, { merchantId: uniqueId('m') });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      await request(app.getHttpServer())
        .get('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('rejects an ADMIN caller that has not enabled MFA', async () => {
      const admin = await seedMerchant(app, { merchantId: uniqueId('admin'), roles: ['ADMIN'] });
      const token = await login(app, admin.apiKeyId, admin.apiKeySecret);

      await request(app.getHttpServer())
        .get('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${token}`)
        .expect(403)
        .expect((res) => {
          expect(res.body.code).toBe('MFA_REQUIRED_FOR_ADMIN');
        });

      // The two MFA self-service routes stay reachable regardless — an
      // ADMIN without MFA still needs a way to enroll.
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/enroll')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('creates a merchant, logs in with the returned credentials, rotates the secret, and invalidates the old one', async () => {
      const merchantId = uniqueId('onboard');

      const createRes = await request(app.getHttpServer())
        .post('/api/v1/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ merchantId, name: 'E2E Onboard Test', roles: ['MERCHANT'] })
        .expect(201);

      expect(createRes.body.apiKeyId).toEqual(expect.any(String));
      expect(createRes.body.apiKeySecret).toEqual(expect.any(String));
      expect(createRes.body.hmacSecret).toEqual(expect.any(String));

      const { apiKeyId, apiKeySecret: originalSecret } = createRes.body;

      // Fresh credentials work immediately.
      await login(app, apiKeyId, originalSecret);

      const rotateRes = await request(app.getHttpServer())
        .post(`/api/v1/admin/merchants/${merchantId}/rotate-api-key`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const newSecret = rotateRes.body.apiKeySecret;
      expect(newSecret).not.toBe(originalSecret);

      // Old secret is dead.
      await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId, apiKeySecret: originalSecret })
        .expect(401);

      // New secret works.
      await login(app, apiKeyId, newSecret);

      // Defaults to 150bps (1.5%) — the rate this used to be hardcoded to.
      expect(createRes.body.platformFeeBps).toBe(150);
    });

    it('an ADMIN can change a merchant\'s fee rate; a non-ADMIN cannot', async () => {
      const merchantId = uniqueId('feerate');
      const merchant = await seedMerchant(app, { merchantId });
      const merchantToken = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchantId}/fee-rate`)
        .set('Authorization', `Bearer ${merchantToken}`)
        .send({ platformFeeBps: 300 })
        .expect(403);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchantId}/fee-rate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ platformFeeBps: 300 })
        .expect(200);
      expect(res.body.platformFeeBps).toBe(300);

      // Out-of-range values are rejected, not clamped.
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchantId}/fee-rate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ platformFeeBps: 10_001 })
        .expect(422);
    });

    it('deactivating a merchant revokes their outstanding token immediately, without an explicit revoke call', async () => {
      const merchantId = uniqueId('m');
      const merchant = await seedMerchant(app, { merchantId });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      await request(app.getHttpServer())
        .get('/api/v1/payments/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/merchants/${merchantId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false })
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/payments/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
        .expect((res) => {
          expect(res.body.code).toBe('TOKEN_REVOKED');
        });
    });

    it('POST /:id/revoke-sessions kills the token without deactivating the merchant', async () => {
      const merchantId = uniqueId('m');
      const merchant = await seedMerchant(app, { merchantId });
      const token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/merchants/${merchantId}/revoke-sessions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/payments/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      // Still active — can log in again.
      await login(app, merchant.apiKeyId, merchant.apiKeySecret);
    });
  });
});
