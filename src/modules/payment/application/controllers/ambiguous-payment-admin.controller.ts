import { Controller, Get, Post, Body, Param, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { AmbiguousPaymentService } from '../services/ambiguous-payment.service';
import { PaymentAggregate } from '../../domain/aggregates/payment.aggregate';
import { PaymentDetailResponseDto } from '../dto/charge-payment.dto';
import { ResolveAmbiguousPaymentDto, ListAmbiguousPaymentsQuery, AmbiguousPaymentSummaryDto } from '../dto/ambiguous-payment.dto';

function toDetailDto(payment: PaymentAggregate): PaymentDetailResponseDto {
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
  };
}

/**
 * Ambiguous Payment Admin Controller — Phase 1 (manual resolution +
 * visibility) of the AMBIGUOUS-resolution gap. See
 * AmbiguousPaymentService's docblock and
 * docs/business-domain/payment-lifecycle.md's note on AMBIGUOUS for what
 * this does and, just as importantly, doesn't yet do (no automated
 * PSP-side resolution — this is the manual escape hatch, not a fix for
 * needing one).
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

  @Post(':id/resolve-ambiguous')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually resolve an AMBIGUOUS payment after checking the PSP directly — SUCCEEDED books the same ledger entries a webhook confirmation would; FAILED records that no charge occurred. There is no automated way to do this yet (see AmbiguousPaymentService\'s docblock) — this is the only way to close one out today.' })
  @ApiResponse({ status: 200, type: PaymentDetailResponseDto })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @ApiResponse({ status: 409, description: 'Payment is not currently AMBIGUOUS' })
  @ApiResponse({ status: 422, description: 'outcome is SUCCEEDED but pspTransactionId was omitted' })
  async resolveAmbiguous(@Param('id') id: string, @Body() dto: ResolveAmbiguousPaymentDto): Promise<PaymentDetailResponseDto> {
    const payment = await this.ambiguousPaymentService.resolve({
      paymentId: id,
      outcome: dto.outcome,
      pspTransactionId: dto.pspTransactionId,
      reason: dto.reason,
    });
    return toDetailDto(payment);
  }
}
