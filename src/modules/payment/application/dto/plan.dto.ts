import { IsString, IsNumber, IsPositive, IsOptional, IsIn, IsInt, Min, Max, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillingInterval } from '../../domain/aggregates/subscription.aggregate';

const BILLING_INTERVALS: BillingInterval[] = ['day', 'week', 'month', 'year'];

export class CreatePlanDto {
  @ApiProperty({ example: 'Pro Monthly' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 29.99, description: 'Amount charged per billing period, in major currency units' })
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(1_000_000_000)
  amount: number;

  @ApiProperty({ example: 'USD', description: 'ISO-4217 currency code' })
  @IsString()
  currency: string;

  @ApiProperty({ enum: BILLING_INTERVALS, example: 'month' })
  @IsIn(BILLING_INTERVALS)
  interval: BillingInterval;

  @ApiPropertyOptional({ example: 1, description: 'Bill every N intervals — e.g. interval=month, intervalCount=3 bills quarterly. Defaults to 1.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  intervalCount?: number;
}

export class PlanResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: 'Pro Monthly' })
  name: string;

  @ApiProperty({ example: 29.99 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ enum: BILLING_INTERVALS })
  interval: BillingInterval;

  @ApiProperty({ example: 1 })
  intervalCount: number;

  @ApiProperty({ example: true, description: 'Deactivated plans cannot be used for new subscriptions or plan changes — existing subscriptions already using one are unaffected (the amount/interval was snapshotted, not a live reference)' })
  isActive: boolean;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
