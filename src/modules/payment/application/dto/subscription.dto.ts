import { IsString, IsNumber, IsPositive, IsOptional, IsIn, IsInt, Min, Max, MaxLength, IsBoolean, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillingInterval, SubscriptionStatus } from '../../domain/aggregates/subscription.aggregate';
import { IsNotRawCardNumber } from './validators/not-raw-card-number.validator';

const BILLING_INTERVALS: BillingInterval[] = ['day', 'week', 'month', 'year'];
const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'];

export class CreateSubscriptionDto {
  @ApiPropertyOptional({
    example: 'a1b2c3d4-...',
    description: 'Subscribe using a pre-defined Plan (POST /plans) — amount/currency/interval/intervalCount are taken from the plan and any of those fields below are ignored. Either this or amount+currency+interval must be provided.',
  })
  @IsOptional()
  @IsUUID()
  planId?: string;

  @ApiPropertyOptional({ example: 29.99, description: 'Amount charged per billing period, in major currency units. Required if planId is omitted.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(1_000_000_000)
  amount?: number;

  @ApiPropertyOptional({ example: 'USD', description: 'ISO-4217 currency code. Required if planId is omitted.' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ example: 'cust_xyz789' })
  @IsString()
  customerId: string;

  @ApiPropertyOptional({ enum: BILLING_INTERVALS, example: 'month', description: 'Required if planId is omitted.' })
  @IsOptional()
  @IsIn(BILLING_INTERVALS)
  interval?: BillingInterval;

  @ApiPropertyOptional({ example: 1, description: 'Bill every N intervals — e.g. interval=month, intervalCount=3 bills quarterly. Defaults to 1. Ignored if planId is set.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  intervalCount?: number;

  @ApiProperty({ example: 'pm_1234567890', description: 'Stored payment method reference — every renewal charges this off-session, so (unlike a one-time charge) a card token alone is not accepted' })
  @IsString()
  @IsNotRawCardNumber()
  paymentMethodId: string;

  @ApiPropertyOptional({ example: 14, description: 'Trial length in days — no charge happens until the trial elapses. Omit/0 to charge the first period immediately.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  trialDays?: number;

  @ApiPropertyOptional({ example: 'order_abc123' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  orderId?: string;

  @ApiPropertyOptional({ example: 'Pro plan monthly' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CancelSubscriptionDto {
  @ApiPropertyOptional({ example: true, description: 'true: keep billing through the current period, cancel when it ends. false/omitted: cancel immediately.' })
  @IsOptional()
  @IsBoolean()
  atPeriodEnd?: boolean;
}

export class ChangePlanDto {
  @ApiProperty({ example: 'a1b2c3d4-...', description: 'The Plan to switch to (POST /plans) — must belong to the same merchant, be active, and be in the same currency as the subscription\'s current amount.' })
  @IsUUID()
  planId: string;
}

export class SubscriptionResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4-...', description: 'The Plan this subscription was created from or last changed to, if any — provenance only, not a live reference (see Subscription aggregate\'s docblock)' })
  planId?: string;

  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: 'cust_xyz789' })
  customerId: string;

  @ApiProperty({ example: 29.99 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ enum: BILLING_INTERVALS })
  interval: BillingInterval;

  @ApiProperty({ example: 1 })
  intervalCount: number;

  @ApiProperty({ enum: SUBSCRIPTION_STATUSES })
  status: SubscriptionStatus;

  @ApiProperty()
  currentPeriodStart: string;

  @ApiProperty()
  currentPeriodEnd: string;

  @ApiProperty({ example: false, description: 'If true, the subscription will stop (not renew) at the end of the current period' })
  cancelAtPeriodEnd: boolean;

  @ApiProperty({ example: 0, description: 'Consecutive failed billing attempts for the current period — resets to 0 on a successful charge' })
  failedAttempts: number;

  @ApiPropertyOptional({ description: 'When status is PAST_DUE, the next scheduled dunning retry (day 1/3/7 backoff, not the next daily sweep tick) — absent otherwise' })
  nextRetryAt?: string;

  @ApiPropertyOptional({ example: 'insufficient_funds', description: 'The PSP\'s decline code from the most recent failed billing attempt, if any was returned — cleared on a successful charge. A hard-decline code (stolen_card, expired_card, ...) means this subscription skipped the retry schedule and canceled immediately.' })
  lastDeclineCode?: string;

  @ApiPropertyOptional({ example: 5.5, description: 'Unused credit from a prior downgrade, applied against a future period\'s charge — absent if there is none' })
  pendingCredit?: number;

  @ApiPropertyOptional()
  orderId?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional()
  canceledAt?: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}

export class ChangePlanResponseDto {
  @ApiProperty({ description: 'The subscription after the plan change' })
  subscription: SubscriptionResponseDto;

  @ApiPropertyOptional({ example: 12.34, description: 'The prorated amount actually charged for switching mid-period, if this was an upgrade. Mutually exclusive with creditIssued.' })
  prorationCharged?: number;

  @ApiPropertyOptional({ example: 5.5, description: 'The credit issued for the unused portion of the current period, if this was a downgrade — applied against a future period\'s charge, not refunded now. Mutually exclusive with prorationCharged. Absent for a lateral move (no price change).' })
  creditIssued?: number;
}

export class BillingSweepResultDto {
  @ApiProperty({ example: 4, description: 'Subscriptions successfully charged for their next period' })
  charged: number;

  @ApiProperty({ example: 1, description: 'Subscriptions finalized as CANCELED (cancelAtPeriodEnd reaching its due date)' })
  canceled: number;

  @ApiProperty({ example: 0, description: 'Charge attempts that failed — see each subscription\'s failedAttempts/status for dunning progress' })
  failed: number;
}
