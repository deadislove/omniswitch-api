import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { PayoutTransferStatus } from '../../../domain/aggregates/payout.aggregate';

@Entity('payouts')
@Index(['merchantId', 'createdAt'])
export class PayoutEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'merchant_id' })
  @Index()
  merchantId: string;

  @Column({ name: 'sweep_run_id' })
  sweepRunId: string;

  @Column({ name: 'gross_amount_minor_units', type: 'bigint' })
  grossAmountMinorUnits: string;

  @Column({ name: 'reserve_amount_minor_units', type: 'bigint' })
  reserveAmountMinorUnits: string;

  @Column({ name: 'net_amount_minor_units', type: 'bigint' })
  netAmountMinorUnits: string;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({ name: 'release_eligible_at', type: 'timestamptz', nullable: true })
  releaseEligibleAt?: Date | null;

  @Column({ name: 'reserve_released', default: false })
  reserveReleased: boolean;

  @Column({ name: 'reserve_released_at', type: 'timestamptz', nullable: true })
  reserveReleasedAt?: Date | null;

  @Column({ name: 'kyc_blocked', default: false })
  kycBlocked: boolean;

  @Column({ name: 'kyc_cleared_at', type: 'timestamptz', nullable: true })
  kycClearedAt?: Date | null;

  @Column({ name: 'transfer_status', type: 'varchar', default: 'NOT_INITIATED' })
  transferStatus: PayoutTransferStatus;

  @Column({ name: 'transfer_id', type: 'varchar', nullable: true })
  transferId?: string | null;

  @Column({ name: 'transfer_initiated_at', type: 'timestamptz', nullable: true })
  transferInitiatedAt?: Date | null;

  @Column({ name: 'transfer_error', type: 'varchar', nullable: true })
  transferError?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
