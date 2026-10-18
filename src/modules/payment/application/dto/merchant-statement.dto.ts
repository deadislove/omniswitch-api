import { IsISO8601 } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MerchantStatement } from '../../domain/aggregates/merchant-statement.aggregate';
import { Money } from '../../domain/value-objects/money.vo';

export class GenerateMerchantStatementDto {
  @ApiProperty({ example: '2026-01-01T00:00:00.000Z', description: 'Inclusive start of the statement period' })
  @IsISO8601()
  periodStart: string;

  @ApiProperty({ example: '2026-02-01T00:00:00.000Z', description: 'Exclusive end of the statement period' })
  @IsISO8601()
  periodEnd: string;
}

export class StatementCurrencyBreakdownDto {
  @ApiProperty({ example: 'USD' })
  currencyCode: string;

  @ApiProperty({ example: 42, description: "This merchant's own direct (non-split) charges in the period" })
  chargeCount: number;

  @ApiProperty({
    example: 4299.5,
    description:
      "Full charged amount before any fee, from this merchant's own direct charges only — see this field's own docblock in merchant-statement.aggregate.ts for why a marketplace split is excluded here rather than estimated.",
  })
  grossVolume: number;

  @ApiProperty({ example: 64.49, description: "This platform's own fee, from the same direct charges as grossVolume" })
  platformFee: number;

  @ApiProperty({
    example: 17.16,
    description: 'BNPL provider (Klarna) merchant fee — 0 for a merchant with no BNPL activity',
  })
  providerFee: number;

  @ApiProperty({
    example: 129.99,
    description:
      'Reversals in the period — covers both ordinary refunds and lost-dispute reversals (both book through the same ledger path)',
  })
  refundedAmount: number;

  @ApiProperty({ example: 1, description: 'Disputes that resolved LOST and were received in this period' })
  chargebackCount: number;

  @ApiProperty({
    example: 89.99,
    description: "Those same LOST disputes' amount — already reflected inside refundedAmount too",
  })
  chargebackAmount: number;

  @ApiProperty({
    example: 0,
    description:
      'Net of marketplace-split-sourced MERCHANT credits/debits in the period — 0 for a merchant with no marketplace splits. Can be negative.',
  })
  marketplaceSplitProceeds: number;

  @ApiProperty({
    example: 4087.86,
    description:
      'The literal net balance of every MERCHANT-type ledger entry for this merchant in the period, regardless of event shape — always reconciles against the real ledger by construction. Can be negative.',
  })
  netSettlement: number;
}

export class MerchantStatementResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'merchant_furniture_store' })
  merchantId: string;

  @ApiProperty()
  periodStart: string;

  @ApiProperty()
  periodEnd: string;

  @ApiProperty({ type: [StatementCurrencyBreakdownDto] })
  breakdowns: StatementCurrencyBreakdownDto[];

  @ApiProperty()
  generatedAt: string;
}

/**
 * `marketplaceSplitProceeds`/`netSettlement` are signed `bigint` minor
 * units on the aggregate (see `StatementCurrencyBreakdown`'s own
 * docblock for why they can't be `Money`) — converting to a major-unit
 * number has to go through `Money.fromMinorUnits()` on the absolute
 * value and re-apply the sign, since `Money` rejects a negative amount
 * by construction.
 */
function signedMinorUnitsToAmount(minorUnits: bigint, currencyCode: string): number {
  const magnitude = minorUnits < 0n ? -minorUnits : minorUnits;
  const amount = Money.fromMinorUnits(magnitude, currencyCode).amount;
  return minorUnits < 0n ? -amount : amount;
}

export function toMerchantStatementResponseDto(statement: MerchantStatement): MerchantStatementResponseDto {
  return {
    id: statement.id,
    merchantId: statement.merchantId,
    periodStart: statement.periodStart.toISOString(),
    periodEnd: statement.periodEnd.toISOString(),
    generatedAt: statement.generatedAt.toISOString(),
    breakdowns: statement.breakdowns.map((b) => ({
      currencyCode: b.currencyCode,
      chargeCount: b.chargeCount,
      grossVolume: b.grossVolume.amount,
      platformFee: b.platformFee.amount,
      providerFee: b.providerFee.amount,
      refundedAmount: b.refundedAmount.amount,
      chargebackCount: b.chargebackCount,
      chargebackAmount: b.chargebackAmount.amount,
      marketplaceSplitProceeds: signedMinorUnitsToAmount(b.marketplaceSplitProceedsMinorUnits, b.currencyCode),
      netSettlement: signedMinorUnitsToAmount(b.netSettlementMinorUnits, b.currencyCode),
    })),
  };
}
