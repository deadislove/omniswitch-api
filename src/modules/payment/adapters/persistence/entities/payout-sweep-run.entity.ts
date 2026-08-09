import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('payout_sweep_runs')
export class PayoutSweepRunEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'window_start', type: 'timestamptz' })
  windowStart!: Date;

  @Column({ name: 'window_end', type: 'timestamptz' })
  windowEnd!: Date;

  @Column({ name: 'connected_merchants_paid', type: 'int' })
  connectedMerchantsPaid!: number;

  @Column({ name: 'ran_at', type: 'timestamptz' })
  ranAt!: Date;
}
