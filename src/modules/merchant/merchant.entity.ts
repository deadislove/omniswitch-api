import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Merchant Entity
 * Credential + configuration record for a tenant of the gateway. Backs both
 * login (API Key ID + Secret -> JWT) and per-merchant HMAC signing keys.
 */
@Entity('merchants')
@Index(['apiKeyId'], { unique: true })
@Index(['merchantId'], { unique: true })
export class MerchantEntity {
  @PrimaryColumn('uuid')
  id: string;

  /** Business-facing id used everywhere else in the app (JWT's `merchantId` claim, ledger accountId, etc.) */
  @Column({ name: 'merchant_id' })
  merchantId: string;

  @Column()
  name: string;

  @Column({ name: 'api_key_id' })
  apiKeyId: string;

  /** bcrypt hash — the plaintext secret is only ever shown once, at creation/rotation time. */
  @Column({ name: 'api_key_secret_hash' })
  apiKeySecretHash: string;

  /**
   * Per-merchant HMAC signing key for HmacSignatureGuard, envelope-encrypted
   * via Vault's Transit engine (VaultTransitService) — this column holds
   * ciphertext, never plaintext. See docs/technical/secret-management.md.
   */
  @Column({ name: 'hmac_secret_ciphertext' })
  hmacSecretCiphertext: string;

  @Column({ type: 'jsonb' })
  roles: string[];

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /**
   * Platform fee rate, in basis points (150 = 1.5%). Applied by
   * PaymentCheckoutSaga/PaymentLifecycleService.capture() to every charge
   * and capture booked to this merchant's ledger entries. Defaults to 150
   * (the rate that used to be hardcoded everywhere) so existing merchants
   * see no behavior change. Deliberately basis points, not a float
   * percentage/decimal — avoids the rounding ambiguity of "is 1.5 already a
   * fraction or a percent" at every call site that reads it.
   */
  @Column({ name: 'platform_fee_bps', type: 'int', default: 150 })
  platformFeeBps: number;

  /**
   * Optional volume-based fee schedule — supersedes platformFeeBps for a
   * charge once this merchant's trailing-current-calendar-month SUCCEEDED
   * charge volume (in the *same currency* as the charge being priced —
   * see ChargeLedgerParamsResolverService.resolve()'s docblock for why
   * this doesn't attempt to blend currencies into one figure) reaches a
   * tier's threshold. Sorted ascending by minVolumeMinorUnits; the
   * highest tier whose threshold the trailing volume has reached applies,
   * and volume below the lowest configured tier still falls back to
   * platformFeeBps — so a merchant doesn't need a redundant "0" tier just
   * to keep their existing flat rate below the first real volume break.
   * Null (the default) means "no tiers" — every existing merchant's
   * behavior is completely unchanged unless this is explicitly set via
   * PATCH /admin/merchants/:id/fee-tiers.
   */
  @Column({ name: 'fee_tiers', type: 'jsonb', nullable: true })
  feeTiers?: { minVolumeMinorUnits: string; bps: number }[] | null;

  /**
   * TOTP secret, envelope-encrypted via Vault Transit — same posture as
   * hmacSecretCiphertext (never plaintext at rest). Set as soon as
   * enrollment starts (POST /auth/mfa/enroll), but `mfaEnabled` stays
   * false until the merchant proves they actually captured it correctly
   * (POST /auth/mfa/confirm) — an unconfirmed secret enforces nothing.
   */
  // Explicit type: 'varchar' — TypeORM infers a column's SQL type from
  // TypeScript's emitted design:type reflection metadata, which collapses
  // any union type (string | null) to bare Object; without this it fails
  // at DataSource.initialize() with `Data type "Object" ... is not
  // supported`, not at compile time, so it's easy to miss.
  @Column({ name: 'mfa_secret_ciphertext', type: 'varchar', nullable: true })
  mfaSecretCiphertext?: string | null;

  @Column({ name: 'mfa_enabled', default: false })
  mfaEnabled: boolean;

