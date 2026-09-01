import { Controller, Get, Post, Body, Param, Query, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { AmbiguousPaymentService } from '../services/ambiguous-payment.service';
import { PaymentAggregate } from '../../domain/aggregates/payment.aggregate';
import { ResolveAmbiguousPaymentDto, ListAmbiguousPaymentsQuery, AmbiguousPaymentSummaryDto, ResolvedAmbiguousPaymentResponseDto } from '../dto/ambiguous-payment.dto';

function toResolvedDto(payment: PaymentAggregate): ResolvedAmbiguousPaymentResponseDto {
  return {
    paymentId: payment.id,
    status: payment.status,
    amount: payment.amount.amount,
    currency: payment.amount.currency.code,
    pspProvider: payment.pspProvider,
    pspTransactionId: payment.pspTransactionId,
    riskScore: payment.riskScore,
    refunds: payment.refunds.map((r) => ({
      refundId: r.refundId,
      amount: r.amount.amount,
      currency: r.amount.currency.code,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
    captures: payment.captures.map((c) => ({
      captureId: c.captureId,
      amount: c.amount.amount,
      createdAt: c.createdAt.toISOString(),
    })),
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    // Non-null assertions: resolve() always calls
    // recordManualAmbiguousResolution() on both branches before returning,
    // so these are always set on the payment this DTO is built from.
    ambiguousResolvedBy: payment.ambiguousResolvedBy!,
    ambiguousResolvedReason: payment.ambiguousResolvedReason!,
    ambiguousResolvedAt: payment.ambiguousResolvedAt!.toISOString(),
  };
}

function toSummaryDto(payment: PaymentAggregate): AmbiguousPaymentSummaryDto {
  return {
    paymentId: payment.id,
    merchantId: payment.metadata.merchantId,
    amount: payment.amount.amount,
    currency: payment.amount.currency.code,
    pspProvider: payment.pspProvider,
    failureReason: payment.failureReason ?? '',
    createdAt: payment.createdAt.toISOString(),
    ageMinutes: Math.floor((Date.now() - payment.createdAt.getTime()) / 60_000),
    ambiguousAutoRetryCount: payment.ambiguousAutoRetryCount,
  };
}

/**
 * Ambiguous Payment Admin Controller — manual resolution, visibility, and
 * an on-demand trigger for the automated PSP-query resolution sweep. See
 * AmbiguousPaymentService's docblock and
 * docs/business-domain/payment-lifecycle.md's note on AMBIGUOUS.
 */
@ApiTags('Admin — Ambiguous Payments')
@ApiBearerAuth()
@Controller('admin/payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class AmbiguousPaymentAdminController {
  constructor(private readonly ambiguousPaymentService: AmbiguousPaymentService) {}

  @Get('ambiguous')
  @ApiOperation({ summary: 'List AMBIGUOUS payments — a PSP call that got no response at all, and a same-provider retry also got no response. Omit olderThanMinutes to list every currently AMBIGUOUS payment.' })
  @ApiResponse({ status: 200, type: [AmbiguousPaymentSummaryDto] })
  async listAmbiguous(@Query() query: ListAmbiguousPaymentsQuery): Promise<AmbiguousPaymentSummaryDto[]> {
    const payments = await this.ambiguousPaymentService.listStale(query.olderThanMinutes ?? 0);
    return payments.map(toSummaryDto);
  }

  @Post('ambiguous/run-auto-resolution')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger the automated PSP-query resolution sweep on demand — the same logic the periodic @Cron runs, without waiting for the schedule. Asks the PSP about each eligible AMBIGUOUS payment (still AMBIGUOUS, under the auto-retry attempt cap, old enough not to re-query a PSP that only just failed to respond) via queryOutcome() and books/fails/keeps-waiting accordingly.' })
  @ApiResponse({ status: 200, description: '{ succeeded, failed, stillUnknown, skipped }' })
  async runAutoResolution(): Promise<{ succeeded: number; failed: number; stillUnknown: number; skipped: number }> {
    return this.ambiguousPaymentService.runAutoResolutionSweep();
  }

  @Post(':id/resolve-ambiguous')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually resolve an AMBIGUOUS payment after checking the PSP directly — SUCCEEDED books the same ledger entries a webhook confirmation would; FAILED records that no charge occurred. The automated sweep (see POST ambiguous/run-auto-resolution) tries this first via a PSP query; use this endpoint when that hasn\'t resolved it (e.g. the PSP genuinely has no record either) or you need to close it out immediately. reason is required and, along with the resolving admin/operator\'s identity, is recorded as a permanent audit trail on the payment.' })
  @ApiResponse({ status: 200, type: ResolvedAmbiguousPaymentResponseDto })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @ApiResponse({ status: 409, description: 'Payment is not currently AMBIGUOUS' })
  @ApiResponse({ status: 422, description: 'outcome is SUCCEEDED but pspTransactionId was omitted' })
  async resolveAmbiguous(@Param('id') id: string, @Body() dto: ResolveAmbiguousPaymentDto, @Req() req: any): Promise<ResolvedAmbiguousPaymentResponseDto> {
    const payment = await this.ambiguousPaymentService.resolve({
      paymentId: id,
      outcome: dto.outcome,
      pspTransactionId: dto.pspTransactionId,
      reason: dto.reason,
      resolvedBy: req.user.merchantId,
    });
    return toResolvedDto(payment);
  }
}
