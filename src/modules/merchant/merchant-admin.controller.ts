import { Controller, Get, Post, Patch, Body, Param, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { MerchantService } from './merchant.service';
import {
  CreateMerchantDto,
  UpdateMerchantStatusDto,
  UpdateFeeRateDto,
  UpdateFeeTiersDto,
  UpdateSettlementCurrencyDto,
  UpdateDisputeNotificationChannelDto,
  UpdateSubscriptionNotificationChannelDto,
  UpdateAmlReviewNotificationChannelDto,
  UpdateMccCodeDto,
  UpdateReservePolicyDto,
  UpdatePayoutReservePolicyDto,
  UpdateRiskTierAutoDto,
  UpdatePspEntitlementDto,
  UpdateSanctionsReviewDto,
  UpdateSanctionsNotificationChannelDto,
  SubmitKycDto,
  SubmitKybDto,
  MerchantSummaryDto,
  MerchantCreatedResponseDto,
  RotateApiKeyResponseDto,
  RotateHmacSecretResponseDto,
  RevokeSessionsResponseDto,
} from './dto/create-merchant.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../shared/decorators/roles.decorator';
import { MerchantEntity } from './merchant.entity';

// Exported (not just used locally) so AmbiguousRiskAdminController — in
// PaymentModule, not this one, since it depends on
// AmbiguousRiskMonitoringService (PaymentRepositoryPort) and
// MerchantModule must never depend on PaymentModule (the reverse already
// holds; see architecture.md's module graph) — can reuse this exact
// mapping instead of carrying its own drift-prone copy. A plain function
// import across module boundaries doesn't create a NestJS DI cycle; only
// service injection via a module's `imports` array does.
export function toSummary(merchant: MerchantEntity): MerchantSummaryDto {
  // Never include apiKeySecretHash or hmacSecretCiphertext in list/read
  // responses — the plaintext HMAC secret only ever goes out once, at
  // creation/rotation time, and the ciphertext itself is never useful to a
  // caller (it's meaningless without the Vault key that encrypted it).
  return {
    merchantId: merchant.merchantId,
    name: merchant.name,
    apiKeyId: merchant.apiKeyId,
    roles: merchant.roles,
    isActive: merchant.isActive,
    platformFeeBps: merchant.platformFeeBps,
    feeTiers: merchant.feeTiers ?? undefined,
    settlementCurrency: merchant.settlementCurrency ?? null,
    reserveBps: merchant.reserveBps,
    reserveHoldDays: merchant.reserveHoldDays,
    riskTierAutoManaged: merchant.riskTierAutoManaged,
    mccCode: merchant.mccCode ?? null,
    industryRiskCategory: merchant.industryRiskCategory,
    accountType: merchant.accountType,
    platformMerchantId: merchant.platformMerchantId ?? null,
    payoutReserveBps: merchant.payoutReserveBps,
    payoutReserveHoldDays: merchant.payoutReserveHoldDays,
    kycStatus: merchant.kycStatus,
    kycApplicationId: merchant.kycApplicationId ?? null,
    kybStatus: merchant.kybStatus,
    kybApplicationId: merchant.kybApplicationId ?? null,
    enabledPspProviders: merchant.enabledPspProviders,
    ambiguousRiskFlagged: merchant.ambiguousRiskFlagged,
    ambiguousRiskFlaggedAt: merchant.ambiguousRiskFlaggedAt?.toISOString() ?? null,
    ambiguousRiskFlagReason: merchant.ambiguousRiskFlagReason ?? null,
    ambiguousRiskFlaggedBy: merchant.ambiguousRiskFlaggedBy ?? null,
    ambiguousRiskAutoManaged: merchant.ambiguousRiskAutoManaged,
    disputeNotificationChannel: merchant.disputeNotificationChannel,
    disputeNotificationTarget: merchant.disputeNotificationTarget ?? null,
    subscriptionNotificationChannel: merchant.subscriptionNotificationChannel,
    subscriptionNotificationTarget: merchant.subscriptionNotificationTarget ?? null,
    amlReviewFlagged: merchant.amlReviewFlagged,
    amlReviewFlaggedAt: merchant.amlReviewFlaggedAt?.toISOString() ?? null,
    amlReviewFlagReason: merchant.amlReviewFlagReason ?? null,
    amlReviewFlaggedBy: merchant.amlReviewFlaggedBy ?? null,
    amlReviewAutoManaged: merchant.amlReviewAutoManaged,
    amlReviewNotificationChannel: merchant.amlReviewNotificationChannel,
    amlReviewNotificationTarget: merchant.amlReviewNotificationTarget ?? null,
    legalName: merchant.legalName ?? null,
    taxId: merchant.taxId ?? null,
    sanctionsScreeningStatus: merchant.sanctionsScreeningStatus,
    sanctionsScreenedAt: merchant.sanctionsScreenedAt?.toISOString() ?? null,
    sanctionsMatchDetails: merchant.sanctionsMatchDetails ?? null,
    sanctionsReviewedBy: merchant.sanctionsReviewedBy ?? null,
    sanctionsReviewedAt: merchant.sanctionsReviewedAt?.toISOString() ?? null,
    sanctionsNotificationChannel: merchant.sanctionsNotificationChannel,
    sanctionsNotificationTarget: merchant.sanctionsNotificationTarget ?? null,
    createdAt: merchant.createdAt.toISOString(),
    updatedAt: merchant.updatedAt.toISOString(),
  };
}

/**
 * Merchant Admin Controller
 * ADMIN-only onboarding and credential management. Secrets (API key secret,
 * HMAC key) are only ever present in a response body at creation or
 * rotation time — every other endpoint here returns metadata only.
 */
@ApiTags('Admin — Merchants')
@ApiBearerAuth()
@Controller('admin/merchants')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class MerchantAdminController {
  constructor(private readonly merchantService: MerchantService) {}

  @Get()
  @ApiOperation({ summary: 'List merchants (no secrets)' })
  @ApiResponse({ status: 200, type: [MerchantSummaryDto] })
  async list(): Promise<MerchantSummaryDto[]> {
    const merchants = await this.merchantService.list();
    return merchants.map(toSummary);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Onboard a new merchant — returns the API key secret once' })
  @ApiResponse({ status: 201, type: MerchantCreatedResponseDto })
  @ApiResponse({ status: 409, description: 'A merchant with this merchantId already exists' })
  @ApiResponse({
    status: 422,
    description: 'SANCTIONS_SCREENING_HIT — sanctions/watchlist match; nothing was created',
  })
  async create(@Body() dto: CreateMerchantDto): Promise<MerchantCreatedResponseDto> {
    const { merchant, apiKeySecret, hmacSecret } = await this.merchantService.createMerchant(dto);
    return {
      ...toSummary(merchant),
      apiKeyId: merchant.apiKeyId,
      apiKeySecret,
      hmacSecret,
      warning: 'Store apiKeySecret and hmacSecret now — they will not be shown again.',
    };
  }

  @Post(':merchantId/rotate-api-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rotate a merchant's API key secret — the old secret stops working immediately" })
  @ApiResponse({ status: 200, type: RotateApiKeyResponseDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async rotateApiKey(@Param('merchantId') merchantId: string): Promise<RotateApiKeyResponseDto> {
    const apiKeySecret = await this.merchantService.rotateApiKeySecret(merchantId);
    return { merchantId, apiKeySecret, warning: 'Store this now — it will not be shown again.' };
  }

  @Post(':merchantId/rotate-hmac-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rotate a merchant's HMAC signing key — the old key stops working immediately" })
  @ApiResponse({ status: 200, type: RotateHmacSecretResponseDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async rotateHmacSecret(@Param('merchantId') merchantId: string): Promise<RotateHmacSecretResponseDto> {
    const hmacSecret = await this.merchantService.rotateHmacSecret(merchantId);
    return { merchantId, hmacSecret, warning: 'Store this now — it will not be shown again.' };
  }

  @Patch(':merchantId/status')
  @ApiOperation({ summary: 'Activate or deactivate a merchant (deactivating also revokes all active sessions)' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async setStatus(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateMerchantStatusDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setActive(merchantId, dto.isActive);
    return toSummary(merchant);
  }

  @Patch(':merchantId/fee-rate')
  @ApiOperation({
    summary:
      "Change a merchant's platform fee rate (basis points) — takes effect on the next charge/capture, does not retroactively change already-booked ledger entries",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateFeeRate(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateFeeRateDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateFeeRate(merchantId, dto.platformFeeBps);
    return toSummary(merchant);
  }

  @Patch(':merchantId/fee-tiers')
  @ApiOperation({
    summary:
      "Set (or clear, with an empty array) a merchant's volume-based fee schedule — supersedes platformFeeBps once this merchant's trailing current-month SUCCEEDED charge volume reaches a tier. Takes effect on the next charge; does not retroactively change already-booked ledger entries.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  @ApiResponse({
    status: 422,
    description: 'Tiers are not strictly ascending by minVolumeMinorUnits, or contain an invalid threshold',
  })
  async updateFeeTiers(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateFeeTiersDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateFeeTiers(merchantId, dto.tiers);
    return toSummary(merchant);
  }

  @Patch(':merchantId/settlement-currency')
  @ApiOperation({
    summary:
      "Change a merchant's settlement currency — omit/null to settle in whatever currency was charged. Takes effect on the next charge/capture, does not retroactively change already-booked ledger entries",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateSettlementCurrency(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateSettlementCurrencyDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateSettlementCurrency(merchantId, dto.settlementCurrency ?? null);
    return toSummary(merchant);
  }

  @Patch(':merchantId/dispute-notification-channel')
  @ApiOperation({
    summary:
      "Change which channel this merchant's dispute.created/dispute.resolved notifications go out on (EMAIL/SLACK/WEBHOOK), and the channel-specific destination. Omit/null target clears it — the merchant then receives no dispute notifications at all.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateDisputeNotificationChannel(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateDisputeNotificationChannelDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateDisputeNotificationChannel(
      merchantId,
      dto.channel,
      dto.target ?? null,
    );
    return toSummary(merchant);
  }

  @Patch(':merchantId/subscription-notification-channel')
  @ApiOperation({
    summary:
      "Change which channel this merchant's subscription.past_due/subscription.canceled notifications go out on (EMAIL/SLACK/WEBHOOK), and the channel-specific destination. Independent of dispute-notification-channel. Omit/null target clears it — the merchant then receives no subscription notifications at all.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateSubscriptionNotificationChannel(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateSubscriptionNotificationChannelDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateSubscriptionNotificationChannel(
      merchantId,
      dto.channel,
      dto.target ?? null,
    );
    return toSummary(merchant);
  }

  @Patch(':merchantId/aml-review-notification-channel')
  @ApiOperation({
    summary:
      "Change which channel this merchant's aml_review.flagged notification goes out on (EMAIL/SLACK/WEBHOOK), and the channel-specific destination. Independent of dispute-notification-channel/subscription-notification-channel. Omit/null target clears it — the merchant then receives no AML-review notification even if flagged.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateAmlReviewNotificationChannel(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateAmlReviewNotificationChannelDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateAmlReviewNotificationChannel(
      merchantId,
      dto.channel,
      dto.target ?? null,
    );
    return toSummary(merchant);
  }

  @Patch(':merchantId/mcc-code')
  @ApiOperation({
    summary:
      "Set this merchant's Merchant Category Code — derives industryRiskCategory via a static risk lookup table, which RiskTieringService factors into its tier escalation. Omit/null clears it back to UNKNOWN.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateMccCode(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateMccCodeDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateMccCode(merchantId, dto.mccCode ?? null);
    return toSummary(merchant);
  }

  @Patch(':merchantId/reserve-policy')
  @ApiOperation({
    summary:
      "Change a merchant's reserve rate/hold period — takes effect on the next charge/capture, does not retroactively change already-booked reserve holds",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateReservePolicy(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateReservePolicyDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateReservePolicy(merchantId, dto.reserveBps, dto.reserveHoldDays);
    return toSummary(merchant);
  }

  @Patch(':merchantId/payout-reserve-policy')
  @ApiOperation({
    summary:
      "Change a merchant's marketplace payout rolling-reserve rate/hold period — takes effect on the next payout sweep, does not retroactively change already-created payouts",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updatePayoutReservePolicy(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdatePayoutReservePolicyDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updatePayoutReservePolicy(
      merchantId,
      dto.payoutReserveBps,
      dto.payoutReserveHoldDays,
    );
    return toSummary(merchant);
  }

  @Patch(':merchantId/risk-tier-auto')
  @ApiOperation({
    summary:
      "Enable/disable RiskTieringService's automatic reserve-policy management for this merchant — a manual reserve-policy change already disables it as a side effect",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateRiskTierAuto(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateRiskTierAutoDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setRiskTierAutoManaged(merchantId, dto.enabled);
    return toSummary(merchant);
  }

  @Patch(':merchantId/psp-entitlement')
  @ApiOperation({
    summary:
      "Set which PSPs this merchant's charges may route through — takes effect on the next charge. A charge that explicitly requests a preferredProvider outside this list is rejected (422), not silently routed elsewhere.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  @ApiResponse({ status: 422, description: 'enabledPspProviders is empty' })
  async updatePspEntitlement(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdatePspEntitlementDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updatePspEntitlement(merchantId, dto.enabledPspProviders);
    return toSummary(merchant);
  }

  @Post(':merchantId/kyc/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Submit (or re-submit) this merchant's KYC application — resolves synchronously against the mock provider (KYC_PROVIDER=mock, the default), or returns PENDING_REVIEW against a real one (KYC_PROVIDER=persona), with the final decision arriving later via POST /webhooks/kyc. Only meaningful for a CONNECTED merchant; gates payouts, not charges.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  @ApiResponse({
    status: 422,
    description:
      'SANCTIONS_SCREENING_HIT — sanctions/watchlist match against the submitted legalName; kycStatus is left unchanged',
  })
  async submitKyc(@Param('merchantId') merchantId: string, @Body() dto: SubmitKycDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.submitKyc(merchantId, dto.legalName, dto.taxId);
    return toSummary(merchant);
  }

  @Post(':merchantId/kyb/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Submit (or re-submit) this merchant's KYB (Know Your Business) application — verifies the business itself and its beneficial owners, independent of kycStatus (which only verifies an individual). Resolves synchronously against the mock provider (KYB_PROVIDER=mock, the default), or returns PENDING_REVIEW against a real one (KYB_PROVIDER=persona), with the final decision arriving later via POST /webhooks/kyb. Only meaningful for a CONNECTED merchant. Not currently wired into any payout gate.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  @ApiResponse({
    status: 422,
    description:
      'SANCTIONS_SCREENING_HIT — sanctions/watchlist match against the submitted legalName; kybStatus is left unchanged',
  })
  async submitKyb(@Param('merchantId') merchantId: string, @Body() dto: SubmitKybDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.submitKyb(
      merchantId,
      dto.legalName,
      dto.taxId,
      dto.country,
      dto.beneficialOwners,
    );
    return toSummary(merchant);
  }

  @Post(':merchantId/sanctions/rescreen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Re-screen this merchant's sanctions/watchlist status on demand, against its currently-stored legalName/taxId (or name, if no legalName was ever supplied) — the same check onboarding/KYC-submit run, without waiting for the weekly sweep.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async rescreenSanctions(@Param('merchantId') merchantId: string): Promise<MerchantSummaryDto> {
    const { merchant } = await this.merchantService.rescreenSanctions(merchantId);
    return toSummary(merchant);
  }

  @Patch(':merchantId/sanctions-review')
  @ApiOperation({
    summary:
      'Records a human determination on a POTENTIAL_MATCH/HIT — CLEARED resets sanctionsScreeningStatus back to CLEAR (false positive); CONFIRMED leaves it exactly as it was. Does not disable future automatic re-screening.',
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  @ApiResponse({ status: 422, description: 'reason is missing/empty' })
  async updateSanctionsReview(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateSanctionsReviewDto,
    @Req() req: any,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.applySanctionsReview(
      merchantId,
      dto.resolution,
      dto.reason,
      req.user.merchantId,
    );
    return toSummary(merchant);
  }

  @Patch(':merchantId/sanctions-notification-channel')
  @ApiOperation({
    summary:
      "Changes which channel (EMAIL/SLACK/WEBHOOK) and destination this merchant's sanctions-screening notifications go out on — independent of every other *-notification-channel setting.",
  })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateSanctionsNotificationChannel(
    @Param('merchantId') merchantId: string,
    @Body() dto: UpdateSanctionsNotificationChannelDto,
  ): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateSanctionsNotificationChannel(
      merchantId,
      dto.channel,
      dto.target ?? null,
    );
    return toSummary(merchant);
  }

  @Post(':merchantId/revoke-sessions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Immediately invalidate every access token currently issued to this merchant' })
  @ApiResponse({ status: 200, type: RevokeSessionsResponseDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async revokeSessions(@Param('merchantId') merchantId: string): Promise<RevokeSessionsResponseDto> {
    await this.merchantService.revokeAllSessions(merchantId);
    return { merchantId, revoked: true };
  }
}
