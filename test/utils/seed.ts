import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
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
