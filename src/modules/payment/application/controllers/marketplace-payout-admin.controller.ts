import { Controller, Get, Post, Param, Query, UseGuards, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PayoutService } from '../services/payout.service';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { Payout, PayoutReserveStatus, PayoutTransferStatus } from '../../domain/aggregates/payout.aggregate';
import { PayoutSweepRun } from '../../domain/aggregates/payout-sweep-run.aggregate';

class ListPayoutsQuery {
  @ApiPropertyOptional({ example: 'merchant_connected_seller' })
  @IsOptional()
  @IsString()
  merchantId?: string;
}

class PayoutSummaryDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'merchant_connected_seller' })
  merchantId: string;

  @ApiProperty({ example: 'a1b2c3d4-...', description: 'The PayoutSweepRun that produced this payout' })
  sweepRunId: string;

  @ApiProperty({ example: 68.5, description: 'Total net MERCHANT-ledger credit swept in this payout, before the rolling reserve' })
  grossAmount: number;

  @ApiProperty({ example: 6.85, description: 'Rolling reserve withheld from grossAmount — 0 if the merchant has no payoutReserveBps configured' })
  reserveAmount: number;

  @ApiProperty({ example: 61.65, description: 'grossAmount - reserveAmount — immediately disbursable' })
  netAmount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ enum: ['NONE', 'HELD', 'RELEASED'], description: 'NONE: reserveAmount is 0. HELD: withheld, not yet eligible or not yet released. RELEASED: credited back.' })
  reserveStatus: PayoutReserveStatus;

  @ApiPropertyOptional({ description: 'When the reserve becomes eligible for release — absent if reserveStatus is NONE' })
  releaseEligibleAt?: string;

  @ApiPropertyOptional()
  reserveReleasedAt?: string;

  @ApiProperty({ description: 'Whether this payout is withheld pending the recipient\'s KYC review — see MerchantEntity.kycStatus. Blocks transfer initiation, independent of reserveStatus.' })
  kycBlocked: boolean;

  @ApiPropertyOptional()
  kycClearedAt?: string;

  @ApiProperty({ enum: ['NOT_INITIATED', 'INITIATED', 'FAILED'], description: 'Whether netAmount has actually been sent to the merchant\'s bank — see BankTransferPort. Never covers a later-released reserve.' })
  transferStatus: PayoutTransferStatus;

  @ApiPropertyOptional()
  transferId?: string;

  @ApiPropertyOptional()
  transferInitiatedAt?: string;

  @ApiPropertyOptional()
  transferError?: string;

  @ApiProperty()
  createdAt: string;
}

class PayoutSweepRunResultDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty()
  windowStart: string;

  @ApiProperty()
  windowEnd: string;

  @ApiProperty({ example: 2, description: 'Distinct CONNECTED merchants paid out in this sweep' })
  connectedMerchantsPaid: number;
}

class ReserveReleaseSweepResultDto {
  @ApiProperty({ example: 3, description: 'Payout reserves successfully released by this sweep' })
  released: number;

  @ApiProperty({ example: 0, description: 'Eligible reserves that failed to release (logged individually; the sweep does not abort on one failure)' })
  failed: number;
}

class KycRecheckResultDto {
  @ApiProperty({ example: 2, description: 'Previously KYC-blocked payouts cleared because the recipient is now VERIFIED' })
  cleared: number;
}

class TransferSweepResultDto {
  @ApiProperty({ example: 3, description: 'Transfers successfully initiated by this sweep' })
  initiated: number;

  @ApiProperty({ example: 0, description: 'Eligible transfers that were declined (logged individually; the sweep does not abort on one failure)' })
  failed: number;
}

function toSummary(payout: Payout): PayoutSummaryDto {
  return {
    id: payout.id,
    merchantId: payout.merchantId,
    sweepRunId: payout.sweepRunId,
    grossAmount: payout.grossAmount.amount,
    reserveAmount: payout.reserveAmount.amount,
    netAmount: payout.netAmount.amount,
    currency: payout.grossAmount.currency.code,
    reserveStatus: payout.reserveStatus,
    releaseEligibleAt: payout.releaseEligibleAt?.toISOString(),
    reserveReleasedAt: payout.reserveReleasedAt?.toISOString(),
    kycBlocked: payout.kycBlocked,
    kycClearedAt: payout.kycClearedAt?.toISOString(),
    transferStatus: payout.transferStatus,
    transferId: payout.transferId,
    transferInitiatedAt: payout.transferInitiatedAt?.toISOString(),
    transferError: payout.transferError,
    createdAt: payout.createdAt.toISOString(),
  };
}

