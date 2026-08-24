import { Injectable, Logger, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { MerchantEntity } from './merchant.entity';
import { TokenRevocationService } from '../../shared/auth/token-revocation.service';
import { VaultTransitService } from '../../shared/vault/vault-transit.service';
import { KYCProviderPort } from './kyc-provider.port';

const BCRYPT_ROUNDS = 12;
// Fixed dummy hash compared against on an unknown apiKeyId, so lookup vs.
// wrong-password failures take roughly the same amount of time — otherwise
// "unknown key" (fast DB miss) is measurably faster than "wrong secret"
// (~100ms+ for a real bcrypt.compare), letting an attacker enumerate valid
// API key ids purely from response timing.
const DUMMY_BCRYPT_HASH = '$2a$12$fSns6b4iyFHaJtwQGortN.nA5raKN/CFICZDo6uzXdrhSxoilrwte';

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('hex')}`;
}

@Injectable()
export class MerchantService {
  private readonly logger = new Logger(MerchantService.name);

  constructor(
    @InjectRepository(MerchantEntity)
    private readonly merchantRepo: Repository<MerchantEntity>,
    private readonly dataSource: DataSource,
    private readonly tokenRevocation: TokenRevocationService,
    private readonly vaultTransit: VaultTransitService,
    private readonly kycProvider: KYCProviderPort,
  ) {}

  // Forced onto master, not the ambient replica-routed connection (see
  // app.module.ts's `replication` config) — this app's DataSource routes
  // plain repository reads to the Postgres replica, which has ~1s
  // streaming lag behind master (same issue documented in
  // reserve.service.ts's release() and payment-typeorm.repository.ts's
  // findPending()). A merchant created via createMerchant() and looked up
  // again moments later — POST /auth/token immediately after creation
  // being the sharpest real-world case, since nothing else forces a delay
  // between the two — can race that lag and come back not-found. Confirmed
  // live: test/reserve.e2e-spec.ts's seedMerchant() → login() sequence
  // failed with a spurious 401 in CI (though not locally, where I/O is
  // fast enough that the gap between the two calls usually — not
  // always — outlasts the lag) — see docs/technical/ci-cd.md.
  private async findMerchantOnMaster(where: Record<string, unknown>): Promise<MerchantEntity | null> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.findOne(MerchantEntity, { where });
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Verifies an API Key ID + Secret pair (used by POST /auth/token).
   * Returns null on any failure — deliberately doesn't distinguish "unknown
   * key" from "wrong secret" from "inactive account" to the caller, so the
   * auth endpoint can't be used to enumerate valid API key ids.
   */
  async verifyCredentials(apiKeyId: string, apiKeySecret: string): Promise<MerchantEntity | null> {
    const merchant = await this.findMerchantOnMaster({ apiKeyId });

    // Always run bcrypt.compare, even when the key doesn't exist — skipping
    // it turns "unknown key" into a fast DB-miss path and "wrong secret"
    // into a ~100ms+ bcrypt path, and that timing gap is enough to enumerate
    // valid apiKeyIds without ever seeing a different error message.
    const hashToCompare = merchant?.apiKeySecretHash ?? DUMMY_BCRYPT_HASH;
    const matches = await bcrypt.compare(apiKeySecret, hashToCompare);

    if (!merchant || !merchant.isActive || !matches) {
      if (merchant && matches) {
        this.logger.warn(`Login attempt for inactive merchant apiKeyId=${apiKeyId}`);
      } else if (merchant) {
        this.logger.warn(`Failed login attempt for apiKeyId=${apiKeyId}`);
      }
      return null;
    }

    return merchant;
  }

  async findByMerchantId(merchantId: string): Promise<MerchantEntity | null> {
    return this.merchantRepo.findOne({ where: { merchantId, isActive: true } });
  }

  async list(): Promise<MerchantEntity[]> {
    return this.merchantRepo.find({ order: { createdAt: 'DESC' } });
  }

  /**
   * Creates a new merchant with a freshly generated API Key ID/Secret pair
   * and HMAC signing key. The plaintext secret and HMAC key are only ever
   * returned here, at creation time — the API key secret is hashed
   * (bcrypt) before persisting; the HMAC key is envelope-encrypted via
   * Vault Transit (it can't be hashed like the API key secret, since
   * HmacSignatureGuard needs the plaintext back to compute HMACs, not just
   * a yes/no comparison).
   */
  async createMerchant(params: {
    merchantId: string;
    name: string;
    roles: string[];
    platformFeeBps?: number;
    settlementCurrency?: string;
    reserveBps?: number;
    reserveHoldDays?: number;
    accountType?: 'PLATFORM' | 'CONNECTED';
    platformMerchantId?: string;
    payoutReserveBps?: number;
    payoutReserveHoldDays?: number;
    enabledPspProviders?: string[];
  }): Promise<{
    merchant: MerchantEntity;
    apiKeySecret: string;
    hmacSecret: string;
  }> {
    const existing = await this.merchantRepo.findOne({ where: { merchantId: params.merchantId } });
    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        error: `Merchant ${params.merchantId} already exists`,
        code: 'MERCHANT_ALREADY_EXISTS',
      });
    }

    const accountType = params.accountType ?? 'PLATFORM';
    if (accountType === 'CONNECTED') {
      if (!params.platformMerchantId) {
        throw new ConflictException({
          statusCode: 409,
          error: 'A CONNECTED merchant requires platformMerchantId',
          code: 'PLATFORM_MERCHANT_ID_REQUIRED',
        });
      }
      const platform = await this.merchantRepo.findOne({ where: { merchantId: params.platformMerchantId } });
      if (!platform) {
        throw new NotFoundException({
          statusCode: 404,
          error: `Platform merchant ${params.platformMerchantId} not found`,
          code: 'PLATFORM_MERCHANT_NOT_FOUND',
        });
      }
      // One level deep only — see MerchantEntity.platformMerchantId's docblock.
      if (platform.accountType !== 'PLATFORM') {
        throw new ConflictException({
          statusCode: 409,
          error: `${params.platformMerchantId} is itself a CONNECTED account and cannot have connected accounts of its own`,
          code: 'PLATFORM_MERCHANT_INVALID',
        });
      }
    } else if (params.platformMerchantId) {
      throw new ConflictException({
        statusCode: 409,
        error: 'platformMerchantId may only be set for a CONNECTED merchant',
        code: 'PLATFORM_MERCHANT_ID_NOT_ALLOWED',
      });
    }

    const apiKeySecret = randomToken('sk');
    const hmacSecret = randomBytes(32).toString('hex');
    const merchant = this.merchantRepo.create({
      id: randomUUID(),
      merchantId: params.merchantId,
      name: params.name,
      apiKeyId: randomToken('ak'),
      apiKeySecretHash: await bcrypt.hash(apiKeySecret, BCRYPT_ROUNDS),
      hmacSecretCiphertext: await this.vaultTransit.encrypt(hmacSecret),
      roles: params.roles,
      isActive: true,
      ...(params.platformFeeBps !== undefined ? { platformFeeBps: params.platformFeeBps } : {}),
      ...(params.settlementCurrency ? { settlementCurrency: params.settlementCurrency.toUpperCase() } : {}),
      ...(params.reserveBps !== undefined ? { reserveBps: params.reserveBps } : {}),
      ...(params.reserveHoldDays !== undefined ? { reserveHoldDays: params.reserveHoldDays } : {}),
      accountType,
      ...(params.platformMerchantId ? { platformMerchantId: params.platformMerchantId } : {}),
      ...(params.payoutReserveBps !== undefined ? { payoutReserveBps: params.payoutReserveBps } : {}),
      ...(params.payoutReserveHoldDays !== undefined ? { payoutReserveHoldDays: params.payoutReserveHoldDays } : {}),
      ...(params.enabledPspProviders ? { enabledPspProviders: params.enabledPspProviders } : {}),
    });

    await this.merchantRepo.save(merchant);
    this.logger.log(`Created merchant ${params.merchantId} (apiKeyId=${merchant.apiKeyId})`);

    return { merchant, apiKeySecret, hmacSecret };
  }

  async rotateApiKeySecret(merchantId: string): Promise<string> {
    const merchant = await this.getOrThrow(merchantId);
    const apiKeySecret = randomToken('sk');
    merchant.apiKeySecretHash = await bcrypt.hash(apiKeySecret, BCRYPT_ROUNDS);
    await this.merchantRepo.save(merchant);
    // Rotating credentials usually means "I think this leaked" — kill
    // existing sessions too, not just future logins with the old secret.
    await this.tokenRevocation.revokeAllForMerchant(merchantId);
    this.logger.log(`Rotated API key secret for merchant ${merchantId} — old secret and existing sessions are now invalid`);
    return apiKeySecret;
  }

  async rotateHmacSecret(merchantId: string): Promise<string> {
    const merchant = await this.getOrThrow(merchantId);
    const hmacSecret = randomBytes(32).toString('hex');
    merchant.hmacSecretCiphertext = await this.vaultTransit.encrypt(hmacSecret);
    await this.merchantRepo.save(merchant);
    this.logger.log(`Rotated HMAC secret for merchant ${merchantId} — old secret is now invalid`);
    return hmacSecret;
  }

  async updateFeeRate(merchantId: string, platformFeeBps: number): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previous = merchant.platformFeeBps;
    merchant.platformFeeBps = platformFeeBps;
    await this.merchantRepo.save(merchant);
    this.logger.log(`Fee rate for merchant ${merchantId} changed from ${previous}bps to ${platformFeeBps}bps`);
    return merchant;
  }

  /**
   * Sets (or clears, via an empty array) this merchant's volume-based fee
   * tier schedule — see MerchantEntity.feeTiers's docblock for how it's
   * applied. Validated here rather than purely via DTO decorators because
   * the real invariant ("strictly ascending thresholds") is a cross-element
   * constraint class-validator's per-field decorators can't express cleanly
   * — same reasoning SpendPolicy.create() validates
   * perTransactionLimit <= monthlyLimit in the domain layer rather than
   * the DTO.
   */
  async updateFeeTiers(merchantId: string, tiers: { minVolumeMinorUnits: string; bps: number }[]): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);

    let previousThreshold = -1n;
    for (const tier of tiers) {
      let threshold: bigint;
      try {
        threshold = BigInt(tier.minVolumeMinorUnits);
      } catch {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: `minVolumeMinorUnits "${tier.minVolumeMinorUnits}" is not a valid integer`,
          code: 'FEE_TIER_INVALID_THRESHOLD',
        });
      }
      if (threshold <= previousThreshold) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Fee tiers must have strictly ascending minVolumeMinorUnits thresholds, with no duplicates',
          code: 'FEE_TIER_NOT_ASCENDING',
        });
      }
      previousThreshold = threshold;
    }

    merchant.feeTiers = tiers.length > 0 ? tiers : null;
    await this.merchantRepo.save(merchant);
    this.logger.log(`Fee tier schedule for merchant ${merchantId} updated: ${tiers.length} tier(s)`);
    return merchant;
  }

  async updateSettlementCurrency(merchantId: string, settlementCurrency: string | null): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previous = merchant.settlementCurrency;
    // null, not undefined — TypeORM's save() silently skips an undefined
    // property instead of writing SQL NULL, which would leave the old
    // currency in the database despite this "clearing" call appearing to
    // succeed (confirmed live: an undefined assignment here left the prior
    // value in Postgres while every response still reported it as cleared).
    merchant.settlementCurrency = settlementCurrency ? settlementCurrency.toUpperCase() : null;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `Settlement currency for merchant ${merchantId} changed from ${previous ?? '(charge currency)'} to ${merchant.settlementCurrency ?? '(charge currency)'}`,
    );
    return merchant;
  }

  /** Operator-initiated — see riskTierAutoManaged's docblock for why this always disables auto-management, unlike applyAutoRiskTier() below. */
  async updateReservePolicy(merchantId: string, reserveBps: number, reserveHoldDays: number): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previous = `${merchant.reserveBps}bps/${merchant.reserveHoldDays}d`;
    merchant.reserveBps = reserveBps;
    merchant.reserveHoldDays = reserveHoldDays;
    merchant.riskTierAutoManaged = false;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `Reserve policy for merchant ${merchantId} changed from ${previous} to ${reserveBps}bps/${reserveHoldDays}d (riskTierAutoManaged disabled)`,
    );
    return merchant;
  }

  async updatePayoutReservePolicy(merchantId: string, payoutReserveBps: number, payoutReserveHoldDays: number): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previous = `${merchant.payoutReserveBps}bps/${merchant.payoutReserveHoldDays}d`;
    merchant.payoutReserveBps = payoutReserveBps;
    merchant.payoutReserveHoldDays = payoutReserveHoldDays;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `Payout reserve policy for merchant ${merchantId} changed from ${previous} to ${payoutReserveBps}bps/${payoutReserveHoldDays}d`,
    );
    return merchant;
  }

  /**
   * Submits (or re-submits, after a REJECTED decision) a CONNECTED
   * merchant's KYC application. Only meaningful for CONNECTED merchants —
   * a PLATFORM merchant isn't gated on this (see MerchantEntity.kycStatus's
   * docblock) — but deliberately not *blocked* for a PLATFORM merchant
   * either; there's no real harm in a platform submitting business info
   * that nothing ever reads, and rejecting it here would just be an
   * arbitrary restriction this system has no real reason to enforce.
   * Resolves synchronously against the mock KYC provider (see
   * KYCProviderPort's docblock for why a real provider wouldn't).
   */
  async submitKyc(merchantId: string, legalName: string, taxId: string): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const { approved, applicationId, reason } = await this.kycProvider.verify({ legalName, taxId });
    merchant.kycStatus = approved ? 'VERIFIED' : 'REJECTED';
    merchant.kycLegalName = legalName;
    merchant.kycTaxId = taxId;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `KYC for merchant ${merchantId}: ${merchant.kycStatus} (applicationId=${applicationId}${reason ? `, reason=${reason}` : ''})`,
    );
    return merchant;
  }

  /**
   * Sets which PSPs this merchant's charges are allowed to route through —
   * see MerchantEntity.enabledPspProviders's docblock. Rejects an empty
   * array: unlike feeTiers/settlementCurrency (where "clear it" is a
   * meaningful state), a merchant with zero entitled PSPs can never
   * successfully charge again — that's very likely a mistake, not an
   * intended "pause this merchant" action (setActive() already exists for
   * that, and is reversible/obvious in a way an empty PSP list isn't).
   */
  async updatePspEntitlement(merchantId: string, enabledPspProviders: string[]): Promise<MerchantEntity> {
    if (enabledPspProviders.length === 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'enabledPspProviders cannot be empty — a merchant must be entitled to at least one PSP',
        code: 'PSP_ENTITLEMENT_EMPTY',
      });
    }
    const merchant = await this.getOrThrow(merchantId);
    const previous = merchant.enabledPspProviders;
    merchant.enabledPspProviders = enabledPspProviders;
    await this.merchantRepo.save(merchant);
    this.logger.log(`PSP entitlement for merchant ${merchantId} changed from [${previous.join(',')}] to [${enabledPspProviders.join(',')}]`);
    return merchant;
  }

  async setRiskTierAutoManaged(merchantId: string, enabled: boolean): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.riskTierAutoManaged = enabled;
    await this.merchantRepo.save(merchant);
    this.logger.log(`riskTierAutoManaged for merchant ${merchantId} set to ${enabled}`);
    return merchant;
  }

  /** Called only by RiskTieringService's sweep — unlike updateReservePolicy(), this does NOT touch riskTierAutoManaged (it's already true, or this wouldn't have been called). */
  async applyAutoRiskTier(merchantId: string, reserveBps: number, reserveHoldDays: number): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.reserveBps = reserveBps;
    merchant.reserveHoldDays = reserveHoldDays;
    await this.merchantRepo.save(merchant);
    return merchant;
  }

  async setActive(merchantId: string, isActive: boolean): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.isActive = isActive;
    await this.merchantRepo.save(merchant);
    if (!isActive) {
      // JWTs are stateless — without this, a deactivated merchant's
      // already-issued tokens would keep working for up to another hour
      // (their remaining lifetime), not stop immediately.
      await this.tokenRevocation.revokeAllForMerchant(merchantId);
    }
    this.logger.warn(`Merchant ${merchantId} ${isActive ? 'reactivated' : 'deactivated'}`);
    return merchant;
  }

  /** Explicit "log out everywhere" for a merchant, independent of any credential change. */
  async revokeAllSessions(merchantId: string): Promise<void> {
    await this.getOrThrow(merchantId);
    await this.tokenRevocation.revokeAllForMerchant(merchantId);
    this.logger.warn(`All active sessions revoked for merchant ${merchantId}`);
  }

  private async getOrThrow(merchantId: string): Promise<MerchantEntity> {
    // Same master-read reasoning as verifyCredentials() above — this is
    // the shared lookup behind 10+ admin mutation endpoints
    // (updateFeeRate, updateSettlementCurrency, setActive, ...), any of
    // which could plausibly be called immediately after createMerchant()
    // in a real onboarding flow, not just in tests.
    const merchant = await this.findMerchantOnMaster({ merchantId });
    if (!merchant) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Merchant ${merchantId} not found`,
        code: 'MERCHANT_NOT_FOUND',
      });
    }
    return merchant;
  }
}
