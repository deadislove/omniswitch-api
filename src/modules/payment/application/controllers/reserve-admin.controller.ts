import { Controller, Get, Post, Param, Query, UseGuards, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsIn, IsString } from 'class-validator';
import { ReserveService } from '../services/reserve.service';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { ReserveHold, ReserveHoldStatus } from '../../domain/aggregates/reserve-hold.aggregate';

const RESERVE_HOLD_STATUSES: ReserveHoldStatus[] = ['HELD', 'RELEASED'];

class ListReserveHoldsQuery {
  @ApiPropertyOptional({ example: 'merchant_acme_corp' })
  @IsOptional()
  @IsString()
  merchantId?: string;

  @ApiPropertyOptional({ enum: RESERVE_HOLD_STATUSES })
  @IsOptional()
  @IsIn(RESERVE_HOLD_STATUSES)
  status?: ReserveHoldStatus;
}

class ReserveHoldSummaryDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: 9.85 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ enum: RESERVE_HOLD_STATUSES })
  status: ReserveHoldStatus;

  @ApiProperty({ description: 'When this hold becomes eligible for release (the scheduled sweep or a manual, non-forced release both honor this)' })
  releaseEligibleAt: string;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional()
  releasedAt?: string;
}

class ReleaseSweepResultDto {
  @ApiProperty({ example: 3, description: 'Holds successfully released by this sweep' })
  released: number;

  @ApiProperty({ example: 0, description: 'Eligible holds that failed to release (logged individually; the sweep does not abort on one failure)' })
  failed: number;
}

function toSummary(hold: ReserveHold): ReserveHoldSummaryDto {
  return {
    id: hold.id,
    paymentId: hold.paymentId,
    merchantId: hold.merchantId,
    amount: hold.amount.amount,
    currency: hold.amount.currency.code,
    status: hold.status,
    releaseEligibleAt: hold.releaseEligibleAt.toISOString(),
    createdAt: hold.createdAt.toISOString(),
    releasedAt: hold.releasedAt?.toISOString(),
  };
}

/**
 * Reserve Admin Controller
 * Operator-facing view into ReserveService — see that service's docblock
 * for the release-sweep/manual-override split, and MerchantEntity's
 * reserveBps/reserveHoldDays fields (set via PATCH
 * /admin/merchants/:id/reserve-policy) for how a hold's size and hold
 * period are configured in the first place.
 */
@ApiTags('Admin — Reserves')
@ApiBearerAuth()
@Controller('admin/reserves')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class ReserveAdminController {
  constructor(private readonly reserveService: ReserveService) {}

  @Get()
  @ApiOperation({ summary: 'List reserve holds, optionally filtered by merchant and/or status' })
  @ApiResponse({ status: 200, type: [ReserveHoldSummaryDto] })
  async list(@Query() query: ListReserveHoldsQuery): Promise<ReserveHoldSummaryDto[]> {
    const holds = await this.reserveService.findMany({ merchantId: query.merchantId, status: query.status });
    return holds.map(toSummary);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single reserve hold by id' })
  @ApiResponse({ status: 200, type: ReserveHoldSummaryDto })
  @ApiResponse({ status: 404, description: 'Reserve hold not found' })
  async getById(@Param('id') id: string): Promise<ReserveHoldSummaryDto> {
    const hold = await this.reserveService.findById(id);
    if (!hold) {
      throw new NotFoundException({ statusCode: 404, error: `Reserve hold ${id} not found`, code: 'RESERVE_HOLD_NOT_FOUND' });
    }
    return toSummary(hold);
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually release a hold — bypasses releaseEligibleAt (an operator override, e.g. a merchant that has since proven low-risk)' })
  @ApiResponse({ status: 200, type: ReserveHoldSummaryDto })
  @ApiResponse({ status: 404, description: 'Reserve hold not found' })
  @ApiResponse({ status: 409, description: 'Reserve hold is already RELEASED' })
  async release(@Param('id') id: string): Promise<ReserveHoldSummaryDto> {
    const hold = await this.reserveService.release(id, { force: true });
    return toSummary(hold);
  }

  @Post('release-eligible')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the release sweep now instead of waiting for the daily schedule — releases every HELD hold whose releaseEligibleAt has passed' })
  @ApiResponse({ status: 200, type: ReleaseSweepResultDto })
  async releaseEligible(): Promise<ReleaseSweepResultDto> {
    return this.reserveService.releaseEligible();
  }
}
