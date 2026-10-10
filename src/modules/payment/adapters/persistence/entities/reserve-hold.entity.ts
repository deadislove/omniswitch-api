import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { ReserveHoldStatus } from '../../../domain/aggregates/reserve-hold.aggregate';

@Entity('reserve_holds')
@Index(['merchantId', 'status'])
export class ReserveHoldEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'payment_id' })
  @Index()
  paymentId: string;

  @Column({ name: 'merchant_id' })
  merchantId: string;

  @Column({ name: 'amount_minor_units', type: 'bigint' })
  amountMinorUnits: string;

  /**
   * The full net amount (after platform fee, before this reserve slice
   * was carved out) this hold was originally created from — needed to
   * correctly recompute the target reserve amount at a *new* reserveBps
   * on tier escalation (RiskTieringService via
   * ReserveService.topUpHeldReservesForMerchant()). Same currency as
   * amountMinorUnits (see ReserveHold's own docblock on why this is
   * always the charge currency).
   */
  @Column({ name: 'net_amount_minor_units', type: 'bigint' })
  netAmountMinorUnits: string;

  @Column({ name: 'currency_code', length: 3 })
  currencyCode: string;

  @Column({ type: 'varchar', default: 'HELD' })
  status: ReserveHoldStatus;

  @Column({ name: 'release_eligible_at', type: 'timestamptz' })
  releaseEligibleAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt?: Date | null;
}
