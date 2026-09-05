import {
  IsString,
  IsNumber,
  IsPositive,
  IsOptional,
  MaxLength,
  IsArray,
  ArrayMaxSize,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DelegationStatus } from '../../domain/aggregates/delegation.aggregate';

export class CreateDelegationDto {
  @ApiProperty({
    example: 'Shopping Assistant Agent',
    description: 'Human-readable label for the agent this delegation authorizes',
  })
  @IsString()
  @MaxLength(255)
  agentName: string;

  @ApiProperty({
    example: 50,
    description: 'Maximum amount this agent may charge in a single transaction, in major currency units',
  })
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(1_000_000_000)
  perTransactionLimit: number;

  @ApiProperty({
    example: 500,
    description:
      'Maximum this agent may charge in total per rolling calendar month, in major currency units — must be >= perTransactionLimit',
  })
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(1_000_000_000)
  monthlyLimit: number;

  @ApiProperty({
    example: 'USD',
    description:
      'ISO-4217 currency code both limits are expressed in — every charge this agent makes must be in this same currency',
  })
  @IsString()
  currency: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['groceries', 'electronics'],
    description:
      'If set, this agent may only charge with a matching ChargePaymentDto.category — an omitted/unlisted category is rejected. If omitted entirely, any category (including none) is allowed.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  allowedCategories?: string[];

  @ApiPropertyOptional({
    example: 86400,
    default: 86400,
    description:
      'Agent token lifetime in seconds (default 24h). Independent of the delegation itself, which stays ACTIVE — and immediately revocable — until POST /delegations/:id/revoke is called, regardless of token expiry.',
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(30 * 24 * 3600)
  tokenTtlSeconds?: number;

  @ApiPropertyOptional({
    example: 200,
    description:
      'If set, a charge above this amount (but still within perTransactionLimit) does not auto-execute — it creates a ChargeApproval and waits for a human operator to approve/deny via POST /charge-approvals/:id/approve|deny. Omit for no approval gate (the default): every charge within the other limits auto-executes exactly as before. Cannot exceed perTransactionLimit.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(1_000_000_000)
  requireApprovalAboveAmount?: number;
}

export class DelegationResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'merchant_acme_corp' })
  merchantId: string;

  @ApiProperty({ example: 'Shopping Assistant Agent' })
  agentName: string;

  @ApiProperty({ enum: ['ACTIVE', 'REVOKED'] })
  status: DelegationStatus;

  @ApiProperty({ example: 50 })
  perTransactionLimit: number;

  @ApiProperty({ example: 500 })
  monthlyLimit: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiPropertyOptional({ type: [String] })
  allowedCategories?: string[];

  @ApiPropertyOptional({
    example: 200,
    description:
      'A charge above this amount requires human approval instead of auto-executing — absent means no approval gate',
  })
  requireApprovalAboveAmount?: number;

  @ApiProperty({ example: 123.45, description: 'Amount spent so far in the current rolling calendar month' })
  currentMonthSpent: number;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional()
  revokedAt?: string;

  @ApiProperty()
  updatedAt: string;
}

export class CreateDelegationResponseDto {
  @ApiProperty({ type: DelegationResponseDto })
  delegation: DelegationResponseDto;

  @ApiProperty({
    description:
      'JWT the agent authenticates with — shown once, same as an API key secret. Use it as a Bearer token against POST /payments/charge only; every other route rejects the AGENT role.',
  })
  agentToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ example: 86400, description: 'Seconds until agentToken expires' })
  expiresIn: number;

  @ApiProperty({
    description:
      "This delegation's own HMAC-SHA256 signing key — shown once, same as agentToken. Required on every POST /payments/charge call this agent makes: sign `${X-Timestamp}.${METHOD}.${path}.${rawBody}` and send the hex digest as X-Signature, the same scheme HmacSignatureGuard uses for merchant requests, just keyed by this delegation's own key instead of the merchant's. Lost or leaked means revoking this delegation and creating a new one — there is no separate key-rotation endpoint, matching agentToken's own posture.",
  })
  agentSigningKey: string;
}
