import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { PaymentStatus } from '../../../domain/value-objects/payment-status.vo';
import { PSPProvider } from '../../../domain/aggregates/payment.aggregate';

@Entity('payments')
@Index(['merchantId', 'createdAt'])
@Index(['idempotencyKey'], { unique: true })
@Index(['status'])
@Index(['pspTransactionId'])
export class PaymentEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'merchant_id' })
  @Index()
  merchantId: string;

  @Column({ name: 'customer_id', nullable: true })
  customerId?: string;

  @Column({ name: 'order_id', nullable: true })
  orderId?: string;

  // Money stored as minor units (bigint as string for PostgreSQL BIGINT)
  @Column({ name: 'amount_minor_units', type: 'bigint' })
  amountMinorUnits: string;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({ name: 'currency_minor_units', type: 'int' })
  currencyMinorUnits: number;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  status: PaymentStatus;

  @Column({ name: 'idempotency_key', unique: true })
  idempotencyKey: string;

  @Column({ name: 'psp_provider', nullable: true, type: 'varchar' })
  pspProvider?: PSPProvider;

  @Column({ name: 'psp_transaction_id', nullable: true })
  pspTransactionId?: string;

  @Column({ name: 'psp_raw_response', type: 'jsonb', nullable: true })
  pspRawResponse?: Record<string, unknown>;

  @Column({ name: 'risk_score', type: 'int', nullable: true })
  riskScore?: number;

  @Column({ name: 'three_ds_result', type: 'jsonb', nullable: true })
  threeDSResult?: Record<string, unknown>;

  @Column({ name: 'refunds', type: 'jsonb', default: '[]' })
  refunds: Record<string, unknown>[];

  @Column({ name: 'captures', type: 'jsonb', default: '[]' })
  captures: Record<string, unknown>[];

  @Column({ name: 'failure_reason', nullable: true })
  failureReason?: string;

  @Column({ name: 'failure_code', nullable: true })
  failureCode?: string;

  @Column({ name: 'description', nullable: true })
  description?: string;

  @Column({ name: 'statement_descriptor', nullable: true })
  statementDescriptor?: string;

  @Column({ name: 'payment_metadata', type: 'jsonb', nullable: true })
  paymentMetadata?: Record<string, string>;

  // BIN info stored as JSONB
  @Column({ name: 'bin_info', type: 'jsonb', nullable: true })
  binInfo?: Record<string, unknown>;

  // FX snapshot if currency conversion occurred
  @Column({ name: 'fx_snapshot', type: 'jsonb', nullable: true })
  fxSnapshot?: Record<string, unknown>;

  /**
   * The rate actually applied to this payment's merchant payout leg, the
   * first time it was settlement-converted — see
   * PaymentAggregate.recordSettlementConversion()'s docblock for why this
   * is recorded once and reused (not re-derived) for refunds/dispute
   * losses. Distinct from fxSnapshot above, which is about the *charge*
   * amount itself potentially having been converted (presentment
   * currency) — this is about the separate settlement/payout leg.
   */
  @Column({ name: 'settlement_conversion', type: 'jsonb', nullable: true })
  settlementConversion?: { currency: string; rate: number; provider: string };

  /**
   * The marketplace `splits` this payment was actually charged with, if
   * any — recorded once at charge time (see
   * PaymentAggregate.recordSplits()'s docblock) so a later refund or lost
   * dispute can reverse each recipient's share proportionally rather than
   * only ever debiting the charging (platform) merchant's own account.
   */
  @Column({ name: 'splits', type: 'jsonb', nullable: true })
  splits?: { merchantId: string; amountMinorUnits: string; currencyCode: string }[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
