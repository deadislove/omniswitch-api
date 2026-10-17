import { IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MerchantTaxForm1099K } from '../../domain/aggregates/merchant-tax-form-1099k.aggregate';

export class GenerateTaxForm1099KDto {
  @ApiProperty({ example: 2025, description: 'Calendar tax year to generate (or return, if already generated)' })
  @IsInt()
  @Min(2000)
  @Max(2100)
  taxYear: number;
}

export class MerchantTaxForm1099KResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'merchant_furniture_store' })
  merchantId: string;

  @ApiProperty({ example: 2025 })
  taxYear: number;

  @ApiProperty({ example: 'USD' })
  currencyCode: string;

  @ApiProperty({
    example: 84250.0,
    description:
      'IRS Box 1a — gross amount of reportable payment transactions, NOT reduced by refunds/chargebacks (the real IRS rule). Includes this merchant\'s own marketplace-split-sourced credits.',
  })
  grossAmount: number;

  @ApiProperty({ example: 412, description: "IRS Box 1b-equivalent — this merchant's own direct charge count for the year" })
  transactionCount: number;

  @ApiProperty({
    type: [Number],
    example: [5200, 6100, 7300, 6800, 7100, 7500, 6900, 7200, 7400, 7600, 6950, 6250],
    description: 'IRS Box 5a-5l — one gross amount per calendar month, January first',
  })
  monthlyAmounts: number[];

  @ApiProperty({
    example: 600,
    description: 'The threshold actually applied when this form was generated — recorded on the form itself so a later config change never retroactively changes a past result',
  })
  thresholdApplied: number;

  @ApiProperty({
    example: true,
    description: 'Whether grossAmount met or exceeded thresholdApplied — illustrative only, never actually filed with the IRS',
  })
  reportable: boolean;

  @ApiProperty()
  generatedAt: string;
}

export function toMerchantTaxForm1099KResponseDto(form: MerchantTaxForm1099K): MerchantTaxForm1099KResponseDto {
  return {
    id: form.id,
    merchantId: form.merchantId,
    taxYear: form.taxYear,
    currencyCode: form.currencyCode,
    grossAmount: form.grossAmount.amount,
    transactionCount: form.transactionCount,
    monthlyAmounts: form.monthlyAmounts.map((m) => m.amount),
    thresholdApplied: form.thresholdApplied.amount,
    reportable: form.reportable,
    generatedAt: form.generatedAt.toISOString(),
  };
}
