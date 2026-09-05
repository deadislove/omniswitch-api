import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { ChargeApprovalStatus } from '../../../domain/aggregates/charge-approval.aggregate';

@Entity('charge_approvals')
@Index(['merchantId', 'status'])
export class ChargeApprovalEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'payment_id' })
  paymentId: string;

  @Column({ name: 'delegation_id' })
  @Index()
  delegationId: string;

  @Column({ name: 'merchant_id' })
  merchantId: string;

  @Column({ name: 'amount_minor_units', type: 'bigint' })
  amountMinorUnits: string;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({ name: 'idempotency_key' })
  idempotencyKey: string;

  /** The original ChargePaymentDto, stored verbatim — see ChargeApproval's own docblock for why. */
  @Column({ name: 'charge_request', type: 'jsonb' })
  chargeRequest: Record<string, unknown>;

  @Column({ type: 'varchar', default: 'PENDING' })
  status: ChargeApprovalStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt?: Date | null;

  @Column({ name: 'decided_by', type: 'varchar', nullable: true })
  decidedBy?: string | null;

  @Column({ name: 'denial_reason', type: 'varchar', nullable: true })
  denialReason?: string | null;
}
