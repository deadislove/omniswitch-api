import { IsIn, IsOptional, IsString, MinLength, MaxLength, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentDetailResponseDto } from './charge-payment.dto';

const RESOLVABLE_OUTCOMES = ['SUCCEEDED', 'FAILED'];

export class ResolveAmbiguousPaymentDto {
  @ApiProperty({
    example: 'SUCCEEDED',
    enum: RESOLVABLE_OUTCOMES,
    description: 'What actually happened at the PSP, per an operator checking the PSP\'s own dashboard/API directly. SUCCEEDED requires pspTransactionId.',
  })
  @IsIn(RESOLVABLE_OUTCOMES)
  outcome: 'SUCCEEDED' | 'FAILED';

  @ApiPropertyOptional({
    example: 'pi_stripe_abc123',
    description: 'Required when outcome is SUCCEEDED — the real PSP transaction reference an operator found by checking the PSP directly. An ambiguous outcome never received one automatically (that\'s what made it ambiguous), so this can\'t be inferred from anything already on the payment.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  pspTransactionId?: string;

  @ApiProperty({
    example: 'Confirmed no charge in Stripe dashboard for this idempotency key',
    description: 'Required — what the operator found when checking the PSP directly. This is a manual override of financial state (SUCCEEDED books real ledger entries), so it always needs a stated justification, not just an optional note.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}

export class ListAmbiguousPaymentsQuery {
  @ApiPropertyOptional({
    example: 15,
    default: 0,
    description: 'Only return payments that have been AMBIGUOUS for at least this many minutes. Omit (or 0) to list every currently AMBIGUOUS payment regardless of age.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  olderThanMinutes?: number;
}

export class AmbiguousPaymentSummaryDto {
  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: 99.99 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiPropertyOptional({ example: 'STRIPE', description: 'The provider the ambiguous attempt was made against — the one to check the dashboard of' })
  pspProvider?: string;

  @ApiProperty({ example: 'STRIPE outcome remains ambiguous after one retry.' })
  failureReason: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty({ example: 42, description: 'Minutes since this payment was created (and, in practice, since it became AMBIGUOUS — the transition happens synchronously within the original charge request)' })
  ageMinutes: number;
}

/**
 * Response shape for POST .../resolve-ambiguous — the normal payment
 * detail shape plus the audit trail for this specific manual action.
 * Deliberately a separate DTO from PaymentDetailResponseDto (which
 * GET /payments/:id also returns to merchant callers) rather than adding
 * these fields to that shared shape — a merchant has no reason to see
 * which internal admin/operator identity resolved their payment.
 */
export class ResolvedAmbiguousPaymentResponseDto extends PaymentDetailResponseDto {
  @ApiProperty({ example: 'admin_ops_team', description: 'merchantId of the ADMIN/OPERATOR account that performed this resolution' })
  ambiguousResolvedBy: string;

  @ApiProperty({ example: 'Confirmed no charge in Stripe dashboard for this idempotency key' })
  ambiguousResolvedReason: string;

  @ApiProperty()
  ambiguousResolvedAt: string;
}
