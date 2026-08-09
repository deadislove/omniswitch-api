import { Controller, Get, Post, Param, Query, Body, UseGuards, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength, IsOptional, IsIn } from 'class-validator';
import { DisputeService } from '../services/dispute.service';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { Dispute, DisputeStatus } from '../../domain/aggregates/dispute.aggregate';
import { DisputeAutoDecision, evidenceGuidanceFor } from '../../domain/services/dispute-policy';

const DISPUTE_STATUSES: DisputeStatus[] = ['NEEDS_RESPONSE', 'UNDER_REVIEW', 'WON', 'LOST'];
const DISPUTE_AUTO_DECISIONS: DisputeAutoDecision[] = ['ACCEPT', 'CONTEST', 'MANUAL_REVIEW'];

class SubmitEvidenceDto {
  @ApiProperty({ example: 'Tracking number 1Z999 shows delivery confirmed on the customer\'s doorstep.' })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  evidence: string;
}

class ListDisputesQuery {
  @ApiPropertyOptional({ example: 'merchant_acme_corp' })
  @IsOptional()
  @IsString()
  merchantId?: string;

  @ApiPropertyOptional({ enum: DISPUTE_STATUSES })
  @IsOptional()
  @IsIn(DISPUTE_STATUSES)
  status?: DisputeStatus;
}

class DisputeSummaryDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: 'STRIPE' })
  pspProvider: string;

  @ApiProperty({ example: 'dp_stripe_abc123', description: 'The PSP\'s own id for this dispute — not the original payment\'s transaction id' })
  pspDisputeId: string;

  @ApiProperty({ example: 99.99 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiPropertyOptional({ example: 'fraudulent' })
  reason?: string;

  @ApiProperty({ enum: DISPUTE_STATUSES })
  status: DisputeStatus;

  @ApiProperty({ description: 'Deadline to respond — defaults to 7 days after creation' })
  respondBy: string;

  @ApiPropertyOptional({ description: 'Evidence text submitted via POST :id/evidence, if any — either an operator\'s own submission, or an automated one if autoDecision is CONTEST' })
  evidence?: string;

  @ApiPropertyOptional({
    enum: DISPUTE_AUTO_DECISIONS,
    description:
      'DisputeService\'s policy recommendation, computed once at creation (see dispute-policy.ts): ' +
      'ACCEPT/MANUAL_REVIEW are advisory only (this system has no PSP "accept" action to call); ' +
      'CONTEST already auto-submitted templated evidence — status will be UNDER_REVIEW, not NEEDS_RESPONSE.',
  })
  autoDecision?: DisputeAutoDecision;

  @ApiProperty({ description: 'What evidence this reason code actually needs to win — shown regardless of autoDecision, since an operator overriding a MANUAL_REVIEW recommendation still needs this' })
  evidenceGuidance: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}

function toSummary(dispute: Dispute): DisputeSummaryDto {
  return {
    id: dispute.id,
    paymentId: dispute.paymentId,
    merchantId: dispute.merchantId,
    pspProvider: dispute.pspProvider,
    pspDisputeId: dispute.pspDisputeId,
    amount: dispute.amount.amount,
    currency: dispute.amount.currency.code,
    reason: dispute.reason,
    status: dispute.status,
    respondBy: dispute.respondBy.toISOString(),
    evidence: dispute.evidence,
    autoDecision: dispute.autoDecision,
    evidenceGuidance: evidenceGuidanceFor(dispute.reason),
    createdAt: dispute.createdAt.toISOString(),
    updatedAt: dispute.updatedAt.toISOString(),
  };
}

/**
 * Dispute Admin Controller
 * The API surface for a payment that's entered DISPUTED via webhook —
 * listing, representment, and the response deadline. See Dispute
 * aggregate's docblock and DisputeService for the full design.
 */
@ApiTags('Admin — Disputes')
@ApiBearerAuth()
@Controller('admin/disputes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.OPERATOR)
export class DisputeAdminController {
  constructor(private readonly disputeService: DisputeService) {}

  @Get()
  @ApiOperation({ summary: 'List disputes, optionally filtered by merchant and/or status' })
  @ApiResponse({ status: 200, type: [DisputeSummaryDto] })
  async list(@Query() query: ListDisputesQuery): Promise<DisputeSummaryDto[]> {
    const disputes = await this.disputeService.findMany({
      merchantId: query.merchantId,
      status: query.status,
    });
    return disputes.map(toSummary);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single dispute by id' })
  @ApiResponse({ status: 200, type: DisputeSummaryDto })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async getById(@Param('id') id: string): Promise<DisputeSummaryDto> {
    const dispute = await this.disputeService.findById(id);
    if (!dispute) {
      throw new NotFoundException({ statusCode: 404, error: `Dispute ${id} not found`, code: 'DISPUTE_NOT_FOUND' });
    }
    return toSummary(dispute);
  }

  @Post(':id/evidence')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit evidence to contest a NEEDS_RESPONSE dispute (representment) — calls the PSP' })
  @ApiResponse({ status: 200, type: DisputeSummaryDto })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  @ApiResponse({ status: 409, description: 'Dispute is not in NEEDS_RESPONSE status' })
  @ApiResponse({ status: 422, description: 'PSP declined the evidence submission' })
  async submitEvidence(@Param('id') id: string, @Body() dto: SubmitEvidenceDto): Promise<DisputeSummaryDto> {
    const dispute = await this.disputeService.submitEvidence(id, dto.evidence);
    return toSummary(dispute);
  }
}
