import { Controller, Post, Get, Body, Param, Query, Req, UseGuards, UseInterceptors, HttpCode, HttpStatus, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsIn, IsString } from 'class-validator';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { HmacSignatureGuard } from '../../../../shared/guards/hmac-signature.guard';
import { MerchantThrottlerGuard } from '../../../../shared/guards/merchant-throttler.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../interceptors/idempotency.interceptor';
import { SubscriptionService } from '../services/subscription.service';
import { CreateSubscriptionDto, CancelSubscriptionDto, ChangePlanDto, ChangePlanResponseDto, SubscriptionResponseDto } from '../dto/subscription.dto';
import { Money } from '../../domain/value-objects/money.vo';
import { Subscription, SubscriptionStatus } from '../../domain/aggregates/subscription.aggregate';

const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'];

class ListSubscriptionsQuery {
  @ApiPropertyOptional({ description: 'ADMIN/OPERATOR/READONLY only — a MERCHANT is always scoped to their own subscriptions regardless of this param' })
  @IsOptional()
  @IsString()
  merchantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ enum: SUBSCRIPTION_STATUSES })
  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: SubscriptionStatus;
}

function toResponseDto(subscription: Subscription): SubscriptionResponseDto {
  return {
    id: subscription.id,
    planId: subscription.planId,
    merchantId: subscription.merchantId,
    customerId: subscription.customerId,
    amount: subscription.amount.amount,
    currency: subscription.amount.currency.code,
    interval: subscription.interval,
    intervalCount: subscription.intervalCount,
    status: subscription.status,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    failedAttempts: subscription.failedAttempts,
    nextRetryAt: subscription.nextRetryAt?.toISOString(),
    lastDeclineCode: subscription.lastDeclineCode,
    pendingCredit: subscription.pendingCredit?.amount,
    orderId: subscription.orderId,
    description: subscription.description,
    canceledAt: subscription.canceledAt?.toISOString(),
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}

/**
 * Subscription Controller (v1)
 * Merchant-facing recurring billing — see Subscription aggregate's
 * docblock and SubscriptionService for the billing mechanics. The same
 * security layers as PaymentController's charge() endpoint apply to
 * POST /subscriptions, since creating one (without a trial) charges a
 * card immediately, same as POST /payments/charge does.
 */
@ApiTags('Subscriptions')
@ApiBearerAuth()
@Controller('subscriptions')
@UseGuards(JwtAuthGuard, RolesGuard, MerchantThrottlerGuard)
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  /** Merchants may only act on/see their own subscriptions; ADMIN/OPERATOR/READONLY may act on any. */
  private assertOwnership(subscription: Subscription, req: any): void {
    if (req.user?.roles?.includes(UserRole.MERCHANT) && subscription.merchantId !== req.user.merchantId) {
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'ACCESS_DENIED' });
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @UseGuards(HmacSignatureGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Create a subscription — from a Plan (planId) or a direct amount/currency/interval — charges the first period immediately unless trialDays is set' })
  @ApiResponse({ status: 201, type: SubscriptionResponseDto })
  @ApiResponse({ status: 422, description: 'Neither planId nor amount/currency/interval were provided, or the first charge did not succeed (no subscription was created) — only possible when trialDays is 0/omitted' })
  async create(@Body() dto: CreateSubscriptionDto, @Req() req: any): Promise<SubscriptionResponseDto> {
    const merchantId = req.user?.merchantId;
    const subscription = await this.subscriptionService.createSubscription({
      merchantId,
      customerId: dto.customerId,
      planId: dto.planId,
      amount: dto.amount !== undefined && dto.currency ? Money.of(dto.amount, dto.currency) : undefined,
      interval: dto.interval,
      intervalCount: dto.intervalCount ?? 1,
      paymentMethodId: dto.paymentMethodId,
      trialDays: dto.trialDays,
      orderId: dto.orderId,
      description: dto.description,
    });
    return toResponseDto(subscription);
  }

  @Get(':id')
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.OPERATOR, UserRole.READONLY)
  @ApiOperation({ summary: 'Get a subscription by id' })
  @ApiResponse({ status: 200, type: SubscriptionResponseDto })
  @ApiResponse({ status: 403, description: 'This subscription belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async getById(@Param('id') id: string, @Req() req: any): Promise<SubscriptionResponseDto> {
    const subscription = await this.subscriptionService.getOrThrow(id);
    this.assertOwnership(subscription, req);
    return toResponseDto(subscription);
  }

  @Get()
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.OPERATOR, UserRole.READONLY)
  @ApiOperation({ summary: 'List subscriptions — a MERCHANT always sees only their own; ADMIN/OPERATOR/READONLY may filter by merchantId' })
  @ApiResponse({ status: 200, type: [SubscriptionResponseDto] })
  async list(@Query() query: ListSubscriptionsQuery, @Req() req: any): Promise<SubscriptionResponseDto[]> {
    const isMerchantRole = req.user?.roles?.includes(UserRole.MERCHANT);
    const merchantId = isMerchantRole ? req.user.merchantId : query.merchantId;
    const subscriptions = await this.subscriptionService.findMany({ merchantId, customerId: query.customerId, status: query.status });
    return subscriptions.map(toResponseDto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @UseGuards(HmacSignatureGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Cancel a subscription — immediately, or at the end of the current period' })
  @ApiResponse({ status: 200, type: SubscriptionResponseDto })
  @ApiResponse({ status: 403, description: 'This subscription belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async cancel(@Param('id') id: string, @Body() dto: CancelSubscriptionDto, @Req() req: any): Promise<SubscriptionResponseDto> {
    const subscription = await this.subscriptionService.getOrThrow(id);
    this.assertOwnership(subscription, req);
    const updated = await this.subscriptionService.cancel(id, dto.atPeriodEnd ?? false);
    return toResponseDto(updated);
  }

  @Post(':id/change-plan')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @UseGuards(HmacSignatureGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Switch an ACTIVE subscription to a different plan — charges the prorated difference immediately if it\'s an upgrade; a downgrade issues a credit for the unused portion, applied against a future period' })
  @ApiResponse({ status: 200, type: ChangePlanResponseDto })
  @ApiResponse({ status: 403, description: 'This subscription (or the target plan) belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Subscription or plan not found (or the plan is deactivated)' })
  @ApiResponse({ status: 409, description: 'The subscription is not ACTIVE, or the target plan is in a different currency' })
  @ApiResponse({ status: 422, description: 'A proration charge was owed and the PSP declined it — the plan was not changed' })
  async changePlan(@Param('id') id: string, @Body() dto: ChangePlanDto, @Req() req: any): Promise<ChangePlanResponseDto> {
    const subscription = await this.subscriptionService.getOrThrow(id);
    this.assertOwnership(subscription, req);
    const { subscription: updated, prorationCharged, creditIssued } = await this.subscriptionService.changePlan(id, dto.planId);
    return {
      subscription: toResponseDto(updated),
      prorationCharged: prorationCharged?.amount,
      creditIssued: creditIssued?.amount,
    };
  }
}