  /**
   * bcrypt hashes of unused single-use recovery codes (never plaintext at
   * rest, same reasoning as apiKeySecretHash) — consumed one at a time by
   * MfaService.verifyCode() as a fallback when the authenticator device
   * isn't available. Regenerated (old ones invalidated) every time MFA is
   * re-confirmed.
   */
  @Column({ name: 'mfa_backup_code_hashes', type: 'jsonb', default: '[]' })
  mfaBackupCodeHashes: string[];

  /**
   * Currency this merchant is paid out in, if different from whatever
   * currency a given charge was made in — e.g. a US-based platform paying
   * a EUR-settled merchant. Null (the default) means "settle in whatever
   * currency was charged," the only behavior that existed before this —
   * every existing merchant keeps that behavior unless this is set
   * explicitly. Only affects the MERCHANT ledger entry booked at
   * charge/capture time; see
   * LedgerOutboxEvent.createChargeEntries()'s settlementConversion param
   * and docs/business-domain/ledger-and-settlement.md.
   */
  // Same reason as mfaSecretCiphertext's comment above — explicit
  // type: 'varchar' required once the TS type includes `| null`.
  @Column({ name: 'settlement_currency', type: 'varchar', nullable: true, length: 3 })
  settlementCurrency?: string | null;

  /**
   * Risk-based reserve, in basis points of each charge's net amount (after
   * the platform fee) — 1000 = 10% withheld into a per-merchant RESERVE
   * ledger account instead of paid out immediately, released back after
   * reserveHoldDays. Defaults to 0 (no reserve), matching every merchant's
   * behavior before this existed. Deliberately a directly-configurable
   * rate per merchant, same idiom as platformFeeBps, rather than a
   * `riskTier` enum mapped to a fixed table of rates — an operator (or
   * RiskTieringService, see riskTierAutoManaged below) setting "this
   * merchant holds 8%" needs no enum this codebase would have to keep in
   * sync with the tiering thresholds. Only affects future charges — see
   * docs/business-domain/ledger-and-settlement.md.
   */
  @Column({ name: 'reserve_bps', type: 'int', default: 0 })
  reserveBps: number;

  /** How long a reserve hold sits before ReserveService's release sweep can pay it out. Meaningless (never read) while reserveBps is 0. */
  @Column({ name: 'reserve_hold_days', type: 'int', default: 0 })
  reserveHoldDays: number;

  /**
   * When true (the default for every merchant), RiskTieringService's daily
   * sweep may overwrite reserveBps/reserveHoldDays based on this
   * merchant's trailing dispute/chargeback history — see that service's
   * docblock for the (deliberately simple, documented-as-illustrative)
   * thresholds. Automatically flipped to false the moment an operator
   * sets a reserve policy by hand (PATCH .../reserve-policy) — a manual
   * override should stick until explicitly re-enabled
   * (PATCH .../risk-tier-auto), the same "manual input pauses automation"
   * behavior a thermostat or autoscaler uses, not something the next
   * sweep tick should silently clobber.
   */
  @Column({ name: 'risk_tier_auto_managed', default: true })
  riskTierAutoManaged: boolean;

  /**
   * Marketplace role. Every merchant defaults to 'PLATFORM' (a flat peer,
   * the only shape that existed before this) — 'CONNECTED' marks a
   * sub-merchant onboarded *under* a platform merchant (see
   * platformMerchantId below), whose payouts a platform charge can route
   * a portion of directly via POST /payments/charge's `splits`. There's no
   * behavioral difference between a 'PLATFORM' merchant that never uses
   * splits and a merchant from before this existed.
   */
  @Column({ name: 'account_type', type: 'varchar', default: 'PLATFORM' })
  accountType: 'PLATFORM' | 'CONNECTED';

