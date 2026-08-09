import { Controller, Get, Post, Query, Body, UseGuards, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsISO8601 } from 'class-validator';
import { ReconciliationService } from '../services/reconciliation.service';
import { ReconciliationPort } from '../../ports/outbound/reconciliation.port';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { ReconciliationRun } from '../../domain/aggregates/reconciliation-run.aggregate';

const RECONCILED_PROVIDERS: PSPProvider[] = ['STRIPE', 'ADYEN'];

class RunReconciliationDto {
  @ApiProperty({ enum: RECONCILED_PROVIDERS })
  @IsIn(RECONCILED_PROVIDERS)
  pspProvider: PSPProvider;

  @ApiPropertyOptional({ description: 'ISO-8601 — defaults to one hour before "until"', example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  since?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 — defaults to now', example: '2026-01-01T01:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  until?: string;
}

class ReconciliationMismatchDto {
  @ApiProperty({ enum: ['MISSING_AT_PSP', 'AMOUNT_MISMATCH', 'UNKNOWN_AT_PSP'] })
  type: string;

  @ApiPropertyOptional({ example: 'pay_abc123' })
  paymentId?: string;

  @ApiPropertyOptional({ example: 'pi_stripe_abc123' })
  pspTransactionId?: string;

  @ApiPropertyOptional({ example: '99.99 USD' })
  expectedAmount?: string;

  @ApiPropertyOptional({ example: '89.99 USD' })
  actualAmount?: string;

  @ApiProperty()
  description: string;
}

class ReconciliationRunSummaryDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ enum: RECONCILED_PROVIDERS })
  pspProvider: string;

  @ApiProperty()
  windowStart: string;

  @ApiProperty()
  windowEnd: string;

  @ApiProperty({ example: 42 })
  transactionsChecked: number;

  @ApiProperty({ enum: ['CLEAN', 'MISMATCHES_FOUND'] })
  status: string;

  @ApiProperty({ example: 0 })
  mismatchCount: number;

  @ApiProperty({ type: [ReconciliationMismatchDto] })
  mismatches: ReconciliationMismatchDto[];

  @ApiProperty()
  ranAt: string;
}

function toSummary(run: ReconciliationRun): ReconciliationRunSummaryDto {
  return {
    id: run.id,
    pspProvider: run.pspProvider,
    windowStart: run.windowStart.toISOString(),
    windowEnd: run.windowEnd.toISOString(),
    transactionsChecked: run.transactionsChecked,
    status: run.status,
    mismatchCount: run.mismatches.length,
    mismatches: run.mismatches.map((m) => ({
      type: m.type,
      paymentId: m.paymentId,
      pspTransactionId: m.pspTransactionId,
      expectedAmount: m.expectedAmount?.toString(),
      actualAmount: m.actualAmount?.toString(),
      description: m.description,
    })),
    ranAt: run.ranAt.toISOString(),
  };
}

/**
 * Reconciliation Admin Controller
 * Operator-facing view into ReconciliationService's runs — see that
 * service's docblock for why this exists (the ledger/settlement safety net
 * unit and e2e tests structurally can't provide).
 */
@ApiTags('Admin — Reconciliation')
@ApiBearerAuth()
@Controller('admin/reconciliation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class ReconciliationAdminController {
  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly reconciliationRepo: ReconciliationPort,
  ) {}

  @Get('runs')
  @ApiOperation({ summary: 'List recent reconciliation runs, optionally filtered by PSP provider' })
  @ApiResponse({ status: 200, type: [ReconciliationRunSummaryDto] })
  @ApiResponse({ status: 400, description: 'Unknown pspProvider' })
  async listRuns(@Query('pspProvider') pspProvider?: string, @Query('limit') limit?: string): Promise<ReconciliationRunSummaryDto[]> {
    const parsedLimit = limit ? Number(limit) : undefined;
    if (pspProvider) {
      if (!RECONCILED_PROVIDERS.includes(pspProvider as PSPProvider)) {
        throw new BadRequestException({
          statusCode: 400,
          error: `Unknown pspProvider '${pspProvider}'`,
          code: 'UNKNOWN_PSP_PROVIDER',
          allowed: RECONCILED_PROVIDERS,
        });
      }
      const runs = await this.reconciliationRepo.findByProvider(pspProvider as PSPProvider, parsedLimit);
      return runs.map(toSummary);
    }
    const runs = await this.reconciliationRepo.findRecent(parsedLimit);
    return runs.map(toSummary);
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger an on-demand reconciliation run for a provider (defaults to the last hour)' })
  @ApiResponse({ status: 200, type: ReconciliationRunSummaryDto })
  async runNow(@Body() dto: RunReconciliationDto): Promise<ReconciliationRunSummaryDto> {
    const until = dto.until ? new Date(dto.until) : new Date();
    const since = dto.since ? new Date(dto.since) : new Date(until.getTime() - 60 * 60 * 1000);
    const run = await this.reconciliationService.reconcile(dto.pspProvider, since, until);
    return toSummary(run);
  }
}
