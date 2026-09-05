import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsIn, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { ChargeApprovalService } from '../services/charge-approval.service';
import { ChargeApproval, ChargeApprovalStatus } from '../../domain/aggregates/charge-approval.aggregate';
import { ChargePaymentResponseDto } from '../dto/charge-payment.dto';
import { CheckoutSagaResult } from '../sagas/payment-checkout.saga';

const CHARGE_APPROVAL_STATUSES: ChargeApprovalStatus[] = ['PENDING', 'APPROVED', 'DENIED'];

class ListChargeApprovalsQuery {
  @ApiPropertyOptional({
    description: 'ADMIN/OPERATOR only — a MERCHANT is always scoped to their own approvals regardless of this param',
  })
  @IsOptional()
  @IsString()
  merchantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  delegationId?: string;

  @ApiPropertyOptional({ enum: CHARGE_APPROVAL_STATUSES })
  @IsOptional()
  @IsIn(CHARGE_APPROVAL_STATUSES)
  status?: ChargeApprovalStatus;
}

class DenyChargeApprovalDto {
  @ApiPropertyOptional({ example: 'Amount looks like a mistaken duplicate order' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class ChargeApprovalResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({
    example: 'a1b2c3d4-...',
    description: 'The Payment id this approval is for — a real Payment only exists once approved',
  })
  paymentId: string;

  @ApiProperty()
  delegationId: string;

  @ApiProperty()
  merchantId: string;

  @ApiProperty({ example: 250 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ enum: CHARGE_APPROVAL_STATUSES })
  status: ChargeApprovalStatus;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional()
  decidedAt?: string;

  @ApiPropertyOptional({ description: 'The merchantId of the operator/merchant who approved or denied this' })
  decidedBy?: string;

  @ApiPropertyOptional()
  denialReason?: string;
}

function toResponseDto(approval: ChargeApproval): ChargeApprovalResponseDto {
  return {
    id: approval.id,
    paymentId: approval.paymentId,
    delegationId: approval.delegationId,
    merchantId: approval.merchantId,
    amount: approval.amount.amount,
    currency: approval.amount.currency.code,
    status: approval.status,
    createdAt: approval.createdAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString(),
    decidedBy: approval.decidedBy,
    denialReason: approval.denialReason,
  };
}

function toChargeResponseDto(result: CheckoutSagaResult): ChargePaymentResponseDto {
  return {
    paymentId: result.paymentId,
    status: result.status,
    pspTransactionId: result.pspTransactionId,
    pspProvider: result.pspProvider,
    actionUrl: result.actionUrl,
    requiresAction: !!result.actionUrl,
    riskScore: result.riskScore,
    usedFallback: false,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Charge Approval Controller
 * The human-approval hold state for an agent-initiated charge above its
 * delegation's `requireApprovalAboveAmount` — see `ChargeApproval`'s own
 * docblock and `docs/business-domain/future-directions.md#agentic-payments`.
 * Same MERCHANT-self-scoped / ADMIN-OPERATOR-cross-merchant access model
 * as `DelegationController` — approving/denying an agent's spend is the
 * merchant's own operator decision, not a platform-operator one, but
 * ADMIN/OPERATOR can act on any merchant's approvals same as everywhere
 * else in this codebase's admin surface.
 */
@ApiTags('Agentic Payments')
@ApiBearerAuth()
@Controller('charge-approvals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChargeApprovalController {
  constructor(private readonly chargeApprovalService: ChargeApprovalService) {}

  private assertOwnership(approval: ChargeApproval, req: any): void {
    if (req.user?.roles?.includes(UserRole.MERCHANT) && approval.merchantId !== req.user.merchantId) {
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'ACCESS_DENIED' });
    }
  }

  @Get(':id')
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.OPERATOR, UserRole.READONLY)
  @ApiOperation({ summary: 'Get a charge approval by id' })
  @ApiResponse({ status: 200, type: ChargeApprovalResponseDto })
  @ApiResponse({ status: 403, description: 'This approval belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Charge approval not found' })
  async getById(@Param('id') id: string, @Req() req: any): Promise<ChargeApprovalResponseDto> {
    const approval = await this.chargeApprovalService.findById(id);
    this.assertOwnership(approval, req);
    return toResponseDto(approval);
  }

  @Get()
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.OPERATOR, UserRole.READONLY)
  @ApiOperation({
    summary:
      'List charge approvals — a MERCHANT always sees only their own; ADMIN/OPERATOR/READONLY may filter by merchantId',
  })
  @ApiResponse({ status: 200, type: [ChargeApprovalResponseDto] })
  async list(@Query() query: ListChargeApprovalsQuery, @Req() req: any): Promise<ChargeApprovalResponseDto[]> {
    const isMerchantRole = req.user?.roles?.includes(UserRole.MERCHANT);
    const merchantId = isMerchantRole ? req.user.merchantId : query.merchantId;
    const approvals = await this.chargeApprovalService.findMany({
      merchantId,
      delegationId: query.delegationId,
      status: query.status,
    });
    return approvals.map(toResponseDto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Approve a pending charge approval — actually executes the deferred charge in this same request (spend was already reserved when the approval was created) and returns the real charge result, same shape as POST /payments/charge',
  })
  @ApiResponse({ status: 200, type: ChargePaymentResponseDto })
  @ApiResponse({ status: 403, description: 'This approval belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Charge approval not found' })
  @ApiResponse({ status: 409, description: 'Already approved or denied' })
  async approve(@Param('id') id: string, @Req() req: any): Promise<ChargePaymentResponseDto> {
    const approval = await this.chargeApprovalService.findById(id);
    this.assertOwnership(approval, req);
    const result = await this.chargeApprovalService.approve(id, req.user?.merchantId ?? 'unknown');
    return toChargeResponseDto(result);
  }

  @Post(':id/deny')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Deny a pending charge approval — releases the reserved spend back to the delegation, the charge is never attempted',
  })
  @ApiResponse({ status: 200, type: ChargeApprovalResponseDto })
  @ApiResponse({ status: 403, description: 'This approval belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Charge approval not found' })
  @ApiResponse({ status: 409, description: 'Already approved or denied' })
  async deny(
    @Param('id') id: string,
    @Body() dto: DenyChargeApprovalDto,
    @Req() req: any,
  ): Promise<ChargeApprovalResponseDto> {
    const existing = await this.chargeApprovalService.findById(id);
    this.assertOwnership(existing, req);
    const approval = await this.chargeApprovalService.deny(id, req.user?.merchantId ?? 'unknown', dto.reason);
    return toResponseDto(approval);
  }
}
