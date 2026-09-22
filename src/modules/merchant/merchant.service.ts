import { Injectable, Logger, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository, DataSource } from 'typeorm';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { MerchantEntity } from './merchant.entity';
import { TokenRevocationService } from '../../shared/auth/token-revocation.service';
import { VaultTransitService } from '../../shared/vault/vault-transit.service';
import { KYCProviderPort } from './kyc-provider.port';
import { KYBProviderPort, BeneficialOwner } from './kyb-provider.port';
import { lookupIndustryRiskCategory } from './mcc-risk-lookup';
import { SanctionsScreeningService } from './sanctions/sanctions-screening.service';

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
    private readonly kybProvider: KYBProviderPort,
    private readonly sanctionsScreening: SanctionsScreeningService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // Forced onto master, not the ambient replica-routed connection (see
  // app.module.ts's `replication` config) — this app's DataSource routes
  // plain repository reads to the Postgres replica, which has ~1s
  // streaming lag behind master (same issue documented in
  // reserve.service.ts's release() and payment-typeorm.repository.ts's
  // findPending()). A merchant created via createMerchant() and looked up
  // again moments later — POST /auth/token immediately after creation
  // being the sharpest real-world case, since nothing else forces a delay
  // between the two — can race that lag and come back not-found: without
  // forcing master, test/reserve.e2e-spec.ts's seedMerchant() → login()
  // sequence fails with a spurious 401 in CI (though not locally, where
  // I/O is fast enough that the gap between the two calls usually — not
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

  /**
   * Same as findByMerchantId(), but forced onto master — for a caller
   * that could plausibly be looking up a merchant moments after that
   * merchant was created (or otherwise just written), same reasoning as
   * findMerchantOnMaster() above. Confirmed as a real, reproducible bug
   * (not just theorized): PayoutService.runSweepLocked() calls this to
   * check a payee's accountType/reserve policy for every net balance it
   * finds — a connected merchant seeded and charged with a split in the
   * same test/request right before a sweep runs is exactly this race,
   * and losing it doesn't throw, it silently `continue`s past that
   * payee, skipping payout creation entirely with no error surfaced
   * anywhere. See docs/technical/ci-cd.md.
   */
  async findByMerchantIdOnMaster(merchantId: string): Promise<MerchantEntity | null> {
    return this.findMerchantOnMaster({ merchantId, isActive: true });
  }

  // Forced onto master, same reasoning as findMerchantOnMaster() above —
  // this is only called by GET /admin/merchants and the ambiguous-risk/
  // risk-tiering sweeps, all low-frequency admin/ops paths (unlike
  // findByMerchantId(), which also backs per-request guards and stays
  // replica-routed on purpose). An admin flagging/clearing a merchant and
  // immediately re-listing — or a sweep reading right after its own prior
  // write — is exactly the "write then read moments later" shape that
  // races replica lag; confirmed via a real e2e failure
  // (ambiguous-risk-monitoring.e2e-spec.ts's daily-volume trigger test)
  // that only reproduced under concurrent e2e load, never in isolation.
  async list(): Promise<MerchantEntity[]> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager.find(MerchantEntity, { order: { createdAt: 'DESC' } });
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Keyset-paginated (not offset-based — a large sweep spanning many
   * batches shouldn't re-scan skipped rows, and offset pagination's cost
   * grows with the offset itself) page of active, auto-managed merchants,
   * ordered by `id` ascending. `id` (the UUID primary key), not
   * `merchantId` or `createdAt` — it's guaranteed unique and already
   * indexed as the primary key, so `id > afterId` is a stable cursor even
   * if two merchants share a `createdAt` timestamp. Built for
   * `RiskTieringService.runTieringSweep()`'s own batching (see that
   * method's docblock for why `list()` above stopped being viable once
   * the merchants table grew large) — filters `isActive`/
   * `riskTierAutoManaged` in SQL rather than fetching every merchant and
   * filtering in application code, so a batch only ever contains rows the
   * caller actually needs to evaluate.
   */
  async findActiveAutoManagedBatch(afterId: string | undefined, limit: number): Promise<MerchantEntity[]> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager
        .createQueryBuilder(MerchantEntity, 'm')
        .where('m.isActive = :isActive', { isActive: true })
        .andWhere('m.riskTierAutoManaged = :autoManaged', { autoManaged: true })
        .andWhere(afterId ? 'm.id > :afterId' : '1=1', afterId ? { afterId } : {})
        .orderBy('m.id', 'ASC')
        .take(limit)
        .getMany();
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Same keyset-pagination shape as findActiveAutoManagedBatch() above,
   * for SanctionsScreeningSweepService's weekly re-screening sweep —
   * filters out merchants already `HIT` in SQL (a confirmed match
   * doesn't need re-screening; the action it would have blocked already
   * was), not merely `!riskTierAutoManaged`-style opt-out, since
   * sanctions screening has no per-merchant opt-out at all.
   */
  async findActiveNotHitBatch(afterId: string | undefined, limit: number): Promise<MerchantEntity[]> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      return await queryRunner.manager
        .createQueryBuilder(MerchantEntity, 'm')
        .where('m.isActive = :isActive', { isActive: true })
        .andWhere('m.sanctionsScreeningStatus != :hit', { hit: 'HIT' })
        .andWhere(afterId ? 'm.id > :afterId' : '1=1', afterId ? { afterId } : {})
        .orderBy('m.id', 'ASC')
        .take(limit)
        .getMany();
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Creates a new merchant with a freshly generated API Key ID/Secret pair
   * and HMAC signing key. The plaintext secret and HMAC key are only ever
   * returned here, at creation time — the API key secret is hashed
   * (bcrypt) before persisting; the HMAC key is envelope-encrypted via
   * Vault Transit (it can't be hashed like the API key secret, since
   * HmacSignatureGuard needs the plaintext back to compute HMACs, not just
   * a yes/no comparison).
   *
   * Sanctions-screens the supplied `legalName` (or, if omitted, `name` at
   * *degraded* confidence) before anything is persisted — a `HIT` throws
   * and nothing is created at all: no merchant row, no API key, no HMAC
   * secret. See docs/business-domain/merchants.md#step-1--identity-capture-and-sanctions-screening-at-creation.
   * A `POTENTIAL_MATCH` does not block creation; the merchant is created
   * normally with the flag set, and a notification fires once the row
   * exists (emitted as `merchant.sanctions_screening.flagged` rather than
   * calling `SanctionsNotificationDispatcherService` directly — that
   * service depends on `MerchantService` to read notification config,
   * so this module resolves the same "who calls whom" problem
   * `updateReservePolicy()`'s `merchant.reserve_policy.escalated` event
   * already solves, just within this module instead of across the
   * Merchant/Payment boundary).
   */
  async createMerchant(params: {
    merchantId: string;
    name: string;
    legalName?: string;
    taxId?: string;
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
      // Forced onto master — same real, previously-hit race
      // findMerchantOnMaster()'s own docblock describes: a platform
      // merchant created moments earlier (its own createMerchant() call,
      // committed to master) and immediately referenced here as
      // platformMerchantId races the replica's ~1s streaming lag. Found
      // live via an intermittent "Platform merchant not found" 404 when
      // running e2e files back-to-back in the same worker — passed every
      // time in isolation, which is exactly this race's signature.
      const platform = await this.findMerchantOnMaster({ merchantId: params.platformMerchantId });
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

    const screening = await this.sanctionsScreening.screen({
      legalName: params.legalName,
      displayName: params.name,
      taxId: params.taxId,
    });
    if (screening.status === 'HIT') {
      this.logger.warn(
        `Merchant creation blocked for "${params.merchantId}": sanctions HIT against "${screening.matchedListEntry}"`,
      );
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Sanctions screening matched "${screening.matchedListEntry}" — merchant not created`,
        code: 'SANCTIONS_SCREENING_HIT',
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
      ...(params.legalName ? { legalName: params.legalName } : {}),
      ...(params.taxId ? { taxId: params.taxId } : {}),
      sanctionsScreeningStatus: screening.status,
      sanctionsScreeningConfidence: screening.confidence,
      sanctionsScreenedAt: new Date(),
      sanctionsMatchDetails: this.sanctionsScreening.formatMatchDetails(screening.matchedListEntry, screening.score),
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

    if (screening.status === 'POTENTIAL_MATCH') {
      this.eventEmitter.emit('merchant.sanctions_screening.flagged', {
        merchantId: params.merchantId,
        status: screening.status,
        matchedListEntry: screening.matchedListEntry,
        score: screening.score,
        confidence: screening.confidence,
      });
    }

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
    this.logger.log(
      `Rotated API key secret for merchant ${merchantId} — old secret and existing sessions are now invalid`,
    );
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
  async updateFeeTiers(
    merchantId: string,
    tiers: { minVolumeMinorUnits: string; bps: number }[],
  ): Promise<MerchantEntity> {
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
    // succeed: an undefined assignment here would leave the prior value in
    // Postgres while every response still reports it as cleared.
    merchant.settlementCurrency = settlementCurrency ? settlementCurrency.toUpperCase() : null;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `Settlement currency for merchant ${merchantId} changed from ${previous ?? '(charge currency)'} to ${merchant.settlementCurrency ?? '(charge currency)'}`,
    );
    return merchant;
  }

  async updateDisputeNotificationChannel(
    merchantId: string,
    channel: 'EMAIL' | 'SLACK' | 'WEBHOOK',
    target: string | null,
  ): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previous = `${merchant.disputeNotificationChannel}:${merchant.disputeNotificationTarget ?? '(none)'}`;
    merchant.disputeNotificationChannel = channel;
    // null, not undefined — same "TypeORM save() silently skips undefined"
    // reasoning as updateSettlementCurrency() above.
    merchant.disputeNotificationTarget = target;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `Dispute notification channel for merchant ${merchantId} changed from ${previous} to ${channel}:${target ?? '(none)'}`,
    );
    return merchant;
  }

  async updateSubscriptionNotificationChannel(
    merchantId: string,
    channel: 'EMAIL' | 'SLACK' | 'WEBHOOK',
    target: string | null,
  ): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previous = `${merchant.subscriptionNotificationChannel}:${merchant.subscriptionNotificationTarget ?? '(none)'}`;
    merchant.subscriptionNotificationChannel = channel;
    // null, not undefined — same "TypeORM save() silently skips undefined"
    // reasoning as updateDisputeNotificationChannel() above.
    merchant.subscriptionNotificationTarget = target;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `Subscription notification channel for merchant ${merchantId} changed from ${previous} to ${channel}:${target ?? '(none)'}`,
    );
    return merchant;
  }

  async updateAmlReviewNotificationChannel(
    merchantId: string,
    channel: 'EMAIL' | 'SLACK' | 'WEBHOOK',
    target: string | null,
  ): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previous = `${merchant.amlReviewNotificationChannel}:${merchant.amlReviewNotificationTarget ?? '(none)'}`;
    merchant.amlReviewNotificationChannel = channel;
    merchant.amlReviewNotificationTarget = target;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `AML-review notification channel for merchant ${merchantId} changed from ${previous} to ${channel}:${target ?? '(none)'}`,
    );
    return merchant;
  }

  /**
   * Derives industryRiskCategory from mccCode via mcc-risk-lookup.ts and
   * stores both — see MerchantEntity.industryRiskCategory's docblock for
   * why this is denormalized at write time rather than looked up fresh
   * by RiskTieringService on every evaluation. Passing null clears both
   * fields back to "no MCC on file" (industryRiskCategory reverts to
   * UNKNOWN, the same as a merchant that never had one set).
   */
  async updateMccCode(merchantId: string, mccCode: string | null): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previous = `${merchant.mccCode ?? '(none)'}/${merchant.industryRiskCategory}`;
    merchant.mccCode = mccCode;
    merchant.industryRiskCategory = lookupIndustryRiskCategory(mccCode);
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `MCC code for merchant ${merchantId} changed from ${previous} to ${mccCode ?? '(none)'}/${merchant.industryRiskCategory}`,
    );
    return merchant;
  }

  /**
   * Operator-initiated — see riskTierAutoManaged's docblock for why this
   * always disables auto-management, unlike applyAutoRiskTier() below.
   *
   * Emits `merchant.reserve_policy.escalated` when the new `reserveBps`
   * is higher than the previous rate — `ReservePolicyEscalationListener`
   * (in `PaymentModule`, which this module can't depend on directly;
   * `MerchantModule` -> `PaymentModule` is the wrong direction of the
   * one-way dependency `docs/technical/architecture.md`'s module graph
   * establishes) reacts by topping up this merchant's still-HELD reserve
   * holds to the new rate, the same way `RiskTieringService`'s own
   * automatic sweep escalation already does via
   * `ReserveService.topUpHeldReservesForMerchant()`. A manual escalation
   * is, if anything, a more deliberate risk signal than an automatic
   * one — there was never a real reason for only the automatic path to
   * reach already-booked holds. Same one-way-only posture: a
   * de-escalation here never claws anything back, matching
   * `topUpHeldReservesForMerchant()`'s own escalation-only contract.
   */
  async updateReservePolicy(merchantId: string, reserveBps: number, reserveHoldDays: number): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previousBps = merchant.reserveBps;
    const previous = `${merchant.reserveBps}bps/${merchant.reserveHoldDays}d`;
    merchant.reserveBps = reserveBps;
    merchant.reserveHoldDays = reserveHoldDays;
    merchant.riskTierAutoManaged = false;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `Reserve policy for merchant ${merchantId} changed from ${previous} to ${reserveBps}bps/${reserveHoldDays}d (riskTierAutoManaged disabled)`,
    );
    if (reserveBps > previousBps) {
      this.eventEmitter.emit('merchant.reserve_policy.escalated', { merchantId, reserveBps });
    }
    return merchant;
  }

  async updatePayoutReservePolicy(
    merchantId: string,
    payoutReserveBps: number,
    payoutReserveHoldDays: number,
  ): Promise<MerchantEntity> {
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
   * Resolves synchronously against the mock provider (`KYC_PROVIDER=mock`,
   * the default) or asynchronously against a real one (`=persona`) — see
   * `confirmKyc()` for the async completion path.
   *
   * Also re-screens sanctions against the submitted `legalName`, at full
   * confidence — superseding whatever degraded-confidence result (based
   * on the display `name` alone) this merchant got at creation, if it
   * never supplied a `legalName` then. A `HIT` rejects the submission
   * outright: nothing is persisted, `kycStatus` is left exactly as it
   * was, same "block before anything is written" posture
   * `createMerchant()` uses. See docs/business-domain/marketplace-and-payouts.md's
   * "KYC submission also re-screens sanctions" note.
   */
  async submitKyc(merchantId: string, legalName: string, taxId: string): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);

    const screening = await this.sanctionsScreening.screen({ legalName, displayName: merchant.name, taxId });
    if (screening.status === 'HIT') {
      this.logger.warn(
        `KYC submission blocked for merchant ${merchantId}: sanctions HIT against "${screening.matchedListEntry}"`,
      );
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Sanctions screening matched "${screening.matchedListEntry}" — KYC submission rejected`,
        code: 'SANCTIONS_SCREENING_HIT',
      });
    }

    const { status, applicationId, reason } = await this.kycProvider.verify({ legalName, taxId });
    merchant.kycLegalName = legalName;
    merchant.kycTaxId = taxId;
    merchant.legalName = legalName;
    merchant.taxId = taxId;
    merchant.sanctionsScreeningStatus = screening.status;
    merchant.sanctionsScreeningConfidence = screening.confidence;
    merchant.sanctionsScreenedAt = new Date();
    merchant.sanctionsMatchDetails = this.sanctionsScreening.formatMatchDetails(
      screening.matchedListEntry,
      screening.score,
    );
    if (status === 'PENDING') {
      merchant.kycStatus = 'PENDING_REVIEW';
      merchant.kycApplicationId = applicationId;
    } else {
      merchant.kycStatus = status === 'APPROVED' ? 'VERIFIED' : 'REJECTED';
      merchant.kycApplicationId = null;
    }
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `KYC for merchant ${merchantId}: ${merchant.kycStatus} (applicationId=${applicationId}${reason ? `, reason=${reason}` : ''})`,
    );

    if (screening.status === 'POTENTIAL_MATCH') {
      this.eventEmitter.emit('merchant.sanctions_screening.flagged', {
        merchantId,
        status: screening.status,
        matchedListEntry: screening.matchedListEntry,
        score: screening.score,
        confidence: screening.confidence,
      });
    }

    return merchant;
  }

  /**
   * Called from `POST /webhooks/kyc` (see `KycWebhookGuard`) once a real
   * provider's async review resolves a `PENDING_REVIEW` application.
   * Idempotent — a duplicate webhook delivery for an already-decided
   * application, or one for an unrecognized `applicationId`, is logged
   * and ignored rather than throwing, same posture as
   * `PayoutService.confirmTransfer()` — including that method's own
   * replica-lag fix: `kycApplicationId` was itself written moments
   * earlier by `submitKyc()`, in the very same real-world flow this
   * webhook is reacting to, so this lookup is forced onto master
   * (`findMerchantOnMaster()`) rather than the ambient replica-routed
   * one, for the identical reason `PayoutService.confirmTransfer()`'s
   * own docblock explains.
   */
  async confirmKyc(applicationId: string, outcome: 'VERIFIED' | 'REJECTED', reason?: string): Promise<void> {
    const merchant = await this.findMerchantOnMaster({ kycApplicationId: applicationId });
    if (!merchant) {
      this.logger.warn(`KYC webhook: no merchant found for applicationId=${applicationId}, ignoring`);
      return;
    }
    if (merchant.kycStatus !== 'PENDING_REVIEW') {
      this.logger.log(
        `KYC webhook: merchant ${merchant.merchantId} (applicationId=${applicationId}) is already ${merchant.kycStatus}, ignoring duplicate confirmation`,
      );
      return;
    }
    merchant.kycStatus = outcome;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `KYC for merchant ${merchant.merchantId} confirmed ${outcome} (applicationId=${applicationId}${reason ? `, reason=${reason}` : ''})`,
    );
  }

  /**
   * Submits (or re-submits, after a REJECTED decision) a CONNECTED
   * merchant's KYB (Know Your Business) application — structurally the
   * same shape as `submitKyc()`, answering a different question (see
   * `KYBProviderPort`'s docblock). Deliberately independent of
   * `kycStatus`: a merchant can be `kycStatus: 'VERIFIED'` (the
   * individual checks out) while `kybStatus` is still `NOT_STARTED` (the
   * business itself was never separately verified) — this method exists
   * specifically because those are different, both-required questions.
   * Not currently wired into any payout gate — see `MerchantEntity.kybStatus`'s
   * docblock for why.
   *
   * Also re-screens sanctions against the submitted `legalName`, same
   * "any entry point that captures a real legal name re-screens" posture
   * `submitKyc()` already established — a business's legal name is
   * exactly the kind of identity sanctions screening exists to catch,
   * and it would be an inconsistent gap if KYB submission were the one
   * legal-name-capturing entry point that skipped it.
   */
  async submitKyb(
    merchantId: string,
    legalName: string,
    taxId: string,
    country: string,
    beneficialOwners?: BeneficialOwner[],
  ): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);

    const screening = await this.sanctionsScreening.screen({ legalName, displayName: merchant.name, taxId });
    if (screening.status === 'HIT') {
      this.logger.warn(
        `KYB submission blocked for merchant ${merchantId}: sanctions HIT against "${screening.matchedListEntry}"`,
      );
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Sanctions screening matched "${screening.matchedListEntry}" — KYB submission rejected`,
        code: 'SANCTIONS_SCREENING_HIT',
      });
    }

    const { status, applicationId, reason } = await this.kybProvider.verify({
      legalName,
      taxId,
      country,
      beneficialOwners,
    });
    merchant.kybLegalName = legalName;
    merchant.kybTaxId = taxId;
    merchant.kybCountry = country;
    merchant.kybBeneficialOwners = beneficialOwners ?? null;
    merchant.legalName = legalName;
    merchant.taxId = taxId;
    merchant.sanctionsScreeningStatus = screening.status;
    merchant.sanctionsScreeningConfidence = screening.confidence;
    merchant.sanctionsScreenedAt = new Date();
    merchant.sanctionsMatchDetails = this.sanctionsScreening.formatMatchDetails(
      screening.matchedListEntry,
      screening.score,
    );
    if (status === 'PENDING') {
      merchant.kybStatus = 'PENDING_REVIEW';
      merchant.kybApplicationId = applicationId;
    } else {
      merchant.kybStatus = status === 'APPROVED' ? 'VERIFIED' : 'REJECTED';
      merchant.kybApplicationId = null;
    }
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `KYB for merchant ${merchantId}: ${merchant.kybStatus} (applicationId=${applicationId}${reason ? `, reason=${reason}` : ''})`,
    );

    if (screening.status === 'POTENTIAL_MATCH') {
      this.eventEmitter.emit('merchant.sanctions_screening.flagged', {
        merchantId,
        status: screening.status,
        matchedListEntry: screening.matchedListEntry,
        score: screening.score,
        confidence: screening.confidence,
      });
    }

    return merchant;
  }

  /**
   * Called from `POST /webhooks/kyb` (see `KybWebhookGuard`) — identical
   * shape to `confirmKyc()`, including that method's own replica-lag fix
   * (`findMerchantOnMaster()`), for the same reason: `kybApplicationId`
   * was itself written moments earlier by `submitKyb()`, in the same
   * real-world flow this webhook reacts to.
   */
  async confirmKyb(applicationId: string, outcome: 'VERIFIED' | 'REJECTED', reason?: string): Promise<void> {
    const merchant = await this.findMerchantOnMaster({ kybApplicationId: applicationId });
    if (!merchant) {
      this.logger.warn(`KYB webhook: no merchant found for applicationId=${applicationId}, ignoring`);
      return;
    }
    if (merchant.kybStatus !== 'PENDING_REVIEW') {
      this.logger.log(
        `KYB webhook: merchant ${merchant.merchantId} (applicationId=${applicationId}) is already ${merchant.kybStatus}, ignoring duplicate confirmation`,
      );
      return;
    }
    merchant.kybStatus = outcome;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `KYB for merchant ${merchant.merchantId} confirmed ${outcome} (applicationId=${applicationId}${reason ? `, reason=${reason}` : ''})`,
    );
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
    this.logger.log(
      `PSP entitlement for merchant ${merchantId} changed from [${previous.join(',')}] to [${enabledPspProviders.join(',')}]`,
    );
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

  /**
   * Called only by AmbiguousRiskMonitoringService's detection/auto-clear
   * logic — same posture as applyAutoRiskTier() above: does NOT touch
   * ambiguousRiskAutoManaged (the caller already only acts on merchants
   * where it's true), and does not record ambiguousRiskFlaggedBy (an
   * automated action has no operator identity to attribute it to).
   */
  async applyAutoAmbiguousRiskFlag(merchantId: string, flagged: boolean, reason: string): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.ambiguousRiskFlagged = flagged;
    merchant.ambiguousRiskFlaggedAt = flagged ? new Date() : undefined;
    merchant.ambiguousRiskFlagReason = flagged ? reason : undefined;
    merchant.ambiguousRiskFlaggedBy = undefined;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `ambiguousRiskFlagged for merchant ${merchantId} automatically set to ${flagged}${flagged ? `: ${reason}` : ''}`,
    );
    return merchant;
  }

  /**
   * Operator-initiated via PATCH .../ambiguous-risk — always disables
   * ambiguousRiskAutoManaged, the same "manual input pauses automation"
   * behavior updateReservePolicy() uses for riskTierAutoManaged. reason
   * and resolvedBy are both required — this is the same audit-trail
   * posture AmbiguousPaymentService.resolve() uses for manually
   * resolving a payment.
   */
  async setAmbiguousRiskFlagManual(
    merchantId: string,
    flagged: boolean,
    reason: string,
    flaggedBy: string,
  ): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.ambiguousRiskFlagged = flagged;
    merchant.ambiguousRiskFlaggedAt = flagged ? new Date() : undefined;
    merchant.ambiguousRiskFlagReason = reason;
    merchant.ambiguousRiskFlaggedBy = flaggedBy;
    merchant.ambiguousRiskAutoManaged = false;
    await this.merchantRepo.save(merchant);
    this.logger.warn(
      `ambiguousRiskFlagged for merchant ${merchantId} manually set to ${flagged} by ${flaggedBy}: ${reason} (ambiguousRiskAutoManaged disabled)`,
    );
    return merchant;
  }

  /** Re-enables AmbiguousRiskMonitoringService's automated flag/auto-clear logic for this merchant — same pattern as setRiskTierAutoManaged() above. */
  async setAmbiguousRiskAutoManaged(merchantId: string, enabled: boolean): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.ambiguousRiskAutoManaged = enabled;
    await this.merchantRepo.save(merchant);
    this.logger.log(`ambiguousRiskAutoManaged for merchant ${merchantId} set to ${enabled}`);
    return merchant;
  }

  /** Called only by AmlReviewMonitoringService's detection logic — same posture as applyAutoAmbiguousRiskFlag() above. */
  async applyAutoAmlReviewFlag(merchantId: string, flagged: boolean, reason: string): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.amlReviewFlagged = flagged;
    merchant.amlReviewFlaggedAt = flagged ? new Date() : undefined;
    merchant.amlReviewFlagReason = flagged ? reason : undefined;
    merchant.amlReviewFlaggedBy = undefined;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `amlReviewFlagged for merchant ${merchantId} automatically set to ${flagged}${flagged ? `: ${reason}` : ''}`,
    );
    return merchant;
  }

  /** Operator-initiated via PATCH .../aml-review — same posture as setAmbiguousRiskFlagManual() above. */
  async setAmlReviewFlagManual(
    merchantId: string,
    flagged: boolean,
    reason: string,
    flaggedBy: string,
  ): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.amlReviewFlagged = flagged;
    merchant.amlReviewFlaggedAt = flagged ? new Date() : undefined;
    merchant.amlReviewFlagReason = reason;
    merchant.amlReviewFlaggedBy = flaggedBy;
    merchant.amlReviewAutoManaged = false;
    await this.merchantRepo.save(merchant);
    this.logger.warn(
      `amlReviewFlagged for merchant ${merchantId} manually set to ${flagged} by ${flaggedBy}: ${reason} (amlReviewAutoManaged disabled)`,
    );
    return merchant;
  }

  /** Re-enables AmlReviewMonitoringService's automated flag logic for this merchant — same pattern as setAmbiguousRiskAutoManaged() above. */
  async setAmlReviewAutoManaged(merchantId: string, enabled: boolean): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.amlReviewAutoManaged = enabled;
    await this.merchantRepo.save(merchant);
    this.logger.log(`amlReviewAutoManaged for merchant ${merchantId} set to ${enabled}`);
    return merchant;
  }

  /**
   * On-demand re-screen (`POST /admin/merchants/:id/sanctions/rescreen`)
   * against this merchant's currently-stored `legalName`/`taxId` (or
   * `name`, if no `legalName` was ever supplied) — the same check
   * `createMerchant()`/`submitKyc()` run, without waiting for the weekly
   * sweep. Unlike those two, a `HIT` here does **not** throw — the
   * merchant already exists; there's no "creation" left to block. It's
   * persisted and notified exactly like the sweep finding one, via
   * `SanctionsScreeningSweepService`'s shared `applySanctionsScreeningResult()`
   * path — this method is a thin, single-merchant wrapper over the same
   * logic, not a separate code path.
   */
  async rescreenSanctions(merchantId: string): Promise<{ merchant: MerchantEntity; previousStatus: string }> {
    const merchant = await this.getOrThrow(merchantId);
    const previousStatus = merchant.sanctionsScreeningStatus;
    const screening = await this.sanctionsScreening.screen({
      legalName: merchant.legalName,
      displayName: merchant.name,
      taxId: merchant.taxId,
    });
    const updated = await this.applySanctionsScreeningResult(merchantId, screening);
    return { merchant: updated, previousStatus };
  }

  /**
   * Persists a screening outcome onto an existing merchant — shared by
   * `rescreenSanctions()` above and `SanctionsScreeningSweepService`'s
   * batch sweep. Does not decide whether to notify; callers compare the
   * returned entity's new status against whatever they already knew the
   * previous status was (the sweep already has it from its own batch
   * fetch; `rescreenSanctions()` captures it just before calling this).
   */
  async applySanctionsScreeningResult(
    merchantId: string,
    screening: {
      status: 'CLEAR' | 'POTENTIAL_MATCH' | 'HIT';
      confidence: 'FULL' | 'DEGRADED';
      matchedListEntry?: string;
      score?: number;
    },
  ): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.sanctionsScreeningStatus = screening.status;
    merchant.sanctionsScreeningConfidence = screening.confidence;
    merchant.sanctionsScreenedAt = new Date();
    merchant.sanctionsMatchDetails = this.sanctionsScreening.formatMatchDetails(
      screening.matchedListEntry,
      screening.score,
    );
    await this.merchantRepo.save(merchant);
    return merchant;
  }

  /**
   * Operator-initiated via `PATCH .../sanctions-review` — records a
   * determination on a `POTENTIAL_MATCH`/`HIT` (false positive vs.
   * confirmed). Unlike `setAmbiguousRiskFlagManual()`/`setAmlReviewFlagManual()`,
   * this does **not** disable future automatic re-screening — see
   * `MerchantEntity.sanctionsReviewResolution`'s docblock for why. A
   * `CLEARED` resolution resets `sanctionsScreeningStatus` back to
   * `CLEAR` (the operator's determination that the current flag is a
   * false positive); `CONFIRMED` leaves the status exactly as it was —
   * a confirmed hit should stay visibly flagged, not appear to clear
   * itself just because a human looked at it.
   */
  async applySanctionsReview(
    merchantId: string,
    resolution: 'CLEARED' | 'CONFIRMED',
    reason: string,
    reviewedBy: string,
  ): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    merchant.sanctionsReviewResolution = resolution;
    merchant.sanctionsReviewedBy = reviewedBy;
    merchant.sanctionsReviewedAt = new Date();
    if (resolution === 'CLEARED') {
      merchant.sanctionsScreeningStatus = 'CLEAR';
    }
    await this.merchantRepo.save(merchant);
    this.logger.warn(`Sanctions review for merchant ${merchantId}: ${resolution} by ${reviewedBy} (${reason})`);
    return merchant;
  }

  async updateSanctionsNotificationChannel(
    merchantId: string,
    channel: 'EMAIL' | 'SLACK' | 'WEBHOOK',
    target: string | null,
  ): Promise<MerchantEntity> {
    const merchant = await this.getOrThrow(merchantId);
    const previous = `${merchant.sanctionsNotificationChannel}:${merchant.sanctionsNotificationTarget ?? '(none)'}`;
    merchant.sanctionsNotificationChannel = channel;
    merchant.sanctionsNotificationTarget = target;
    await this.merchantRepo.save(merchant);
    this.logger.log(
      `Sanctions notification channel for merchant ${merchantId} changed from ${previous} to ${channel}:${target ?? '(none)'}`,
    );
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
