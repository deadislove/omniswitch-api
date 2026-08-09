import { Controller, Post, Get, Body, Param, Query, Req, UseGuards, HttpCode, HttpStatus, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsString } from 'class-validator';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { MerchantThrottlerGuard } from '../../../../shared/guards/merchant-throttler.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { PlanService } from '../services/plan.service';
import { CreatePlanDto, PlanResponseDto } from '../dto/plan.dto';
import { Money } from '../../domain/value-objects/money.vo';
import { Plan } from '../../domain/aggregates/plan.aggregate';

class ListPlansQuery {
  @ApiPropertyOptional({ description: 'ADMIN/OPERATOR/READONLY only — a MERCHANT is always scoped to their own plans regardless of this param' })
  @IsOptional()
  @IsString()
  merchantId?: string;

  @ApiPropertyOptional({ default: true, description: 'Defaults to true (active plans only) — pass false to include deactivated ones' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

function toResponseDto(plan: Plan): PlanResponseDto {
  return {
    id: plan.id,
    merchantId: plan.merchantId,
    name: plan.name,
    amount: plan.amount.amount,
    currency: plan.amount.currency.code,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
    isActive: plan.isActive,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

/**
 * Plan Controller (v1)
 * Merchant-facing subscription plan catalog — see Plan aggregate's
 * docblock for why plans are create-or-deactivate only, never edited in
 * place. No HMAC/idempotency guards: unlike POST /subscriptions, creating
 * a plan never moves money by itself.
 */
@ApiTags('Plans')
@ApiBearerAuth()
@Controller('plans')
@UseGuards(JwtAuthGuard, RolesGuard, MerchantThrottlerGuard)
export class PlanController {
  constructor(private readonly planService: PlanService) {}

  private assertOwnership(plan: Plan, req: any): void {
    if (req.user?.roles?.includes(UserRole.MERCHANT) && plan.merchantId !== req.user.merchantId) {
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'ACCESS_DENIED' });
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a reusable subscription plan' })
  @ApiResponse({ status: 201, type: PlanResponseDto })
  async create(@Body() dto: CreatePlanDto, @Req() req: any): Promise<PlanResponseDto> {
    const plan = await this.planService.createPlan({
      merchantId: req.user?.merchantId,
      name: dto.name,
      amount: Money.of(dto.amount, dto.currency),
      interval: dto.interval,
      intervalCount: dto.intervalCount ?? 1,
    });
    return toResponseDto(plan);
  }

  @Get(':id')
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.OPERATOR, UserRole.READONLY)
  @ApiOperation({ summary: 'Get a plan by id' })
  @ApiResponse({ status: 200, type: PlanResponseDto })
  @ApiResponse({ status: 403, description: 'This plan belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async getById(@Param('id') id: string, @Req() req: any): Promise<PlanResponseDto> {
    const plan = await this.planService.getOrThrow(id);
    this.assertOwnership(plan, req);
    return toResponseDto(plan);
  }

  @Get()
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.OPERATOR, UserRole.READONLY)
  @ApiOperation({ summary: 'List plans — a MERCHANT always sees only their own; ADMIN/OPERATOR/READONLY may filter by merchantId' })
  @ApiResponse({ status: 200, type: [PlanResponseDto] })
  async list(@Query() query: ListPlansQuery, @Req() req: any): Promise<PlanResponseDto[]> {
    const isMerchantRole = req.user?.roles?.includes(UserRole.MERCHANT);
    const merchantId = isMerchantRole ? req.user.merchantId : query.merchantId;
    const plans = await this.planService.findMany({ merchantId, isActive: query.isActive ?? true });
    return plans.map(toResponseDto);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @ApiOperation({ summary: 'Deactivate a plan — stops it being usable for new subscriptions or plan changes; existing subscribers are unaffected' })
  @ApiResponse({ status: 200, type: PlanResponseDto })
  @ApiResponse({ status: 403, description: 'This plan belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async deactivate(@Param('id') id: string, @Req() req: any): Promise<PlanResponseDto> {
    const existing = await this.planService.getOrThrow(id);
    this.assertOwnership(existing, req);
    const plan = await this.planService.deactivate(id);
    return toResponseDto(plan);
  }
}
