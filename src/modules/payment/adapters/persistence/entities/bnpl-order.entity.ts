import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { BnplOrderStatus } from '../../../domain/aggregates/bnpl-order.aggregate';

@Entity('bnpl_orders')
@Index(['merchantId', 'createdAt'])
export class BnplOrderEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'merchant_id' })
  @Index()
  merchantId: string;

  @Column({ name: 'amount_minor_units', type: 'bigint' })
  amountMinorUnits: string;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({ name: 'idempotency_key' })
  @Index({ unique: true })
  idempotencyKey: string;

  @Column({ type: 'varchar', default: 'PENDING_AUTHORIZATION' })
  status: BnplOrderStatus;

  @Column({ name: 'customer_id', type: 'varchar', nullable: true })
  customerId?: string | null;

  @Column({ type: 'varchar', nullable: true })
  description?: string | null;

  @Column({ name: 'provider_order_id', type: 'varchar', nullable: true })
  @Index()
  providerOrderId?: string | null;

  @Column({ name: 'provider_capture_id', type: 'varchar', nullable: true })
  providerCaptureId?: string | null;

  @Column({ name: 'failure_reason', type: 'varchar', nullable: true })
  failureReason?: string | null;

  @Column({ name: 'refunds', type: 'jsonb', default: '[]' })
  refunds: Record<string, unknown>[];

  @Column({ name: 'captured_at', type: 'timestamptz', nullable: true })
  capturedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
