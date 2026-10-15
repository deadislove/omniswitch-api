import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { PayoutTransferStatus, PayoutRail } from '../../../domain/aggregates/payout.aggregate';

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
  @Index()
  transferId?: string | null;

  @Column({ name: 'transfer_initiated_at', type: 'timestamptz', nullable: true })
  transferInitiatedAt?: Date | null;

  @Column({ name: 'transfer_error', type: 'varchar', nullable: true })
  transferError?: string | null;

  @Column({ name: 'reserve_transfer_status', type: 'varchar', default: 'NOT_INITIATED' })
  reserveTransferStatus: PayoutTransferStatus;

  @Column({ name: 'reserve_transfer_id', type: 'varchar', nullable: true })
  @Index()
  reserveTransferId?: string | null;

  @Column({ name: 'reserve_transfer_initiated_at', type: 'timestamptz', nullable: true })
  reserveTransferInitiatedAt?: Date | null;

  @Column({ name: 'reserve_transfer_error', type: 'varchar', nullable: true })
  reserveTransferError?: string | null;

  /** Which rail actually carried the net-amount transfer — see `PayoutRail`'s own docblock. Null until a transfer has actually been initiated. Never set for the reserve-release follow-up transfer (see that type's docblock for why). */
  @Column({ name: 'transfer_rail', type: 'varchar', nullable: true })
  transferRail?: PayoutRail | null;

  /** The premium charged for using the instant rail, in this payout's own currency's minor units — see `calculateInstantPayoutFee()`. Null unless transferRail is INSTANT. */
  @Column({ name: 'instant_fee_amount_minor_units', type: 'bigint', nullable: true })
  instantFeeAmountMinorUnits?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