function toSweepRunResult(run: PayoutSweepRun): PayoutSweepRunResultDto {
  return {
    id: run.id,
    windowStart: run.windowStart.toISOString(),
    windowEnd: run.windowEnd.toISOString(),
    connectedMerchantsPaid: run.connectedMerchantsPaid,
  };
}

/**
 * Marketplace Payout Admin Controller
 * Operator-facing view into PayoutService — see that service's docblock
 * and the Payout aggregate's docblock for the sweep/reserve-release split
 * (same dual on-demand + scheduled shape as ReconciliationService/
 * ReserveService), and MerchantEntity's payoutReserveBps/
 * payoutReserveHoldDays fields (set via PATCH
 * /admin/merchants/:id/payout-reserve-policy) for how a payout's rolling
 * reserve is configured.
 */
@ApiTags('Admin — Marketplace Payouts')
@ApiBearerAuth()
@Controller('admin/marketplace')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class MarketplacePayoutAdminController {
  constructor(private readonly payoutService: PayoutService) {}

  @Get('payouts')
  @ApiOperation({ summary: 'List payouts, optionally filtered by (connected) merchant' })
  @ApiResponse({ status: 200, type: [PayoutSummaryDto] })
  async list(@Query() query: ListPayoutsQuery): Promise<PayoutSummaryDto[]> {
    const payouts = await this.payoutService.findMany({ merchantId: query.merchantId });
    return payouts.map(toSummary);
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: 'Get a single payout by id' })
  @ApiResponse({ status: 200, type: PayoutSummaryDto })
  @ApiResponse({ status: 404, description: 'Payout not found' })
  async getById(@Param('id') id: string): Promise<PayoutSummaryDto> {
    const payout = await this.payoutService.findById(id);
    if (!payout) {
      throw new NotFoundException({ statusCode: 404, error: `Payout ${id} not found`, code: 'PAYOUT_NOT_FOUND' });
    }
    return toSummary(payout);
  }

  @Post('run-payouts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the payout sweep now instead of waiting for the daily schedule — batches every CONNECTED merchant\'s unswept MERCHANT-ledger balance into a Payout, withholding each merchant\'s configured rolling reserve' })
  @ApiResponse({ status: 200, type: PayoutSweepRunResultDto })
  async runPayouts(): Promise<PayoutSweepRunResultDto> {
    const run = await this.payoutService.runSweep();
    return toSweepRunResult(run);
  }

  @Post('payouts/:id/release-reserve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually release a payout\'s rolling reserve — bypasses releaseEligibleAt (an operator override)' })
  @ApiResponse({ status: 200, type: PayoutSummaryDto })
  @ApiResponse({ status: 404, description: 'Payout not found' })
  @ApiResponse({ status: 409, description: 'Payout has no reserve, or it is already released' })
  async releaseReserve(@Param('id') id: string): Promise<PayoutSummaryDto> {
    const payout = await this.payoutService.releaseReserve(id, { force: true });
    return toSummary(payout);
  }

  @Post('release-eligible-reserves')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the reserve-release sweep now instead of waiting for the daily schedule — releases every payout reserve whose releaseEligibleAt has passed' })
  @ApiResponse({ status: 200, type: ReserveReleaseSweepResultDto })
  async releaseEligibleReserves(): Promise<ReserveReleaseSweepResultDto> {
    return this.payoutService.releaseEligibleReserves();
  }

  @Post('recheck-kyc-blocks')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the KYC-recheck sweep now instead of waiting for the daily schedule — clears every KYC-blocked payout whose recipient is now VERIFIED' })
  @ApiResponse({ status: 200, type: KycRecheckResultDto })
  async recheckKycBlocks(): Promise<KycRecheckResultDto> {
    return this.payoutService.recheckKycBlocks();
  }

  @Post('payouts/:id/initiate-transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate a (mock) bank transfer for this payout\'s netAmount — see BankTransferPort' })
  @ApiResponse({ status: 200, type: PayoutSummaryDto })
  @ApiResponse({ status: 404, description: 'Payout not found' })
  @ApiResponse({ status: 409, description: 'Payout is KYC-blocked, has no net amount, or its transfer is already initiated' })
  @ApiResponse({ status: 422, description: 'The bank declined the transfer' })
  async initiateTransfer(@Param('id') id: string): Promise<PayoutSummaryDto> {
    const payout = await this.payoutService.initiateTransfer(id);
    return toSummary(payout);
  }

  @Post('initiate-eligible-transfers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the transfer-initiation sweep now instead of waiting for the daily schedule — initiates a transfer for every eligible payout (not KYC-blocked, has a net amount, not already initiated)' })
  @ApiResponse({ status: 200, type: TransferSweepResultDto })
  async initiateEligibleTransfers(): Promise<TransferSweepResultDto> {
    return this.payoutService.initiateEligibleTransfers();
  }
}
