import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, IsISO8601, IsNumberString, IsOptional } from 'class-validator';
import { PspCostReconciliationService, PspCostReconciliationReport } from '../services/psp-cost-reconciliation.service';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';

const RECONCILED_PROVIDERS: PSPProvider[] = ['STRIPE', 'ADYEN'];

class RunPspCostReconciliationDto {
  @ApiProperty({ enum: RECONCILED_PROVIDERS })
  @IsIn(RECONCILED_PROVIDERS)
  provider: PSPProvider;

  @ApiProperty({ example: 'USD', description: 'Only charges settled in this currency are counted' })
  @IsString()
  currency: string;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  @IsISO8601()
  since: string;

  @ApiProperty({ example: '2026-02-01T00:00:00.000Z' })
  @IsISO8601()
  until: string;

  @ApiPropertyOptional({
    example: '125000',
    description:
      'Overrides the PSP statement figure this endpoint fetches automatically ' +
      '(PSPAdapterPort.fetchFeeStatement()) with a number read by hand off a real PSP invoice/statement ' +
      'instead — e.g. reconciling against a downloaded CSV. Omit to use the fetched figure (the normal case).',
  })
  @IsOptional()
  @IsNumberString()
  actualInvoicedFeeMinorUnits?: string;
}

class PspCostReconciliationReportDto {
  @ApiProperty({ enum: RECONCILED_PROVIDERS })
  provider: PSPProvider;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty()
  since: string;

  @ApiProperty()
  until: string;

  @ApiProperty({ example: 42, description: 'Settled charges in this provider/currency/window' })
  chargesEvaluated: number;

  @ApiProperty({ example: '4200000', description: 'Sum of settled charge amounts, minor units' })
  grossVolumeMinorUnits: string;

  @ApiProperty({
    example: '121890',
    description: "What this platform's configured PSP fee schedule estimates the PSP would charge for that volume",
  })
  estimatedFeeMinorUnits: string;

  @ApiProperty({ example: '125000' })
  actualInvoicedFeeMinorUnits: string;

  @ApiProperty({
    enum: ['PSP_STATEMENT', 'MANUAL_OVERRIDE'],
    description: 'Whether actualInvoicedFeeMinorUnits came from a real PSP statement fetch or an operator override',
  })
  actualFeeSource: 'PSP_STATEMENT' | 'MANUAL_OVERRIDE';

  @ApiProperty({ example: '3110', description: 'actualInvoicedFeeMinorUnits - estimatedFeeMinorUnits' })
  deltaMinorUnits: string;

  @ApiPropertyOptional({ example: 2.55, description: 'delta as a percent of the estimate; null if the estimate is 0' })
  deltaPercent: number | null;
}

function toDto(report: PspCostReconciliationReport): PspCostReconciliationReportDto {
  return {
    ...report,
    since: report.since.toISOString(),
    until: report.until.toISOString(),
  };
}

/**
 * PSP Cost Reconciliation Admin Controller
 * On-demand report comparing PspFeeScheduleService's configured cost
 * estimate (the same numbers smart-routing uses to pick a cheaper PSP)
 * against what a PSP actually invoiced — fetched for real via
 * PSPAdapterPort.fetchFeeStatement() by default, with an optional manual
 * override; see PspCostReconciliationService's own docblock.
 */
@ApiTags('Admin — PSP Cost Reconciliation')
@ApiBearerAuth()
@Controller('admin/psp-cost-reconciliation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class PspCostReconciliationAdminController {
  constructor(private readonly reconciliationService: PspCostReconciliationService) {}

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compare estimated vs. actual-invoiced PSP processing fees for a window' })
  @ApiResponse({ status: 200, type: PspCostReconciliationReportDto })
  async run(@Body() dto: RunPspCostReconciliationDto): Promise<PspCostReconciliationReportDto> {
    const report = await this.reconciliationService.computeReport({
      provider: dto.provider,
      currency: dto.currency,
      since: new Date(dto.since),
      until: new Date(dto.until),
      actualInvoicedFeeMinorUnits:
        dto.actualInvoicedFeeMinorUnits !== undefined ? BigInt(dto.actualInvoicedFeeMinorUnits) : undefined,
    });
    return toDto(report);
  }
}
