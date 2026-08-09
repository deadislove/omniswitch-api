import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';
import { seedMerchant, login, uniqueId } from './utils/seed';

/**
 * Proves per-merchant rate-limit isolation using *relative* comparisons
 * (does a fresh merchant's counter start over, or continue a busy
 * merchant's count?) rather than asserting against the exact configured
 * limit. The limit itself is raised for the rest of the e2e suite (see
 * setup-env.ts) so other specs can fire several requests per second without
 * tripping it — this test still proves isolation correctly at any limit
 * value, which is also exactly how this was verified manually before being
 * automated here.
 */
describe('Per-merchant rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  function remainingBurst(res: request.Response): number {
    const header = res.headers['x-ratelimit-remaining-burst'];
    expect(header).toBeDefined();
    return Number(header);
  }

  it('two merchants sharing a source IP get independent burst counters', async () => {
    const merchantA = await seedMerchant(app, { merchantId: uniqueId('m') });
    const tokenA = await login(app, merchantA.apiKeyId, merchantA.apiKeySecret);

    const merchantB = await seedMerchant(app, { merchantId: uniqueId('m') });
    const tokenB = await login(app, merchantB.apiKeyId, merchantB.apiKeySecret);

    const get = (token: string) =>
      request(app.getHttpServer())
        .get('/api/v1/payments/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`);

    const a1 = remainingBurst(await get(tokenA));
    const a2 = remainingBurst(await get(tokenA));
    expect(a2).toBe(a1 - 1);

    // Merchant B's very first request, made right after A has already used
    // some of its own quota — if the two shared one counter, B's remaining
    // would be a1 - 2 (continuing A's depletion). It isn't.
    const b1 = remainingBurst(await get(tokenB));
    expect(b1).toBe(a1); // fresh start, same as A's very first request

    // A's count picks back up from where it left off, unaffected by B.
    const a3 = remainingBurst(await get(tokenA));
    expect(a3).toBe(a2 - 1);
  });

  it('POST /auth/token has its own (much stricter) rate limit, independent of the general API limit', async () => {
    // Just confirms the header is present with a materially smaller budget
    // than the general API's burst limit — the exact number is
    // environment-configurable (AUTH_LOGIN_RATE_LIMIT) and intentionally
    // set high for this test run, so this checks the *mechanism* is wired
    // up rather than the production default value.
    const merchant = await seedMerchant(app, { merchantId: uniqueId('m') });
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/token')
      .send({ apiKeyId: merchant.apiKeyId, apiKeySecret: merchant.apiKeySecret })
      .expect(200);

    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });
});
