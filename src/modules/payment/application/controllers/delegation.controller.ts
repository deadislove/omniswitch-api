import { Controller, Post, Get, Body, Param, Query, Req, UseGuards, HttpCode, HttpStatus, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsIn, IsString } from 'class-validator';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { MerchantThrottlerGuard } from '../../../../shared/guards/merchant-throttler.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { DelegationService } from '../services/delegation.service';
import { CreateDelegationDto, DelegationResponseDto, CreateDelegationResponseDto } from '../dto/delegation.dto';
import { Money } from '../../domain/value-objects/money.vo';
import { Delegation, DelegationStatus } from '../../domain/aggregates/delegation.aggregate';

const DELEGATION_STATUSES: DelegationStatus[] = ['ACTIVE', 'REVOKED'];

class ListDelegationsQuery {
  @ApiPropertyOptional({ description: 'ADMIN/OPERATOR/READONLY only — a MERCHANT is always scoped to their own delegations regardless of this param' })
  @IsOptional()
  @IsString()
  merchantId?: string;

  @ApiPropertyOptional({ enum: DELEGATION_STATUSES })
  @IsOptional()
  @IsIn(DELEGATION_STATUSES)
  status?: DelegationStatus;
}

function toResponseDto(delegation: Delegation): DelegationResponseDto {
  return {
    id: delegation.id,
    merchantId: delegation.merchantId,
    agentName: delegation.agentName,
    status: delegation.status,
    perTransactionLimit: delegation.spendPolicy.perTransactionLimit.amount,
    monthlyLimit: delegation.spendPolicy.monthlyLimit.amount,
    currency: delegation.spendPolicy.currency,
    allowedCategories: delegation.spendPolicy.allowedCategories,
    currentMonthSpent: delegation.currentMonthSpent.amount,
    createdAt: delegation.createdAt.toISOString(),
    revokedAt: delegation.revokedAt?.toISOString(),
    updatedAt: delegation.updatedAt.toISOString(),
  };
}

/**
 * Delegation Controller (v1)
 * Merchant-facing agentic-payments credential issuance — see
 * delegation.aggregate.ts's docblock for what a Delegation is and
 * docs/business-domain/future-directions.md#agentic-payments for the
 * business framing. No HMAC/idempotency guards: creating or revoking a
 * delegation never moves money by itself, same posture as PlanController.
 */
@ApiTags('Agentic Payments')
@ApiBearerAuth()
@Controller('delegations')
@UseGuards(JwtAuthGuard, RolesGuard, MerchantThrottlerGuard)
export class DelegationController {
  constructor(private readonly delegationService: DelegationService) {}

  private assertOwnership(delegation: Delegation, req: any): void {
    if (req.user?.roles?.includes(UserRole.MERCHANT) && delegation.merchantId !== req.user.merchantId) {
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'ACCESS_DENIED' });
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @ApiOperation({ summary: 'Authorize a new agent to charge on this merchant\'s behalf, within a spend policy — returns the agent\'s JWT once, like an API key secret' })
  @ApiResponse({ status: 201, type: CreateDelegationResponseDto })
  async create(@Body() dto: CreateDelegationDto, @Req() req: any): Promise<CreateDelegationResponseDto> {
    const { delegation, agentToken, expiresIn } = await this.delegationService.createDelegation({
      merchantId: req.user?.merchantId,
      agentName: dto.agentName,
      perTransactionLimit: Money.of(dto.perTransactionLimit, dto.currency),
      monthlyLimit: Money.of(dto.monthlyLimit, dto.currency),
      allowedCategories: dto.allowedCategories,
      tokenTtlSeconds: dto.tokenTtlSeconds,
    });
    return { delegation: toResponseDto(delegation), agentToken, tokenType: 'Bearer', expiresIn };
  }

  @Get(':id')
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.OPERATOR, UserRole.READONLY)
  @ApiOperation({ summary: 'Get a delegation by id' })
  @ApiResponse({ status: 200, type: DelegationResponseDto })
  @ApiResponse({ status: 403, description: 'This delegation belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Delegation not found' })
  async getById(@Param('id') id: string, @Req() req: any): Promise<DelegationResponseDto> {
    const delegation = await this.delegationService.getOrThrow(id);
    this.assertOwnership(delegation, req);
    return toResponseDto(delegation);
  }

  @Get()
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.OPERATOR, UserRole.READONLY)
  @ApiOperation({ summary: 'List delegations — a MERCHANT always sees only their own; ADMIN/OPERATOR/READONLY may filter by merchantId' })
  @ApiResponse({ status: 200, type: [DelegationResponseDto] })
  async list(@Query() query: ListDelegationsQuery, @Req() req: any): Promise<DelegationResponseDto[]> {
    const isMerchantRole = req.user?.roles?.includes(UserRole.MERCHANT);
    const merchantId = isMerchantRole ? req.user.merchantId : query.merchantId;
    const delegations = await this.delegationService.findMany({ merchantId, status: query.status });
    return delegations.map(toResponseDto);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @ApiOperation({ summary: 'Revoke a delegation — takes effect immediately: the agent\'s JWT is rejected on its very next request, not just once it naturally expires' })
  @ApiResponse({ status: 200, type: DelegationResponseDto })
  @ApiResponse({ status: 403, description: 'This delegation belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Delegation not found' })
  @ApiResponse({ status: 409, description: 'Already revoked' })
  async revoke(@Param('id') id: string, @Req() req: any): Promise<DelegationResponseDto> {
    const existing = await this.delegationService.getOrThrow(id);
    this.assertOwnership(existing, req);
    const delegation = await this.delegationService.revoke(id);
    return toResponseDto(delegation);
  }
}
