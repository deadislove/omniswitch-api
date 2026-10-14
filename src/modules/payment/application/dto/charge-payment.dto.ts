import {
  IsString,
  IsNumber,
  IsPositive,
  IsOptional,
  IsEnum,
  IsObject,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  MinLength,
  MaxLength,
  Max,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PSPProvider } from '../../domain/aggregates/payment.aggregate';
import { CardBrand, CardProduct, CardType } from '../../domain/value-objects/bin-info.vo';
import { IsNotRawCardNumber } from './validators/not-raw-card-number.validator';

export class ChargeSplitDto {
  @ApiProperty({
    example: 'merchant_connected_seller',
    description: 'A CONNECTED merchant onboarded under the charging (PLATFORM) merchant',
  })
  @IsString()
  merchantId: string;

  @ApiProperty({
    example: 25.0,
    description: 'Amount routed to this connected merchant, in the same currency as the charge',
  })
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  amount: number;
}

export class BinInfoDto {
  @ApiProperty({ example: '424242', description: 'First 6-8 digits of card number' })
  @IsString()
  @Matches(/^\d{6,8}$/, { message: 'BIN must be 6-8 digits' })
  bin: string;

  @ApiProperty({ example: 'US', description: 'ISO 3166-1 alpha-2 country code' })
  @IsString()
  @MinLength(2)
  @MaxLength(2)
  country: string;

  @ApiProperty({ enum: CardBrand, example: CardBrand.VISA })
  @IsEnum(CardBrand)
  cardBrand: CardBrand;

  @ApiProperty({ enum: CardType, example: CardType.CREDIT })
  @IsEnum(CardType)
  cardType: CardType;

  @ApiPropertyOptional({
    enum: CardProduct,
    example: CardProduct.CONSUMER,
    description:
      'Interchange product tier — see CardProduct for what each value means. Defaults to CONSUMER when omitted.',
  })
  @IsOptional()
  @IsEnum(CardProduct)
  cardProduct?: CardProduct;

  @ApiPropertyOptional({ example: 'Chase Bank' })
  @IsOptional()
  @IsString()
  issuingBank?: string;
}

export class ChargePaymentDto {
  @ApiProperty({
    example: 99.99,
    description: 'Payment amount in major currency units (e.g., 99.99 for $99.99)',
  })
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(1_000_000_000)
  amount: number;

  @ApiProperty({ example: 'USD', description: 'ISO-4217 currency code' })
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency: string;

  @ApiPropertyOptional({
    example: 'pm_1234567890',
    description: 'PSP payment method ID (opaque reference from client-side tokenization, never a raw card number)',
  })
  @IsOptional()
  @IsString()
  @IsNotRawCardNumber()
  paymentMethodId?: string;

  @ApiPropertyOptional({
    example: 'tok_visa',
    description: 'Card token from PSP.js (opaque reference from client-side tokenization, never a raw card number)',
  })
  @IsOptional()
  @IsString()
  @IsNotRawCardNumber()
  cardToken?: string;

