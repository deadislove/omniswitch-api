import { IsString, IsNumber, IsPositive, IsOptional, MaxLength, MinLength, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BnplOrderStatus } from '../../domain/aggregates/bnpl-order.aggregate';

export class CreateBnplOrderDto {
  @ApiProperty({ example: 299.99, description: 'Order amount in major currency units' })
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(1_000_000_000)
  amount: number;

  @ApiProperty({ example: 'USD', description: 'ISO-4217 currency code' })
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency: string;

  @ApiPropertyOptional({ example: 'cust_xyz789' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ example: 'Sofa + 2 armchairs' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class RefundBnplOrderDto {
  @ApiProperty({ example: 99.99, description: "Refund amount — can be less than the order's full amount" })
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  amount: number;

  @ApiProperty({ example: 'Customer returned one item' })
  @IsString()
  @MaxLength(500)
  reason: string;
}

export class BnplRefundRecordDto {
  @ApiProperty()
  refundId: string;
  @ApiProperty()
  amount: number;
  @ApiProperty()
  reason: string;
  @ApiProperty()
  createdAt: string;
  @ApiPropertyOptional()
  providerRefundId?: string;
}

export class BnplOrderResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'merchant_furniture_store' })
  merchantId: string;

  @ApiProperty({ example: 299.99 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({
    enum: ['PENDING_AUTHORIZATION', 'AUTHORIZED', 'REJECTED', 'CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
    description:
      "See BnplOrder's own docblock — AUTHORIZED means Klarna granted credit but has not yet paid the merchant; CAPTURED means it has.",
  })
  status: BnplOrderStatus;

  @ApiPropertyOptional()
  customerId?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional({ description: "Klarna's own order id" })
  providerOrderId?: string;

  @ApiPropertyOptional({ description: "Klarna's own capture id" })
  providerCaptureId?: string;

  @ApiPropertyOptional({ description: 'Set only when status is REJECTED' })
  failureReason?: string;

  @ApiProperty({ type: [BnplRefundRecordDto] })
  refunds: BnplRefundRecordDto[];

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional()
  capturedAt?: string;
}
