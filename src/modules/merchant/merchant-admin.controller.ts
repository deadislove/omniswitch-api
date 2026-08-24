import { Controller, Get, Post, Patch, Body, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { MerchantService } from './merchant.service';
import {
  CreateMerchantDto,
  UpdateMerchantStatusDto,
  UpdateFeeRateDto,
  UpdateFeeTiersDto,
  UpdateSettlementCurrencyDto,
  UpdateReservePolicyDto,
  UpdatePayoutReservePolicyDto,
  UpdateRiskTierAutoDto,
  UpdatePspEntitlementDto,
  SubmitKycDto,
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

function toSummary(merchant: MerchantEntity): MerchantSummaryDto {
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
    accountType: merchant.accountType,
    platformMerchantId: merchant.platformMerchantId ?? null,
    payoutReserveBps: merchant.payoutReserveBps,
    payoutReserveHoldDays: merchant.payoutReserveHoldDays,
    kycStatus: merchant.kycStatus,
    enabledPspProviders: merchant.enabledPspProviders,
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
  @ApiOperation({ summary: 'Rotate a merchant\'s API key secret — the old secret stops working immediately' })
  @ApiResponse({ status: 200, type: RotateApiKeyResponseDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async rotateApiKey(@Param('merchantId') merchantId: string): Promise<RotateApiKeyResponseDto> {
    const apiKeySecret = await this.merchantService.rotateApiKeySecret(merchantId);
    return { merchantId, apiKeySecret, warning: 'Store this now — it will not be shown again.' };
  }

  @Post(':merchantId/rotate-hmac-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a merchant\'s HMAC signing key — the old key stops working immediately' })
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
  async setStatus(@Param('merchantId') merchantId: string, @Body() dto: UpdateMerchantStatusDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setActive(merchantId, dto.isActive);
    return toSummary(merchant);
  }

  @Patch(':merchantId/fee-rate')
  @ApiOperation({ summary: 'Change a merchant\'s platform fee rate (basis points) — takes effect on the next charge/capture, does not retroactively change already-booked ledger entries' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateFeeRate(@Param('merchantId') merchantId: string, @Body() dto: UpdateFeeRateDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateFeeRate(merchantId, dto.platformFeeBps);
    return toSummary(merchant);
  }

  @Patch(':merchantId/fee-tiers')
  @ApiOperation({ summary: 'Set (or clear, with an empty array) a merchant\'s volume-based fee schedule — supersedes platformFeeBps once this merchant\'s trailing current-month SUCCEEDED charge volume reaches a tier. Takes effect on the next charge; does not retroactively change already-booked ledger entries.' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  @ApiResponse({ status: 422, description: 'Tiers are not strictly ascending by minVolumeMinorUnits, or contain an invalid threshold' })
  async updateFeeTiers(@Param('merchantId') merchantId: string, @Body() dto: UpdateFeeTiersDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateFeeTiers(merchantId, dto.tiers);
    return toSummary(merchant);
  }

  @Patch(':merchantId/settlement-currency')
  @ApiOperation({ summary: 'Change a merchant\'s settlement currency — omit/null to settle in whatever currency was charged. Takes effect on the next charge/capture, does not retroactively change already-booked ledger entries' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateSettlementCurrency(@Param('merchantId') merchantId: string, @Body() dto: UpdateSettlementCurrencyDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateSettlementCurrency(merchantId, dto.settlementCurrency ?? null);
    return toSummary(merchant);
  }

  @Patch(':merchantId/reserve-policy')
  @ApiOperation({ summary: 'Change a merchant\'s reserve rate/hold period — takes effect on the next charge/capture, does not retroactively change already-booked reserve holds' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateReservePolicy(@Param('merchantId') merchantId: string, @Body() dto: UpdateReservePolicyDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updateReservePolicy(merchantId, dto.reserveBps, dto.reserveHoldDays);
    return toSummary(merchant);
  }

  @Patch(':merchantId/payout-reserve-policy')
  @ApiOperation({ summary: 'Change a merchant\'s marketplace payout rolling-reserve rate/hold period — takes effect on the next payout sweep, does not retroactively change already-created payouts' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updatePayoutReservePolicy(@Param('merchantId') merchantId: string, @Body() dto: UpdatePayoutReservePolicyDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updatePayoutReservePolicy(merchantId, dto.payoutReserveBps, dto.payoutReserveHoldDays);
    return toSummary(merchant);
  }

  @Patch(':merchantId/risk-tier-auto')
  @ApiOperation({ summary: 'Enable/disable RiskTieringService\'s automatic reserve-policy management for this merchant — a manual reserve-policy change already disables it as a side effect' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async updateRiskTierAuto(@Param('merchantId') merchantId: string, @Body() dto: UpdateRiskTierAutoDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.setRiskTierAutoManaged(merchantId, dto.enabled);
    return toSummary(merchant);
  }

  @Patch(':merchantId/psp-entitlement')
  @ApiOperation({ summary: 'Set which PSPs this merchant\'s charges may route through — takes effect on the next charge. A charge that explicitly requests a preferredProvider outside this list is rejected (422), not silently routed elsewhere.' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  @ApiResponse({ status: 422, description: 'enabledPspProviders is empty' })
  async updatePspEntitlement(@Param('merchantId') merchantId: string, @Body() dto: UpdatePspEntitlementDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.updatePspEntitlement(merchantId, dto.enabledPspProviders);
    return toSummary(merchant);
  }

  @Post(':merchantId/kyc/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit (or re-submit) this merchant\'s KYC application — resolves synchronously against the (mock) KYC provider. Only meaningful for a CONNECTED merchant; gates payouts, not charges.' })
  @ApiResponse({ status: 200, type: MerchantSummaryDto })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async submitKyc(@Param('merchantId') merchantId: string, @Body() dto: SubmitKycDto): Promise<MerchantSummaryDto> {
    const merchant = await this.merchantService.submitKyc(merchantId, dto.legalName, dto.taxId);
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