  @ApiPropertyOptional({ example: 'order_abc123', description: 'Merchant order reference' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  orderId?: string;

  @ApiPropertyOptional({ example: 'cust_xyz789', description: 'Customer identifier' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ example: 'Premium subscription payment' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'OMNISWITCH*PREMIUM', description: 'Statement descriptor (max 22 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(22)
  statementDescriptor?: string;

  @ApiPropertyOptional({ type: BinInfoDto, description: 'Card BIN information for smart routing' })
  @IsOptional()
  @IsObject()
  binInfo?: BinInfoDto;

  @ApiPropertyOptional({
    enum: ['STRIPE', 'ADYEN', 'PAYPAL', 'CHASE'],
    description: 'Preferred PSP provider (overrides smart routing)',
  })
  @IsOptional()
  @IsEnum(['STRIPE', 'ADYEN', 'PAYPAL', 'CHASE'])
  preferredProvider?: PSPProvider;

  @ApiPropertyOptional({
    example: { campaign: 'summer_sale', source: 'mobile_app' },
    description: 'Custom metadata key-value pairs',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;

  @ApiPropertyOptional({
    example: 'groceries',
    description:
      'Purchase category — only enforced when the caller is an agent acting under a Delegation with allowedCategories set (see POST /delegations); ignored for a merchant/admin-authenticated charge.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({
    enum: ['automatic', 'manual'],
    default: 'automatic',
    description:
      '"manual" authorizes funds without capturing them; call POST /:id/capture separately to complete the charge.',
  })
  @IsOptional()
  @IsEnum(['automatic', 'manual'])
  captureMethod?: 'automatic' | 'manual';

  @ApiPropertyOptional({
    example: 'EUR',
    description:
      'Currency to show the customer on their statement, if different from `currency` (which is what is actually ' +
      'charged/settled — this never changes that). Purely informational: the response includes a computed ' +
      'presentmentAmount, but nothing about the charge itself changes. Not persisted.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  presentmentCurrency?: string;

  @ApiPropertyOptional({
    type: [ChargeSplitDto],
    description:
      "Route part of this charge's net proceeds directly to one or more of your CONNECTED merchants (marketplace splits). " +
      'Whatever is left after all splits still goes to your own account — a split does not have to add up to the full amount. ' +
      'Requires captureMethod "automatic" (the default) and is not supported together with a settlement-currency conversion.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ChargeSplitDto)
  splits?: ChargeSplitDto[];
}

export class EstimatedFeeDto {
  @ApiProperty({ example: 2.9 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;
}

export class ChargePaymentResponseDto {
  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiProperty({
    example: 'SUCCEEDED',
    description:
      "PENDING_APPROVAL is a special case: only returned for an AGENT charge above the delegation's requireApprovalAboveAmount — no Payment exists yet (the PSP was never called), only a ChargeApproval (see approvalId). Every other value is PaymentStatus as usual.",
  })
  status: string;

  @ApiPropertyOptional({
    description:
      'Only present when status is PENDING_APPROVAL — the ChargeApproval id to approve/deny via POST /charge-approvals/:id/approve|deny',
  })
  approvalId?: string;

  @ApiPropertyOptional({ example: 'pi_stripe_abc123' })
  pspTransactionId?: string;

  @ApiPropertyOptional({ example: 'STRIPE' })
  pspProvider?: string;

  @ApiPropertyOptional({ example: 'https://3ds.stripe.com/challenge/...' })
  actionUrl?: string;

  @ApiProperty({ example: false })
  requiresAction: boolean;

  @ApiPropertyOptional({ example: 25 })
  riskScore?: number;

  @ApiProperty({ example: false })
  usedFallback: boolean;

  @ApiPropertyOptional({ type: EstimatedFeeDto })
  estimatedFee?: EstimatedFeeDto;

  @ApiPropertyOptional({
    example: 91.23,
    description:
      'Only present if the request included presentmentCurrency — the charge amount converted for display, informational only',
  })
  presentmentAmount?: number;

  @ApiPropertyOptional({ example: 'EUR' })
  presentmentCurrency?: string;

  @ApiProperty()
  createdAt: string;
}

export class RefundRecordDto {
  @ApiProperty({ example: 're_abc123' })
  refundId: string;

  @ApiProperty({ example: 49.99 })
  amount: number;

  @ApiPropertyOptional({
    example: 'USD',
    description: 'Only present on GET /payments/:id — POST /:id/refund reports currency once at the top level instead',
  })
  currency?: string;

  @ApiPropertyOptional({ example: 'requested_by_customer' })
  reason?: string;

  @ApiProperty()
  createdAt: string;
}

export class CaptureRecordDto {
  @ApiProperty({ example: 'cap_abc123' })
  captureId: string;

  @ApiProperty({ example: 30 })
  amount: number;

  @ApiProperty()
  createdAt: string;
}

export class InterchangeQualificationDto {
  @ApiProperty({ enum: CardBrand })
  cardBrand: CardBrand;

  @ApiProperty({ enum: CardProduct })
  cardProduct: CardProduct;

  @ApiProperty({ description: 'Best-qualified rate for this brand/product, in basis points.' })
  qualifiedBps: number;

  @ApiProperty({ description: 'Best-qualified flat per-transaction fee, in minor units.' })
  qualifiedFixedMinorUnits: number;

  @ApiProperty()
  downgraded: boolean;

  @ApiProperty({
    type: [String],
    description:
      'Empty when not downgraded. One or more of AVS_NOT_MATCHED, CVV_NOT_MATCHED, NO_AVS_CVV_DATA, LATE_SETTLEMENT.',
  })
  downgradeReasons: string[];

  @ApiProperty({
    description: 'Rate actually applied to this charge — qualifiedBps plus the downgrade surcharge when downgraded.',
  })
  appliedBps: number;

  @ApiProperty()
  appliedFixedMinorUnits: number;
}

export class PaymentDetailResponseDto {
  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiProperty({ example: 'SUCCEEDED' })
  status: string;

  @ApiProperty({ example: 99.99 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiPropertyOptional({ example: 'STRIPE' })
  pspProvider?: string;

  @ApiPropertyOptional({ example: 'pi_stripe_abc123' })
  pspTransactionId?: string;

  @ApiPropertyOptional({ example: 25 })
  riskScore?: number;

  @ApiProperty({ type: [RefundRecordDto] })
  refunds: RefundRecordDto[];

  @ApiProperty({ type: [CaptureRecordDto] })
  captures: CaptureRecordDto[];

  @ApiPropertyOptional({
    example: { campaign: 'summer_sale', source: 'mobile_app' },
    description:
      'Custom metadata key-value pairs, echoed back exactly as sent on charge — see ChargePaymentDto.metadata',
  })
  metadata?: Record<string, string>;

  @ApiPropertyOptional({ example: 'OMNISWITCH*PREMIUM' })
  statementDescriptor?: string;

  @ApiPropertyOptional({
    type: InterchangeQualificationDto,
    description:
      'Only present once this charge actually captures and a binInfo was supplied — see InterchangeQualificationDto.',
  })
  interchangeQualification?: InterchangeQualificationDto;

  @ApiPropertyOptional({
    enum: ['LOW_VALUE', 'TRANSACTION_RISK_ANALYSIS', 'MIT'],
    nullable: true,
    description:
      'The SCA exemption this platform requested from the PSP, if any — only present when a binInfo-carrying European charge or a subscription MIT charge was evaluated. See scaExemptionReason for why, and scaExemptionIndicator for what the PSP actually applied.',
  })
  scaExemptionRequested?: string | null;

  @ApiPropertyOptional({ nullable: true })
  scaExemptionReason?: string | null;

  @ApiPropertyOptional({
    enum: ['LOW_VALUE', 'TRANSACTION_RISK_ANALYSIS', 'MIT'],
    nullable: true,
    description:
      "What the PSP actually applied — can differ from scaExemptionRequested if the PSP's own SCA engine rejected the request and challenged anyway.",
  })
  scaExemptionIndicator?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Whether this authorization used a real network token (Visa VTS / Mastercard MDES) instead of the raw PAN, read from the PSP\'s own response. Null means the PSP never told us either way (e.g. Adyen only reports this when the merchant account opted into the relevant additionalData field) — not a confirmed "false."',
  })
  networkTokenized?: boolean | null;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}

export class RefundPaymentResponseDto {
  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiProperty({ example: 'PARTIALLY_REFUNDED' })
  status: string;

  @ApiProperty({ example: 49.99 })
  totalRefunded: number;

  @ApiProperty({ example: 50.0 })
  remainingRefundable: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ type: [RefundRecordDto] })
  refunds: RefundRecordDto[];
}

export class CapturePaymentResponseDto {
  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiProperty({ example: 'PARTIALLY_CAPTURED' })
  status: string;

  @ApiPropertyOptional({ example: 'pi_stripe_abc123' })
  pspTransactionId?: string;

  @ApiProperty({ example: 100 })
  amount: number;

  @ApiProperty({ example: 30 })
  totalCaptured: number;

  @ApiProperty({ example: 70 })
  remainingCapturable: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ type: [CaptureRecordDto] })
  captures: CaptureRecordDto[];
}

export class CancelPaymentResponseDto {
  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiProperty({ example: 'CANCELLED' })
  status: string;
}

export class BulkUploadRowResultDto {
  @ApiProperty({ example: 0 })
  rowIndex: number;

  @ApiProperty({ example: 'pay_abc123' })
  paymentId: string;

  @ApiPropertyOptional({ example: 'order_001' })
  orderId?: string;

  @ApiProperty({ example: 99.99 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: 'QUEUED' })
  status: string;

  @ApiProperty()
  idempotencyKey: string;
}

export class BulkUploadRowErrorDto {
  @ApiProperty({ description: 'The raw, unparsed CSV row that failed' })
  row: Record<string, string>;

  @ApiProperty({ example: 'Invalid amount: not-a-number' })
  error: string;
}

export class BulkUploadResponseDto {
  @ApiProperty({ example: 100 })
  totalRows: number;

  @ApiProperty({ example: 97 })
  queued: number;

  @ApiProperty({ example: 3 })
  failed: number;

  @ApiProperty({ type: [BulkUploadRowResultDto] })
  payments: BulkUploadRowResultDto[];

  @ApiProperty({ type: [BulkUploadRowErrorDto], description: 'First 10 row-level errors only' })
  errors: BulkUploadRowErrorDto[];

  @ApiProperty()
  batchId: string;

  @ApiProperty()
  processedAt: string;
}
