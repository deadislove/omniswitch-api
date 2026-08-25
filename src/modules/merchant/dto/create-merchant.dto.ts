import { IsString, MinLength, MaxLength, Matches, IsArray, ArrayNotEmpty, ArrayMaxSize, IsIn, IsBoolean, IsInt, IsOptional, IsNumberString, ValidateNested, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const VALID_ROLES = ['ADMIN', 'MERCHANT', 'OPERATOR', 'READONLY'];
// Matches PaymentProcessorFactory's actual registered adapters (payment
// module's PSPProvider type also allows 'PAYPAL'/'CHASE', but no adapter
// exists for either yet — entitling a merchant to a PSP this system can't
// actually route to would just be a confusing no-op).
const VALID_PSP_PROVIDERS = ['STRIPE', 'ADYEN'];

export class CreateMerchantDto {
  @ApiProperty({ example: 'merchant_acme_corp', description: 'Business-facing merchant identifier' })
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'merchantId may only contain letters, numbers, underscores and hyphens' })
  merchantId: string;

  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: ['MERCHANT'], enum: VALID_ROLES, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(VALID_ROLES, { each: true })
  roles: string[];

  @ApiPropertyOptional({
    example: 150,
    description: 'Platform fee rate in basis points (150 = 1.5%). Omit to use the default (150).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  platformFeeBps?: number;

  @ApiPropertyOptional({
    example: 'EUR',
    description: 'Currency to pay this merchant out in, if different from whatever currency a charge was made in. Omit to settle in whatever currency was charged (the default).',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  settlementCurrency?: string;

  @ApiPropertyOptional({
    example: 1000,
    description: 'Reserve rate in basis points of each charge\'s net amount (1000 = 10%) withheld into a per-merchant reserve instead of paid out immediately. Omit for no reserve (the default).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  reserveBps?: number;

  @ApiPropertyOptional({
    example: 90,
    description: 'Days a reserve hold sits before it becomes releasable. Ignored if reserveBps is 0/omitted.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  reserveHoldDays?: number;

  @ApiPropertyOptional({
    example: 'PLATFORM',
    enum: ['PLATFORM', 'CONNECTED'],
    description: 'Marketplace role. Omit for the default, PLATFORM (a flat peer, unchanged from before this existed). CONNECTED requires platformMerchantId.',
  })
  @IsOptional()
  @IsIn(['PLATFORM', 'CONNECTED'])
  accountType?: 'PLATFORM' | 'CONNECTED';

  @ApiPropertyOptional({
    example: 'merchant_acme_platform',
    description: 'Required, and only allowed, when accountType is CONNECTED — the parent platform merchant this account is onboarded under.',
  })
  @IsOptional()
  @IsString()
  platformMerchantId?: string;

  @ApiPropertyOptional({
    example: 1000,
    description:
      'Rolling reserve in basis points (1000 = 10%) withheld from this merchant\'s share of each marketplace payout sweep. Only meaningful for a CONNECTED merchant. Omit for no rolling reserve (the default).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  payoutReserveBps?: number;

  @ApiPropertyOptional({
    example: 90,
    description: 'Days a payout\'s withheld rolling reserve sits before it becomes releasable. Ignored if payoutReserveBps is 0/omitted.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  payoutReserveHoldDays?: number;

  @ApiPropertyOptional({
    example: ['STRIPE', 'ADYEN'],
    enum: VALID_PSP_PROVIDERS,
    isArray: true,
    description: 'PSPs this merchant\'s charges may route through. Omit for the default: every PSP this system has an adapter for (currently STRIPE and ADYEN).',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(VALID_PSP_PROVIDERS, { each: true })
  enabledPspProviders?: string[];
}

export class UpdateMerchantStatusDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  isActive: boolean;
}

export class UpdateFeeRateDto {
  @ApiProperty({ example: 125, description: 'New platform fee rate in basis points (125 = 1.25%)' })
  @IsInt()
  @Min(0)
  @Max(10_000)
  platformFeeBps: number;
}

export class FeeTierDto {
  @ApiProperty({ example: '10000000', description: 'This tier applies once the merchant\'s trailing current-calendar-month SUCCEEDED charge volume (in minor units, same currency as the charge being priced) reaches this amount' })
  @IsNumberString()
  minVolumeMinorUnits: string;

  @ApiProperty({ example: 100, description: 'Platform fee rate for this tier, in basis points' })
  @IsInt()
  @Min(0)
  @Max(10_000)
  bps: number;
}

export class UpdateFeeTiersDto {
  @ApiProperty({
    type: [FeeTierDto],
    description: 'Volume-based fee schedule, sorted ascending by minVolumeMinorUnits (strictly increasing, no duplicates) — supersedes platformFeeBps once a threshold is reached. Send an empty array to clear it and fall back to the flat platformFeeBps rate for every charge.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => FeeTierDto)
  tiers: FeeTierDto[];
}

export class UpdateSettlementCurrencyDto {
  @ApiPropertyOptional({
    example: 'EUR',
    description: 'New settlement currency. Omit or send null to go back to settling in whatever currency was charged.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  settlementCurrency?: string | null;
}

export class UpdateReservePolicyDto {
  @ApiProperty({ example: 1000, description: 'Reserve rate in basis points of each charge\'s net amount (1000 = 10%). 0 disables the reserve.' })
  @IsInt()
  @Min(0)
  @Max(10_000)
  reserveBps: number;

  @ApiProperty({ example: 90, description: 'Days a reserve hold sits before it becomes releasable. Ignored if reserveBps is 0.' })
  @IsInt()
  @Min(0)
  @Max(3650)
  reserveHoldDays: number;
}

export class UpdatePayoutReservePolicyDto {
  @ApiProperty({ example: 1000, description: 'Rolling reserve in basis points withheld from each marketplace payout sweep (1000 = 10%). 0 disables it.' })
  @IsInt()
  @Min(0)
  @Max(10_000)
  payoutReserveBps: number;

  @ApiProperty({ example: 90, description: 'Days a payout\'s withheld rolling reserve sits before it becomes releasable. Ignored if payoutReserveBps is 0.' })
  @IsInt()
  @Min(0)
  @Max(3650)
  payoutReserveHoldDays: number;
}

export class UpdatePspEntitlementDto {
  @ApiProperty({
    example: ['STRIPE', 'ADYEN'],
    enum: VALID_PSP_PROVIDERS,
    isArray: true,
    description: 'PSPs this merchant\'s charges may route through. Must be non-empty. Omitting a PSP here does not affect its liveness for other merchants — this is a per-merchant allowlist, not a global kill switch (use the routing health endpoint / circuit breaker for that).',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(VALID_PSP_PROVIDERS, { each: true })
  enabledPspProviders: string[];
}

export class UpdateRiskTierAutoDto {
  @ApiProperty({ example: true, description: 'true: RiskTieringService\'s daily sweep may adjust this merchant\'s reserve policy automatically. false: leave it exactly as set (an operator\'s manual reserve-policy change already sets this to false as a side effect).' })
  @IsBoolean()
  enabled: boolean;
}

export class UpdateAmbiguousRiskFlagDto {
  @ApiProperty({ example: true, description: 'true to flag this merchant for observation, false to clear the flag.' })
  @IsBoolean()
  flagged: boolean;

  @ApiProperty({
    example: 'Manually flagging after 3 customer complaints about failed charges this week',
    description: 'Required — always needs a stated justification, same posture as AmbiguousPaymentService\'s manual resolution audit trail. Setting this also disables ambiguousRiskAutoManaged: a manual action sticks until explicitly re-enabled via PATCH .../ambiguous-risk-auto.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}

export class UpdateAmbiguousRiskAutoDto {
  @ApiProperty({ example: true, description: 'true: AmbiguousRiskMonitoringService\'s automated flag/auto-clear logic may manage this merchant again. false: leave it exactly as set (a manual flag/clear already sets this to false as a side effect).' })
  @IsBoolean()
  enabled: boolean;
}

export class SubmitKycDto {
  @ApiProperty({ example: 'Acme Marketplace Sellers LLC', description: 'Registered business/legal name' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  legalName: string;

  @ApiProperty({ example: '12-3456789', description: 'Tax identification number (EIN, VAT number, etc.) — not validated against any real registry by this mock' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  taxId: string;
}

export class MerchantSummaryDto {
  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: 'Acme Corp' })
  name: string;

  @ApiProperty({ example: 'ak_1a2b3c4d5e6f...' })
  apiKeyId: string;

  @ApiProperty({ example: ['MERCHANT'], enum: VALID_ROLES, isArray: true })
  roles: string[];

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ example: 150, description: 'Basis points — 150 = 1.5%. The rate actually used for any given charge may be lower if feeTiers is set and this merchant\'s trailing monthly volume has reached a tier.' })
  platformFeeBps: number;

  @ApiPropertyOptional({ type: [FeeTierDto], description: 'Volume-based fee schedule, if configured — absent/empty means every charge uses the flat platformFeeBps rate' })
  feeTiers?: FeeTierDto[];

  @ApiProperty({ example: 'EUR', nullable: true, description: 'null means "settle in whatever currency was charged"' })
  settlementCurrency: string | null;

  @ApiProperty({ example: 1000, description: 'Basis points of net amount withheld per charge into a reserve — 0 means no reserve' })
  reserveBps: number;

  @ApiProperty({ example: 90, description: 'Days a reserve hold sits before it becomes releasable' })
  reserveHoldDays: number;

  @ApiProperty({ example: true, description: 'Whether RiskTieringService\'s daily sweep may adjust reserveBps/reserveHoldDays automatically for this merchant' })
  riskTierAutoManaged: boolean;

  @ApiProperty({ example: 'PLATFORM', enum: ['PLATFORM', 'CONNECTED'] })
  accountType: 'PLATFORM' | 'CONNECTED';

  @ApiProperty({ example: null, nullable: true, description: 'The parent platform merchant\'s merchantId — only set when accountType is CONNECTED' })
  platformMerchantId: string | null;

  @ApiProperty({ example: 1000, description: 'Basis points withheld from each marketplace payout sweep as a rolling reserve — 0 means none. Only meaningful for a CONNECTED merchant' })
  payoutReserveBps: number;

  @ApiProperty({ example: 90, description: 'Days a payout\'s withheld rolling reserve sits before it becomes releasable' })
  payoutReserveHoldDays: number;

  @ApiProperty({ example: 'NOT_STARTED', enum: ['NOT_STARTED', 'VERIFIED', 'REJECTED'], description: 'Onboarding/KYC review status — only meaningful for a CONNECTED merchant, gates payouts (not charges)' })
  kycStatus: 'NOT_STARTED' | 'VERIFIED' | 'REJECTED';

  @ApiProperty({ example: ['STRIPE', 'ADYEN'], enum: VALID_PSP_PROVIDERS, isArray: true, description: 'PSPs this merchant\'s charges may route through' })
  enabledPspProviders: string[];

  @ApiProperty({ example: false, description: 'Passive risk-observation flag — set when this merchant\'s AMBIGUOUS payment incidents cross a volume or streak threshold. Does not affect how charges are processed; visibility only.' })
  ambiguousRiskFlagged: boolean;

  @ApiProperty({ example: null, nullable: true })
  ambiguousRiskFlaggedAt: string | null;

  @ApiProperty({ example: null, nullable: true, description: 'Why this merchant is flagged — automated summary or an operator\'s own stated reason' })
  ambiguousRiskFlagReason: string | null;

  @ApiProperty({ example: null, nullable: true, description: 'merchantId of the ADMIN/OPERATOR who manually flagged/cleared this merchant — null when the current state was set automatically' })
  ambiguousRiskFlaggedBy: string | null;

  @ApiProperty({ example: true, description: 'Whether AmbiguousRiskMonitoringService\'s automated flag/auto-clear logic may manage this merchant\'s ambiguousRiskFlagged' })
  ambiguousRiskAutoManaged: boolean;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}

export class MerchantCreatedResponseDto extends MerchantSummaryDto {
  @ApiProperty({ example: 'sk_1a2b3c4d5e6f...', description: 'Shown once — store it now' })
  apiKeySecret: string;

  @ApiProperty({ example: 'a1b2c3d4e5f6...', description: 'Shown once — store it now' })
  hmacSecret: string;

  @ApiProperty({ example: 'Store apiKeySecret and hmacSecret now — they will not be shown again.' })
  warning: string;
}

export class RotateApiKeyResponseDto {
  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: 'sk_1a2b3c4d5e6f...', description: 'Shown once — store it now' })
  apiKeySecret: string;

  @ApiProperty({ example: 'Store this now — it will not be shown again.' })
  warning: string;
}

export class RotateHmacSecretResponseDto {
  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: 'a1b2c3d4e5f6...', description: 'Shown once — store it now' })
  hmacSecret: string;

  @ApiProperty({ example: 'Store this now — it will not be shown again.' })
  warning: string;
}

export class RevokeSessionsResponseDto {
  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: true })
  revoked: boolean;
}
