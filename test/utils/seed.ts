import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { generate } from 'otplib';
import { MerchantService } from '../../src/modules/merchant/merchant.service';

export interface SeededMerchant {
  merchantId: string;
  apiKeyId: string;
  apiKeySecret: string;
  hmacSecret: string;
}

/**
 * Seeds a merchant directly via MerchantService (bcrypt-hashes the secret,
 * generates a real random HMAC key) — bypasses the admin API on purpose,
 * since most specs need a merchant to already exist *before* they can
 * exercise anything else. Auth/admin specs test the API surface directly
 * instead of going through this helper.
 */
export async function seedMerchant(
  app: INestApplication,
  params: {
    merchantId: string;
    name?: string;
    roles?: string[];
    platformFeeBps?: number;
    settlementCurrency?: string;
    reserveBps?: number;
    reserveHoldDays?: number;
    accountType?: 'PLATFORM' | 'CONNECTED';
    platformMerchantId?: string;
    payoutReserveBps?: number;
    payoutReserveHoldDays?: number;
    /** Omit for the default — every PSP this system has an adapter for (STRIPE, ADYEN) — so existing specs are unaffected. */
    enabledPspProviders?: string[];
  },
): Promise<SeededMerchant> {
  const merchantService = app.get(MerchantService);
  const { merchant, apiKeySecret, hmacSecret } = await merchantService.createMerchant({
    merchantId: params.merchantId,
    name: params.name ?? params.merchantId,
    roles: params.roles ?? ['MERCHANT'],
    platformFeeBps: params.platformFeeBps,
    settlementCurrency: params.settlementCurrency,
    reserveBps: params.reserveBps,
    reserveHoldDays: params.reserveHoldDays,
    accountType: params.accountType,
    platformMerchantId: params.platformMerchantId,
    payoutReserveBps: params.payoutReserveBps,
    payoutReserveHoldDays: params.payoutReserveHoldDays,
    enabledPspProviders: params.enabledPspProviders,
  });

  return {
    merchantId: merchant.merchantId,
    apiKeyId: merchant.apiKeyId,
    apiKeySecret,
    hmacSecret,
  };
}

/** Logs in through the real POST /auth/token endpoint — not a JWT minted by hand. */
export async function login(app: INestApplication, apiKeyId: string, apiKeySecret: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/token')
    .send({ apiKeyId, apiKeySecret })
    .expect(200);
  return res.body.accessToken;
}

/** Unique-enough id for test fixtures (merchantId, orderId, ...) so parallel/repeat runs don't collide. */
export function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Seeds an ADMIN-role merchant and completes real MFA enrollment for it.
 * `RolesGuard` requires `mfaEnabled` for any caller whose token carries
 * `ADMIN` (see roles.guard.ts) — a plain `seedMerchant({ roles: ['ADMIN'] })`
 * + `login()` would 403 on every `@Roles(...)`-gated admin route, since a
 * freshly seeded merchant never has MFA enabled.
 *
 * Returns the token from the login that happened *before* enrollment —
 * still fully valid afterwards, not just during enrollment itself:
 * RolesGuard checks the merchant's *current* `mfaEnabled` state via a DB
 * lookup on every request, not a claim baked into the token at issuance,
 * so this one token keeps working across the enroll → confirm transition
 * without a second login. A *new* login after this call would instead
 * come back as a restricted `mfaPending` token (this merchant now has MFA
 * enabled), so callers that need to exercise a fresh login for this
 * merchant should go through `POST /auth/mfa/verify` the same way
 * `mfa.e2e-spec.ts` does, not call `login()` again expecting a direct token.
 */
export async function seedAdminMerchant(
  app: INestApplication,
  merchantId: string,
): Promise<{ admin: SeededMerchant; adminToken: string }> {
  const admin = await seedMerchant(app, { merchantId, roles: ['ADMIN'] });
  const adminToken = await login(app, admin.apiKeyId, admin.apiKeySecret);

  const enrollRes = await request(app.getHttpServer())
    .post('/api/v1/auth/mfa/enroll')
    .set('Authorization', `Bearer ${adminToken}`)
    .expect(200);

  const code = await generate({ secret: enrollRes.body.secret });
  await request(app.getHttpServer())
    .post('/api/v1/auth/mfa/confirm')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ code })
    .expect(200);

  return { admin, adminToken };
}
