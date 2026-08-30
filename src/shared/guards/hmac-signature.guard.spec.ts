import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { HmacSignatureGuard } from './hmac-signature.guard';
import { MerchantService } from '../../modules/merchant/merchant.service';
import { VaultTransitService } from '../vault/vault-transit.service';

function buildGuard(hmacSecret: string | undefined): HmacSignatureGuard {
  const configService = {
    get: jest.fn((key: string) => (key === 'HMAC_SECRET' ? hmacSecret : undefined)),
  } as unknown as ConfigService;
  return new HmacSignatureGuard(
    configService,
    new Reflector(),
    {} as MerchantService,
    {} as VaultTransitService,
  );
}

describe('HmacSignatureGuard boot-time HMAC_SECRET validation', () => {
  it('refuses to construct with no HMAC_SECRET set', () => {
    expect(() => buildGuard(undefined)).toThrow(/HMAC_SECRET/);
  });

  it('refuses to construct with a weak/short HMAC_SECRET (under 32 chars)', () => {
    // This only guards the length floor, matching JWT_SECRET's own bar in
    // jwt.strategy.ts — a deliberately-crafted placeholder that happens
    // to be 32+ chars would still pass.
    expect(() => buildGuard('too-short-secret')).toThrow(/HMAC_SECRET/);
  });

  it('constructs successfully with a strong HMAC_SECRET', () => {
    expect(() => buildGuard('a'.repeat(32))).not.toThrow();
  });
});