  /**
   * Set only when accountType is 'CONNECTED' — the parent platform
   * merchant's business-facing merchantId (not its internal uuid, same
   * convention as every other merchantId reference in this codebase). A
   * charge's `splits` may only route funds to a CONNECTED merchant whose
   * platformMerchantId matches the charging merchant — see
   * ChargeLedgerParamsResolverService.resolve()'s SPLIT_RECIPIENT_INVALID
   * check. Deliberately one level deep only: a CONNECTED merchant can't
   * itself have connected accounts (MerchantService.createMerchant()
   * rejects that), the same "platform vs. seller" shape Stripe Connect and
   * Adyen for Platforms use, not an arbitrary org tree.
   */
  // Explicit type: 'varchar' — same reason as mfaSecretCiphertext's
  // comment above (TypeScript's `string | null` union collapses to bare
  // Object in TypeORM's reflected design:type metadata without this).
  @Column({ name: 'platform_merchant_id', type: 'varchar', nullable: true })
  platformMerchantId?: string | null;

  /**
   * Rolling reserve applied at *payout* time, in basis points — distinct
   * from reserveBps/reserveHoldDays above, which apply at *charge* time to
   * whichever merchant is doing the charging. A CONNECTED merchant that
   * also charges directly (nothing stops one from having its own API
   * credentials) could reasonably want a different rate for "money I
   * charged myself" versus "money a platform routed to me via a split" —
   * reusing reserveBps for both would conflate two genuinely different
   * money flows. Only read by PayoutService.runSweep(), and only for
   * CONNECTED merchants; meaningless on a PLATFORM merchant, since
   * marketplace payout scheduling doesn't apply to a platform's own
   * charges. See docs/business-domain/ledger-and-settlement.md#marketplace-splits.
   */
  @Column({ name: 'payout_reserve_bps', type: 'int', default: 0 })
  payoutReserveBps: number;

  /** How long a payout's withheld rolling reserve sits before PayoutService's release sweep can free it. Meaningless while payoutReserveBps is 0. */
  @Column({ name: 'payout_reserve_hold_days', type: 'int', default: 0 })
  payoutReserveHoldDays: number;

  /**
   * Onboarding/KYC review status — only meaningful for a `CONNECTED`
   * merchant. Defaults to `NOT_STARTED` for every merchant (existing
   * `PLATFORM` merchants are unaffected — nothing reads this field for
   * them). Gates *payouts* only, not charges — a `CONNECTED` merchant can
   * still receive split credits into its ledger balance before KYC
   * clears (`PayoutService.runSweep()` still creates a `Payout` for it,
   * just marked `kycBlocked`), the same `charges_enabled`/
   * `payouts_enabled` distinction real Stripe Connect draws. See
   * MerchantService.submitKyc() and
   * docs/business-domain/ledger-and-settlement.md#connected-account-kyc.
   * Deliberately a synchronous three-state model (no `PENDING` sitting
   * in the database for days) — a real KYC provider review is genuinely
   * async over days; this system's mock decision resolves immediately.
   */
  @Column({ name: 'kyc_status', type: 'varchar', default: 'NOT_STARTED' })
  kycStatus: 'NOT_STARTED' | 'VERIFIED' | 'REJECTED';

  /** Captured at KYC submission time — never shown back except in the merchant's own summary, same posture as any other identity field. */
  @Column({ name: 'kyc_legal_name', type: 'varchar', nullable: true })
  kycLegalName?: string | null;

  @Column({ name: 'kyc_tax_id', type: 'varchar', nullable: true })
  kycTaxId?: string | null;

  /**
   * PSPs this merchant is allowed to route charges through — see
   * SmartRoutingStrategy.filterAvailableProviders() and
   * PaymentCheckoutSaga.execute(). Defaults to every PSP this system
   * actually has an adapter for (`STRIPE`/`ADYEN` — see
   * PaymentProcessorFactory's constructor), so every existing merchant's
   * routing behavior is unchanged unless this is explicitly narrowed via
   * PATCH .../psp-entitlement. Deliberately `string[]`, not the payment
   * module's `PSPProvider` type — the merchant module has no reason to
   * depend on the payment module (payment already depends on merchant,
   * not the reverse; see MerchantModule's `exports`), so the known-value
   * set (`STRIPE`/`ADYEN`) is validated at the DTO layer
   * (UpdatePspEntitlementDto) instead of the entity/column.
   */
  @Column({ name: 'enabled_psp_providers', type: 'jsonb', default: '["STRIPE","ADYEN"]' })
  enabledPspProviders: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
