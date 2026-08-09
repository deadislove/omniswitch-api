import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { authenticator } from 'otplib';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId, SeededMerchant } from './utils/seed';

describe('MFA: enroll / confirm / login gate / disable (e2e)', () => {
  let app: INestApplication;
  let merchant: SeededMerchant;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    merchant = await seedMerchant(app, { merchantId: uniqueId('merchant') });
    token = await login(app, merchant.apiKeyId, merchant.apiKeySecret);
  });

  afterAll(async () => {
    await app.close();
  });

  function currentTotp(secret: string): string {
    return authenticator.generate(secret);
  }

  it('rejects confirming enrollment with a wrong code, and MFA stays disabled', async () => {
    const enrollRes = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(enrollRes.body.secret).toEqual(expect.any(String));
    expect(enrollRes.body.otpauthUrl).toContain('otpauth://totp/');

    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' })
      .expect(401);

    // Still disabled — login for this merchant is still a normal, direct token.
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/token')
      .send({ apiKeyId: merchant.apiKeyId, apiKeySecret: merchant.apiKeySecret })
      .expect(200);
    expect(loginRes.body.mfaRequired).toBeFalsy();
  });

  describe('Full enrollment + enforced login', () => {
    let mfaMerchant: SeededMerchant;
    let mfaToken: string;
    let totpSecret: string;
    let backupCodes: string[];

    beforeAll(async () => {
      mfaMerchant = await seedMerchant(app, { merchantId: uniqueId('mfamerchant') });
      mfaToken = await login(app, mfaMerchant.apiKeyId, mfaMerchant.apiKeySecret);

      const enrollRes = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/enroll')
        .set('Authorization', `Bearer ${mfaToken}`)
        .expect(200);
      totpSecret = enrollRes.body.secret;

      const confirmRes = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/confirm')
        .set('Authorization', `Bearer ${mfaToken}`)
        .send({ code: await currentTotp(totpSecret) })
        .expect(200);
      backupCodes = confirmRes.body.backupCodes;
      expect(backupCodes).toHaveLength(10);
    });

    it('login now returns a short-lived, restricted pending token instead of a directly-usable one', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: mfaMerchant.apiKeyId, apiKeySecret: mfaMerchant.apiKeySecret })
        .expect(200);
      expect(res.body.mfaRequired).toBe(true);
      expect(res.body.expiresIn).toBeLessThanOrEqual(300);
    });

    it('the pending token is rejected on a normal protected route, not just accepted like a real session', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: mfaMerchant.apiKeyId, apiKeySecret: mfaMerchant.apiKeySecret })
        .expect(200);
      const pendingToken = loginRes.body.accessToken;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/revoke')
        .set('Authorization', `Bearer ${pendingToken}`)
        .expect(401);
      expect(res.body.code).toBe('MFA_VERIFICATION_REQUIRED');
    });

    it('a wrong code at /auth/mfa/verify is rejected', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: mfaMerchant.apiKeyId, apiKeySecret: mfaMerchant.apiKeySecret })
        .expect(200);
      const pendingToken = loginRes.body.accessToken;

      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Authorization', `Bearer ${pendingToken}`)
        .send({ code: '000000' })
        .expect(401);
    });

    it('a correct TOTP code at /auth/mfa/verify trades the pending token for a full, directly-usable one', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: mfaMerchant.apiKeyId, apiKeySecret: mfaMerchant.apiKeySecret })
        .expect(200);
      const pendingToken = loginRes.body.accessToken;

      const verifyRes = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Authorization', `Bearer ${pendingToken}`)
        .send({ code: await currentTotp(totpSecret) })
        .expect(200);
      expect(verifyRes.body.mfaRequired).toBeFalsy();
      expect(verifyRes.body.expiresIn).toBe(3600);

      const fullToken = verifyRes.body.accessToken;
      await request(app.getHttpServer())
        .post('/api/v1/auth/revoke')
        .set('Authorization', `Bearer ${fullToken}`)
        .expect(200);
    });

    it('a backup code works once at /auth/mfa/verify, then is rejected on reuse', async () => {
      const backupCode = backupCodes[0];

      const login1 = await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: mfaMerchant.apiKeyId, apiKeySecret: mfaMerchant.apiKeySecret })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Authorization', `Bearer ${login1.body.accessToken}`)
        .send({ code: backupCode })
        .expect(200);

      // Same backup code again, against a fresh pending token — must fail,
      // it's single-use, not a second static password.
      const login2 = await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: mfaMerchant.apiKeyId, apiKeySecret: mfaMerchant.apiKeySecret })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Authorization', `Bearer ${login2.body.accessToken}`)
        .send({ code: backupCode })
        .expect(401);
    });

    it('disabling MFA requires a valid code; a stolen full JWT alone is not enough', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: mfaMerchant.apiKeyId, apiKeySecret: mfaMerchant.apiKeySecret })
        .expect(200);
      const verifyRes = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
        .send({ code: await currentTotp(totpSecret) })
        .expect(200);
      const fullToken = verifyRes.body.accessToken;

      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/disable')
        .set('Authorization', `Bearer ${fullToken}`)
        .send({ code: '000000' })
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/disable')
        .set('Authorization', `Bearer ${fullToken}`)
        .send({ code: await currentTotp(totpSecret) })
        .expect(200);

      // MFA is off — login goes back to returning a directly-usable token.
      const afterRes = await request(app.getHttpServer())
        .post('/api/v1/auth/token')
        .send({ apiKeyId: mfaMerchant.apiKeyId, apiKeySecret: mfaMerchant.apiKeySecret })
        .expect(200);
      expect(afterRes.body.mfaRequired).toBeFalsy();
    });
  });
});
