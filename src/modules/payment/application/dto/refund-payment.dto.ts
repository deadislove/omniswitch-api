import { IsNumber, IsPositive, IsOptional, IsString, MaxLength, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RefundPaymentDto {
  @ApiPropertyOptional({
    example: 49.99,
    description: 'Amount to refund in major currency units. Omit for a full refund of the remaining refundable balance.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(1_000_000_000)
  amount?: number;

  @ApiPropertyOptional({ example: 'requested_by_customer' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class CapturePaymentDto {
  @ApiPropertyOptional({
    example: 99.99,
    description: 'Amount to capture in major currency units. Omit to capture the full remaining authorized amount. Multiple partial captures against the same authorization are supported as long as their sum does not exceed the original amount.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(1_000_000_000)
  amount?: number;
}
