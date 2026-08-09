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
